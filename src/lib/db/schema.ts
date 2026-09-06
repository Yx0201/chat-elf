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
  varchar,
  bigint,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { vector } from "drizzle-orm/pg-core";

/**
 * tsvector 自定义类型(0009 知识库模块)。drizzle 无原生 tsvector —— 但本项目
 * 对该列只写入原生 SQL(to_tsvector(...)),TS 侧声明仅为让 schema 镜像完整、
 * 类型检查通过,不做查询构建器层的过滤。
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

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

/* ------------------------------------------------------------------ */
/* 知识库模块(0009_knowledge_base.sql,自 codeweaver 迁移;详见        */
/* specCoding/知识库模块/step1)                                       */
/* ------------------------------------------------------------------ */

/**
 * 知识库。summary 是全部文档内容范围的聚合归纳 —— step2 注入 realtime
 * instructions,作为"闲聊直答 / 检索知识库"前置判断的依据。
 */
export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    summary: text("summary"),
    summaryGeneratedAt: timestamp("summary_generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_knowledge_bases_user").on(table.userId)],
);

/**
 * 上传文件。content 是 UTF-8 文本缓存(分块/嵌入读库不回源 Blob);
 * metadata 存六阶段流水线进度 state 与图谱统计;summary 为单文件内容摘要。
 */
export const uploadedFiles = pgTable(
  "uploaded_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kbId: uuid("kb_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    blobUrl: varchar("blob_url", { length: 1000 }),
    content: text("content"),
    /** uploaded | processing | completed | failed(SQL CHECK 约束强制) */
    status: text("status").notNull().default("uploaded"),
    summary: text("summary"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_uploaded_files_kb").on(table.kbId)],
);

/**
 * 检索分块(父子双轨):parent 供上下文、child 供命中;命中 child 后升 parent。
 * keywords 列只经原生 SQL 写入/查询(to_tsvector/to_tsquery)。
 */
export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => uploadedFiles.id, { onDelete: "cascade" }),
    /** parent | child(SQL CHECK 约束强制) */
    chunkType: text("chunk_type").notNull(),
    chunkIndex: integer("chunk_index").notNull().default(0),
    parentChunkId: uuid("parent_chunk_id").references((): AnyPgColumn => documentChunks.id, {
      onDelete: "cascade",
    }),
    chunkText: text("chunk_text").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    keywords: tsvector("keywords"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_document_chunks_file").on(table.fileId),
    index("idx_document_chunks_parent").on(table.parentChunkId),
    index("idx_document_chunks_embedding_hnsw")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
    index("idx_document_chunks_keywords_gin").using("gin", table.keywords),
    index("idx_document_chunks_chunk_text_trgm").using(
      "gin",
      sql`${table.chunkText} gin_trgm_ops`,
    ),
  ],
);

/** 图谱专用大分块(带卷/章标题,供实体抽取与图谱检索)。 */
export const graphChunks = pgTable(
  "graph_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => uploadedFiles.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull().default(0),
    text: text("text").notNull(),
    chapterTitle: text("chapter_title"),
    volumeTitle: text("volume_title"),
    /** 图谱构建状态机:graph_processed / processing_at / graph_error */
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_graph_chunks_file").on(table.fileId)],
);

/** 知识图谱实体。name_embedding 用于跨批次实体合并(余弦相似度)。 */
export const kgEntities = pgTable(
  "kg_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kbId: uuid("kb_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 500 }).notNull(),
    /** person | location | organization | event | concept(约定值) */
    entityType: varchar("entity_type", { length: 50 }).notNull().default("concept"),
    description: text("description"),
    nameEmbedding: vector("name_embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    nameKeywords: tsvector("name_keywords"),
    /** aliases 等(跨批次实体合并记录) */
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_kg_entities_kb").on(table.kbId),
    index("idx_kg_entities_name_embedding_hnsw")
      .using("hnsw", table.nameEmbedding.op("vector_cosine_ops")),
    index("idx_kg_entities_name_keywords_gin").using("gin", table.nameKeywords),
    index("idx_kg_entities_name_trgm").using("gin", sql`${table.name} gin_trgm_ops`),
    index("idx_kg_entities_kb_type_lower_name").on(
      table.kbId,
      table.entityType,
      sql`lower(${table.name})`,
    ),
  ],
);

/** 知识图谱关系(有向:source → target)。 */
export const kgRelations = pgTable(
  "kg_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kbId: uuid("kb_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    relationType: varchar("relation_type", { length: 200 }).notNull(),
    description: text("description"),
    sourceEntityId: uuid("source_entity_id")
      .notNull()
      .references(() => kgEntities.id, { onDelete: "cascade" }),
    targetEntityId: uuid("target_entity_id")
      .notNull()
      .references(() => kgEntities.id, { onDelete: "cascade" }),
    /** chunk_id:关系来源图谱块(孤儿清理与块级去重依据) */
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_kg_relations_kb").on(table.kbId),
    index("idx_kg_relations_source").on(table.sourceEntityId),
    index("idx_kg_relations_target").on(table.targetEntityId),
  ],
);

/** 实体 ↔ 图谱块多对多。 */
export const kgEntityChunks = pgTable(
  "kg_entity_chunks",
  {
    entityId: uuid("entity_id")
      .notNull()
      .references(() => kgEntities.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => graphChunks.id, { onDelete: "cascade" }),
  },
  (table) => [index("idx_kg_entity_chunks_chunk").on(table.chunkId)],
);

export type KnowledgeBaseRow = typeof knowledgeBases.$inferSelect;
export type UploadedFileRow = typeof uploadedFiles.$inferSelect;
export type DocumentChunkRow = typeof documentChunks.$inferSelect;
export type GraphChunkRow = typeof graphChunks.$inferSelect;
export type KgEntityRow = typeof kgEntities.$inferSelect;
export type KgRelationRow = typeof kgRelations.$inferSelect;

/* ------------------------------------------------------------------ */
/* 知识库文本问答线(0010_knowledge_chat.sql,step2 T6)—— 与语音      */
/* 陪伴线的 conversations/messages 完全独立                            */
/* ------------------------------------------------------------------ */

/**
 * 文本问答会话:绑定一个知识库(删除后 SET NULL,会话保留)。
 * search_mode 是该会话的检索模式偏好,UI 可切换。
 */
export const kbConversations = pgTable(
  "kb_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kbId: uuid("kb_id").references(() => knowledgeBases.id, { onDelete: "set null" }),
    /** hybrid | graph | fast(SQL CHECK 约束强制) */
    searchMode: text("search_mode").notNull().default("hybrid"),
    title: text("title").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_kb_conversations_user").on(table.userId, table.updatedAt.desc()),
    index("idx_kb_conversations_kb").on(table.kbId),
  ],
);

/**
 * 文本问答消息。assistant 的 metadata 存引用列表
 * (Array<{index, fileId, fileName, chunkId}>)与工具轨迹,刷新后还原引用 UI。
 */
export const kbMessages = pgTable(
  "kb_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => kbConversations.id, { onDelete: "cascade" }),
    /** user | assistant(SQL CHECK 约束强制) */
    role: text("role").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_kb_messages_conversation").on(table.conversationId, table.createdAt)],
);

export type KbConversationRow = typeof kbConversations.$inferSelect;
export type KbMessageRow = typeof kbMessages.$inferSelect;

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
export type PersonaRow = typeof personas.$inferSelect;
export type FeedbackRow = typeof feedback.$inferSelect;
export type UserProfileRow = typeof userProfile.$inferSelect;
