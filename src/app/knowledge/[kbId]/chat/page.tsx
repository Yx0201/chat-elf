/**
 * 知识库文本问答页 `/knowledge/[kbId]/chat`(step2 T7,入口 A:库内问答)。
 *
 * RSC 壳:取 KB 信息 + 会话列表 + 最近会话历史;流式对话在客户端面板。
 * 查询串 ?c=<conversationId> 指定会话(会话切换/懒创建后由面板回写)。
 */

import { notFound } from "next/navigation";
import { KbChatPanel, type KbChatSeed } from "@/components/knowledge/chat/kb-chat-panel";
import { PersonaPageHeader } from "@/components/persona/persona-page-header";
import { requirePageUserId } from "@/lib/auth/session";
import { getKnowledgeBase, isValidKbId } from "@/lib/knowledge/repository";
import { listKbConversations, loadKbMessages, parseCitationMetadata } from "@/lib/knowledge/chat/repository";

export const dynamic = "force-dynamic";

export default async function KbChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ kbId: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const userId = await requirePageUserId();
  const { kbId } = await params;
  if (!isValidKbId(kbId)) notFound();

  const kb = await getKnowledgeBase(userId, kbId);
  if (kb === null) notFound();

  const { c } = await searchParams;
  const conversations = await listKbConversations(userId, kbId);
  const activeId =
    c !== undefined && conversations.some((conv) => conv.id === c)
      ? c
      : (conversations[0]?.id ?? null);

  // 最近会话的历史(无会话 = 全新开始,首条消息触发懒创建)
  let seed: KbChatSeed | null = null;
  if (activeId !== null) {
    const rows = await loadKbMessages(userId, activeId, 100);
    if (rows.length > 0) {
      seed = {
        conversationId: activeId,
        messages: rows.map((row) => ({
          id: row.id,
          role: row.role,
          content: row.content,
          references: row.role === "assistant" ? parseCitationMetadata(row.metadata) : [],
        })),
      };
    }
  }

  return (
    <div className="mimic-page flex min-h-dvh flex-col bg-[#F6F5F4]">
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-5 pt-8 sm:pt-12 md:max-w-2xl">
        <PersonaPageHeader title={`问 · ${kb.name}`} backHref={`/knowledge/${kbId}`} />

        <div className="mt-5 flex-1">
          <KbChatPanel
            kbId={kb.id}
            kbName={kb.name}
            initialConversationId={seed?.conversationId ?? null}
            initialMessages={seed?.messages ?? []}
            conversations={conversations.map((conv) => ({ id: conv.id, title: conv.title }))}
          />
        </div>
      </div>
    </div>
  );
}
