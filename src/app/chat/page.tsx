/**
 * /chat 入口:进最近一场会话(对话持续在最新会话上),没有则给「开始」表单。
 *
 * 2026-08-31 UI 大一统后,这是唯一的对话 UI 落点:
 * 登录(已孵化)→ 本页;孵化确认 → /chat/<新会话 id>。
 * 无数据库时落到占位会话 local-demo(对话照常,只是不落库)。
 */

import { redirect } from "next/navigation";
import { MimicNewConversationForm } from "@/components/mimic/mimic-new-conversation-form";
import { isDatabaseConfigured } from "@/lib/db/client";
import { listConversations } from "@/lib/memory/conversations";

export const dynamic = "force-dynamic";

export default async function ChatEntryPage() {
  if (!isDatabaseConfigured()) redirect("/chat/local-demo");

  const latest = await listConversations(1);
  if (latest.length > 0) {
    const conversation = latest[0];
    if (conversation !== undefined) redirect(`/chat/${conversation.id}`);
  }
  return <MimicNewConversationForm />;
}