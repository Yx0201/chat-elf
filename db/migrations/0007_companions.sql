-- 0007 陪伴精灵(specCoding/用户体系 step1 T4):companions 表
--
-- 执行方式(psql,非 pooled 直连串):
--   psql "$DATABASE_URL" -f db/migrations/0007_companions.sql
-- 幂等:IF NOT EXISTS,可反复执行。
--
-- 语义:用户 1:1 陪伴精灵。user_id 上的 UNIQUE 是"一次性孵化"的数据库级
-- 保证 —— 一人只有一行,重复写入由代码侧 ON CONFLICT DO NOTHING 吸收。
-- persona_name / voice 是定格时的快照(对齐 conversations.persona 的既有先例):
-- 人格日后被删除(persona_id 置 NULL)后,精灵的名字与音色仍然显示得出来。

CREATE TABLE IF NOT EXISTS companions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text        NOT NULL UNIQUE REFERENCES "user" (id) ON DELETE CASCADE,
  persona_id  uuid        REFERENCES personas (id) ON DELETE SET NULL,
  persona_name text,
  voice       text        NOT NULL,
  hatched_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS companions_persona_idx ON companions (persona_id);
