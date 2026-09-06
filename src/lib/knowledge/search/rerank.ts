/**
 * 重排客户端(DashScope 原生 rerank 端点)—— 替代 codeweaver 的 Jina。
 *
 * 端点:POST https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank
 * (非 OpenAI 兼容,嵌套 input/parameters;响应 output.results[].{index, relevance_score})
 * 模型默认 qwen3.7-text-rerank(2026-09-06 实测可用;gte-rerank-v2 已于 2026-05-30 下线)。
 *
 * 降级语义:任何失败(网络/非 2xx)回落原序 —— 重排是精度增强,不是硬依赖。
 */

import { resolveDashScopeConfig } from "@/lib/dashscope/config";

const RERANK_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank";

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

export async function rerank(query: string, documents: string[], topK: number): Promise<RerankResult[]> {
  if (documents.length === 0) return [];

  try {
    const { apiKey } = resolveDashScopeConfig();
    const model = process.env.DASHSCOPE_RERANK_MODEL?.trim() || "qwen3.7-text-rerank";

    const res = await fetch(RERANK_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: { query, documents },
        parameters: { top_n: topK, return_documents: false },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.error(`[knowledge] 重排返回 ${res.status},回落融合原序`);
      return fallbackResults(documents, topK);
    }

    const data = (await res.json()) as {
      output?: { results?: Array<{ index: number; relevance_score?: number }> };
    };
    const results = data.output?.results ?? [];
    if (results.length === 0) {
      console.error("[knowledge] 重排响应无 results,回落融合原序");
      return fallbackResults(documents, topK);
    }

    return results
      .map((r) => ({ index: r.index, relevanceScore: r.relevance_score ?? 0 }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, topK);
  } catch (error) {
    console.error("[knowledge] 重排调用失败,回落融合原序:", error instanceof Error ? error.message : error);
    return fallbackResults(documents, topK);
  }
}

/** 降级:保持融合序(线性衰减分),检索永不因重排故障而断。 */
function fallbackResults(documents: string[], topK: number): RerankResult[] {
  return documents.slice(0, topK).map((_, i) => ({
    index: i,
    relevanceScore: 1 - i / documents.length,
  }));
}
