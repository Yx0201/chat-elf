/**
 * 会话与消息的服务端数据访问(step1 P4)。
 *
 * 只在服务端调用(Server Component / Server Action)。
 * 单用户阶段 `user_id` 一律取 `LOCAL_USER_ID`(ARCHITECTURE.md「持久化架构」:
 * 数据库访问走 Next.js 服务端可信通道,不启用 RLS)。
 */

import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { conversations, messages, LOCAL_USER_ID } from "@/lib/db/schema";

export interface MessageInput {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  persona: string | null;
  voice: string | null;
  createdAt: Date;
  messageCount: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 客户端传入的会话 id 是不可信输入,先校验形状再拼进查询。 */
export function isValidConversationId(id: string): boolean {
  return UUID_RE.test(id);
}

/** 新建会话,返回 id。标题留空,待首条用户消息落库时回填。 */
export async function createConversation(input?: {
  persona?: string | null;
  voice?: string | null;
}): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(conversations)
    .values({
      userId: LOCAL_USER_ID,
      persona: input?.persona ?? null,
      voice: input?.voice ?? null,
    })
    .returning({ id: conversations.id });
  return row.id;
}

export async function listConversations(limit = 30): Promise<ConversationSummary[]> {
  const db = getDb();
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      persona: conversations.persona,
      voice: conversations.voice,
      createdAt: conversations.createdAt,
      messageCount: sql<number>`count(${messages.id})::int`,
    })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(eq(conversations.userId, LOCAL_USER_ID))
    .groupBy(conversations.id)
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}

export async function deleteConversation(conversationId: string): Promise<void> {
  if (!isValidConversationId(conversationId)) return;
  const db = getDb();
  // messages / memories.source_conversation_id 由外键级联(SET NULL / CASCADE)处理
  await db.delete(conversations).where(eq(conversations.id, conversationId));
}

/**
 * 会话没有任何转写时删除它(返回是否真的删了)。
 *
 * 用途:切换人格/音色会新建会话记录,若来源会话还一条消息都没有,
 * 留在列表里就是一条"未命名会话"垃圾 —— 有内容则一律保留。
 */
export async function discardIfEmpty(conversationId: string): Promise<boolean> {
  if (!isValidConversationId(conversationId)) return false;
  const db = getDb();
  const count = await countMessages(conversationId);
  if (count > 0) return false;
  await db.delete(conversations).where(eq(conversations.id, conversationId));
  return true;
}

export async function countMessages(conversationId: string): Promise<number> {
  if (!isValidConversationId(conversationId)) return 0;
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return row?.count ?? 0;
}

export interface AppendResult {
  /** 插入后该会话的消息总数 */
  total: number;
  /** 本次实际插入的条数(过滤掉空内容后的) */
  inserted: number;
}

/** 批量写入转写;空数组直接返回。 */
export async function appendMessages(
  conversationId: string,
  entries: readonly MessageInput[],
): Promise<AppendResult> {
  if (!isValidConversationId(conversationId) || entries.length === 0) {
    return { total: await countMessages(conversationId), inserted: 0 };
  }
  const db = getDb();
  const clean = entries
    .map((e) => ({ ...e, content: e.content.trim() }))
    .filter((e) => e.content !== "");
  if (clean.length === 0) {
    return { total: await countMessages(conversationId), inserted: 0 };
  }

  await db.insert(messages).values(
    clean.map((e) => ({
      conversationId,
      role: e.role,
      content: e.content,
    })),
  );

  // 标题仍为空时,用第一条用户消息回填(避免列表里出现一堆空白项)
  const firstUser = clean.find((e) => e.role === "user");
  await db
    .update(conversations)
    .set({
      updatedAt: new Date(),
      ...(firstUser === undefined
        ? {}
        : { title: sql`(case when ${conversations.title} = '' then ${firstUser.content.slice(0, 40)} else ${conversations.title} end)` }),
    })
    .where(eq(conversations.id, conversationId));

  return { total: await countMessages(conversationId), inserted: clean.length };
}

/** 该用户最近 N 条消息(跨会话),按时间正序 —— 用于新会话注入历史。 */
export async function loadRecentMessages(
  limit: number,
  userId: string = LOCAL_USER_ID,
): Promise<Array<{ role: string; content: string }>> {
  const db = getDb();
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(eq(conversations.userId, userId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}

/** 取某会话的完整转写(按时间正序),供记忆抽取使用。 */
export async function loadTranscript(
  conversationId: string,
  limit: number,
): Promise<Array<{ role: string; content: string }>> {
  if (!isValidConversationId(conversationId)) return [];
  const db = getDb();
  const rows = await db
    .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}
