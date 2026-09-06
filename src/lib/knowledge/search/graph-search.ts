/**
 * 图谱检索通道 —— 自 codeweaver graph-search.ts 移植。
 *
 * 流程:LLM 从查询提取实体(≤5 个)→ 图谱实体匹配(ILIKE/trigram + 批量
 * name_embedding 余弦,覆盖别名)→ 0/1/2 跳遍历收集关联图谱块 →
 * 按实体数累加打分(0 跳 1.0 / 1 跳 0.3 / 2 跳 0.1;1 跳 >15 个不扩 2 跳,
 * 大邻域扩 2 跳只会加噪音)。
 *
 * 多个查询实体同时命中的块得分累加 —— 两个实体的块(2.0)排在一个实体的(1.0)之上。
 */

import { sql } from "drizzle-orm";
import { GRAPH_ENTITY_MATCH_SIMILARITY } from "@/lib/knowledge/config";
import { queryRows, textArrayParam, uuidArrayParam, vectorArrayParam } from "@/lib/knowledge/sql";
import { embedTexts } from "@/lib/memory/embedding";
import { extractQueryEntities } from "@/lib/knowledge/ingestion/graph-extractor";
import type { ChannelResult, SearchScope } from "./vector-search";

function scope(scopeObj: SearchScope) {
  return scopeObj.kbId
    ? sql`e.kb_id = ${scopeObj.kbId}::uuid`
    : sql`kb.user_id = ${scopeObj.userId}`;
}

export interface GraphChannelResult extends ChannelResult {
  score: number;
}

export async function graphSearch(
  query: string,
  scopeObj: SearchScope,
  topK: number,
): Promise<GraphChannelResult[]> {
  const queryEntities = await extractQueryEntities(query);
  if (queryEntities.length === 0) return [];

  const matchedEntityIds = await findMatchingEntities(queryEntities, scopeObj);
  if (matchedEntityIds.length === 0) return [];

  const chunkScores = await traverseAndGetChunks(matchedEntityIds, scopeObj);
  if (chunkScores.size === 0) return [];

  const chunkIds = [...chunkScores.keys()];
  const rows = await queryRows<{ id: string; fileId: string; fileName: string; text: string }>(sql`
    SELECT gc.id, gc.file_id AS "fileId", uf.file_name AS "fileName", gc.text
    FROM graph_chunks gc
    JOIN uploaded_files uf ON gc.file_id = uf.id
    WHERE gc.id = ANY(${uuidArrayParam(chunkIds)})`);

  return rows
    .map((row) => ({
      chunkId: row.id,
      fileId: row.fileId,
      fileName: row.fileName,
      text: row.text,
      score: chunkScores.get(row.id) ?? 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * 查询实体 → 图谱实体匹配:关键词(ILIKE 双向包含 + trigram,别名经
 * name_keywords 同步可命中)与向量相似度两路,各一次批量查询。
 */
async function findMatchingEntities(entityNames: string[], scopeObj: SearchScope): Promise<string[]> {
  const entityIds = new Set<string>();

  const keywordRows = await queryRows<{ id: string }>(sql`
    SELECT DISTINCT e.id
    FROM kg_entities e
    JOIN knowledge_bases kb ON e.kb_id = kb.id
    JOIN unnest(${textArrayParam(entityNames)}) AS q(name) ON
      e.name ILIKE '%' || q.name || '%'
      OR q.name ILIKE '%' || e.name || '%'
      OR similarity(e.name, q.name) > 0.25
    WHERE ${scope(scopeObj)}
    LIMIT ${entityNames.length * 5}`);
  for (const row of keywordRows) entityIds.add(row.id);

  try {
    const embeddings = await embedTexts(entityNames);
    const vectorStrs = embeddings.map((e) => `[${e.join(",")}]`);

    const vectorRows = await queryRows<{ id: string }>(sql`
      SELECT DISTINCT m.id
      FROM unnest(${vectorArrayParam(vectorStrs)}) AS q(emb)
      CROSS JOIN LATERAL (
        SELECT e.id
        FROM kg_entities e
        JOIN knowledge_bases kb ON e.kb_id = kb.id
        WHERE ${scope(scopeObj)}
          AND e.name_embedding IS NOT NULL
          AND 1 - (e.name_embedding <=> q.emb) >= ${GRAPH_ENTITY_MATCH_SIMILARITY}
        ORDER BY e.name_embedding <=> q.emb
        LIMIT 5
      ) m`);
    for (const row of vectorRows) entityIds.add(row.id);
  } catch (error) {
    // 实体名向量化失败(嵌入抖动)只损失一路匹配,不中断
    console.error("[knowledge] 图谱实体向量匹配失败:", error instanceof Error ? error.message : error);
  }

  return [...entityIds];
}

/** 0/1/2 跳遍历:收集块并按跳数加权累分。 */
async function traverseAndGetChunks(
  seedEntityIds: string[],
  scopeObj: SearchScope,
): Promise<Map<string, number>> {
  const chunkScores = new Map<string, number>();

  await addChunksForEntities(seedEntityIds, 1.0, chunkScores);

  const oneHopIds = await getRelatedEntities(seedEntityIds, scopeObj);
  if (oneHopIds.length > 0) {
    await addChunksForEntities(oneHopIds, 0.3, chunkScores);

    // 1 跳邻域过大时 2 跳基本只剩噪音
    if (oneHopIds.length <= 15) {
      const twoHopIds = await getRelatedEntities(oneHopIds, scopeObj);
      if (twoHopIds.length > 0) {
        await addChunksForEntities(twoHopIds, 0.1, chunkScores);
      }
    }
  }

  return chunkScores;
}

async function addChunksForEntities(
  entityIds: string[],
  scorePerEntity: number,
  chunkScores: Map<string, number>,
): Promise<void> {
  const rows = await queryRows<{ chunk_id: string; entity_count: number }>(sql`
    SELECT chunk_id, COUNT(DISTINCT entity_id)::int AS entity_count
    FROM kg_entity_chunks
    WHERE entity_id = ANY(${uuidArrayParam(entityIds)})
    GROUP BY chunk_id`);

  for (const row of rows) {
    const existing = chunkScores.get(row.chunk_id) ?? 0;
    chunkScores.set(row.chunk_id, existing + scorePerEntity * row.entity_count);
  }
}

async function getRelatedEntities(entityIds: string[], scopeObj: SearchScope): Promise<string[]> {
  const seedSet = new Set(entityIds);
  const relatedIds = new Set<string>();

  const rows = await queryRows<{ source_entity_id: string; target_entity_id: string }>(sql`
    SELECT source_entity_id, target_entity_id
    FROM kg_relations r
    JOIN knowledge_bases kb ON r.kb_id = kb.id
    WHERE ${scopeObj.kbId ? sql`r.kb_id = ${scopeObj.kbId}::uuid` : sql`kb.user_id = ${scopeObj.userId}`}
      AND (source_entity_id = ANY(${uuidArrayParam(entityIds)}) OR target_entity_id = ANY(${uuidArrayParam(entityIds)}))`);

  for (const row of rows) {
    if (!seedSet.has(row.source_entity_id)) relatedIds.add(row.source_entity_id);
    if (!seedSet.has(row.target_entity_id)) relatedIds.add(row.target_entity_id);
  }

  return [...relatedIds].slice(0, 30); // 限制邻域扩张
}
