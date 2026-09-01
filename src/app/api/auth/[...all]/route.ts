/**
 * Better Auth 的 HTTP 端点(注册/登录/退出等,cookie 设置与 CSRF 防护
 * 依赖标准 HTTP 流程,是「不建 REST 数据路由」原则的例外之一,
 * 见 ARCHITECTURE.md 修订后的 Route Handler 例外清单)。
 */

import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/auth";

export const { GET, POST } = toNextJsHandler(auth.handler);
