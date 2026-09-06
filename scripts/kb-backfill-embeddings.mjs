/**
 * 向量回填脚本(开发用)—— 切换 embedding 模型后把存量数据对齐到目标向量空间。
 * 覆盖:document_chunks(检索子块,全量重写)、kg_entities(实体名,全量重写)、
 *       memories(仅补 NULL)。只重算向量,不重跑分块/图谱/摘要(LLM 零调用)。
 *
 * 端点自动二选一:
 *   - .env.local 设了 EMBEDDING_BASE_URL → 该 OpenAI 兼容端点(本地 Ollama 等)
 *   - 未设 → 百炼 compatible-mode(云端 text-embedding 系列)
 *
 * 运行:node scripts/kb-backfill-embeddings.mjs [--dry-run]
 * 幂等:可反复执行;--dry-run 只统计不写入。
 */

import { readFileSync } from "node:fs";
import { Pool } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");

function loadEnv(key) {
  const match = readFileSync(".env.local", "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].trim().replace(/^"|"$/g, "") : null;
}

const OVERRIDE_BASE = loadEnv("EMBEDDING_BASE_URL");
const DASHSCOPE_KEY = loadEnv("DASHSCOPE_API_KEY");
const MODEL = loadEnv("DASHSCOPE_EMBEDDING_MODEL") || "text-embedding-v3";
const DIMS = 1024;
const BATCH = 10;

const BASE_URL = OVERRIDE_BASE || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const HEADERS = OVERRIDE_BASE
  ? { "Content-Type": "application/json" }
  : { "Content-Type": "application/json", Authorization: `Bearer ${DASHSCOPE_KEY}` };

console.log(`目标端点:${BASE_URL} 模型:${MODEL} 维度:${DIMS}${DRY_RUN ? "(dry-run)" : ""}`);

const pool = new Pool({ connectionString: loadEnv("DATABASE_URL") });

async function embedBatch(values) {
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ model: MODEL, input: values, dimensions: DIMS }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`端点返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()).data;
  if (data.length !== values.length || data.some((d) => d.embedding.length !== DIMS)) {
    throw new Error("返回数量或维度不符");
  }
  return data.map((d) => d.embedding);
}

/** 通用回填:query 取(id, text) 行,UPDATE ... FROM (VALUES) 批量写回。 */
async function backfill(name, query, updateSql) {
  const { rows } = await pool.query(query);
  console.log(`[${name}] 待回填 ${rows.length} 条`);
  if (DRY_RUN || rows.length === 0) return;

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const embeddings = await embedBatch(slice.map((r) => r.text));
    const params = [];
    const values = slice.map((row, j) => {
      params.push(row.id, `[${embeddings[j].join(",")}]`);
      return `($${params.length - 1}::uuid, $${params.length}::vector)`;
    });
    await pool.query(
      `UPDATE ${updateSql.target} AS t SET ${updateSql.column} = v.emb
       FROM (VALUES ${values.join(",")}) AS v(id, emb) WHERE t.${updateSql.key} = v.id`,
      params,
    );
    process.stdout.write(`\r[${name}] ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  console.log("");
}

try {
  await backfill(
    "检索子块",
    `SELECT id, chunk_text AS text FROM document_chunks
     WHERE chunk_type = 'child' AND (embedding IS NULL OR TRUE)`,
    { target: "document_chunks", column: "embedding", key: "id" },
  );
  await backfill(
    "实体名",
    `SELECT id, name AS text FROM kg_entities WHERE name_embedding IS NULL OR TRUE`,
    { target: "kg_entities", column: "name_embedding", key: "id" },
  );
  await backfill(
    "记忆",
    `SELECT id, content AS text FROM memories WHERE embedding IS NULL AND archived = false`,
    { target: "memories", column: "embedding", key: "id" },
  );
  console.log(DRY_RUN ? "(dry-run,未写入)" : "回填完成");
} finally {
  await pool.end();
}
