-- 0004 画像层(step3 T4):user_profile 表
--
-- 执行方式(psql):
--   psql "$DATABASE_URL" -f db/migrations/0004_user_profile.sql
--
-- 双层分工(README §2.3 / spec §4 T4):
--   碎片层 memories  —— ADD-only,新旧事实共存,靠时间戳消解,不覆盖不删除;
--   画像层 user_profile —— 每次**整体重写**,由 LLM 依据时间戳把冲突消解成"现居上海(原在北京)"。
-- 重写只发生在画像层,事实层不动:既得到凝练画像,又保留时序可追溯。
--
-- 韧性要求:画像只依赖 memories 表(memories.source_conversation_id 是 on delete set null),
-- 对话记录清空后画像仍完整可用 —— "转写没了画像还在"是设计要求。

CREATE TABLE IF NOT EXISTS user_profile (
  user_id     text PRIMARY KEY,
  /** LLM 整合出的人物速写(第三人称,≤300 字) */
  summary     text        NOT NULL DEFAULT '',
  /** 结构化画像字段,如 {"职业":"后端","居住":"杭州"} */
  traits      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  /**
   * 距上次画像整合以来新结束的会话数。达到阈值才重写 ——
   * 每会话都重写成本高且无必要(spec 待决策项 2 的选定值:N=3)。
   */
  pending_conversations int NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  /** 最近一次 LLM 整体重写的时间;从未整合过为 NULL */
  refreshed_at timestamptz
);
