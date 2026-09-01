/**
 * Better Auth 浏览器客户端(用户体系 step1 T5)—— 仅 "use client" 组件导入。
 *
 * 登录/注册/退出都走 /api/auth HTTP 端点(与 route handler 直接交互,
 * cookie 由服务端响应下发,浏览器自动保存)。
 * baseURL 缺省取当前源,本地与部署环境都不需要配置。
 */

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
