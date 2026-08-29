/**
 * Drizzle 查询侧 schema —— 与 `db/migrations/0001_init.sql` **一一对应**。
 *
 * 职责边界(重要):本项目迁移的真相源是**手写 SQL 文件**,不是这份 TS schema。
 * 因此这里只用 drizzle-orm 做查询侧的类型安全,不接管建表 —— 不引入 drizzle-kit,
 * 不做 codegen(选型理由见 specCoding/情感陪伴模块/step1 §8 实施记录)。
 *
 * 相应地,SQL 里的 CHECK 约束没有在这里重复声明:约束由数据库强制,
 * 而这份 schema 不参与 DDL。改动列结构时**先改 SQL 迁移,再同步本文件**。
 */

import { index, pgTable, real, text, timestamp, uuid, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { vector } from "drizzle-orm/pg-core";

/**
 * 向量维度 1024 —— 百炼 text-embedding-v3 / v4 / qwen3.7-text-embedding 的
 * **默认**维度(官方文档:dimensions 可选 …1024、768、512…,默认 1024)。
 * 取默认值是为了将来换 embedding 模型时不必改表。
 * https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api
 */
export const EMBEDDING_DIMENSIONS = 1024;

/** 单用户阶段的 user_id 占位(ARCHITECTURE.md「持久化架构」)。 */
export const LOCAL_USER_ID = "local-user";

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().default(LOCAL_USER_ID),
    title: text("title").notNull().default(""),
    /** 人格 id(step1 P1 存在 localStorage,落库后迁移到此) */
    persona: text("persona"),
    voice: text("voice"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("conversations_user_created_idx").on(table.userId, table.createdAt.desc())],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** 'user' | 'assistant' | 'system'(取值由 SQL 的 CHECK 约束强制) */
    role: text("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("messages_conversation_created_idx").on(table.conversationId, table.createdAt)],
);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().default(LOCAL_USER_ID),
    content: text("content").notNull(),
    /** fact | preference | event | relationship | emotion(取值由 SQL 的 CHECK 约束强制) */
    category: text("category").notNull().default("fact"),
    importance: real("importance").notNull().default(0.5),
    emotionScore: real("emotion_score").notNull().default(0),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    sourceConversationId: uuid("source_conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("memories_user_active_idx")
      .on(table.userId)
      .where(sql`${table.archived} = false`),
    index("memories_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
