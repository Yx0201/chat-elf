/**
 * 向量检索通道 —— 自 codeweaver vector-search.ts 移植。
 *
 * 查询向量化失败(降级返回 null)时本通道返回空数组 —— 检索是增强,
 * 不能因嵌入抖动拖垮整条链路。
 */

import { sql, type SQL } from "drizzle-orm";
import { embedText } from "@/lib/memory/embedding";
import { queryRows } from "@/lib/knowledge/sql";

export interface ChannelResult {
  chunkId: string;
  fileId: string;
  fileName: string;
  text: string;
}

/** 检索范围:kbId 缺省 = 该用户全部知识库(语音线语义)。 */
export interface SearchScope {
  userId: string;
  kbId?: string;
}

export function scopeCondition(scope: SearchScope): SQL {
  return scope.kbId
    ? sql`uf.kb_id = ${scope.kbId}::uuid`
    : sql`kb.user_id = ${scope.userId}`;
}

export async function vectorSearch(
  query: string,
  scope: SearchScope,
  topK: number,
): Promise<ChannelResult[]> {
  const embedding = await embedText(query);
  if (embedding === null) return [];
  const vectorStr = `[${embedding.join(",")}]`;

  return queryRows<ChannelResult>(sql`
    SELECT dc.id AS "chunkId",
           dc.file_id AS "fileId",
           uf.file_name AS "fileName",
           dc.chunk_text AS text,
           1 - (dc.embedding <=> ${vectorStr}::vector) AS similarity
    FROM document_chunks dc
    JOIN uploaded_files uf ON dc.file_id = uf.id
    JOIN knowledge_bases kb ON uf.kb_id = kb.id
    WHERE ${scopeCondition(scope)}
      AND dc.embedding IS NOT NULL
    ORDER BY dc.embedding <=> ${vectorStr}::vector
    LIMIT ${topK}`);
}
