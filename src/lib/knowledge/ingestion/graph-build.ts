/**
 * 知识图谱构建写路径 —— 自 codeweaver knowledge-graph.ts 移植
 * (echarts 可视化的读路径 getKnowledgeGraphData 未移植,本模块只做写入与清理)。
 *
 * 核心是 `resolveEntityIds` 的五步批量化(原 N×4 次往返压缩到 ~5 次,
 * 远程库上这是秒级与分钟级的差别):
 *  1. 一次 embedMany 嵌入全部实体名;
 *  2. 一次 SELECT 精确名/别名匹配;
 *  3. 一次向量相似度 SELECT(unnest + LATERAL)处理未命中项;
 *  4. 相似命中项并发别名合并(数量少,实体 id 互不相同,安全);
 *  5. 真新实体一次多行 INSERT + 一次批量 UPDATE 回填向量/关键词。
 *
 * 实体合并阈值 ENTITY_MERGE_SIMILARITY(默认 0.92 余弦):
 * 高于阈值并入既有实体并记录别名,否则新建。
 */

import { sql } from "drizzle-orm";
import { embedTexts } from "@/lib/memory/embedding";
import { ENTITY_MERGE_SIMILARITY } from "@/lib/knowledge/config";
import { toTsvectorInput } from "@/lib/knowledge/tokenizer";
import {
  executeStatement,
  intArrayParam,
  queryRows,
  textArrayParam,
  vectorArrayParam,
} from "@/lib/knowledge/sql";
import type { ExtractedEntity, ExtractedRelation } from "./graph-extractor";

export interface KnowledgeGraphChunkIngestion {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** 关系名归一:压空白、去首尾引号/标点,截 30 字(语义相同的关系折叠)。 */
function normalizeRelationName(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .replace(/^[\s"'""''《》【】()（）.,,。;；::!!??-]+/, "")
    .replace(/[\s"'""''《》【】()（）.,,。;；::!!??-]+$/, "")
    .trim()
    .slice(0, 30);
}

function dedupeEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const entityMap = new Map<string, ExtractedEntity>();

  for (const entity of entities) {
    const normalizedName = normalizeName(entity.name);
    if (!normalizedName) continue;

    const key = `${entity.entity_type}:${normalizedName.toLowerCase()}`;
    const existing = entityMap.get(key);
    if (!existing || (!existing.description && entity.description)) {
      entityMap.set(key, { ...entity, name: normalizedName });
    }
  }

  return [...entityMap.values()];
}

function dedupeRelations(relations: ExtractedRelation[]): ExtractedRelation[] {
  const relationMap = new Map<string, ExtractedRelation>();

  for (const relation of relations) {
    const source = normalizeName(relation.source);
    const target = normalizeName(relation.target);
    const relationName = normalizeRelationName(relation.relation);
    if (!source || !target || !relationName) continue;

    const key = `${source.toLowerCase()}|${relationName.toLowerCase()}|${target.toLowerCase()}`;
    const existing = relationMap.get(key);
    if (!existing || (!existing.description && relation.description)) {
      relationMap.set(key, { ...relation, source, target, relation: relationName });
    }
  }

  return [...relationMap.values()];
}

interface ExactMatchRow {
  id: string;
  name: string;
  description: string | null;
  aliases: string[] | null;
}

/**
 * 批量把抽取实体解析为 kg_entities id。
 * 返回 `lowercase(name) -> entityId`(命中/合并/新建三者都覆盖)。
 */
async function resolveEntityIds(
  kbId: string,
  entities: ExtractedEntity[],
): Promise<Map<string, string>> {
  const idMap = new Map<string, string>();

  const items = entities
    .map((e) => ({
      name: normalizeName(e.name),
      type: e.entity_type,
      desc: e.description ?? null,
    }))
    .filter((it) => it.name);
  if (items.length === 0) return idMap;

  const lowerNames = items.map((it) => it.name.toLowerCase());
  const lowerNameSet = new Set(lowerNames);

  // Step 1:全部实体名一次嵌入(替代 N 次调用)。
  const embeddings = await embedTexts(items.map((it) => it.name));

  // Step 2:精确名/别名一次批量匹配(数组参数化,无字符串拼接)。
  const exactRows = await queryRows<ExactMatchRow>(sql`
    SELECT id, name, description,
           (SELECT array_agg(a) FROM jsonb_array_elements_text(COALESCE(metadata->'aliases','[]'::jsonb)) a) AS aliases
    FROM kg_entities
    WHERE kb_id = ${kbId}::uuid
      AND (
        lower(name) = ANY(${textArrayParam(lowerNames)})
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(metadata->'aliases','[]'::jsonb)) a
          WHERE lower(a) = ANY(${textArrayParam(lowerNames)})
        )
      )`);

  // 把命中的规范名/别名映射回实体 id;顺带回填缺失的 description。
  const descBackfill: Array<{ id: string; desc: string }> = [];
  for (const row of exactRows) {
    const ln = row.name.toLowerCase();
    if (lowerNameSet.has(ln)) {
      idMap.set(ln, row.id);
      if (!row.description) {
        const item = items.find((it) => it.name.toLowerCase() === ln);
        if (item?.desc) descBackfill.push({ id: row.id, desc: item.desc });
      }
    }
    for (const alias of row.aliases ?? []) {
      const al = alias.toLowerCase();
      if (lowerNameSet.has(al)) idMap.set(al, row.id);
    }
  }

  if (descBackfill.length > 0) {
    const values = sql.join(
      descBackfill.map((d) => sql`(${d.id}::uuid, ${d.desc})`),
      sql`, `,
    );
    await executeStatement(sql`
      UPDATE kg_entities AS e
      SET description = v.descr
      FROM (VALUES ${values}) AS v(id, descr)
      WHERE e.id = v.id AND e.description IS NULL`);
  }

  // 未命中项(无精确/别名匹配)。
  const unresolvedIdx: number[] = [];
  const unresolvedTypes: string[] = [];
  const unresolvedVectors: string[] = [];
  items.forEach((it, i) => {
    if (!idMap.has(it.name.toLowerCase())) {
      unresolvedIdx.push(i);
      unresolvedTypes.push(it.type);
      unresolvedVectors.push(`[${embeddings[i].join(",")}]`);
    }
  });

  if (unresolvedIdx.length === 0) return idMap;

  // Step 3:未命中项一次批量向量相似度匹配(unnest + LATERAL,数组参数化)。
  const simRows = await queryRows<{ idx: number; id: string; name: string; sim: number }>(sql`
    SELECT q.idx, e.id, e.name, 1 - (e.name_embedding <=> q.emb) AS sim
    FROM unnest(
           ${intArrayParam(unresolvedIdx)},
           ${textArrayParam(unresolvedTypes)},
           ${vectorArrayParam(unresolvedVectors)}
         ) AS q(idx, etype, emb)
    CROSS JOIN LATERAL (
      SELECT id, name, name_embedding
      FROM kg_entities
      WHERE kb_id = ${kbId}::uuid
        AND entity_type = q.etype
        AND name_embedding IS NOT NULL
      ORDER BY name_embedding <=> q.emb
      LIMIT 1
    ) e`);

  const simByOrigIdx = new Map<number, { id: string; name: string; sim: number }>();
  for (const r of simRows) simByOrigIdx.set(r.idx, { id: r.id, name: r.name, sim: r.sim });

  const toMerge: Array<{ entityId: string; canonicalName: string; alias: string }> = [];
  const toCreate: Array<{ name: string; type: string; vector: string }> = [];

  unresolvedIdx.forEach((origIdx, pos) => {
    const item = items[origIdx];
    const match = simByOrigIdx.get(origIdx);
    if (match && match.sim >= ENTITY_MERGE_SIMILARITY) {
      idMap.set(item.name.toLowerCase(), match.id);
      toMerge.push({ entityId: match.id, canonicalName: match.name, alias: item.name });
    } else {
      toCreate.push({ name: item.name, type: item.type, vector: unresolvedVectors[pos] });
    }
  });

  // Step 4:并发别名合并(数量少,实体 id 互不相同,无写冲突)。
  if (toMerge.length > 0) {
    await Promise.all(toMerge.map((m) => addEntityAlias(m.entityId, m.canonicalName, m.alias)));
  }

  // Step 5:真新实体一次多行 INSERT,再一次批量 UPDATE 回填向量/关键词。
  if (toCreate.length > 0) {
    const insValues = sql.join(
      toCreate.map((c) => sql`(${crypto.randomUUID()}::uuid, ${kbId}::uuid, ${c.name}, ${c.type})`),
      sql`, `,
    );
    const created = await queryRows<{ id: string; name: string }>(sql`
      INSERT INTO kg_entities (id, kb_id, name, entity_type)
      VALUES ${insValues}
      RETURNING id, name`);

    created.forEach((row) => idMap.set(row.name.toLowerCase(), row.id));

    const upValues = sql.join(
      created.map((row, i) => sql`(${row.id}::uuid, ${toCreate[i].vector}::vector, ${toTsvectorInput(toCreate[i].name)})`),
      sql`, `,
    );
    await executeStatement(sql`
      UPDATE kg_entities AS e
      SET name_embedding = v.emb,
          name_keywords = to_tsvector('simple', v.kw)
      FROM (VALUES ${upValues}) AS v(id, emb, kw)
      WHERE e.id = v.id`);
  }

  return idMap;
}

/**
 * 在既有实体上记录别名并刷新 name_keywords(规范名 + 全部别名一起分词),
 * 让关键词/图谱实体查找能命中别名。
 */
async function addEntityAlias(
  entityId: string,
  canonicalName: string,
  alias: string,
): Promise<void> {
  try {
    const rows = await queryRows<{ metadata: Record<string, unknown> | null }>(
      sql`SELECT metadata FROM kg_entities WHERE id = ${entityId}::uuid LIMIT 1`,
    );
    const meta = rows[0]?.metadata ?? null;
    const existingAliases = Array.isArray(meta?.aliases) ? (meta?.aliases as string[]) : [];

    const allNames = [canonicalName, alias, ...existingAliases];
    const tokenizedAll = allNames.map((n) => toTsvectorInput(n)).join(" ");

    await executeStatement(sql`
      UPDATE kg_entities
      SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{aliases}',
            (
              SELECT jsonb_agg(DISTINCT v)
              FROM jsonb_array_elements_text(
                COALESCE(metadata -> 'aliases', '[]'::jsonb) || to_jsonb(ARRAY[${alias}]::text[])
              ) v
            )
          ),
          name_keywords = to_tsvector('simple', ${tokenizedAll})
      WHERE id = ${entityId}::uuid`);
  } catch (error) {
    console.error("[knowledge] 记录实体别名失败:", error instanceof Error ? error.message : error);
  }
}

/** LLM 抽取 + 去重(块内归一),不落库 —— 与写入分离便于并行。 */
export async function prepareKnowledgeGraphChunkIngestion(
  chunkText: string,
): Promise<KnowledgeGraphChunkIngestion> {
  const { extractEntitiesAndRelations } = await import("./graph-extractor");
  const extraction = await extractEntitiesAndRelations(chunkText);

  return {
    entities: dedupeEntities(extraction.entities),
    relations: dedupeRelations(extraction.relations),
  };
}

/** 把一次抽取结果写入图谱表(实体解析 → 实体↔块关联 → 关系,全部批量化)。 */
export async function writeKnowledgeGraphChunkIngestion(params: {
  kbId: string;
  graphChunkId: string;
  extraction: KnowledgeGraphChunkIngestion;
}): Promise<void> {
  const { kbId, graphChunkId, extraction } = params;
  const { entities, relations } = extraction;

  if (entities.length === 0 && relations.length === 0) return;

  const idMap = await resolveEntityIds(kbId, entities);

  // 实体↔块关联:一次多行 INSERT,ON CONFLICT 去重。
  const seenPairs = new Set<string>();
  const pairs: string[] = [];
  for (const entity of entities) {
    const entityId = idMap.get(normalizeName(entity.name).toLowerCase());
    if (!entityId) continue;
    const key = `${entityId}|${graphChunkId}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    pairs.push(entityId);
  }
  if (pairs.length > 0) {
    const values = sql.join(
      pairs.map((id) => sql`(${id}::uuid, ${graphChunkId}::uuid)`),
      sql`, `,
    );
    await executeStatement(sql`
      INSERT INTO kg_entity_chunks (entity_id, chunk_id)
      VALUES ${values}
      ON CONFLICT (entity_id, chunk_id) DO NOTHING`);
  }

  // 关系:块内去重 → 查本块已有 → 增量插入。
  const relSeen = new Set<string>();
  const rels = relations
    .map((r) => ({
      source: idMap.get(normalizeName(r.source).toLowerCase()),
      target: idMap.get(normalizeName(r.target).toLowerCase()),
      type: normalizeRelationName(r.relation),
      description: r.description ?? null,
    }))
    .filter((r): r is { source: string; target: string; type: string; description: string | null } =>
      Boolean(r.source && r.target && r.type));

  const uniqueRels = rels.filter((r) => {
    const k = `${r.source}|${r.target}|${r.type}`;
    if (relSeen.has(k)) return false;
    relSeen.add(k);
    return true;
  });

  if (uniqueRels.length === 0) return;

  const existing = await queryRows<{ s: string; t: string; rt: string }>(sql`
    SELECT source_entity_id AS s, target_entity_id AS t, relation_type AS rt
    FROM kg_relations
    WHERE kb_id = ${kbId}::uuid AND metadata ->> 'chunk_id' = ${graphChunkId}`);
  const existSet = new Set(existing.map((e) => `${e.s}|${e.t}|${e.rt}`));
  const toInsert = uniqueRels.filter((r) => !existSet.has(`${r.source}|${r.target}|${r.type}`));

  if (toInsert.length > 0) {
    const values = sql.join(
      toInsert.map(
        (r) => sql`(${crypto.randomUUID()}::uuid, ${kbId}::uuid, ${r.source}::uuid, ${r.target}::uuid, ${r.type}, ${r.description}, ${JSON.stringify({ chunk_id: graphChunkId })}::jsonb)`,
      ),
      sql`, `,
    );
    await executeStatement(sql`
      INSERT INTO kg_relations (id, kb_id, source_entity_id, target_entity_id, relation_type, description, metadata)
      VALUES ${values}`);
  }
}

/**
 * 孤儿清理:删除来源图谱块已不存在的关系,以及不再被任何块引用的实体。
 * graphSplit 与 finalize 阶段各调一次。
 */
export async function cleanupKnowledgeGraph(kbId: string): Promise<void> {
  await executeStatement(sql`
    DELETE FROM kg_relations r
    WHERE r.kb_id = ${kbId}::uuid
      AND (
        (r.metadata ->> 'chunk_id') IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM graph_chunks gc
          JOIN uploaded_files uf ON uf.id = gc.file_id
          WHERE gc.id = (r.metadata ->> 'chunk_id')::uuid
            AND uf.kb_id = ${kbId}::uuid
        )
      )`);

  await executeStatement(sql`
    DELETE FROM kg_entities e
    WHERE e.kb_id = ${kbId}::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM kg_entity_chunks ec
        JOIN graph_chunks gc ON gc.id = ec.chunk_id
        JOIN uploaded_files uf ON uf.id = gc.file_id
        WHERE ec.entity_id = e.id
          AND uf.kb_id = ${kbId}::uuid
      )`);
}
