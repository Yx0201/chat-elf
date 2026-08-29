/**
 * 文本向量化(百炼 text-embedding-v3,经 AI SDK 的 OpenAI 兼容模式)。
 *
 * 设计原则:向量化是**增强能力**,不是关键路径。任何失败都返回 null 并记录日志,
 * 让调用方降级为"无语义检索",绝不能拖垮实时语音链路或转写落库。
 */

import { embed } from "ai";
import { EMBEDDING_MODEL, getDashScopeProvider } from "@/lib/ai/provider";
import { EMBEDDING_DIMENSIONS } from "@/lib/db/schema";

/** 单次输入上限(text-embedding-v3 支持 8192 token,这里按字符保守截断)。 */
const MAX_INPUT_CHARS = 6000;

/** 生成向量;失败或维度不符返回 null。 */
export async function embedText(text: string): Promise<number[] | null> {
  const value = text.trim().slice(0, MAX_INPUT_CHARS);
  if (value === "") return null;

  try {
    const result = await embed({
      model: getDashScopeProvider().textEmbeddingModel(EMBEDDING_MODEL),
      value,
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
