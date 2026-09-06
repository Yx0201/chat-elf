/**
 * 知识库文本问答流式路由(step2 T6,Route Handler 例外第 7 个:流式响应)。
 *
 * agent 检索模式:streamText + search_knowledge / web_search 双工具 +
 * isStepCount(6) 护栏,模型自主决定查什么/查几次(三分路由:资料→知识库、
 * 时效公域→联网、其余直接答);跨调用维护全局 [N] 引用编号(codeweaver 经验),
 * 引用列表经 messageMetadata(finish 时闭包内已完整)下发客户端,并持久化到
 * kb_messages.metadata(刷新还原)。
 *
 * ai v7 适配:instructions(非 system)、onEnd(非 onFinish)、
 * toUIMessageStream({ stream }) 新助手(旧 result.toUIMessageStream 已弃用)。
 */

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { getSessionUserId } from "@/lib/auth/session";
import { getDashScopeProvider, isAiConfigured, TEXT_MODEL, textModelProviderOptions } from "@/lib/ai/provider";
import { webSearch, type WebSearchResult } from "@/lib/ai/web-search";
import { currentDateLabel } from "@/lib/time-label";
import { getKnowledgeBase, isValidKbId } from "@/lib/knowledge/repository";
import { defineSearchKnowledgeTool } from "@/lib/knowledge/search/tool";
import { WEB_SEARCH_DESCRIPTION } from "@/lib/knowledge/search/tool-shared";
import { buildSearchContext, TEXT_CHAT_BUDGET } from "@/lib/knowledge/search/context-builder";
import { searchKnowledge } from "@/lib/knowledge/search/search-service";
import {
  appendKbMessage,
  createKbConversation,
  getKbConversation,
  isValidKbConversationId,
  loadKbMessages,
  type CitationMeta,
} from "@/lib/knowledge/chat/repository";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 引用列表与会话 id 挂在消息 metadata 上(客户端从 message.metadata 读)。 */
export type KbChatUIMessage = UIMessage<{ references?: CitationMeta[]; conversationId?: string }>;

interface RequestBody {
  kbId?: string;
  conversationId?: string;
  mode?: string;
  /** useChat 默认 transport 上传完整 messages;服务端只信库里的历史,从这里仅取最后一条用户消息 */
  messages?: UIMessage[];
}

function textOfLastUserMessage(messages: UIMessage[] | undefined): string {
  if (!messages) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (userId === null) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }
  if (!isAiConfigured()) {
    return Response.json({ error: "未配置 DASHSCOPE_API_KEY" }, { status: 503 });
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return Response.json({ error: "请求体非法" }, { status: 400 });
  }

  const userText = textOfLastUserMessage(body.messages).slice(0, 4000);
  if (userText === "") {
    return Response.json({ error: "没有可回答的内容" }, { status: 400 });
  }
  const mode = body.mode === "fast" || body.mode === "graph" ? body.mode : "hybrid";

  // 会话:带 id 且归属正确 → 复用;否则懒创建(标题 = 首条消息前 20 字,不做 LLM 标题)
  let conversationId: string;
  if (body.conversationId !== undefined && isValidKbConversationId(body.conversationId)) {
    const existing = await getKbConversation(userId, body.conversationId);
    if (existing === null) {
      return Response.json({ error: "会话不存在" }, { status: 404 });
    }
    conversationId = existing.id;
  } else {
    const created = await createKbConversation({
      userId,
      kbId: body.kbId !== undefined && isValidKbId(body.kbId) ? body.kbId : null,
      title: userText.slice(0, 20),
    });
    conversationId = created.id;
  }
  await appendKbMessage({ conversationId, role: "user", content: userText });

  // KB 范围(库被删的会话仍在,退化为无检索普通问答)
  const kb =
    body.kbId !== undefined && isValidKbId(body.kbId) ? await getKnowledgeBase(userId, body.kbId) : null;
  const kbScope = kb !== null ? { userId, kbId: kb.id } : { userId };

  // 历史只信数据库(排除刚落库的这条用户消息,它单独作为 prompt 末条)
  const history = (await loadKbMessages(userId, conversationId, 61)).slice(0, -1);

  // 全局引用编号:跨工具调用连续(codeweaver agent-tools 经验)
  const references: CitationMeta[] = [];
  const searchTool = defineSearchKnowledgeTool(async (input) => {
    const items = await searchKnowledge(input.query, kbScope, input.mode ?? mode);
    if (items.length === 0) {
      return "知识库中没有检索到相关内容。请如实告知用户资料里似乎没有这部分,基于已有知识回答。";
    }
    const built = buildSearchContext(items, TEXT_CHAT_BUDGET);
    const offset = references.length;
    for (const ref of built.references) {
      references.push({ ...ref, kind: "kb", index: offset + ref.index });
    }
    // 单次检索的局部 [1..n] 重编号为全局连续编号
    const renumbered = built.context.replace(/\[(\d+)\]/g, (_, n: string) => {
      const local = Number(n);
      return local >= 1 && local <= built.references.length ? `[${offset + local}]` : `[${n}]`;
    });
    return `以下是知识库检索结果([N] 对应引用列表编号):\n\n${renumbered}`;
  });

  // 联网搜索工具(step3):执行端为原生 API,来源并入同一全局引用编号
  const webSearchTool = tool({
    description: WEB_SEARCH_DESCRIPTION,
    inputSchema: z.object({ query: z.string().min(1) }),
    execute: async (input) => {
      let result: WebSearchResult;
      try {
        result = await webSearch(input.query.slice(0, 200));
      } catch (error) {
        console.error("[kb-chat] web_search 失败:", error instanceof Error ? error.message : error);
        return "联网搜索暂时不可用,请告知用户稍后再试,或基于已有知识回答。";
      }
      const offset = references.length;
      result.sources.forEach((source, position) => {
        references.push({
          index: offset + position + 1,
          kind: "web",
          fileId: "",
          fileName: source.title,
          chunkId: "",
          siteName: source.siteName,
          url: source.url,
        });
      });
      const sourceLines = result.sources
        .map((source, position) => `[${offset + position + 1}] ${source.title}(${source.siteName})`)
        .join("\n");
      return `以下是联网检索摘要与来源([N] 对应引用列表编号):\n\n${result.answer}\n\n来源:\n${sourceLines}\n\n请只依据以上摘要与来源陈述网络信息,摘要里没有的日期/数字不要自行补充;引用处标 [N]。`;
    },
  });

  const instructions = [
    `[当前时间] ${currentDateLabel(new Date(), "Asia/Shanghai")}(北京时间)。回答涉及日期时间的问题以此为准;用户说的相对时间(今天/明天/最近)先换算成具体日期。`,
    kb !== null
      ? `你是「${kb.name}」知识库的问答助手。用户在这个知识库里上传了资料,回答与资料相关的问题前先调用 search_knowledge 工具检索,再依据检索结果回答;可以按需多次检索(换关键词)。`
      : "你是知识库问答助手,可通过 search_knowledge 工具检索用户的资料后再回答。",
    "你也可以调用 web_search 工具联网检索:用于时效性信息(今天/最新/现在,如天气、新闻、价格)或资料之外的公域知识。用户资料里的问题优先 search_knowledge 而非联网;对话上下文已有的信息不要再检索;两类检索都无结果就如实说明,不要编造。",
    "引用资料内容时在句末标注 [N] 角标(N 对应引用列表编号);检索不到的内容要如实说明资料里没有,不要编造。回答用中文,排版清晰。",
  ].join("\n");

  let finalText = "";
  const stream = createUIMessageStream<KbChatUIMessage>({
    execute: async ({ writer }) => {
      const result = streamText({
        model: getDashScopeProvider().chatModel(TEXT_MODEL),
        instructions,
        messages: [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: "user" as const, content: userText },
        ],
        tools: { searchKnowledge: searchTool, webSearch: webSearchTool },
        stopWhen: isStepCount(6),
        providerOptions: textModelProviderOptions(),
        onError: (error) => {
          console.error("[kb-chat] 流式生成错误:", error instanceof Error ? error.message : error);
        },
      });

      // 终稿文本留给 onEnd 持久化(流结束时已就绪)
      void result.text.then((text) => {
        finalText = text;
      });

      writer.merge(
        toUIMessageStream({
          stream: result.stream,
          // finish 块携带引用列表与会话 id;此刻工具已全部执行,闭包内数据完整
          messageMetadata: () => ({
            conversationId,
            ...(references.length > 0 ? { references: [...references] } : {}),
          }),
        }),
      );
    },
    onEnd: async () => {
      if (finalText.trim() === "") return;
      try {
        await appendKbMessage({
          conversationId,
          role: "assistant",
          content: finalText,
          metadata: { references },
        });
      } catch (error) {
        console.error("[kb-chat] 助手消息持久化失败:", error instanceof Error ? error.message : error);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
