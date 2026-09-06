/**
 * 检索结果 → LLM 上下文的压缩构建器。
 *
 * 输出 `[N] 《文件名》\n正文` 编号格式(step2 文本问答线的引用角标与
 * realtime 工具的口语转述都消费此格式)。两条线预算不同:
 *  - 文本线:默认每条 1600 字、总量 12000 字(markdown 渲染,可承载);
 *  - 语音线:每条 600 字、总量 3000 字(function_call_output 要为口语化转述
 *    留空间,塞太长 realtime 模型容易逐字照念)。
 */

import type { SearchItem } from "./search-service";

export interface ContextBudget {
  /** 单条正文截断长度(字符) */
  perItemChars: number;
  /** 全部上下文的总量上限(字符) */
  maxTotalChars: number;
}

export const TEXT_CHAT_BUDGET: ContextBudget = { perItemChars: 1600, maxTotalChars: 12_000 };
export const VOICE_BUDGET: ContextBudget = { perItemChars: 600, maxTotalChars: 3_000 };

export interface BuiltContext {
  /** 编号正文,形如 "[1] 《file》\n..." 逐条拼接 */
  context: string;
  /** 与正文编号对应的引用元数据(step2 持久化引用列表用) */
  references: Array<{ index: number; fileId: string; fileName: string; chunkId: string }>;
}

export function buildSearchContext(items: SearchItem[], budget: ContextBudget): BuiltContext {
  const parts: string[] = [];
  const references: BuiltContext["references"] = [];
  let total = 0;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const index = i + 1;
    const body = item.text.slice(0, budget.perItemChars);
    const part = `[${index}] 《${item.fileName}》\n${body}`;

    if (total + part.length > budget.maxTotalChars && parts.length > 0) break;
    parts.push(part);
    references.push({ index, fileId: item.fileId, fileName: item.fileName, chunkId: item.chunkId });
    total += part.length;
  }

  return { context: parts.join("\n\n"), references };
}
