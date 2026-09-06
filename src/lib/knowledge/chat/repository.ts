/**
 * 知识库文本问答线的数据访问层(0010 两表)。
 * 归属过滤同全站约定:user_id 直查或经 conversation 归属链校验。
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { kbConversations, kbMessages, type KbConversationRow } from "@/lib/db/schema";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidKbConversationId(id: string): boolean {
  return UUID_RE.test(id);
}

/** assistant 消息 metadata 的引用条目结构(刷新还原引用 UI)。 */
export interface CitationMeta {
  index: number;
  fileId: string;
  fileName: string;
  chunkId: string;
}

/** KB 内(或用户全部)的问答会话列表,最近优先。 */
export async function listKbConversations(
  userId: string,
  kbId: string,
): Promise<KbConversationRow[]> {
  const db = getDb();
  return db
    .select()
    .from(kbConversations)
    .where(and(eq(kbConversations.userId, userId), eq(kbConversations.kbId, kbId)))
    .orderBy(desc(kbConversations.updatedAt))
    .limit(30);
}

export async function getKbConversation(
  userId: string,
  conversationId: string,
): Promise<KbConversationRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(kbConversations)
    .where(and(eq(kbConversations.id, conversationId), eq(kbConversations.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** 建会话(懒创建:首条消息到达时);标题 = 首条用户消息前 20 字(spec:不做 LLM 标题)。 */
export async function createKbConversation(params: {
  userId: string;
  kbId: string | null;
  title: string;
}): Promise<KbConversationRow> {
  const db = getDb();
  const [row] = await db
    .insert(kbConversations)
    .values({ userId: params.userId, kbId: params.kbId, title: params.title.slice(0, 40) })
    .returning();
  return row;
}

/** 历史消息(正序),供 useChat 的 initialMessages。 */
export async function loadKbMessages(
  userId: string,
  conversationId: string,
  limit = 100,
): Promise<Array<{ id: string; role: "user" | "assistant"; content: string; metadata: unknown }>> {
  if ((await getKbConversation(userId, conversationId)) === null) return [];
  const db = getDb();
  const rows = await db
    .select({
      id: kbMessages.id,
      role: kbMessages.role,
      content: kbMessages.content,
      metadata: kbMessages.metadata,
    })
    .from(kbMessages)
    .where(eq(kbMessages.conversationId, conversationId))
    .orderBy(desc(kbMessages.createdAt))
    .limit(limit);
  return rows.reverse().map((row) => ({
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    metadata: row.metadata,
  }));
}

/** 追加一条消息并触碰会话 updated_at(会话列表按它排序)。 */
export async function appendKbMessage(params: {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(kbMessages)
    .values({
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      metadata: params.metadata ?? {},
    })
    .returning({ id: kbMessages.id });
  await db
    .update(kbConversations)
    .set({ updatedAt: new Date() })
    .where(eq(kbConversations.id, params.conversationId));
  return row.id;
}

/** 解析 assistant 消息持久化的引用列表(容错)。 */
export function parseCitationMetadata(metadata: unknown): CitationMeta[] {
  if (!metadata || typeof metadata !== "object") return [];
  const refs = (metadata as Record<string, unknown>).references;
  if (!Array.isArray(refs)) return [];
  return refs.filter(
    (ref): ref is CitationMeta =>
      typeof ref === "object" &&
      ref !== null &&
      typeof (ref as CitationMeta).index === "number" &&
      typeof (ref as CitationMeta).fileName === "string",
  );
}
