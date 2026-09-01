/**
 * Better Auth 服务端实例(specCoding/用户体系 step1)——纯服务端模块,
 * 客户端组件禁止值导入本文件(编码约定:值导入会拖整条依赖链进浏览器 bundle)。
 *
 * - 数据层:drizzle adapter 直连自有 PostgreSQL(与业务表同一个连接池);
 * - 登录方式:邮箱 + 密码;**注册/登录分开展示**(2026-09-01 修订:
 *   登录页内文字按钮切换注册表单,注册成功回登录页登录)——
 *   autoSignIn 关闭,注册不建会话;
 * - **注册邀请码**(内测准入):/sign-up/email 在 hooks.before 里强制校验
 *   invite_codes 表(active 的码比对一致才放行)。放在服务端 hook 是
 *   硬要求 —— /api/auth 是公开 HTTP 端点,只在前端拦会被直接调 API 绕过;
 *   登录不校验(已注册用户不受影响)。
 * - session 为 DB session(cookie 只存令牌),Neon pooled 连接兼容;
 * - 密码哈希默认 scrypt(Node 内置,无原生编译依赖)。
 *
 * 无 DATABASE_URL 时模块加载即抛 DatabaseConfigError —— 强制有库的
 * fail fast 语义(spec §7 决策 3),不做无库演示。
 */

import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

/** 邀请码是否有效(库里存在且 active)。明文比对 —— 准入门槛,非安全机制。 */
async function isValidInviteCode(code: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ code: schema.inviteCodes.code })
    .from(schema.inviteCodes)
    .where(and(eq(schema.inviteCodes.code, code), eq(schema.inviteCodes.active, true)))
    .limit(1);
  return row !== undefined;
}

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
    // 注册不自动登录:注册成功回登录页,用登录进入(2026-09-01 用户需求)
    autoSignIn: false,
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email") {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const code = typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";
        if (code === "" || !(await isValidInviteCode(code))) {
          throw new APIError("FORBIDDEN", {
            message: "邀请码不对。",
            code: "INVITE_CODE_INVALID",
          });
        }
      }
    }),
  },
  // baseURL 缺省时按 BETTER_AUTH_URL / 请求头自动推断;本地即 localhost:3000。
  // 部署 Vercel 后在环境变量里显式配置线上域名(见 .env.example)。
  trustedOrigins: ["http://localhost:3000"],
});
