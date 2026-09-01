/**
 * 孵化页 /hatch · 服务端壳(2026-08-31 UI 大一统新增)。
 *
 * 主路径第二步:登录 → **孵化** → 对话。孵化 = egg→burst 唤醒 +
 * 一次性设定人格与音色(预设 chips + 五维滑块 + 音色 + 预览),确认后不可修改。
 *
 * 守卫(用户体系 step1 T4):需登录;**已有精灵(companion)直接回 /chat** ——
 * 孵化是一次性的,服务端判定取代旧的 localStorage isHatched 判断。
 *
 * 预设人格来自常量(presets.ts,与库内种子同源),自建人格由服务端读库
 * 注入 —— 孵化页本身是 Server Component,交互全在 HatchFlow(客户端)。
 */

import { redirect } from "next/navigation";
import { HatchFlow } from "@/components/mimic/hatch-flow";
import { requirePageUserId } from "@/lib/auth/session";
import { getCompanion } from "@/lib/companion/repository";
import { isDatabaseConfigured } from "@/lib/db/client";
import { listPersonas } from "@/lib/persona/repository";

export const dynamic = "force-dynamic";

export default async function HatchPage() {
  const userId = await requirePageUserId();

  if ((await getCompanion(userId)) !== null) redirect("/chat");

  const persistence = isDatabaseConfigured();
  const all = persistence ? await listPersonas(userId) : [];
  const customs = all.filter((persona) => !persona.isPreset);

  return <HatchFlow customs={customs} persistence={persistence} />;
}
