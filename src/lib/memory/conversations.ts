/**
 * 会话与消息的服务端数据访问(step1 P4)。
 *
 * 只在服务端调用(Server Component / Server Action)。
 * 单用户阶段 `user_id` 一律取 `LOCAL_USER_ID`(ARCHITECTURE.md「持久化架构」:
 * 数据库访问走 Next.js 服务端可信通道,不启用 RLS)。
 */

import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { conversations, feedback as feedbackTable, messages, LOCAL_USER_ID } from "@/lib/db/schema";
import { isValidPersonaId } from "@/lib/persona/types";

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

/**
 * 新建会话,返回 id。标题留空,待首条用户消息落库时回填。
 *
 * `personaId` 是 step2 的 personas 外键。只有**自建人格的 uuid** 才写外键 ——
 * 预设的 id 是 archetype 字符串(如 'xiaoyou'),不是 uuid,写进去会违反外键类型。
 * 两种情况下 `persona` 文本列都记下当时的选择,作为历史列表的展示快照。
 */
export async function createConversation(input?: {
  personaId?: string | null;
  persona?: string | null;
  voice?: string | null;
}): Promise<string> {
  const db = getDb();
  const personaId = input?.personaId ?? null;
  const [row] = await db
    .insert(conversations)
    .values({
      userId: LOCAL_USER_ID,
      personaId: personaId !== null && isValidPersonaId(personaId) ? personaId : null,
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
  /**
   * 本次插入的 message id,**顺序与入参 entries 一致**(已过滤空内容)。
   * 客户端靠它把字幕条目对应到库里的行,用于 👍/👎 反馈埋点(step2 T4)。
   */
  ids: string[];
}

/** 批量写入转写;空数组直接返回。 */
export async function appendMessages(
  conversationId: string,
  entries: readonly MessageInput[],
): Promise<AppendResult> {
  if (!isValidConversationId(conversationId) || entries.length === 0) {
    return { total: await countMessages(conversationId), inserted: 0, ids: [] };
  }
  const db = getDb();
  const clean = entries
    .map((e) => ({ ...e, content: e.content.trim() }))
    .filter((e) => e.content !== "");
  if (clean.length === 0) {
    return { total: await countMessages(conversationId), inserted: 0, ids: [] };
  }

  // 逐条插入并回读 id,而不是一次多行 INSERT:PostgreSQL **不保证**多行 INSERT
  // 的 RETURNING 顺序,顺序错了反馈就会打在另一条消息上。单次 append 通常只有
  // 1-2 条(字幕流式落库),逐条的额外往返可以忽略。
  const ids: string[] = [];
  for (const entry of clean) {
    const [row] = await db
      .insert(messages)
      .values({ conversationId, role: entry.role, content: entry.content })
      .returning({ id: messages.id });
    ids.push(row.id);
  }

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

  return { total: await countMessages(conversationId), inserted: clean.length, ids };
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

export interface TranscriptRow {
  id: string;
  role: string;
  content: string;
  /** 该条已收到的反馈(👍 = 1 / 👎 = -1);null = 未评价 */
  feedback: 1 | -1 | null;
}

/**
 * 取某会话的完整转写(按时间正序),供记忆抽取与字幕回显使用。
 *
 * 一并带出 feedback:进入历史会话时要显示用户此前点过的赞/踩。
 */
export async function loadTranscript(
  conversationId: string,
  limit: number,
): Promise<TranscriptRow[]> {
  if (!isValidConversationId(conversationId)) return [];
  const db = getDb();
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
      score: feedbackTable.score,
    })
    .from(messages)
    .leftJoin(feedbackTable, eq(feedbackTable.messageId, messages.id))
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows
    .reverse()
    .map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      feedback: row.score === 1 ? 1 : row.score === -1 ? -1 : null,
    }));
}
