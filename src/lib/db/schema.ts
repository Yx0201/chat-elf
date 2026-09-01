/**
 * Drizzle 查询侧 schema —— 与 `db/migrations/*.sql` **一一对应**
 * (0001 会话/转写/记忆、0002 人格、0003 反馈、0004 画像、0005 记忆来源、
 *  0006 Better Auth 四表、0007 陪伴精灵)。
 *
 * 职责边界(重要):本项目迁移的真相源是**手写 SQL 文件**,不是这份 TS schema。
 * 因此这里只用 drizzle-orm 做查询侧的类型安全,不接管建表 —— 不引入 drizzle-kit,
 * 不做 codegen(选型理由见 specCoding/情感陪伴模块/step1 §8 实施记录)。
 *
 * 相应地,SQL 里的 CHECK 约束没有在这里重复声明:约束由数据库强制,
 * 而这份 schema 不参与 DDL。改动列结构时**先改 SQL 迁移,再同步本文件**。
 */

import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uuid,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { vector } from "drizzle-orm/pg-core";

/**
 * 向量维度 1024 —— 百炼 text-embedding-v3 / v4 / qwen3.7-text-embedding 的
 * **默认**维度(官方文档:dimensions 可选 …1024、768、512…,默认 1024)。
 * 取默认是为了将来换 embedding 模型时不必改表。
 * https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api
 */
export const EMBEDDING_DIMENSIONS = 1024;

/* ------------------------------------------------------------------ */
/* Better Auth 核心四表(0006_auth.sql;列结构以 @better-auth/cli        */
/* generate 的产出为参考翻译,查询侧镜像同此)                            */
/* ------------------------------------------------------------------ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    /** 提供方侧的主体 id;credential 登录时为邮箱 */
    accountId: text("account_id").notNull(),
    /** 提供方 id;credential 登录时为 'credential' */
    providerId: text("provider_id").notNull(),
    /** 身份命名空间;credential 策略下为 'local:credential' */
    issuer: text("issuer"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    /** credential 登录时的密码哈希(scrypt) */
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("account_issuer_account_id_idx").on(table.issuer, table.accountId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  type: text("type").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof user.$inferSelect;
export type SessionRow = typeof session.$inferSelect;
export type AccountRow = typeof account.$inferSelect;
export type VerificationRow = typeof verification.$inferSelect;

/**
 * 人格(step2 T1)。
 *
 * `traits` 是 jsonb —— 人格矩阵是"可调的、会随产品演进增减维度"的配置,
 * 不适合拆成 6 个固定列(加一个维度就要改表)。解析交给 `parseTraits()`,
 * 非法值一律回落中性,不因一条脏数据拖垮渲染。
 */
export const personas = pgTable(
  "personas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    emoji: text("emoji").notNull().default(""),
    tagline: text("tagline").notNull().default(""),
    /** 模板来源 id(如 'xiaoyou');用户自建为 null */
    archetype: text("archetype"),
    /** 人格矩阵;数据类型见 PersonaTraits(traits.ts) */
    traits: jsonb("traits").notNull().default({}),
    voice: text("voice").notNull(),
    backstory: text("backstory").notNull().default(""),
    boundaries: text("boundaries").notNull().default(""),
    isPreset: boolean("is_preset").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("personas_user_idx").on(table.userId, table.updatedAt.desc()),
    index("personas_user_archetype_idx").on(table.userId, table.archetype),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    title: text("title").notNull().default(""),
    /**
     * 人格外键(step2)。可空:人格被删除后由数据库置 NULL,会话本身保留。
     *
     * 与之并存的 `persona` / `voice` **文本列是快照**:记录这场会话当时用的
     * 人格名与音色,外键置空后历史列表仍显示得出来。
     */
    personaId: uuid("persona_id").references(() => personas.id, { onDelete: "set null" }),
    persona: text("persona"),
    voice: text("voice"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("conversations_user_created_idx").on(table.userId, table.createdAt.desc()),
    index("conversations_persona_idx").on(table.personaId),
  ],
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
    userId: text("user_id").notNull(),
    content: text("content").notNull(),
    /** fact | preference | event | relationship | emotion(取值由 SQL 的 CHECK 约束强制) */
    category: text("category").notNull().default("fact"),
    importance: real("importance").notNull().default(0.5),
    emotionScore: real("emotion_score").notNull().default(0),
    /** 写入来源:batch = 会话后批量抽取;realtime = 会话中 function call 实时标记 */
    source: text("source").notNull().default("batch"),
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

/**
 * 单条回复的反馈(step2 T4)。只埋点,不分析。
 * `message_id` 唯一:改判走 upsert,撤销走 delete。
 */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** 1 = 👍,-1 = 👎 */
    score: smallint("score").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("feedback_message_idx").on(table.messageId)],
);

/**
 * 用户画像(step3 T4)。
 *
 * 与 memories 的分工:memories 是 ADD-only 的碎片事实层,这里是由 LLM
 * **整体重写**的凝练画像 —— 冲突消解(如"住北京"→"搬上海")发生在本层。
 * 因此它只存一行(按 user_id 主键),不存在"多条画像"。
 */
export const userProfile = pgTable("user_profile", {
  userId: text("user_id").primaryKey(),
  summary: text("summary").notNull().default(""),
  traits: jsonb("traits").notNull().default({}),
  /** 距上次整合以来新结束的会话数;达到阈值才触发重写 */
  pendingConversations: integer("pending_conversations").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
});

/**
 * 陪伴精灵(0007_companions.sql,用户体系 step1 T4)。
 *
 * 用户 1:1:userId UNIQUE 是"一次性孵化"的数据库级保证。
 * personaName / voice 是定格时的快照 —— 人格被删(personaId 置 NULL)后
 * 精灵名与音色仍可展示,对齐 conversations.persona 的快照先例。
 */
export const companions = pgTable(
  "companions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    personaId: uuid("persona_id").references(() => personas.id, { onDelete: "set null" }),
    personaName: text("persona_name"),
    voice: text("voice").notNull(),
    hatchedAt: timestamp("hatched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("companions_persona_idx").on(table.personaId)],
);

export type CompanionRow = typeof companions.$inferSelect;

/**
 * 注册邀请码(0008_invite_codes.sql,内测准入)。
 *
 * 定位是准入门槛而非安全机制:明文比对。注册时服务端 hook 校验
 * (见 lib/auth/auth.ts),只挡 /sign-up/email,不挡登录。
 */
export const inviteCodes = pgTable("invite_codes", {
  code: text("code").primaryKey(),
  note: text("note").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InviteCodeRow = typeof inviteCodes.$inferSelect;

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
export type PersonaRow = typeof personas.$inferSelect;
export type FeedbackRow = typeof feedback.$inferSelect;
export type UserProfileRow = typeof userProfile.$inferSelect;
