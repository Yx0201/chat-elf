-- 0005 记忆来源标记(step3 T2)
--
-- 执行方式(psql):
--   psql "$DATABASE_URL" -f db/migrations/0005_memory_source.sql
--
-- 区分两条写入轨(spec §4 的"双轨写入"):
--   batch    = 会话结束后由 LLM 批量抽取(step1 已有)
--   realtime = 会话中模型通过 function call 当场标记(step3 T2)
--
-- 标出来的用途:将来评估"哪条轨的召回质量更高",以及定位异常数据来自哪条轨。

ALTER TABLE memories ADD COLUMN IF NOT EXISTS
  source text NOT NULL DEFAULT 'batch';

-- 约束放在列上而不是靠应用层自觉:拼写错误会在写入时就失败
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_source_check;
ALTER TABLE memories ADD CONSTRAINT memories_source_check
  CHECK (source IN ('batch', 'realtime'));
