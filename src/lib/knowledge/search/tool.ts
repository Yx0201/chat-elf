/**
 * search_knowledge 的 ai v7 工具定义(文本问答线专用,服务端)。
 * 共享的名字/description/触发边界见 tool-shared.ts(双端安全)。
 * execute 由调用方闭包注入 —— 它要维护跨调用的全局引用编号与用户鉴权,
 * 不适合在这里写死。
 */

import { tool } from "ai";
import { z } from "zod";
import { SEARCH_KNOWLEDGE_DESCRIPTION, type SearchKnowledgeMode } from "./tool-shared";

const SearchKnowledgeInputSchema = z.object({
  /** 检索词:自然语句或关键词均可 */
  query: z.string().min(1),
  /** 限定某个知识库;不传 = 用户全部知识库 */
  kbId: z.string().uuid().optional(),
  mode: z.enum(["hybrid", "fast", "graph"]).optional(),
});

export type SearchKnowledgeToolInput = z.infer<typeof SearchKnowledgeInputSchema>;
export type { SearchKnowledgeMode };

export function defineSearchKnowledgeTool(
  execute: (input: SearchKnowledgeToolInput) => Promise<string>,
) {
  return tool({
    description: SEARCH_KNOWLEDGE_DESCRIPTION,
    inputSchema: SearchKnowledgeInputSchema,
    execute,
  });
}
