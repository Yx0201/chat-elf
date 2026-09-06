/**
 * 联网搜索执行端(step3)—— DashScope **原生** API + enable_search。
 *
 * 为什么是原生而非 OpenAI 兼容通道:引用来源(enable_source →
 * output.search_info.search_results)只有原生 API 返回,兼容模式无角标
 * 无来源(2026-09-06 官方文档核实);而来源 URL 是文本线引用体系与语音线
 * 口头溯源的前提。同一 DASHSCOPE_API_KEY,零新依赖(原生 fetch)。
 *
 * 端点与流式(2026-09-06 实测踩坑):
 *  - qwen3.x 全系属多模态模型,原生 Generation 端点报 400 "url error",
 *    必须走 multimodal-generation 端点;
 *  - 多模态模型联网搜索**必须流式**(X-DashScope-SSE: enable +
 *    incremental_output),非流式报 "Non-streaming mode does not support
 *    Web Search";SSE 逐块携带增量 content([{text}])与累积 search_info。
 *
 * 语义:一次调用 = "qwen3.7-flash 联网检索后的事实摘要 + 来源列表"。
 * 它作为编排模型(qwen3.7-flash / omni-realtime)的 web_search 工具结果,
 * 不是给用户的最终回答 —— 摘要按要点组织(≤400 字),关键数据尽量带全。
 */

import { resolveDashScopeConfig } from "@/lib/dashscope/config";
import { currentDateAnchor } from "@/lib/time-label";

/** 原生 API 公开云端点(与兼容模式的 base 不同段:无 /compatible-mode)。 */
const NATIVE_BASE_URL =
  process.env.DASHSCOPE_NATIVE_BASE_URL?.trim() || "https://dashscope.aliyuncs.com";

/** turbo(默认,快)约 0.008 元/次;max 更详尽但慢一倍,留 env 开关。 */
const SEARCH_STRATEGY = process.env.DASHSCOPE_WEB_SEARCH_STRATEGY?.trim() || "turbo";

const TIMEOUT_MS = Number.parseInt(process.env.DASHSCOPE_WEB_SEARCH_TIMEOUT_MS ?? "", 10) || 15_000;

export interface WebSearchSource {
  /** 全局引用编号由调用方重排,这里只保留原序号 */
  index: number;
  title: string;
  url: string;
  siteName: string;
}

export interface WebSearchResult {
  /** 联网检索后的事实摘要(≤200 字,已含在检索结果里) */
  answer: string;
  sources: WebSearchSource[];
  /** 计费次数(usage.plugins.search.count,核对账单用) */
  searchCount: number;
}

interface SseChunk {
  output?: {
    choices?: Array<{ message?: { content?: Array<{ text?: string }> } }>;
    search_info?: {
      search_results?: Array<{
        index?: number;
        title?: string;
        url?: string;
        site_name?: string;
      }>;
    };
  };
  usage?: { plugins?: { search?: { count?: number } } };
}

/**
 * 联网检索一次。失败抛错:文本线的 ai 工具 execute 捕获后返回降级文案,
 * 语音线的 action 捕获后返回可朗读降级 —— 两处都不让错误冒泡给模型。
 */
export async function webSearch(query: string): Promise<WebSearchResult> {
  const config = resolveDashScopeConfig();
  const startedAt = Date.now();
  // 日期锚定(2026-09-06 实锤:不带当前日期,摘要模型自己都说"无法确定'明天'的
  // 定义",多个日期的旧预报混着报)。服务端固定北京时间,防函数区域时差。
  const dateAnchor = currentDateAnchor(new Date(), "Asia/Shanghai");

  const response = await fetch(
    `${NATIVE_BASE_URL}/api/v1/services/aigc/multimodal-generation/generation`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-SSE": "enable",
      },
      body: JSON.stringify({
        model: "qwen3.7-flash",
        input: {
          messages: [
            {
              role: "user",
              content: [
                {
                  text:
                    `${dateAnchor}。请联网检索并回答(400字以内,分要点,只陈述检索到的当前事实,查不到就明说):\n` +
                    `${query}\n` +
                    `注意:优先给出具体数据(时间/地点/人物/数字/进展);问题中的相对时间(今天/明天/最近)` +
                    `一律以今天为基准换算成具体日期再核对;检索结果里出现的其他日期的旧数据不要采信;` +
                    `多个来源数据冲突时以更权威/更新的为准并注明。`,
                },
              ],
            },
          ],
        },
        parameters: {
          enable_search: true,
          search_options: {
            search_strategy: SEARCH_STRATEGY === "max" ? "max" : "turbo",
            enable_source: true,
          },
          // qwen3 系默认开思考;搜索摘要要快,关掉(与 textModelProviderOptions 同理)
          enable_thinking: false,
          incremental_output: true,
          result_format: "message",
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => "");
    throw new Error(`联网搜索请求失败 HTTP ${response.status}:${detail.slice(0, 200)}`);
  }

  let answer = "";
  let searchCount = 1;
  const sourcesByUrl = new Map<string, WebSearchSource>();
  let nextIndex = 1;

  // SSE 增量解析:content 逐块拼接;search_info 随块累积到达(后到覆盖,URL 去重)
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineAt: number;
    while ((newlineAt = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineAt).trim();
      buffer = buffer.slice(newlineAt + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;

      let chunk: SseChunk;
      try {
        chunk = JSON.parse(payload) as SseChunk;
      } catch {
        continue;
      }

      for (const choice of chunk.output?.choices ?? []) {
        for (const part of choice.message?.content ?? []) {
          if (typeof part.text === "string") answer += part.text;
        }
      }
      const count = chunk.usage?.plugins?.search?.count;
      if (typeof count === "number") searchCount = count;
      for (const item of chunk.output?.search_info?.search_results ?? []) {
        if (typeof item.title !== "string" || typeof item.url !== "string") continue;
        if (!item.url.startsWith("http") || sourcesByUrl.has(item.url)) continue;
        sourcesByUrl.set(item.url, {
          index: typeof item.index === "number" ? item.index : nextIndex,
          title: item.title,
          url: item.url,
          siteName: item.site_name ?? new URL(item.url).hostname,
        });
        nextIndex += 1;
      }
    }
  }

  answer = answer.trim();
  const sources = [...sourcesByUrl.values()];
  if (answer === "" && sources.length === 0) {
    throw new Error("联网搜索返回空结果");
  }

  console.log(
    `[knowledge] 联网搜索完成 query="${query.slice(0, 40)}" 来源=${sources.length} 计费次数=${searchCount} 耗时=${Date.now() - startedAt}ms`,
  );

  return { answer, sources, searchCount };
}
