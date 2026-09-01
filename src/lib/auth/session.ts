/**
 * 会话读取与鉴权守卫(用户体系 step1 T2)—— 纯服务端模块。
 *
 * 三个出口,按调用场景区分:
 *   - `getSessionUserId()`   :读取;未登录返回 null(调用方自行决定降级形态);
 *   - `requirePageUserId()`  :RSC 页面守卫;未登录 redirect 回登录页,
 *                              未配置数据库直接抛 DatabaseConfigError
 *                              (强制有库的 fail fast,spec §7 决策 3);
 *   - `requireActionUserId()` :Server Action 守卫;未登录返回 null,
 *                              由各 action 以既有风格静默失败(数据零写入,
 *                              无危害面),不在这里 redirect。
 *
 * 注意 Better Auth 的 server 端调用需要请求头(next/headers),
 * 因此这些函数只能出现在请求上下文(RSC / Action / Route Handler)中。
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { DatabaseConfigError, isDatabaseConfigured } from "@/lib/db/client";
import { auth } from "./auth";

/** 当前登录用户 id;未登录 / 会话过期返回 null。 */
export async function getSessionUserId(): Promise<string | null> {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    return session?.user.id ?? null;
  } catch (error) {
    // auth 表未建(迁移未执行)等场景:视为未登录,不拖垮页面渲染
    console.error("[auth] 读取会话失败:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * RSC 页面守卫:返回可用的 userId。
 * 未登录 → 302 登录页;未配置数据库 → 抛配置错误(不再有"无库演示模式")。
 */
export async function requirePageUserId(): Promise<string> {
  if (!isDatabaseConfigured()) {
    throw new DatabaseConfigError(
      "缺少环境变量 DATABASE_URL。用户体系要求配置数据库(见 .env.example),请配置后重启。",
    );
  }
  const userId = await getSessionUserId();
  if (userId === null) redirect("/");
  return userId;
}

/**
 * Server Action 守卫:返回 userId 或 null。
 * null 时调用方按各自的失败形态返回(null / false / {ok:false}),
 * 不写任何数据 —— 会话过期时静默失败比抛错更贴合既有 action 风格。
 */
export async function requireActionUserId(): Promise<string | null> {
  if (!isDatabaseConfigured()) return null;
  return getSessionUserId();
}
