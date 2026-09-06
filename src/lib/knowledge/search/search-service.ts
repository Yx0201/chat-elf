/**
 * 检索统一入口 —— 自 codeweaver search-service + hybrid-search 合并移植
 * (query-rewriter 与 trace 树未迁移:agent 自主重查替代前者,后者待
 * step2 文本线需要时再加)。
 *
 * 三种模式:
 *  - hybrid(默认):向量 + 关键词 + 图谱三通道并行 → RRF(k=60)融合
 *                  → gte/qwen rerank → 低分截断 → 子块升父块
 *  - graph       :纯图谱检索
 *  - fast        :向量 + 关键词,跳过图谱与重排(低延迟,语音线可选)
 *
 * 出口 `searchKnowledge` 是 step2 两条线(语音工具 / 文本问答)的唯一消费接口;
 * scope.kbId 缺省时检索该用户全部知识库(语音线语义)。
 */

import { sql } from "drizzle-orm";
import {
  DEFAULT_FINAL_TOP_K,
  DEFAULT_FUSION_TOP_K,
  DEFAULT_GRAPH_CHANNEL_TOP_K,
  DEFAULT_KEYWORD_TOP_K,
  DEFAULT_RERANKER_TOP_K,
  DEFAULT_VECTOR_TOP_K,
  MIN_RERANK_KEEP,
  MIN_RERANK_SCORE,
  RRF_K,
} from "@/lib/knowledge/config";
import { queryRows, uuidArrayParam } from "@/lib/knowledge/sql";
import { keywordSearch } from "./keyword-search";
import { rerank } from "./rerank";
import { vectorSearch, type ChannelResult, type SearchScope } from "./vector-search";
import { graphSearch } from "./graph-search";

export type RetrievalMode = "hybrid" | "graph" | "fast";

export type ChannelLabel = "vector" | "keyword" | "graph";

export interface SearchItem {
  chunkId: string;
  fileId: string;
  fileName: string;
  /** 升父块后的正文(图谱通道为图谱块文本) */
  text: string;
  /** RRF 融合分 */
  score: number;
  source: ChannelLabel | "both";
  /** 重排分(hybrid 模式且重排可用时有值) */
  rerankScore?: number;
}

export interface SearchKnowledgeOptions {
  vectorTopK?: number;
  keywordTopK?: number;
  fusionTopK?: number;
  rerankerTopK?: number;
  finalTopK?: number;
  graphTopK?: number;
  useGraph?: boolean;
}

interface RrfFusedEntry {
  chunkId: string;
  fileId: string;
  fileName: string;
  text: string;
  score: number;
  sources: Set<ChannelLabel>;
}

/**
 * RRF(Reciprocal Rank Fusion):每文档得分 = Σ 1/(k + rank)。
 * 融合键为 chunk_id —— 多通道(或多子查询)命中同一块时排名分累加。
 */
function reciprocalRankFusion(
  resultLists: Array<{ results: ChannelResult[]; label: ChannelLabel }>,
  k: number,
): Map<string, RrfFusedEntry> {
  const scores = new Map<string, RrfFusedEntry>();

  for (const { results, label } of resultLists) {
    results.forEach((r, rank) => {
      const existing =
        scores.get(r.chunkId) ??
        ({
          chunkId: r.chunkId,
          fileId: r.fileId,
          fileName: r.fileName,
          text: r.text,
          score: 0,
          sources: new Set<ChannelLabel>(),
        } satisfies RrfFusedEntry);
      existing.score += 1 / (k + rank + 1);
      existing.sources.add(label);
      scores.set(r.chunkId, existing);
    });
  }

  return scores;
}

/** 融合 → 可选重排 → 低分截断 → 子块升父块。 */
async function fuseAndFinalize(
  query: string,
  resultLists: Array<{ results: ChannelResult[]; label: ChannelLabel }>,
  finalTopK: number,
  options: { useReranker: boolean; fusionTopK?: number; rerankerTopK?: number },
): Promise<SearchItem[]> {
  const { useReranker, fusionTopK = DEFAULT_FUSION_TOP_K, rerankerTopK = DEFAULT_RERANKER_TOP_K } = options;

  const fusedResults: SearchItem[] = [...reciprocalRankFusion(resultLists, RRF_K).values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, useReranker ? fusionTopK : finalTopK)
    .map((entry) => ({
      chunkId: entry.chunkId,
      fileId: entry.fileId,
      fileName: entry.fileName,
      text: entry.text,
      score: entry.score,
      source: entry.sources.size > 1 ? "both" : ([...entry.sources][0] as ChannelLabel),
    }));

  let finalResults: SearchItem[];
  if (useReranker && fusedResults.length > 0) {
    const rerankResults = await rerank(query, fusedResults.map((r) => r.text), rerankerTopK);
    const reranked = rerankResults.map((rr) => ({
      ...fusedResults[rr.index],
      rerankScore: rr.relevanceScore,
    }));

    // 明显无关的结果不进 LLM 上下文(护忠实度),但保底保留护召回
    finalResults =
      MIN_RERANK_SCORE > 0
        ? reranked.filter((r, i) => i < MIN_RERANK_KEEP || (r.rerankScore ?? 0) >= MIN_RERANK_SCORE)
        : reranked;
  } else {
    finalResults = fusedResults.slice(0, finalTopK);
  }

  return resolveParentChunks(finalResults);
}

/**
 * 子块升父块:多个子块命中同一父块时只保留得分最高者,正文换为父块文本,
 * chunk_id 同步换成父块 id(引用 UI 指向展示的正文)。非子块(父块/图谱块)直通。
 */
async function resolveParentChunks(results: SearchItem[]): Promise<SearchItem[]> {
  if (results.length === 0) return results;

  const chunkIds = results.map((r) => r.chunkId);
  const childRows = await queryRows<{ id: string; parent_chunk_id: string }>(sql`
    SELECT id, parent_chunk_id
    FROM document_chunks
    WHERE id = ANY(${uuidArrayParam(chunkIds)}) AND parent_chunk_id IS NOT NULL`);
  if (childRows.length === 0) return results;

  const childToParent = new Map(childRows.map((row) => [row.id, row.parent_chunk_id]));
  const parentIds = [...new Set(childToParent.values())];
  const parentRows = await queryRows<{ id: string; chunk_text: string }>(sql`
    SELECT id, chunk_text FROM document_chunks WHERE id = ANY(${uuidArrayParam(parentIds)})`);
  const parentTextMap = new Map(parentRows.map((row) => [row.id, row.chunk_text]));

  const deduped = new Map<string, SearchItem>();
  const nonChildResults: SearchItem[] = [];

  for (const result of results) {
    const parentId = childToParent.get(result.chunkId);
    if (parentId !== undefined && parentTextMap.has(parentId)) {
      const existing = deduped.get(parentId);
      if (existing === undefined || (result.rerankScore ?? result.score) > (existing.rerankScore ?? existing.score)) {
        deduped.set(parentId, { ...result, chunkId: parentId, text: parentTextMap.get(parentId) ?? result.text });
      }
    } else {
      nonChildResults.push(result);
    }
  }

  return [...deduped.values(), ...nonChildResults].sort(
    (a, b) => (b.rerankScore ?? b.score) - (a.rerankScore ?? a.score),
  );
}

/**
 * 检索统一入口。
 *
 * @param scope kbId 缺省 = 用户全部知识库
 * @param mode  hybrid(默认)| graph | fast
 */
export async function searchKnowledge(
  query: string,
  scope: SearchScope,
  mode: RetrievalMode = "hybrid",
  options: SearchKnowledgeOptions = {},
): Promise<SearchItem[]> {
  const {
    vectorTopK = DEFAULT_VECTOR_TOP_K,
    keywordTopK = DEFAULT_KEYWORD_TOP_K,
    finalTopK = DEFAULT_FINAL_TOP_K,
    graphTopK = DEFAULT_GRAPH_CHANNEL_TOP_K,
    useGraph,
  } = options;

  if (mode === "graph") {
    const results = await graphSearch(query, scope, finalTopK);
    return results.map((r) => ({
      chunkId: r.chunkId,
      fileId: r.fileId,
      fileName: r.fileName,
      text: r.text,
      score: r.score,
      source: "graph" as const,
    }));
  }

  const useReranker = mode === "hybrid";
  const graphEnabled = useGraph ?? mode === "hybrid";

  // 三通道并行;图谱通道独立失败不拖垮整条链路(fast 模式直接跳过)
  const [vectorResults, keywordResults, graphResults] = await Promise.all([
    vectorSearch(query, scope, vectorTopK),
    keywordSearch(query, scope, keywordTopK),
    graphEnabled
      ? graphSearch(query, scope, graphTopK).catch((error) => {
          console.error("[knowledge] 图谱通道失败,继续无图谱检索:", error instanceof Error ? error.message : error);
          return [] as ChannelResult[];
        })
      : Promise.resolve([] as ChannelResult[]),
  ]);

  const resultLists: Array<{ results: ChannelResult[]; label: ChannelLabel }> = [
    { results: vectorResults, label: "vector" },
    { results: keywordResults, label: "keyword" },
  ];
  if (graphResults.length > 0) {
    resultLists.push({ results: graphResults, label: "graph" });
  }

  return fuseAndFinalize(query, resultLists, finalTopK, {
    useReranker,
    fusionTopK: options.fusionTopK,
    rerankerTopK: options.rerankerTopK,
  });
}
