"use server";

/**
 * 登录后的落点解析(用户体系 step1 T5)。
 *
 * 登录/注册/退出本体走 Better Auth 的 HTTP 端点(authClient,见
 * src/lib/auth/client.ts)—— cookie 由 /api/auth 路由直接下发,
 * 不经 Server Action 中转。这里只做注册后的首次播种与落点判定:
 *   - 已有精灵(companion) → /chat;
 *   - 没有精灵 → /hatch(新用户首次进来顺带播种 5 个预设人格)。
 */

import { requireActionUserId } from "@/lib/auth/session";
import { getCompanion } from "@/lib/companion/repository";
import { getDb, isDatabaseConfigured } from "@/lib/db/client";
import { personas } from "@/lib/db/schema";
import { seedPresetsForUser } from "@/lib/persona/repository";
import { eq } from "drizzle-orm";

export async function resolveLandingAction(): Promise<string> {
  const userId = await requireActionUserId();
  if (userId === null) return "/";

  if (!isDatabaseConfigured()) return "/";

  // 首次进来(还没有任何人格)则播种预设;幂等,重复调用安全
  const existing = await getDb()
    .select({ id: personas.id })
    .from(personas)
    .where(eq(personas.userId, userId))
    .limit(1);
  if (existing.length === 0) await seedPresetsForUser(userId);

  const companion = await getCompanion(userId);
  return companion !== null ? "/chat" : "/hatch";
}
