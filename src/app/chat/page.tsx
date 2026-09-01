/**
 * /chat 入口:进最近一场会话(对话持续在最新会话上),没有则给「开始」表单。
 *
 * 2026-08-31 UI 大一统后,这是唯一的对话 UI 落点:
 * 登录(已孵化)→ 本页;孵化确认 → /chat/<新会话 id>。
 * 用户体系 step1 起:需登录;未配置数据库由 requirePageUserId 直接抛错
 * (强制有库,spec §7 决策 3,local-demo 占位会话已移除)。
 */

import { redirect } from "next/navigation";
import { MimicNewConversationForm } from "@/components/mimic/mimic-new-conversation-form";
import { requirePageUserId } from "@/lib/auth/session";
import { getCompanion } from "@/lib/companion/repository";
import { listConversations } from "@/lib/memory/conversations";

export const dynamic = "force-dynamic";

export default async function ChatEntryPage() {
  const userId = await requirePageUserId();

  // 还没孵化(直访本页的边缘路径)→ 去孵化;正常登录流由登录页壳判定落点
  if ((await getCompanion(userId)) === null) redirect("/hatch");

  const latest = await listConversations(userId, 1);
  if (latest.length > 0) {
    const conversation = latest[0];
    if (conversation !== undefined) redirect(`/chat/${conversation.id}`);
  }
  return <MimicNewConversationForm />;
}
