/**
 * 原生 SQL 执行助手(知识库模块)。
 *
 * 检索与摄取管线大量使用 PG 专有能力(tsvector/tsquery/HNSW/向量运算/
 * FOR UPDATE SKIP LOCKED),这些不走 drizzle 查询构建器,统一经
 * `sql` 模板标签参数化后交给连接池执行 —— 全程无字符串拼接,
 * 与项目「禁止 any」约定兼容。
 */

import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

/** 执行查询并返回行(泛型标注调用方的期望行形状)。 */
export async function queryRows<T>(query: SQL): Promise<T[]> {
  const result = await getDb().execute(query);
  return result.rows as T[];
}

/** 执行写语句并返回受影响行数。 */
export async function executeStatement(query: SQL): Promise<number> {
  const result = await getDb().execute(query);
  return result.rowCount ?? 0;
}

/**
 * PG 数组参数辅助 —— drizzle 的 sql 模板会把 JS 数组**展开成参数元组**
 * (`${arr}` → `($1,$2,...)`),放进 ANY()/unnest() 直接报错。
 * 这里显式构造 ARRAY[...] 并整体转型,每个元素仍是独立参数(无字符串拼接)。
 */

export function textArrayParam(values: string[]): SQL {
  return sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;
}

export function uuidArrayParam(values: string[]): SQL {
  return sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::uuid[]`;
}

export function intArrayParam(values: number[]): SQL {
  return sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::int[]`;
}

/** 向量数组:元素是 "[0.1,0.2,...]" 字符串字面量,转型 vector[]。 */
export function vectorArrayParam(values: string[]): SQL {
  return sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::vector[]`;
}
