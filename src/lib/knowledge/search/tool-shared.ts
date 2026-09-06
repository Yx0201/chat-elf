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
  "刚才已经检索到并回答过的内容不必重复检索。" +
  "query 只传核心检索词(人名/物品/事件 + 关键词),不要把解释性文字(如某字的写法说明)放进 query。" +
  "语音转写常有同音字误差:首次检索无果或明显答非所问时,结合上下文换同音/近义写法再检索一次。";

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

// ── web_search(step3 网络搜索)─────────────────────────────────────────
// 三分路由的另一半:search_knowledge 管"用户的私域资料",本工具管"时效性
// 与公域信息"。边界措辞与 search_knowledge 的 description 互补,双线同源。

export const WEB_SEARCH_TOOL_NAME = "web_search";

export const WEB_SEARCH_DESCRIPTION =
  "联网搜索最新或公共信息。当用户问时效性内容(今天/最近/最新/现在,如天气、新闻、价格、" +
  "版本发布)或对话上下文与用户资料都没有的公域知识(公众人物、地理常识、技术文档)时调用。" +
  "用户明确要求\u201c搜索/查一下/联网\u201d时**必须**调用本工具,即使你自认知道答案" +
  "(你的知识可能过时);重大事件、灾害、伤亡统计等事实类问题也必须先搜索核实再回答。" +
  "复杂事件可拆成多个角度(时间线/伤亡/救援/影响)分别搜索后综合。" +
  "用户自己上传资料里的内容不要用本工具,应使用 search_knowledge;闲聊陪伴不要调用;" +
  "刚才已经搜过且上下文已有的信息不重复搜。";

/** realtime session.update 注册用(与 SEARCH_KNOWLEDGE_REALTIME_TOOL 同形状)。 */
export const WEB_SEARCH_REALTIME_TOOL: {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
  };
} = {
  type: "function",
  function: {
    name: WEB_SEARCH_TOOL_NAME,
    description: WEB_SEARCH_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索词,自然语句描述要查的内容" },
      },
      required: ["query"],
    },
  },
};

export function parseWebSearchArguments(raw: string | undefined): { query: string } | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const query =
    typeof (parsed as Record<string, unknown>).query === "string"
      ? ((parsed as Record<string, unknown>).query as string).trim().slice(0, 200)
      : "";
  return query === "" ? null : { query };
}

/** 语音字幕条目上展示的联网来源(webSearchAction → hook → 面板)。 */
export interface TranscriptWebSource {
  title: string;
  siteName: string;
  url: string;
}
