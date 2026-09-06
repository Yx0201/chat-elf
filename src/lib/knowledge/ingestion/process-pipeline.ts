/**
 * 摄取流水线:六阶段状态机 + 各阶段执行器 —— 自 codeweaver 移植,
 * 执行层换 drizzle 原生 SQL;finalize 阶段新增文件/KB 摘要生成(step2 前置判断依据)。
 *
 * 驱动方式:客户端 250ms 轮询 POST /api/knowledge/[kbId]/files/[fileId]/process,
 * 每次请求推进**一个有界批次**(hobby 函数 60s 时长约束下安全;split 按
 * KB_SPLIT_BATCH_SIZE 个父块/批,embed/graphBuild 各自限量),状态持久化在
 * uploaded_files.metadata.process,断点可续。并发安全双保险:
 *  - 文件级 process_claim 原子认领(claimPipelineRun,90s TTL)防重复推进互踩;
 *  - graphBuild 另有 SKIP LOCKED + processing_at 过期重领。
 *
 * 相对 codeweaver 的差异:
 *  - app 层预生成 UUID 保留(规避 RETURNING 线程化依赖,且 drizzle 下同样简单);
 *  - embed 批大小默认 10(KB_EMBEDDING_BATCH_SIZE);
 *  - finalize 加摘要生成,失败降级不回滚流水线(摘要是增强)。
 */

import { sql } from "drizzle-orm";
import { buildNovelGraphChunks, buildNovelRetrievalChunks } from "@/lib/knowledge/chunking";
import {
  EMBEDDING_BATCH_SIZE,
  GRAPH_BUILD_CONCURRENCY,
  GRAPH_BUILD_MAX_CONCURRENCY,
  GRAPH_BUILD_MIN_CONCURRENCY,
  SPLIT_BATCH_SIZE,
} from "@/lib/knowledge/config";
import { executeStatement, queryRows } from "@/lib/knowledge/sql";
import { toTsvectorInput } from "@/lib/knowledge/tokenizer";
import { embedTexts } from "@/lib/memory/embedding";
import { consumeRateLimitHits } from "./graph-extractor";
import {
  cleanupKnowledgeGraph,
  prepareKnowledgeGraphChunkIngestion,
  writeKnowledgeGraphChunkIngestion,
  type KnowledgeGraphChunkIngestion,
} from "./graph-build";
import { generateFileSummary, rebuildKnowledgeBaseSummary } from "./summary";

// ── 状态形状(与 codeweaver v2 完全一致,UI 侧无脑对接)─────────────────

export type UploadStepKey =
  | "upload"
  | "retrieval"
  | "embed"
  | "graphSplit"
  | "graphBuild"
  | "finalize";
export type UploadStepStatus = "pending" | "running" | "completed" | "failed";

export interface UploadPipelineStep {
  key: UploadStepKey;
  label: string;
  description: string;
  status: UploadStepStatus;
  progress: number;
}

export interface UploadPipelineCounts {
  retrievalParentChunks: number;
  retrievalChildChunks: number;
  embeddedChunks: number;
  graphChunks: number;
  graphBuiltChunks: number;
}

export interface UploadPipelineState {
  version: 2;
  stage: UploadStepKey;
  totalPercent: number;
  totalStages: number;
  currentStageIndex: number;
  steps: UploadPipelineStep[];
  counts: UploadPipelineCounts;
  /**
   * 检索分块游标:下一批从第几个父块开始。分块阶段分批推进
   * (每请求 KB_SPLIT_BATCH_SIZE 个父块),整文件单请求会撞 60s 函数墙。
   */
  splitCursor?: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

const STEP_DEFS: Array<Pick<UploadPipelineStep, "key" | "label" | "description">> = [
  { key: "upload", label: "上传保存", description: "保存原始文件和基础记录" },
  { key: "retrieval", label: "检索分块", description: "按混合检索策略切出父子 chunk" },
  { key: "embed", label: "向量构建", description: "为检索子 chunk 生成 embedding 与关键词索引" },
  { key: "graphSplit", label: "图谱分块", description: "按小说结构切出专用 graph chunk" },
  { key: "graphBuild", label: "图谱构建", description: "提取实体、关系并写入图谱表" },
  { key: "finalize", label: "完成收尾", description: "生成内容摘要并更新状态" },
];

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function withComputedTotals(state: UploadPipelineState): UploadPipelineState {
  const steps = state.steps.map((step) => ({
    ...step,
    progress: clampProgress(step.progress),
  }));

  const totalPercent = clampProgress(
    steps.reduce((sum, step) => sum + step.progress, 0) / steps.length,
  );
  const currentStageIndex = Math.max(
    1,
    STEP_DEFS.findIndex((step) => step.key === state.stage) + 1,
  );

  return { ...state, steps, totalPercent, currentStageIndex };
}

export function createInitialProcessState(): UploadPipelineState {
  return withComputedTotals({
    version: 2,
    stage: "retrieval",
    totalPercent: 0,
    totalStages: STEP_DEFS.length,
    currentStageIndex: 2,
    startedAt: new Date().toISOString(),
    counts: {
      retrievalParentChunks: 0,
      retrievalChildChunks: 0,
      embeddedChunks: 0,
      graphChunks: 0,
      graphBuiltChunks: 0,
    },
    steps: STEP_DEFS.map((step) => ({
      ...step,
      status: step.key === "upload" ? "completed" : step.key === "retrieval" ? "running" : "pending",
      progress: step.key === "upload" ? 100 : 0,
    })),
  });
}

function updateStepState(
  state: UploadPipelineState,
  key: UploadStepKey,
  patch: Partial<Pick<UploadPipelineStep, "status" | "progress">>,
): UploadPipelineState {
  return withComputedTotals({
    ...state,
    steps: state.steps.map((step) => (step.key === key ? { ...step, ...patch } : step)),
  });
}

function moveToStage(state: UploadPipelineState, stage: UploadStepKey): UploadPipelineState {
  return withComputedTotals({
    ...state,
    stage,
    steps: state.steps.map((step) => {
      if (step.key === stage && step.status === "pending") {
        return { ...step, status: "running" };
      }
      return step;
    }),
  });
}

export function markPipelineFailed(state: UploadPipelineState, error: string): UploadPipelineState {
  return withComputedTotals({
    ...state,
    error,
    steps: state.steps.map((step) => (step.key === state.stage ? { ...step, status: "failed" } : step)),
  });
}

/**
 * 把错误压成给人看的一行:沿 cause 链取**最深层原因**(PG 真实报错)
 * 放最前,drizzle 那层「Failed query: + 整段 SQL」截短垫后。
 * 否则 UI 上只能看到一坨 SQL,真实原因(如外键断裂)被淹没。
 */
export function formatPipelineError(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && messages.length < 4) {
    messages.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  if (messages.length === 0) return String(error).slice(0, 800);

  // 最深层在前;最外层(SQL 壳)只留头 150 字符
  const ordered = messages.slice(1).reverse().concat(messages[0]);
  const clipped = ordered.map((message, index) =>
    index === ordered.length - 1 ? message.slice(0, 150) : message.slice(0, 400),
  );
  return clipped.filter(Boolean).join(" ← ").slice(0, 900);
}

/** 认领 TTL:超过此时长未释放(函数被 60s 强杀等)视为死锁,可被抢。 */
const PROCESS_CLAIM_TTL_MS = 90_000;

/**
 * 原子认领:同一文件的推进请求全局只允许一个在跑。
 * 没有它,页面刷新/重试会让第二个 POST 在第一个还在途时进场,
 * split 的全量 DELETE 互踩对方半成品 → 外键断裂。
 * 认领随状态落库释放(updateFileProcess),崩溃残留由 TTL 自愈。
 */
export async function claimPipelineRun(fileId: string): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(sql`
    UPDATE uploaded_files
    SET metadata = COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object('process_claim', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
    WHERE id = ${fileId}::uuid
      AND COALESCE((metadata ->> 'process_claim')::bigint, 0)
          < (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint - ${PROCESS_CLAIM_TTL_MS}
    RETURNING id`);
  return rows.length > 0;
}

function markPipelineCompleted(state: UploadPipelineState): UploadPipelineState {
  return withComputedTotals({
    ...state,
    stage: "finalize",
    completedAt: new Date().toISOString(),
    steps: state.steps.map((step) => ({ ...step, status: "completed", progress: 100 })),
  });
}

export function parseUploadPipelineState(metadata: unknown): UploadPipelineState | null {
  if (!metadata || typeof metadata !== "object") return null;

  const process = (metadata as { process?: unknown }).process;
  if (!process || typeof process !== "object") return null;

  const candidate = process as Partial<UploadPipelineState>;
  if (!candidate.version || !Array.isArray(candidate.steps) || !candidate.stage) return null;

  const counts = (candidate.counts ?? {}) as Partial<UploadPipelineCounts>;

  return withComputedTotals({
    version: 2,
    stage: candidate.stage,
    totalPercent: candidate.totalPercent ?? 0,
    totalStages: candidate.totalStages ?? STEP_DEFS.length,
    currentStageIndex: candidate.currentStageIndex ?? 1,
    counts: {
      retrievalParentChunks: counts.retrievalParentChunks ?? 0,
      retrievalChildChunks: counts.retrievalChildChunks ?? 0,
      embeddedChunks: counts.embeddedChunks ?? 0,
      graphChunks: counts.graphChunks ?? 0,
      graphBuiltChunks: counts.graphBuiltChunks ?? 0,
    },
    steps: candidate.steps.map((step) => ({
      key: step.key,
      label: step.label,
      description: step.description,
      status: step.status,
      progress: step.progress,
    })),
    splitCursor:
      typeof candidate.splitCursor === "number" && candidate.splitCursor > 0
        ? candidate.splitCursor
        : undefined,
    error: candidate.error,
    startedAt: candidate.startedAt ?? new Date().toISOString(),
    completedAt: candidate.completedAt,
  } as UploadPipelineState);
}

/** 把流水线状态合并写回 uploaded_files.metadata(保留 graph_build_stats 等兄弟键),同时释放推进认领。 */
export async function updateFileProcess(
  fileId: string,
  state: UploadPipelineState,
  status: string = "processing",
): Promise<void> {
  await executeStatement(sql`
    UPDATE uploaded_files
    SET status = ${status},
        metadata = (COALESCE(metadata, '{}'::jsonb)
          || ${JSON.stringify({ process: state })}::jsonb) - 'process_claim',
        updated_at = now()
    WHERE id = ${fileId}::uuid`);
}

// ── 各阶段执行器 ─────────────────────────────────────────────────────

/**
 * 检索分块(分批推进):每请求处理 SPLIT_BATCH_SIZE 个父块。
 *
 * 幂等性:每个父块带稳定 chunk_index(章节序),批次先删本批区间
 * (子块→父块,FK 安全顺序)再插入 —— 请求在「插入完成、状态未落库」
 * 间被杀时,重跑同批自动清掉半成品,不会产生重复块。
 * 首批(cursor=0)先全量 DELETE,重试/重处理获得干净起点。
 */
async function runRetrievalSplitStage(
  fileId: string,
  content: string,
  state: UploadPipelineState,
): Promise<UploadPipelineState> {
  const parents = buildNovelRetrievalChunks(content);
  const cursor = Math.min(state.splitCursor ?? 0, parents.length);
  const batch = parents.slice(cursor, cursor + SPLIT_BATCH_SIZE);

  if (cursor === 0) {
    await executeStatement(sql`DELETE FROM document_chunks WHERE file_id = ${fileId}::uuid`);
  } else if (batch.length > 0) {
    // 批次自愈:清掉上一次同区间可能残留的半成品(崩溃在落库前的场景)。
    const end = cursor + batch.length;
    await executeStatement(sql`
      DELETE FROM document_chunks
      WHERE file_id = ${fileId}::uuid
        AND parent_chunk_id IN (
          SELECT id FROM document_chunks
          WHERE file_id = ${fileId}::uuid AND chunk_type = 'parent'
            AND chunk_index >= ${cursor} AND chunk_index < ${end})`);
    await executeStatement(sql`
      DELETE FROM document_chunks
      WHERE file_id = ${fileId}::uuid AND chunk_type = 'parent'
        AND chunk_index >= ${cursor} AND chunk_index < ${end}`);
  }

  let batchChildCount = 0;
  for (const parent of batch) {
    const parentId = crypto.randomUUID();
    const parentMeta = JSON.stringify({
      ...parent.metadata,
      chapterTitle: parent.chapterTitle,
      volumeTitle: parent.volumeTitle,
    });

    await executeStatement(sql`
      INSERT INTO document_chunks (id, file_id, chunk_text, chunk_index, chunk_type, metadata)
      VALUES (${parentId}::uuid, ${fileId}::uuid, ${parent.text}, ${parent.order}, 'parent', ${parentMeta}::jsonb)`);

    batchChildCount += parent.childChunks.length;
    if (parent.childChunks.length === 0) continue;

    // 同一父块的全部子块一次多行 INSERT(一次网络往返,含 jieba 分词入 tsvector)。
    const childValues = parent.childChunks.map(
      (chunkText, index) =>
        sql`(${crypto.randomUUID()}::uuid, ${fileId}::uuid, ${chunkText}, to_tsvector('simple', ${toTsvectorInput(chunkText)}), ${index}, 'child', ${parentId}::uuid, ${JSON.stringify({
          documentType: "novel",
          strategy: "retrieval-child",
          chapterTitle: parent.chapterTitle,
          volumeTitle: parent.volumeTitle,
          parentOrder: parent.order,
        })}::jsonb)`,
    );
    await executeStatement(sql`
      INSERT INTO document_chunks (id, file_id, chunk_text, keywords, chunk_index, chunk_type, parent_chunk_id, metadata)
      VALUES ${sql.join(childValues, sql`, `)}`);
  }

  const nextCursor = cursor + batch.length;
  const batchDone = nextCursor >= parents.length;

  // 完成时从库里取权威计数(批次重跑历史下也能对账),进行中用累计近似值。
  let parentTotal = nextCursor;
  let childTotal = state.counts.retrievalChildChunks + batchChildCount;
  if (batchDone) {
    const counts = await queryRows<{ parents: number; children: number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE chunk_type = 'parent')::int AS parents,
        COUNT(*) FILTER (WHERE chunk_type = 'child')::int AS children
      FROM document_chunks WHERE file_id = ${fileId}::uuid`);
    parentTotal = counts[0]?.parents ?? parentTotal;
    childTotal = counts[0]?.children ?? childTotal;
  }

  const progress = parents.length === 0 ? 100 : Math.round((nextCursor / parents.length) * 100);
  let nextState: UploadPipelineState = {
    ...state,
    splitCursor: nextCursor,
    counts: { ...state.counts, retrievalParentChunks: parentTotal, retrievalChildChunks: childTotal },
  };
  nextState = updateStepState(nextState, "retrieval", {
    status: batchDone ? "completed" : "running",
    progress,
  });

  if (!batchDone) return nextState;

  const doneState = { ...nextState };
  delete doneState.splitCursor;
  nextState = doneState;
  nextState = moveToStage(nextState, "embed");
  nextState = updateStepState(nextState, "embed", {
    status: "running",
    progress: childTotal === 0 ? 100 : 0,
  });

  if (childTotal === 0) {
    nextState = updateStepState(nextState, "embed", { status: "completed", progress: 100 });
    nextState = moveToStage(nextState, "graphSplit");
    nextState = updateStepState(nextState, "graphSplit", { status: "running", progress: 0 });
  }

  return nextState;
}

async function runEmbeddingStage(
  fileId: string,
  state: UploadPipelineState,
): Promise<UploadPipelineState> {
  const rows = await queryRows<{ id: string; chunk_text: string }>(sql`
    SELECT id, chunk_text
    FROM document_chunks
    WHERE file_id = ${fileId}::uuid
      AND chunk_type = 'child'
      AND embedding IS NULL
    ORDER BY chunk_index ASC
    LIMIT ${EMBEDDING_BATCH_SIZE}`);

  if (rows.length > 0) {
    // 失败直接抛错 → 本阶段 failed,可 retry;不吞错以免剩余计数永远清不了零。
    const embedStart = Date.now();
    const embeddings = await embedTexts(rows.map((row) => row.chunk_text));
    console.log(
      `[knowledge][trace] 嵌入批次 ${rows.length}条 耗时=${Date.now() - embedStart}ms`,
    );

    // 单往返批量回填:UPDATE ... FROM (VALUES ...) 按 id 匹配向量。
    const values = rows.map(
      (row, index) => sql`(${row.id}::uuid, ${`[${embeddings[index].join(",")}]`}::vector)`,
    );
    await executeStatement(sql`
      UPDATE document_chunks AS dc
      SET embedding = v.embedding
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, embedding)
      WHERE dc.id = v.id`);
  }

  const remainingRows = await queryRows<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM document_chunks
    WHERE file_id = ${fileId}::uuid
      AND chunk_type = 'child'
      AND embedding IS NULL`);
  const remaining = remainingRows[0]?.count ?? 0;
  const embeddedChunks = Math.max(0, state.counts.retrievalChildChunks - remaining);
  const progress =
    state.counts.retrievalChildChunks === 0
      ? 100
      : Math.round((embeddedChunks / state.counts.retrievalChildChunks) * 100);

  let nextState = { ...state, counts: { ...state.counts, embeddedChunks } };
  nextState = updateStepState(nextState, "embed", {
    status: remaining === 0 ? "completed" : "running",
    progress,
  });

  if (remaining === 0) {
    nextState = moveToStage(nextState, "graphSplit");
    nextState = updateStepState(nextState, "graphSplit", { status: "running", progress: 0 });
  }

  return nextState;
}

async function runGraphSplitStage(
  kbId: string,
  fileId: string,
  content: string,
  state: UploadPipelineState,
): Promise<UploadPipelineState> {
  const graphChunkDescriptors = buildNovelGraphChunks(content);

  await executeStatement(sql`DELETE FROM graph_chunks WHERE file_id = ${fileId}::uuid`);
  await cleanupKnowledgeGraph(kbId);

  // 100/批多行 INSERT(远程库每次语句一个往返,逐行插会拖死本阶段)。
  const GRAPH_INSERT_BATCH = 100;
  for (let start = 0; start < graphChunkDescriptors.length; start += GRAPH_INSERT_BATCH) {
    const batch = graphChunkDescriptors.slice(start, start + GRAPH_INSERT_BATCH);
    const values = batch.map(
      (chunk) =>
        sql`(${crypto.randomUUID()}::uuid, ${fileId}::uuid, ${chunk.text}, ${chunk.order}, ${chunk.chapterTitle}, ${chunk.volumeTitle}, ${JSON.stringify(chunk.metadata ?? {})}::jsonb)`,
    );
    await executeStatement(sql`
      INSERT INTO graph_chunks (id, file_id, text, chunk_index, chapter_title, volume_title, metadata)
      VALUES ${sql.join(values, sql`, `)}`);
  }

  let nextState = updateStepState(state, "graphSplit", { status: "completed", progress: 100 });
  nextState = {
    ...nextState,
    counts: {
      ...nextState.counts,
      graphChunks: graphChunkDescriptors.length,
      graphBuiltChunks: 0,
    },
  };
  console.log(
    `[knowledge][trace] graphSplit 完成 图谱块=${graphChunkDescriptors.length}` +
      `(检索父块=${nextState.counts.retrievalParentChunks}/子块=${nextState.counts.retrievalChildChunks})`,
  );
  nextState = moveToStage(nextState, "graphBuild");
  nextState = updateStepState(nextState, "graphBuild", {
    status: "running",
    progress: graphChunkDescriptors.length === 0 ? 100 : 0,
  });

  if (graphChunkDescriptors.length === 0) {
    nextState = updateStepState(nextState, "graphBuild", { status: "completed", progress: 100 });
    nextState = moveToStage(nextState, "finalize");
    nextState = updateStepState(nextState, "finalize", { status: "running", progress: 100 });
  }

  return nextState;
}

interface GraphBuildStats {
  startedAt?: string;
  successCount?: number;
  failCount?: number;
  totalExtractMs?: number;
  concurrency?: number;
}

function readGraphBuildStats(metadata: unknown): GraphBuildStats {
  if (metadata && typeof metadata === "object") {
    const stats = (metadata as Record<string, unknown>).graph_build_stats;
    if (stats && typeof stats === "object") return stats as GraphBuildStats;
  }
  return {};
}

async function runGraphBuildStage(
  kbId: string,
  fileId: string,
  fileMetadata: unknown,
  state: UploadPipelineState,
): Promise<UploadPipelineState> {
  const stats = readGraphBuildStats(fileMetadata);
  const concurrency = Math.min(
    Math.max(stats.concurrency ?? GRAPH_BUILD_CONCURRENCY, GRAPH_BUILD_MIN_CONCURRENCY),
    GRAPH_BUILD_MAX_CONCURRENCY,
  );
  const startedAt = stats.startedAt ?? new Date().toISOString();

  // 原子认领一批未处理块:打上 processing_at 并返回。
  // FOR UPDATE SKIP LOCKED 保证并发请求各拿不相交的集合;
  // processing_at 超过 10 分钟视为死认领(请求崩了没来得及标 graph_processed),可重领。
  const rows = await queryRows<{ id: string; text: string }>(sql`
    UPDATE graph_chunks
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('processing_at', NOW())
    WHERE id IN (
      SELECT id FROM graph_chunks
      WHERE file_id = ${fileId}::uuid
        AND COALESCE(metadata ->> 'graph_processed', 'false') <> 'true'
        AND (
          metadata ->> 'processing_at' IS NULL
          OR (metadata ->> 'processing_at')::timestamp < NOW() - INTERVAL '10 minutes'
        )
      ORDER BY chunk_index ASC
      LIMIT ${concurrency}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, text`);

  console.log(`[knowledge] graphBuild 批次开始 file=${fileId} 并发=${concurrency} 块数=${rows.length}`);
  const batchStart = Date.now();
  consumeRateLimitHits(); // 清零计数,本批重新累计

  const extractedRows = await Promise.all(
    rows.map(async (row) => {
      const chunkStart = Date.now();
      let graphError: string | null = null;
      let extraction: KnowledgeGraphChunkIngestion | null = null;

      try {
        extraction = await prepareKnowledgeGraphChunkIngestion(row.text);
        console.log(
          `[knowledge] 图谱块抽取完成 ${row.id}: 实体=${extraction.entities.length} 关系=${extraction.relations.length}`,
        );
      } catch (error) {
        graphError = error instanceof Error ? error.message : "未知图谱构建错误";
        console.warn(`[knowledge] 图谱块抽取跳过 ${row.id}: ${graphError}`);
      }

      return { row, extraction, graphError, ms: Date.now() - chunkStart };
    }),
  );

  // 串行写库:并发写入会产生重复实体(解析与合并不原子)。
  // 写库段逐块计时(trace 分析用:提取是并行、写库是串行,两者的耗时分布
  // 决定加并发还有没有收益)。
  const writeStart = Date.now();
  const writeMsPerChunk: number[] = [];
  for (let i = 0; i < extractedRows.length; i += 1) {
    const { row, extraction } = extractedRows[i];
    const chunkWriteStart = Date.now();
    try {
      if (extraction) {
        await writeKnowledgeGraphChunkIngestion({ kbId, graphChunkId: row.id, extraction });
      }
    } catch (error) {
      // 写入失败同样计入批次失败统计(否则 failCount 失真)
      extractedRows[i].graphError = error instanceof Error ? error.message : "未知图谱构建错误";
      console.warn(`[knowledge] 图谱块写入跳过 ${row.id}: ${extractedRows[i].graphError}`);
    }

    await executeStatement(sql`
      UPDATE graph_chunks
      SET metadata = (COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object('graph_processed', true, 'graph_error', ${extractedRows[i].graphError}::text)) - 'processing_at'
      WHERE id = ${row.id}::uuid`);
    writeMsPerChunk.push(Date.now() - chunkWriteStart);
  }
  const writeMs = Date.now() - writeStart;
  const slowestWrite = writeMsPerChunk.length > 0 ? Math.max(...writeMsPerChunk) : 0;
  if (slowestWrite > 3000) {
    console.warn(`[knowledge][trace] 慢写库块 ${slowestWrite}ms(串行段的拖累点)`);
  }
  const slowestExtract = extractedRows.reduce((max, r) => Math.max(max, r.ms), 0);
  if (slowestExtract > 12000) {
    console.warn(`[knowledge][trace] 慢LLM调用 ${slowestExtract}ms`);
  }

  const batchMs = Date.now() - batchStart;
  const batchSuccess = extractedRows.filter((r) => !r.graphError).length;
  const batchFail = extractedRows.length - batchSuccess;
  const batchExtractMs = extractedRows.reduce((sum, r) => sum + r.ms, 0);

  // AIMD 并发控制:限流减半,干净批次 +1。
  const rateLimitHits = consumeRateLimitHits();
  const nextConcurrency =
    rateLimitHits > 0
      ? Math.max(GRAPH_BUILD_MIN_CONCURRENCY, Math.floor(concurrency / 2))
      : Math.min(GRAPH_BUILD_MAX_CONCURRENCY, concurrency + 1);

  const remainingRows = await queryRows<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM graph_chunks
    WHERE file_id = ${fileId}::uuid
      AND COALESCE(metadata ->> 'graph_processed', 'false') <> 'true'`);
  const remaining = remainingRows[0]?.count ?? 0;

  const perChunkAvgMs = rows.length > 0 ? Math.round(batchMs / rows.length) : 0;
  const etaSec = remaining > 0 && rows.length > 0 ? Math.round((remaining * batchMs) / rows.length / 1000) : 0;
  console.log(
    `[knowledge][trace] graphBuild 批次完成 file=${fileId.slice(0, 8)} 本批=${rows.length} 成功=${batchSuccess} 失败=${batchFail}` +
      ` 墙钟=${batchMs}ms[提取段最慢${slowestExtract}ms ‖ 写库段${writeMs}ms(最慢${slowestWrite}ms)]` +
      ` 均耗/块=${perChunkAvgMs}ms 限流=${rateLimitHits} 下一并发=${nextConcurrency} 剩余=${remaining}` +
      (remaining > 0 ? ` 预计还需~${Math.floor(etaSec / 60)}分${etaSec % 60}秒` : ""),
  );

  const newStats: GraphBuildStats = {
    startedAt,
    successCount: (stats.successCount ?? 0) + batchSuccess,
    failCount: (stats.failCount ?? 0) + batchFail,
    totalExtractMs: (stats.totalExtractMs ?? 0) + batchExtractMs,
    concurrency: nextConcurrency,
  };
  await executeStatement(sql`
    UPDATE uploaded_files
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('graph_build_stats', ${JSON.stringify(newStats)}::jsonb)
    WHERE id = ${fileId}::uuid`);

  const graphBuiltChunks = Math.max(0, state.counts.graphChunks - remaining);
  const progress =
    state.counts.graphChunks === 0
      ? 100
      : Math.round((graphBuiltChunks / state.counts.graphChunks) * 100);

  let nextState = { ...state, counts: { ...state.counts, graphBuiltChunks } };
  nextState = updateStepState(nextState, "graphBuild", {
    status: remaining === 0 ? "completed" : "running",
    progress,
  });

  if (remaining === 0) {
    nextState = moveToStage(nextState, "finalize");
    nextState = updateStepState(nextState, "finalize", { status: "running", progress: 100 });
  }

  return nextState;
}

/**
 * 收尾:孤儿清理 + 文件摘要 + KB 聚合摘要 + 标记 completed。
 * 摘要失败只降级(null 摘要),不回滚整个流水线 —— 摘要是增强能力。
 */
async function runFinalizeStage(
  kbId: string,
  fileId: string,
  fileName: string,
  content: string,
  state: UploadPipelineState,
): Promise<UploadPipelineState> {
  await cleanupKnowledgeGraph(kbId);

  try {
    await generateFileSummary(fileId, fileName, content);
  } catch (error) {
    console.error("[knowledge] 文件摘要生成失败(降级跳过):", error instanceof Error ? error.message : error);
  }
  try {
    await rebuildKnowledgeBaseSummary(kbId);
  } catch (error) {
    console.error("[knowledge] KB 聚合摘要生成失败(降级跳过):", error instanceof Error ? error.message : error);
  }

  let nextState = updateStepState(state, "finalize", { status: "completed", progress: 100 });
  nextState = markPipelineCompleted(nextState);
  return nextState;
}

/** 推进一个批次;返回下一个状态(由路由层持久化)。 */
export async function advancePipeline(params: {
  kbId: string;
  fileId: string;
  fileName: string;
  content: string;
  fileMetadata: unknown;
  state: UploadPipelineState;
}): Promise<UploadPipelineState> {
  const { kbId, fileId, fileName, content, fileMetadata, state } = params;

  switch (state.stage) {
    case "retrieval":
      return runRetrievalSplitStage(fileId, content, state);
    case "embed":
      return runEmbeddingStage(fileId, state);
    case "graphSplit":
      return runGraphSplitStage(kbId, fileId, content, state);
    case "graphBuild":
      return runGraphBuildStage(kbId, fileId, fileMetadata, state);
    case "finalize":
      return runFinalizeStage(kbId, fileId, fileName, content, state);
    default:
      return state;
  }
}
