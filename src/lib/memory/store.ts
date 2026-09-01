/**
 * 记忆的读写(step3 T5「TA 记得你」页面用)。
 *
 * 抽取与去重在 tasks.ts(会话后批量轨),检索在 context-builder.ts,
 * 这里是**面向用户管理界面**的读写:列出来给用户看、以及删掉。
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb, isDatabaseConfigured } from "@/lib/db/client";
import { memories } from "@/lib/db/schema";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MemoryListItem {
  id: string;
  content: string;
  /** fact / preference / event / relationship / emotion */
  category: string;
  importance: number;
  emotionScore: number;
  createdAt: Date;
  lastConfirmedAt: Date | null;
}

export function isValidMemoryId(id: string): boolean {
  return UUID_RE.test(id);
}

/** 列出全部活跃记忆(最近确认过的在前)。 */
export async function listMemories(userId: string): Promise<MemoryListItem[]> {
  if (!isDatabaseConfigured()) return [];
  try {
    return await getDb()
      .select({
        id: memories.id,
        content: memories.content,
        category: memories.category,
        importance: memories.importance,
        emotionScore: memories.emotionScore,
        createdAt: memories.createdAt,
        lastConfirmedAt: memories.lastConfirmedAt,
      })
      .from(memories)
      .where(and(eq(memories.userId, userId), eq(memories.archived, false)))
      .orderBy(desc(memories.lastConfirmedAt), desc(memories.createdAt));
  } catch (error) {
    console.error("[memory] 读取记忆列表失败:", error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * 物理删除一条记忆。
 *
 * 为什么不做软删除(archived):用户在管理页主动删除是**合规诉求**
 * (Replika memory editor 模式 + 个人信息删除权),语义是"彻底忘掉",
 * 不是"暂时不检索"。软删除反而会在数据库里留下用户要求删掉的内容。
 */
export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  if (!isDatabaseConfigured() || !isValidMemoryId(id)) return false;
  const rows = await getDb()
    .delete(memories)
    .where(and(eq(memories.id, id), eq(memories.userId, userId)))
    .returning({ id: memories.id });
  return rows.length > 0;
}
