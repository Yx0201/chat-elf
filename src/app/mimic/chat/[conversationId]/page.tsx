/**
 * 拟态球对话页(服务端壳):读通道预设、组装记忆上下文、回显历史转写,
 * 全部注入 MimicChatPanel('use client')——实时会话与麦克风在客户端。
 * 与 /chat/[conversationId] 同构,差别只在 UI 层(拟态球 + Ardot 设计稿布局)。
 */

import { MimicChatPanel } from "@/components/mimic/mimic-chat-panel";
import { isDatabaseConfigured } from "@/lib/db/client";
import { loadTranscript } from "@/lib/memory/conversations";
import { buildMemoryContext } from "@/lib/memory/context-builder";
import { listPersonas } from "@/lib/persona/repository";
import { resolveRealtimeSessionDefaults } from "@/lib/realtime/provider";
import type { SeedTranscriptEntry } from "@/lib/realtime/use-realtime-session";

// 每次进入都要重新读最近历史与语义记忆,不能被静态化或缓存
export const dynamic = "force-dynamic";

/** 字幕区最多回显的历史条数。 */
const MAX_ECHOED_MESSAGES = 200;

export default async function MimicChatPage({
  params,
}: PageProps<"/mimic/chat/[conversationId]">) {
  const { conversationId } = await params;
  const persistence = isDatabaseConfigured();

  // role 是 text 列,逐条收窄;system 注入消息不回显。
  // 无库时 conversationId 是占位 id("local"),loadTranscript 校验不通过返回 []。
  const initialMessages: SeedTranscriptEntry[] = persistence
    ? (await loadTranscript(conversationId, MAX_ECHOED_MESSAGES)).flatMap((message) =>
        message.role === "user" || message.role === "assistant"
          ? [
              {
                role: message.role,
                text: message.content,
                dbId: message.id,
                feedback: message.feedback,
              },
            ]
          : [],
      )
    : [];

  return (
    <MimicChatPanel
      key={conversationId}
      conversationId={conversationId}
      sessionDefaults={resolveRealtimeSessionDefaults()}
      memoryContext={persistence ? await buildMemoryContext() : ""}
      persistence={persistence}
      initialMessages={initialMessages}
      personas={await listPersonas()}
    />
  );
}
