-- 0006 用户体系(specCoding/用户体系 step1 T1):Better Auth 核心四表
--   + 业务表 user_id 去默认值 + 清理单用户阶段 local-user 旧数据(spec §7 决策 4)
--
-- 执行方式(psql,注意迁移/DDL 走非 pooled 直连串):
--   psql "$DATABASE_URL" -f db/migrations/0006_auth.sql
-- 幂等:建表/索引用 IF NOT EXISTS,DELETE 天然幂等,可反复执行。
--
-- 列结构依据(2026-09-01 核实):
--   - @better-auth/cli generate 的产出作参考(其 account 表滞后、缺 issuer 列);
--   - 运行时源码为准:better-auth@1.7.2 sign-up 调 linkAccount({providerId:'credential',
--     issuer:'local:credential', accountId:user.id, password:hash}),sign-in 按
--     providerId + issuer + accountId 三元组匹配 —— issuer 列与复合唯一索引必须存在。

-- ---------------------------------------------------------------------
-- user / session / account / verification
-- ---------------------------------------------------------------------
-- "user" 是 Postgres 保留字,SQL 里必须带双引号引用。
CREATE TABLE IF NOT EXISTS "user" (
  id            text PRIMARY KEY,
  name          text        NOT NULL,
  email         text        NOT NULL UNIQUE,
  email_verified boolean     NOT NULL DEFAULT false,
  image         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "session" (
  id          text PRIMARY KEY,
  expires_at  timestamptz NOT NULL,
  token       text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  ip_address  text,
  user_agent  text,
  user_id     text        NOT NULL REFERENCES "user" (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS session_user_id_idx ON "session" (user_id);

CREATE TABLE IF NOT EXISTS "account" (
  id                        text PRIMARY KEY,
  account_id                text NOT NULL,
  provider_id               text NOT NULL,
  -- 身份命名空间;credential 策略下为 'local:credential'
  issuer                    text,
  user_id                   text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  access_token              text,
  refresh_token             text,
  id_token                  text,
  access_token_expires_at   timestamptz,
  refresh_token_expires_at  timestamptz,
  scope                     text,
  -- credential 登录的密码哈希(scrypt)
  password                  text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_user_id_idx ON "account" (user_id);
-- 每个身份唯一:同一 issuer 下的 account_id 不得重复(官方文档要求)
CREATE UNIQUE INDEX IF NOT EXISTS account_issuer_account_id_idx
  ON "account" (issuer, account_id);

CREATE TABLE IF NOT EXISTS "verification" (
  id          text PRIMARY KEY,
  identifier  text        NOT NULL,
  value       text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS verification_identifier_idx ON "verification" (identifier);

-- ---------------------------------------------------------------------
-- 业务表 user_id 去掉 'local-user' 默认值
-- (代码侧已全部显式传 session userId;user_profile.user_id 是主键、无默认值)
-- ---------------------------------------------------------------------
ALTER TABLE conversations ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE memories     ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE personas     ALTER COLUMN user_id DROP DEFAULT;

-- ---------------------------------------------------------------------
-- 清理单用户阶段旧数据(spec §7 决策 4:直接删除,不迁移)
-- ---------------------------------------------------------------------
-- 顺序:conversations 级联清掉 messages/feedback;memories 的
-- source_conversation_id 为 SET NULL,先删会话再删记忆即可。
DELETE FROM conversations WHERE user_id = 'local-user';
DELETE FROM memories      WHERE user_id = 'local-user';
DELETE FROM user_profile  WHERE user_id = 'local-user';
DELETE FROM personas      WHERE user_id = 'local-user';
