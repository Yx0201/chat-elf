-- 0009 知识库模块 · 摄取与检索底座(specCoding/知识库模块/step1,2026-09-06)。
--   自 codeweaver 迁移的 8 张业务表 + pg_trgm 扩展;ORM 统一 Drizzle(查询侧镜像
--   见 src/lib/db/schema.ts),模型链路统一 DashScope。
--
-- 表结构相对 codeweaver 的差异(均为有意的对齐/简化):
--   · 主键统一 uuid(对齐本项目惯例,codeweaver 是 Int 自增);
--   · uploaded_files 不建 bytea 废弃列(codeweaver 的 file_data 是迁移过渡);
--   · 新增 summary 列(单文件)与 knowledge_bases.summary(KB 聚合)——
--     step2 语音线前置判断的 metadata 来源;
--   · metadata 为 jsonb,存六阶段流水线进度 state 与图谱统计。
--
-- 执行方式(psql,非 pooled 直连串):
--   psql "$DATABASE_URL" -f db/migrations/0009_knowledge_base.sql
-- 幂等:全部 IF NOT EXISTS,可反复执行。

-- pg_trgm:关键词通道的 similarity() 兜底评分依赖(本地 Homebrew PG 自带;Neon 支持)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 知识库 ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  name                text NOT NULL,
  description         text NOT NULL DEFAULT '',
  -- KB 聚合摘要(所有文档的内容范围归纳,注入 realtime instructions 用)
  summary             text,
  summary_generated_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_user ON knowledge_bases (user_id);

-- ── 上传文件 ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS uploaded_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id       uuid NOT NULL REFERENCES knowledge_bases (id) ON DELETE CASCADE,
  file_name   text NOT NULL,
  size_bytes  bigint NOT NULL DEFAULT 0,
  -- Vercel Blob 原文地址(private store,下载走签名 URL)
  blob_url    varchar(1000),
  -- UTF-8 文本缓存:分块/嵌入直接读库,不回源 Blob
  content     text,
  -- uploaded | processing | completed | failed(流水线状态机)
  status      text NOT NULL DEFAULT 'uploaded'
              CONSTRAINT uploaded_files_status_check CHECK (status IN ('uploaded','processing','completed','failed')),
  -- 单文件内容摘要(step2 前置判断 metadata;finalize 阶段 LLM 生成)
  summary     text,
  -- 流水线进度 state v2 + graph_build_stats
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_kb ON uploaded_files (kb_id);

-- ── 检索分块(父子双轨)─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id         uuid NOT NULL REFERENCES uploaded_files (id) ON DELETE CASCADE,
  -- parent = 供上下文的大块;child = 检索命中用的小块(命中后升父块)
  chunk_type      text NOT NULL
                  CONSTRAINT document_chunks_type_check CHECK (chunk_type IN ('parent','child')),
  chunk_index     integer NOT NULL DEFAULT 0,
  parent_chunk_id uuid REFERENCES document_chunks (id) ON DELETE CASCADE,
  chunk_text      text NOT NULL,
  embedding       vector(1024),
  -- 关键词通道:入库时 to_tsvector('simple', 应用层 jieba 分词结果)
  keywords        tsvector,
  -- 章/卷标题等结构信息(展示与调试用)
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_document_chunks_file ON document_chunks (file_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_parent ON document_chunks (parent_chunk_id);
-- 向量通道:HNSW 余弦(与 memories 同构;换 embedding 模型若改维度需同步改列宽)
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_hnsw
  ON document_chunks USING hnsw (embedding vector_cosine_ops);
-- 关键词通道:GIN(tsvector)
CREATE INDEX IF NOT EXISTS idx_document_chunks_keywords_gin
  ON document_chunks USING gin (keywords);
-- trigram 兜底评分(similarity())
CREATE INDEX IF NOT EXISTS idx_document_chunks_chunk_text_trgm
  ON document_chunks USING gin (chunk_text gin_trgm_ops);

-- ── 图谱专用大分块 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS graph_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id       uuid NOT NULL REFERENCES uploaded_files (id) ON DELETE CASCADE,
  chunk_index   integer NOT NULL DEFAULT 0,
  text          text NOT NULL,
  -- 小说结构:卷/章标题由分块阶段识别后前置
  chapter_title text,
  volume_title  text,
  -- 图谱构建状态机:graph_processed / processing_at(10 分钟过期重领)/ graph_error
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_graph_chunks_file ON graph_chunks (file_id);

-- ── 知识图谱:实体 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kg_entities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id          uuid NOT NULL REFERENCES knowledge_bases (id) ON DELETE CASCADE,
  name           varchar(500) NOT NULL,
  -- person | location | organization | event | concept(约定值,不建 enum)
  entity_type    varchar(50) NOT NULL DEFAULT 'concept',
  description    text,
  name_embedding vector(1024),
  name_keywords  tsvector,
  -- aliases:跨批次实体合并时记录的别名(name_keywords 同步纳入,供关键词匹配)
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kg_entities_kb ON kg_entities (kb_id);
CREATE INDEX IF NOT EXISTS idx_kg_entities_name_embedding_hnsw
  ON kg_entities USING hnsw (name_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_kg_entities_name_keywords_gin
  ON kg_entities USING gin (name_keywords);
CREATE INDEX IF NOT EXISTS idx_kg_entities_name_trgm
  ON kg_entities USING gin (name gin_trgm_ops);
-- 摄取期实体去重查找(非唯一:去重靠应用层 name_embedding 余弦合并,索引只加速查找)
CREATE INDEX IF NOT EXISTS idx_kg_entities_kb_type_lower_name
  ON kg_entities (kb_id, entity_type, lower(name));

-- ── 知识图谱:关系 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kg_relations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id            uuid NOT NULL REFERENCES knowledge_bases (id) ON DELETE CASCADE,
  relation_type    varchar(200) NOT NULL,
  description      text,
  source_entity_id uuid NOT NULL REFERENCES kg_entities (id) ON DELETE CASCADE,
  target_entity_id uuid NOT NULL REFERENCES kg_entities (id) ON DELETE CASCADE,
  -- chunk_id:关系来源图谱块(孤儿清理与块级去重的依据)
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kg_relations_kb ON kg_relations (kb_id);
CREATE INDEX IF NOT EXISTS idx_kg_relations_source ON kg_relations (source_entity_id);
CREATE INDEX IF NOT EXISTS idx_kg_relations_target ON kg_relations (target_entity_id);

-- ── 知识图谱:实体 ↔ 图谱块 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kg_entity_chunks (
  entity_id uuid NOT NULL REFERENCES kg_entities (id) ON DELETE CASCADE,
  chunk_id  uuid NOT NULL REFERENCES graph_chunks (id) ON DELETE CASCADE,
  PRIMARY KEY (entity_id, chunk_id)
);
