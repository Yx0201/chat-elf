/**
 * search_knowledge 工具的共享定义(客户端/服务端双端安全:无 ai、无 zod、
 * 无服务端模块依赖)。realtime hook(客户端)与 kb-chat 路由(服务端)
 * 都从这里取名字、description 与参数解析,保证两条线触发边界一致。
 *
 * 2026-09-06 T1 实测结论(WS 文本会话,qwen3.5-omni-flash-realtime):
 *  - 知识型问题正确触发,query 抽取为中文短句(可直接进检索管线);
 *  - 闲聊/问候不触发;信息已在对话上下文时会直接复用不再查;
 *  - function_call 后模型静默等待 function_call_output,回传后综合回答
 *    准确、口语化、会口头提及来源文件。
 */

export const SEARCH_KNOWLEDGE_TOOL_NAME = "search_knowledge";

export const SEARCH_KNOWLEDGE_DESCRIPTION =
  "检索用户的知识库资料。当用户的问题涉及知识库涵盖的主题(小说情节、文档内容、资料细节、" +
  "用户上传资料里的任何信息)时调用;日常闲聊、问候、情感陪伴、知识库范围外的问题不要调用。" +
  "刚才已经检索到并回答过的内容不必重复检索。";

export type SearchKnowledgeMode = "hybrid" | "fast" | "graph";

export interface SearchKnowledgeArgs {
  query: string;
  mode?: SearchKnowledgeMode;
}

/** realtime session.update 注册用(嵌套式 FunctionTool 形状,qwen omni 实测接受)。 */
export const SEARCH_KNOWLEDGE_REALTIME_TOOL: {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
  };
} = {
  type: "function",
  function: {
    name: SEARCH_KNOWLEDGE_TOOL_NAME,
    description: SEARCH_KNOWLEDGE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词,自然语句描述要查的内容" },
        mode: { type: "string", enum: ["hybrid", "fast", "graph"], description: "默认 hybrid" },
      },
      required: ["query"],
    },
  },
};

/**
 * 解析模型给出的工具入参(客户端用,零依赖收窄):
 * arguments 是 JSON 字符串,模型可能缺字段/类型不对,逐项收窄后才可用。
 */
export function parseSearchKnowledgeArguments(raw: string | undefined): SearchKnowledgeArgs | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const query = typeof record.query === "string" ? record.query.trim().slice(0, 200) : "";
  if (query === "") return null;

  const mode =
    record.mode === "fast" || record.mode === "graph" || record.mode === "hybrid"
      ? record.mode
      : undefined;

  return { query, mode };
}
