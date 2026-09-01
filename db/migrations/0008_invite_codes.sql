-- 0008 注册邀请码(内测准入,2026-09-01 用户需求):注册(/sign-up/email)时
--   必须携带数据库中存在且 active 的邀请码,比对一致才放行。
--
-- 定位:准入门槛而非安全机制 —— 明文比对,不做哈希。
-- 只挡注册不挡登录:已注册用户登 /sign-in/email 不校验邀请码。
--
-- 执行方式(psql,非 pooled 直连串):
--   psql "$DATABASE_URL" -f db/migrations/0008_invite_codes.sql
-- 幂等:IF NOT EXISTS,可反复执行。
--
-- ⚠️ 本迁移只建表、不预置码。生成并插入你的邀请码(自行换成真实值):
--   INSERT INTO invite_codes (code, note) VALUES ('你的邀请码', '内测主码');
-- 停用一个码(泄露/作废):
--   UPDATE invite_codes SET active = false WHERE code = '...';

CREATE TABLE IF NOT EXISTS invite_codes (
  code       text PRIMARY KEY,
  note       text        NOT NULL DEFAULT '',
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 内测主码(2026-09-01 用户提供;ON CONFLICT 幂等,重跑安全)
INSERT INTO invite_codes (code, note) VALUES ('thebestisbbimasheep', '内测主码')
ON CONFLICT (code) DO NOTHING;
