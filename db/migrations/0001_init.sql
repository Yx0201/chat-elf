-- 0001 初始化:情感陪伴模块 · 记忆层(step1 P4)
--
-- 目标库:本地 PostgreSQL 17 / 上线 Neon(见 ARCHITECTURE.md「持久化架构」)。
-- 幂等:全部使用 IF NOT EXISTS,可重复执行。
-- 执行方式(psql):
--   psql "$DATABASE_URL" -f db/migrations/0001_init.sql
--
-- 前置:pgvector 扩展。本地 Homebrew PostgreSQL 17 自带 vector 0.8.0
--   (select * from pg_available_extensions where name = 'vector'),
--   因此无需改用 pgvector/pgvector Docker 镜像 —— 原 ARCHITECTURE.md 的
--   「Homebrew 不含 vector」前提在本机不成立。Neon 需先 CREATE EXTENSION(见下)。

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------
-- 会话
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 单用户阶段硬编码 'local-user'(ARCHITECTURE.md 持久化架构);
  -- 无账号体系故不启用 RLS,数据库访问一律走 Next.js 服务端可信通道。
  user_id     text        NOT NULL DEFAULT 'local-user',
  title       text        NOT NULL DEFAULT '',
  -- step1 P1 的人格存在 localStorage,落库后迁移到这两个字段
  persona     text,
  voice       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_user_created_idx
  ON conversations (user_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 转写消息(realtime 会话是易失的,这是历史留存与跨设备恢复的唯一可靠途径)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            text        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON messages (conversation_id, created_at);

-- ---------------------------------------------------------------------
-- 语义记忆(step3 T1 提前纳入:本期含记忆抽取 + 语义检索)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text        NOT NULL DEFAULT 'local-user',
  content         text        NOT NULL,
  -- 记忆类目:客观事实 / 偏好 / 事件 / 人际关系 / 情绪状态
  category        text        NOT NULL DEFAULT 'fact'
                    CHECK (category IN ('fact', 'preference', 'event', 'relationship', 'emotion')),
  importance      real        NOT NULL DEFAULT 0.5,
  emotion_score   real        NOT NULL DEFAULT 0,
  -- 维度 1024:百炼 text-embedding-v3 / v4 / qwen3.7-text-embedding 的**默认**维度
  --   (官方文档:dimensions 取值 …1024、768、512…,默认 1024)
  --   https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api
  --   取默认值可在将来换 embedding 模型时不改表。
  embedding       vector(1024),
  source_conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
  last_confirmed_at timestamptz,
  last_accessed_at  timestamptz,
  archived        boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memories_user_active_idx
  ON memories (user_id)
  WHERE archived = false;

-- HNSW 余弦距离索引(pgvector 0.8+)
CREATE INDEX IF NOT EXISTS memories_embedding_idx
  ON memories USING hnsw (embedding vector_cosine_ops);
