/**
 * /mimic/chat 入口:进最近一场会话(对话持续在最新会话上),没有则给「开始」表单。
 *
 * 与旧版 /chat 的差别只在落点:这里跳 /mimic/chat/<id>(拟态球 UI)。
 * 无数据库时落到占位会话 local(对话照常,只是不落库)。
 */

import { redirect } from "next/navigation";
import { MimicNewConversationForm } from "@/components/mimic/mimic-new-conversation-form";
import { isDatabaseConfigured } from "@/lib/db/client";
import { listConversations } from "@/lib/memory/conversations";

export const dynamic = "force-dynamic";

export default async function MimicChatEntryPage() {
  if (!isDatabaseConfigured()) redirect("/mimic/chat/local");

  const latest = await listConversations(1);
  if (latest.length > 0) {
    const conversation = latest[0];
    if (conversation !== undefined) redirect(`/mimic/chat/${conversation.id}`);
  }
  return <MimicNewConversationForm />;
}
