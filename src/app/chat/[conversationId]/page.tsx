/**
 * 对话页:Server Component 读取当前接入通道(tokenplan / dashscope)的
 * 会话参数预设、组装记忆上下文、回显本会话的历史转写,一并注入客户端面板;
 * 实时会话、麦克风等浏览器能力全部位于 ChatPanel('use client')内 —— 编码约定。
 * 密钥只用于信令路由,不经本页下发。
 */

import { ChatPanel } from "@/components/chat/chat-panel";
import { isDatabaseConfigured } from "@/lib/db/client";
import { loadTranscript } from "@/lib/memory/conversations";
import { buildMemoryContext } from "@/lib/memory/context-builder";
import { resolveRealtimeSessionDefaults } from "@/lib/realtime/provider";
import type { SeedTranscriptEntry } from "@/lib/realtime/use-realtime-session";

// 每次进入都要重新读最近历史与语义记忆,不能被静态化或缓存
export const dynamic = "force-dynamic";

/** 字幕区最多回显的历史条数;再多既无必要,也会拖慢首屏与 hydration。 */
const MAX_ECHOED_MESSAGES = 200;

export default async function ChatPage({
  params,
}: PageProps<"/chat/[conversationId]">) {
  const { conversationId } = await params;
  const persistence = isDatabaseConfigured();

  // 进入已有会话时回显历史转写。role 在库里是 text 列,逐条收窄后再传给客户端
  // (不做类型断言);system 角色的注入消息不参与回显。
  const initialMessages: SeedTranscriptEntry[] = persistence
    ? (await loadTranscript(conversationId, MAX_ECHOED_MESSAGES)).flatMap((message) =>
        message.role === "user" || message.role === "assistant"
          ? [{ role: message.role, text: message.content }]
          : [],
      )
    : [];

  return (
    <ChatPanel
      // key 强制在新会话 id 下重挂载:切换人格会 router.push 到另一个 id,
      // 若不重挂载,客户端的字幕区与落库游标会带着上一场会话的状态
      key={conversationId}
      conversationId={conversationId}
      sessionDefaults={resolveRealtimeSessionDefaults()}
      memoryContext={persistence ? await buildMemoryContext() : ""}
      persistence={persistence}
      initialMessages={initialMessages}
    />
  );
}
