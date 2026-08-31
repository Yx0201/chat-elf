/**
 * 05 历史记录 · 服务端壳(2026-08-31 起为唯一历史页,接真实 conversations 表)。
 *
 * 顶栏(Chat Elf · 历史 + 新开一场)+ 左米色舞台(comet 球 + 「穿过旧日子」)
 * + 右会话列表(可进会话、可删除)。H5:舞台压缩顶部、列表全宽。
 *
 * 交互(spec §3.5,在客户端组件 MimicHistoryList):
 * 滚动列表 → 球轻微倾斜(彗尾相位跟手);点进一场对话 → orbit 转场 →
 * /chat/<id>;新开一场 → startConversationAction(统一落点)。
 */

import { MimicHistoryList } from "@/components/mimic/mimic-history-list";
import { isDatabaseConfigured } from "@/lib/db/client";
import { listConversations } from "@/lib/memory/conversations";
import { listPersonas } from "@/lib/persona/repository";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const persistence = isDatabaseConfigured();
  // 人格名查不到(预设之外/已删除)就不显示 —— 副标题只留时间与条数
  const conversations = persistence ? await listConversations() : [];
  const personaNames = new Map(
    (await listPersonas()).map((persona) => [persona.id, persona.name] as const),
  );

  const sessions = conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    messageCount: conversation.messageCount,
    personaName:
      conversation.persona === null ? null : (personaNames.get(conversation.persona) ?? null),
  }));

  return <MimicHistoryList sessions={sessions} persistence={persistence} />;
}