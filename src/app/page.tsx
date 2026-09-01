/**
 * 首页 · 登录(2026-08-31 UI 大一统后,首页即登录页;2026-09-01 用户体系 step1
 * 起接入真实登录:Better Auth 邮箱+密码,注册/登录一体,见 LoginForm)。
 *
 * 主路径:登录 → 孵化(一次性设定性格/音色)→ 对话。
 * 已登录用户直接进入主路径(有精灵 → /chat;无精灵 → /hatch),不停留在本页。
 */

import { redirect } from "next/navigation";
import { LoginForm } from "@/components/mimic/login-form";
import { getSessionUserId } from "@/lib/auth/session";
import { getCompanion } from "@/lib/companion/repository";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const userId = await getSessionUserId();
  if (userId !== null) {
    redirect((await getCompanion(userId)) !== null ? "/chat" : "/hatch");
  }
  return <LoginForm />;
}
