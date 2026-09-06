"use client";

/**
 * 知识库文本问答面板(step2 T7):useChat + streamdown 流式渲染 + [N] 引用角标。
 *
 * - agent 检索:模型自主调用 search_knowledge(服务端 /api/kb-chat);
 * - 引用:assistant 文本中的 [N] 预处理为可点角标(跳到本条消息底部的引用列表),
 *   列表来自 message.metadata.references(流式 finish 时下发,刷新后从库里还原);
 * - 会话:首条消息懒创建,metadata.conversationId 回写指针并同步 URL ?c=;
 * - H5:输入区吸底(键盘弹出不遮挡)、发送键 ≥44px、消息区自动滚底。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import { Streamdown } from "streamdown";
import type { KbChatUIMessage } from "@/app/api/kb-chat/route";
import type { CitationMeta } from "@/lib/knowledge/chat/repository";

export interface KbChatSeedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  references: CitationMeta[];
}

export interface KbChatSeed {
  conversationId: string;
  messages: KbChatSeedMessage[];
}

const STREAMDOWN_PLUGINS = { cjk, code } as const;

function seedToUIMessages(
  seed: KbChatSeedMessage[],
): UIMessage<{ references?: CitationMeta[]; conversationId?: string }>[] {
  return seed.map((m) => ({
    id: m.id,
    role: m.role,
    parts: [{ type: "text" as const, text: m.content }],
    metadata: m.role === "assistant" && m.references.length > 0 ? { references: m.references } : undefined,
  }));
}

/** [N] → 可点的 markdown 链接(跳到本条消息底部引用列表的锚点)。 */
function withCitationLinks(text: string, msgKey: string): string {
  return text.replace(/\[(\d+)\]/g, (_, n: string) => `[[${n}]](#cite-${msgKey}-${n})`);
}

export function KbChatPanel({
  kbId,
  kbName,
  initialConversationId,
  initialMessages,
  conversations,
}: {
  kbId: string;
  kbName: string;
  initialConversationId: string | null;
  initialMessages: KbChatSeedMessage[];
  conversations: ReadonlyArray<{ id: string; title: string }>;
}) {
  const router = useRouter();
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [mode, setMode] = useState<"hybrid" | "fast" | "graph">("hybrid");
  const [convs, setConvs] = useState(conversations);
  const conversationIdRef = useRef(conversationId);
  // React Compiler:渲染期禁写 ref,统一在提交后同步(onFinish 回调内可直写)
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const { messages, sendMessage, status, error, setMessages } = useChat<KbChatUIMessage>({
    transport: new DefaultChatTransport<KbChatUIMessage>({ api: "/api/kb-chat" }),
    messages: seedToUIMessages([...initialMessages]),
    onFinish: ({ message }) => {
      // 懒创建的会话 id 回写指针 + URL;新会话进入切换列表
      const id = message.metadata?.conversationId;
      if (id !== undefined && conversationIdRef.current === null) {
        conversationIdRef.current = id;
        setConversationId(id);
        const firstUser = messages.find((m) => m.role === "user");
        const title =
          firstUser?.parts.map((p) => (p.type === "text" ? p.text : "")).join("").slice(0, 20) ?? "新问答";
        setConvs((prev) => (prev.some((c) => c.id === id) ? prev : [{ id, title }, ...prev]));
        router.replace(`/knowledge/${kbId}/chat?c=${id}`);
      }
    },
  });

  const busy = status === "submitted" || status === "streaming";

  const send = useCallback(
    (text: string) => {
      if (text.trim() === "" || busy) return;
      void sendMessage({ text }, { body: { kbId, conversationId: conversationIdRef.current, mode } });
    },
    [busy, kbId, mode, sendMessage],
  );

  /** 切会话:整页刷新到目标会话(seed 从服务端重灌,简单可靠)。 */
  function switchConversation(id: string | null) {
    if (id === null) {
      setMessages([]);
      setConversationId(null);
      conversationIdRef.current = null;
      router.replace(`/knowledge/${kbId}/chat`);
      return;
    }
    router.push(`/knowledge/${kbId}/chat?c=${id}`);
  }

  // 自动滚底
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 会话工具行:新对话 + 会话切换 + 检索模式 */}
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <button
          type="button"
          onClick={() => switchConversation(null)}
          disabled={busy}
          className="flex h-9 items-center rounded-lg bg-[#5645D4] px-3 text-xs font-medium text-white transition-colors hover:bg-[#4536A8] disabled:opacity-50"
        >
          新对话
        </button>
        {convs.length > 0 ? (
          <select
            value={conversationId ?? ""}
            onChange={(e) => switchConversation(e.target.value === "" ? null : e.target.value)}
            disabled={busy}
            className="h-9 min-w-0 max-w-[45%] flex-1 rounded-lg border border-[#E5E3DF] bg-white px-2 text-xs text-[#37352E] outline-none focus:border-[#5645D4] disabled:opacity-50"
            aria-label="切换会话"
          >
            {conversationId === null ? <option value="">(新对话)</option> : null}
            {convs.map((conv) => (
              <option key={conv.id} value={conv.id}>
                {conv.title === "" ? "未命名问答" : conv.title}
              </option>
            ))}
          </select>
        ) : null}
        <div className="flex gap-1 rounded-lg bg-[#EDECE9] p-0.5">
          {(["hybrid", "fast", "graph"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`h-8 rounded-md px-2.5 text-xs font-medium transition-colors ${
                mode === m ? "bg-white text-[#1A1A1A] shadow-sm" : "text-[#787671]"
              }`}
            >
              {m === "hybrid" ? "混合" : m === "fast" ? "快速" : "图谱"}
            </button>
          ))}
        </div>
      </div>

      {/* 消息区 */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {messages.length === 0 ? (
          <div className="mt-10 rounded-xl border border-dashed border-[#E5E3DF] bg-white px-6 py-10 text-center">
            <p className="text-sm text-[#5D5B54]">问点「{kbName}」里有的</p>
            <p className="mt-1 text-xs text-[#A4A097]">AI 会按需检索知识库或联网,引用处带 [N] 角标可溯源</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3 pb-24">
            {messages.map((message, i) => (
              <MessageBubble key={message.id} message={message} msgKey={i === 0 ? "m0" : message.id} busy={busy && i === messages.length - 1} />
            ))}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区:吸底(消息区滚到底时贴住键盘上方,H5 关键) */}
      <div className="sticky bottom-0 -mx-5 border-t border-[#E5E3DF] bg-[#F6F5F4]/95 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        {error != null ? <p className="pb-2 text-xs text-[#C0392B]">{error.message || "出错了,稍后再试"}</p> : null}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem("q") as HTMLInputElement | null;
            if (input === null) return;
            send(input.value);
            input.value = "";
          }}
        >
          <input
            name="q"
            placeholder={busy ? "回答生成中…" : `问问「${kbName}」里的内容…`}
            disabled={busy}
            autoComplete="off"
            className="h-11 min-w-0 flex-1 rounded-lg border border-[#E5E3DF] bg-white px-3 text-sm text-[#1A1A1A] outline-none focus:border-[#5645D4] disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[#5645D4] text-white transition-colors hover:bg-[#4536A8] disabled:opacity-50"
            aria-label="发送"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  msgKey,
  busy,
}: {
  message: KbChatUIMessage;
  msgKey: string;
  busy: boolean;
}) {
  const text = useMemo(
    () => message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
    [message.parts],
  );
  const references = message.metadata?.references ?? [];

  if (message.role === "user") {
    return (
      <li className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#5645D4] px-3.5 py-2.5 text-sm leading-6 text-white">
          {text}
        </div>
      </li>
    );
  }

  return (
    <li className="flex flex-col items-start gap-2">
      <div className="w-full max-w-full rounded-2xl rounded-bl-sm bg-white p-3.5 shadow-sm">
        {text === "" && busy ? (
          <p className="text-sm text-[#A4A097]">正在检索知识库…</p>
        ) : (
          <div className="kb-prose text-sm leading-6 text-[#37352E]">
            <Streamdown plugins={STREAMDOWN_PLUGINS}>{withCitationLinks(text, msgKey)}</Streamdown>
          </div>
        )}

        {references.length > 0 ? (
          <div className="mt-3 border-t border-[#F0EEEB] pt-2">
            <p className="pb-1 text-[11px] font-medium text-[#A4A097]">引用来源</p>
            <ol className="flex flex-col gap-0.5">
              {references.map((ref) => (
                <li key={ref.index} id={`cite-${msgKey}-${ref.index}`} className="text-[11px] leading-5 text-[#787671]">
                  {ref.kind === "web" ? (
                    <>
                      [{ref.index}] 🌐{" "}
                      <a
                        href={ref.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="underline decoration-[#C9C6BF] underline-offset-2 hover:text-[#5645D4]"
                      >
                        {ref.siteName !== undefined && ref.siteName !== "" ? `${ref.siteName} · ` : ""}
                        {ref.fileName}
                      </a>
                    </>
                  ) : (
                    <>[{ref.index}] 📚 《{ref.fileName}》</>
                  )}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </li>
  );
}
