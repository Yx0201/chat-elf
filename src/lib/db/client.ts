/**
 * PostgreSQL 连接 —— 服务端专用(ARCHITECTURE.md「持久化架构」)。
 *
 * 关键约束:
 * - `DATABASE_URL` 绝不加 `NEXT_PUBLIC_` 前缀;本文件只能在服务端代码路径被引用。
 * - 上线 Neon 时:运行时查询用 **pooled** 连接串(`-pooler` 后缀,内置 PgBouncer),
 *   迁移 / DDL 走**非 pooled** 直连串(事务模式池化会破坏 session 级状态)。
 * - 开发期 HMR 会反复求值模块,连接池必须挂在 globalThis 上复用,
 *   否则每次热更新都会泄漏一组连接,很快打满 PG 的 max_connections。
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

/** serverless 场景下单个实例保持较小的池;本地开发同样够用。 */
const MAX_POOL_SIZE = 5;

const globalForDb = globalThis as typeof globalThis & {
  __chatElfPool?: Pool;
};

function createPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (typeof url !== "string" || url.trim() === "") {
    throw new DatabaseConfigError(
      "缺少环境变量 DATABASE_URL。请在 .env.local 中配置(参考 .env.example):" +
        "本地形如 postgres://<用户名>@localhost:5432/chat_elf",
    );
  }
  return new Pool({
    connectionString: url,
    max: MAX_POOL_SIZE,
    // 网络抖动时不要无限挂起,避免耗尽 serverless 实例时长
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

function getPool(): Pool {
  globalForDb.__chatElfPool ??= createPool();
  return globalForDb.__chatElfPool;
}

/** 获取 drizzle 实例;首次调用时建池。只在服务端调用。 */
export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(getPool(), { schema });
}

/**
 * 数据库是否可用(未配置 DATABASE_URL 时返回 false)。
 * 供页面在缺少配置时优雅降级为"无记忆"模式,而不是整页报错。
 */
export function isDatabaseConfigured(): boolean {
  const url = process.env.DATABASE_URL;
  return typeof url === "string" && url.trim() !== "";
}
