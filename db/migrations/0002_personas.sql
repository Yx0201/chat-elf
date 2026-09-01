-- 0002 人格系统(step2 T1):personas 表 + 人格矩阵 + conversations 外键
--
-- 执行方式(psql):
--   psql "$DATABASE_URL" -f db/migrations/0002_personas.sql
-- 幂等:建表/建索引用 IF NOT EXISTS,可反复执行。

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------
-- 人格
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS personas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text        NOT NULL,
  name        text        NOT NULL,
  -- 头像占位:ui spec §7 待决策项 3 推荐本期用 Emoji
  emoji       text        NOT NULL DEFAULT '',
  tagline     text        NOT NULL DEFAULT '',
  -- 模板来源 id(如 'xiaoyou');用户自建的人格为 NULL
  archetype   text,
  -- 人格矩阵:{warmth,energy,humor,chattiness,initiative,closeness} 各 0-100
  traits      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  voice       text        NOT NULL,
  -- 人格本体 / 背景故事;渲染时作为 instructions 的"身份与背景"段
  backstory   text        NOT NULL DEFAULT '',
  -- 行为边界:绝不做什么
  boundaries  text        NOT NULL DEFAULT '',
  is_preset   boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS personas_user_idx
  ON personas (user_id, updated_at DESC);

-- 每个用户下 archetype 唯一:种子可幂等重复插入,也防止同一预设被播种两次
CREATE UNIQUE INDEX IF NOT EXISTS personas_user_archetype_idx
  ON personas (user_id, archetype)
  WHERE archetype IS NOT NULL;

-- ---------------------------------------------------------------------
-- conversations → personas
-- ---------------------------------------------------------------------
-- 注意:原有的 persona / voice **文本列保留**。它们是会话发生时的展示快照 ——
-- 人格被删除后(ON DELETE SET NULL),历史列表仍要能显示"当时聊的是谁"。
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS
  persona_id uuid REFERENCES personas (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS conversations_persona_idx
  ON conversations (persona_id);
-- ---------------------------------------------------------------------
-- 种子段已移除(2026-09-01,用户体系 step1):预设人格改为注册时由
-- TS 侧 seedPresetsForUser() 从 src/lib/persona/presets.ts 播种 ——
-- SQL/TS 双源同步问题就此消灭,历史 local-user 种子由 0006 清理。
