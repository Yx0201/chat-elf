-- 0010 知识库文本问答线(specCoding/知识库模块/step2 T6,2026-09-06)。
--   kb_conversations / kb_messages:与传统文本问答(选库开聊,agent 检索模式)。
--   与语音陪伴线的 conversations/messages 完全独立 —— 两种会话形态差异大
--   (语音快照 persona/voice vs 文本绑定 kb/检索模式),不共用表。
--
-- 执行方式(psql,非 pooled 直连串):
--   psql "$DATABASE_URL" -f db/migrations/0010_knowledge_chat.sql
-- 幂等:IF NOT EXISTS,可反复执行。

CREATE TABLE IF NOT EXISTS kb_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  -- 知识库被删后会话保留(仅失去检索范围,问答仍可继续)
  kb_id       uuid REFERENCES knowledge_bases (id) ON DELETE SET NULL,
  -- hybrid | graph | fast(默认 hybrid,决策 2)
  search_mode text NOT NULL DEFAULT 'hybrid'
              CONSTRAINT kb_conversations_mode_check CHECK (search_mode IN ('hybrid','graph','fast')),
  title       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_conversations_user ON kb_conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_conversations_kb ON kb_conversations (kb_id);

CREATE TABLE IF NOT EXISTS kb_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES kb_conversations (id) ON DELETE CASCADE,
  -- user | assistant(SQL CHECK 约束强制;system 由 instructions 承载不落库)
  role            text NOT NULL
                  CONSTRAINT kb_messages_role_check CHECK (role IN ('user','assistant')),
  content         text NOT NULL,
  -- assistant 消息:引用列表([N] 角标对应的文件/块)与工具轨迹,刷新还原引用 UI 用
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_messages_conversation ON kb_messages (conversation_id, created_at);
