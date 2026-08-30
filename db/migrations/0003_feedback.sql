-- 0003 反馈闭环(step2 T4):单条回复的 👍/👎 埋点
--
-- 执行方式(psql):
--   psql "$DATABASE_URL" -f db/migrations/0003_feedback.sql
--
-- 只埋点、不分析(step2 明确不做自动人设调优)。攒数据是为将来的人设迭代留依据 ——
-- 对应 README §2.2 调研结论里 Character.AI 的星级反馈闭环。
--
-- message_id 唯一:同一条消息只保留一个最终评价。
--   - 点 👍 再点 👎 = 改判(UPSERT);
--   - 点同一个 = 撤销(DELETE)。
-- 之所以不存 (+1 与 -1) 两条记录:同一条消息同时被点赞和点踩没有分析价值,
-- 反而要在使用侧做去重聚合。

CREATE TABLE IF NOT EXISTS feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  score       smallint    NOT NULL CHECK (score IN (-1, 1)),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS feedback_message_idx
  ON feedback (message_id);
