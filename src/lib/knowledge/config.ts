/**
 * 知识库管线集中配置 —— 自 codeweaver config.ts 移植,变量名统一 KB_* 前缀。
 *
 * 单一来源:.env.local → process.env → 本文件 → 全部消费方。
 * 模型与端点不在这里(见 src/lib/ai/provider.ts 与 rerank.ts):
 * 全链路统一 DashScope,复用 DASHSCOPE_API_KEY。
 */

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readFloatEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// ── 并发 ────────────────────────────────────────────────────────────

/** 图谱构建初始并发(AIMD 自适应:限流减半、干净批次 +1)。 */
export const GRAPH_BUILD_CONCURRENCY = readPositiveIntEnv("KB_GRAPH_BUILD_CONCURRENCY", 8);
export const GRAPH_BUILD_MIN_CONCURRENCY = 1;
export const GRAPH_BUILD_MAX_CONCURRENCY = readPositiveIntEnv("KB_GRAPH_BUILD_MAX_CONCURRENCY", 24);

/** 摄取期 embedding 批大小(DashScope 兼容端点单请求文本数上限以实测为准)。 */
export const EMBEDDING_BATCH_SIZE = readPositiveIntEnv("KB_EMBEDDING_BATCH_SIZE", 10);

/**
 * 检索分块阶段单请求处理的父块数。分块必须分批:大文件逐父块两次
 * 往返,远程库(Vercel 函数→Neon 跨区 ~75ms/次)整文件跑必撞 60s
 * 函数时长墙;40 父块/批 ≈ 80 次往返 ≈ 7s,留足余量。
 */
export const SPLIT_BATCH_SIZE = readPositiveIntEnv("KB_SPLIT_BATCH_SIZE", 40);

// ── 检索 Top-K ──────────────────────────────────────────────────────

export const DEFAULT_VECTOR_TOP_K = readPositiveIntEnv("KB_VECTOR_TOP_K", 50);
export const DEFAULT_KEYWORD_TOP_K = readPositiveIntEnv("KB_KEYWORD_TOP_K", 50);
export const DEFAULT_FUSION_TOP_K = readPositiveIntEnv("KB_FUSION_TOP_K", 30);
export const DEFAULT_RERANKER_TOP_K = readPositiveIntEnv("KB_RERANK_TOP_K", 10);
export const DEFAULT_FINAL_TOP_K = readPositiveIntEnv("KB_FINAL_TOP_K", 10);
/** 图谱通道参与 hybrid RRF 融合的块数。 */
export const DEFAULT_GRAPH_CHANNEL_TOP_K = readPositiveIntEnv("KB_GRAPH_CHANNEL_TOP_K", 10);

// ── RRF 平滑常数 ────────────────────────────────────────────────────

export const RRF_K = readPositiveIntEnv("KB_RRF_K", 60);

// ── 相关性阈值 ──────────────────────────────────────────────────────

/**
 * 重排得分低于此值的结果丢弃,但保底保留 MIN_RERANK_KEEP 条(护召回);
 * 设 0 关闭。
 */
export const MIN_RERANK_SCORE = readFloatEnv("KB_MIN_RERANK_SCORE", 0.05);
export const MIN_RERANK_KEEP = readPositiveIntEnv("KB_MIN_RERANK_KEEP", 3);

/**
 * 图谱检索实体链接:查询实体与图谱实体的 name_embedding 余弦相似度下限。
 */
export const GRAPH_ENTITY_MATCH_SIMILARITY = readFloatEnv("KB_GRAPH_ENTITY_MATCH_SIMILARITY", 0.6);

/**
 * 摄取期实体合并:新抽取实体并入既有实体的 name_embedding 余弦下限。
 * 保持高位,避免名字相近的不同角色被误并。
 */
export const ENTITY_MERGE_SIMILARITY = readFloatEnv("KB_ENTITY_MERGE_SIMILARITY", 0.92);
