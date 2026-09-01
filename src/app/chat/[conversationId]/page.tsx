/**
 * 对话页(服务端壳,2026-08-31 起为唯一对话 UI):读通道预设、组装记忆上下文、
 * 回显本会话的历史转写,一并注入 MimicChatPanel('use client')——
 * 实时会话与麦克风等浏览器能力全部位于客户端(编码约定)。
 * 密钥只用于信令路由,不经本页下发。
 *
 * 用户体系 step1(T4):需登录;人格/音色真源是服务端 companion(孵化定格),
 * 作为 props 下发 —— 不再依赖客户端 localStorage。
 */

import { redirect } from "next/navigation";
import { MimicChatPanel } from "@/components/mimic/mimic-chat-panel";
import { requirePageUserId } from "@/lib/auth/session";
import { getCompanion } from "@/lib/companion/repository";
import { isDatabaseConfigured } from "@/lib/db/client";
import { loadTranscript } from "@/lib/memory/conversations";
import { buildMemoryContext } from "@/lib/memory/context-builder";
import { listPersonas } from "@/lib/persona/repository";
import { resolveRealtimeSessionDefaults } from "@/lib/realtime/provider";
import type { SeedTranscriptEntry } from "@/lib/realtime/use-realtime-session";

// 每次进入都要重新读最近历史与语义记忆,不能被静态化或缓存
export const dynamic = "force-dynamic";

/** 字幕区最多回显的历史条数;再多既无必要,也会拖慢首屏与 hydration。 */
const MAX_ECHOED_MESSAGES = 200;

export default async function ChatPage({
  params,
}: PageProps<"/chat/[conversationId]">) {
  const userId = await requirePageUserId();
  const { conversationId } = await params;
  const persistence = isDatabaseConfigured();

  // 人格/音色来自孵化定格的 companion;没有精灵说明还没孵化,回孵化页
  const companion = await getCompanion(userId);
  if (companion === null) redirect("/hatch");

  // 进入已有会话时回显历史转写。role 在库里是 text 列,逐条收窄后再传给客户端
  // (不做类型断言);system 角色的注入消息不参与回显。
  // 一并带出 message id 与已收到的反馈,这样历史消息也能打 👍/👎(step2 T4)。
  // 他人的会话 id 与不存在的 id 同样返回空(归属过滤在 loadTranscript 内)。
  const initialMessages: SeedTranscriptEntry[] = persistence
    ? (await loadTranscript(userId, conversationId, MAX_ECHOED_MESSAGES)).flatMap((message) =>
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
      // key 强制在新会话 id 下重挂载,清掉上一场会话的字幕区与落库游标
      key={conversationId}
      conversationId={conversationId}
      sessionDefaults={resolveRealtimeSessionDefaults()}
      memoryContext={persistence ? await buildMemoryContext(userId) : ""}
      persistence={persistence}
      initialMessages={initialMessages}
      // 人格库一次性下发:客户端要用它把 personaId 渲染成 instructions
      // (instructions 在客户端随 session.update 下发,服务端无法代劳)
      personas={await listPersonas(userId)}
      companionPersona={{ personaId: companion.personaId, voice: companion.voice }}
    />
  );
}
