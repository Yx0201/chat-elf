/**
 * 文本向量化(百炼 text-embedding-v3,经 AI SDK 的 OpenAI 兼容模式)。
 *
 * 设计原则:向量化是**增强能力**,不是关键路径。任何失败都返回 null 并记录日志,
 * 让调用方降级为"无语义检索",绝不能拖垮实时语音链路或转写落库。
 */

import { embed, embedMany } from "ai";
import { EMBEDDING_MODEL, getEmbeddingChannel } from "@/lib/ai/provider";
import { EMBEDDING_DIMENSIONS } from "@/lib/db/schema";

/** 单次输入上限(text-embedding-v3 支持 8192 token,这里按字符保守截断)。 */
const MAX_INPUT_CHARS = 6000;

/** 生成向量;失败或维度不符返回 null。 */
export async function embedText(text: string): Promise<number[] | null> {
  const value = text.trim().slice(0, MAX_INPUT_CHARS);
  if (value === "") return null;

  // dimensions 显式下发:本地 qwen3-embedding:4b 原生 2560 维,靠 MRL 截断到
  // 1024 才与库列兼容;DashScope 侧 1024 本就是默认值,显式传无害
  const { model, providerName } = getEmbeddingChannel();
  try {
    const result = await embed({
      model,
      value,
      providerOptions: { [providerName]: { dimensions: EMBEDDING_DIMENSIONS } },
    });
    const vector = result.embedding;
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      // 维度不匹配说明模型或 dimensions 配置变了,继续写入会污染索引 —— 宁可不用
      console.error(
        `[memory] 向量维度不符:期望 ${EMBEDDING_DIMENSIONS},实际 ${vector.length}(模型 ${EMBEDDING_MODEL})`,
      );
      return null;
    }
    return vector;
  } catch (error) {
    console.error("[memory] 文本向量化失败:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * 批量向量化(知识库摄取管线用)。
 *
 * 与单条版 `embedText` 的语义刻意不同:**失败直接抛错**而非返回 null ——
 * 摄取管线把"某批向量缺失"视为该阶段失败(文件转 failed 可重试),
 * 否则未嵌入的块会让 embed 阶段的剩余计数永远清不了零,轮询死循环。
 *
 * DashScope 兼容端点单请求**硬上限 10 条文本**(2026-09-06 实测 400
 * "batch size ... should not be larger than 10"),这里按 10 内部分批,
 * 调用方无需关心批次大小。
 */
const EMBED_HARD_BATCH = 10;

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const { model, providerName } = getEmbeddingChannel();
  const embeddings: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_HARD_BATCH) {
    const slice = texts.slice(start, start + EMBED_HARD_BATCH).map((t) => t.trim().slice(0, MAX_INPUT_CHARS));
    const result = await embedMany({
      model,
      values: slice,
      providerOptions: { [providerName]: { dimensions: EMBEDDING_DIMENSIONS } },
    });
    if (result.embeddings.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      // 维度不匹配说明模型或 dimensions 配置变了,继续写入会污染索引
      throw new Error(
        `[knowledge] 向量维度不符:期望 ${EMBEDDING_DIMENSIONS}(模型 ${EMBEDDING_MODEL})`,
      );
    }
    embeddings.push(...result.embeddings);
  }
  return embeddings;
}
