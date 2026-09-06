/**
 * 关键词检索通道 —— 自 codeweaver keyword-search.ts 移植。
 *
 * 管线:应用层 jieba 分词 → AND/OR tsquery → tsvector 召回
 *   (`dc.keywords @@ to_tsquery('simple', $orQuery)`,仅 child 块)
 * → 评分混合:
 *     2 × ts_rank_cd(AND)  —— 全词命中的块重奖
 *   + 1 × ts_rank_cd(OR)   —— 任一词命中保底
 *   + 0.2 × similarity()   —— pg_trgm 字符级加成(短/精确查询友好)
 */

import { sql } from "drizzle-orm";
import { buildAndTsquery, buildOrTsquery } from "@/lib/knowledge/tokenizer";
import { queryRows } from "@/lib/knowledge/sql";
import type { ChannelResult, SearchScope } from "./vector-search";

export async function keywordSearch(
  query: string,
  scope: SearchScope,
  topK: number,
): Promise<ChannelResult[]> {
  const andQuery = buildAndTsquery(query);
  const orQuery = buildOrTsquery(query);
  if (orQuery === "") return []; // 分词后无内容词元,无从召回

  return queryRows<ChannelResult>(sql`
    SELECT dc.id AS "chunkId",
           dc.file_id AS "fileId",
           uf.file_name AS "fileName",
           dc.chunk_text AS text,
           (
             CASE WHEN ${andQuery} <> '' AND dc.keywords @@ to_tsquery('simple', ${andQuery})
                  THEN 2.0 * ts_rank_cd(dc.keywords, to_tsquery('simple', ${andQuery}), 32)
                  ELSE 0
             END
             + ts_rank_cd(dc.keywords, to_tsquery('simple', ${orQuery}), 32)
             + 0.2 * similarity(dc.chunk_text, ${query})
           ) AS rank
    FROM document_chunks dc
    JOIN uploaded_files uf ON dc.file_id = uf.id
    JOIN knowledge_bases kb ON uf.kb_id = kb.id
    WHERE ${scope.kbId ? sql`uf.kb_id = ${scope.kbId}::uuid` : sql`kb.user_id = ${scope.userId}`}
      AND dc.chunk_type = 'child'
      AND dc.keywords @@ to_tsquery('simple', ${orQuery})
    ORDER BY rank DESC
    LIMIT ${topK}`);
}
