/**
 * 知识库数据访问层(Drizzle)—— 纯服务端模块。
 *
 * 全部查询显式带 userId 归属过滤(经 kb 归属或 user_id 直查),
 * 客户端传入的 id 一律先过 UUID 校验再进库。
 */

import { and, count, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { createInitialProcessState } from "@/lib/knowledge/ingestion/process-pipeline";
import {
  documentChunks,
  graphChunks,
  kgEntities,
  kgRelations,
  knowledgeBases,
  uploadedFiles,
  type KnowledgeBaseRow,
  type UploadedFileRow,
} from "@/lib/db/schema";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidKbId(id: string): boolean {
  return UUID_RE.test(id);
}

export function isValidFileId(id: string): boolean {
  return UUID_RE.test(id);
}

/** 用户的全部知识库(按更新时间倒序)。 */
export async function listKnowledgeBases(
  userId: string,
): Promise<Array<KnowledgeBaseRow & { fileCount: number }>> {
  const db = getDb();
  const [kbRows, countRows] = await Promise.all([
    db
      .select()
      .from(knowledgeBases)
      .where(eq(knowledgeBases.userId, userId))
      .orderBy(desc(knowledgeBases.updatedAt)),
    db
      .select({ kbId: uploadedFiles.kbId, value: count() })
      .from(uploadedFiles)
      .innerJoin(knowledgeBases, eq(uploadedFiles.kbId, knowledgeBases.id))
      .where(eq(knowledgeBases.userId, userId))
      .groupBy(uploadedFiles.kbId),
  ]);
  const countMap = new Map(countRows.map((row) => [row.kbId, row.value]));
  return kbRows.map((kb) => ({ ...kb, fileCount: countMap.get(kb.id) ?? 0 }));
}

/** 取用户的一个知识库(归属过滤:他人的 id 视为不存在)。 */
export async function getKnowledgeBase(
  userId: string,
  kbId: string,
): Promise<KnowledgeBaseRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createKnowledgeBase(
  userId: string,
  input: { name: string; description: string },
): Promise<KnowledgeBaseRow> {
  const db = getDb();
  const [row] = await db
    .insert(knowledgeBases)
    .values({ userId, name: input.name, description: input.description })
    .returning();
  return row;
}

/**
 * 删除知识库:先取文件 blob_url 清理远端,再删库(级联清 chunks/图谱)。
 * Blob 删除失败容忍孤儿(见 blob.ts),不阻断。
 */
export async function deleteKnowledgeBase(userId: string, kbId: string): Promise<boolean> {
  const db = getDb();
  const files = await db
    .select({ blobUrl: uploadedFiles.blobUrl })
    .from(uploadedFiles)
    .innerJoin(knowledgeBases, eq(uploadedFiles.kbId, knowledgeBases.id))
    .where(and(eq(uploadedFiles.kbId, kbId), eq(knowledgeBases.userId, userId)));

  const deleted = await db
    .delete(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.userId, userId)))
    .returning({ id: knowledgeBases.id });

  if (deleted.length > 0) {
    const { deleteBlobs } = await import("./blob");
    await deleteBlobs(files.map((f) => f.blobUrl));
    return true;
  }
  return false;
}

/** 知识库下的文件列表(含流水线进度)。 */
export async function listFiles(
  userId: string,
  kbId: string,
): Promise<UploadedFileRow[] | null> {
  const kb = await getKnowledgeBase(userId, kbId);
  if (kb === null) return null;
  const db = getDb();
  return db
    .select()
    .from(uploadedFiles)
    .where(eq(uploadedFiles.kbId, kbId))
    .orderBy(desc(uploadedFiles.createdAt));
}

/** 取单个文件(带归属校验:file → kb → user)。 */
export async function getFile(
  userId: string,
  fileId: string,
): Promise<UploadedFileRow | null> {
  const db = getDb();
  const rows = await db
    .select({ file: uploadedFiles })
    .from(uploadedFiles)
    .innerJoin(knowledgeBases, eq(uploadedFiles.kbId, knowledgeBases.id))
    .where(and(eq(uploadedFiles.id, fileId), eq(knowledgeBases.userId, userId)))
    .limit(1);
  return rows[0]?.file ?? null;
}

/** 删除单个文件(级联清其 chunks/图谱块;Blob 孤儿容忍)。 */
export async function deleteFile(userId: string, fileId: string): Promise<boolean> {
  const db = getDb();
  const file = await getFile(userId, fileId);
  if (file === null) return false;

  await db.delete(uploadedFiles).where(eq(uploadedFiles.id, fileId));
  const { deleteBlob } = await import("./blob");
  await deleteBlob(file.blobUrl);
  return true;
}

/** failed 文件重置为 uploaded(带初始流水线状态,从 retrieval 阶段重来)。 */
export async function resetFileForRetry(userId: string, fileId: string): Promise<boolean> {
  const db = getDb();
  const file = await getFile(userId, fileId);
  if (file === null || file.status !== "failed") return false;
  await db
    .update(uploadedFiles)
    .set({
      status: "uploaded",
      // 带初始流水线状态(而非清空):清空会让 POST /process 因状态缺失 409,
      // 推进循环续不上;split 首批会全量 DELETE 旧分块,干净重来。
      metadata: { process: createInitialProcessState() },
      updatedAt: new Date(),
    })
    .where(eq(uploadedFiles.id, fileId));
  return true;
}

/** KB 详情页统计:分块数 / 实体数 / 关系数(RSC 直查)。 */
export async function getKbStats(
  userId: string,
  kbId: string,
): Promise<{ chunks: number; entities: number; relations: number } | null> {
  const kb = await getKnowledgeBase(userId, kbId);
  if (kb === null) return null;
  const db = getDb();

  const [chunkRow] = await db
    .select({ value: count() })
    .from(documentChunks)
    .innerJoin(uploadedFiles, eq(documentChunks.fileId, uploadedFiles.id))
    .where(eq(uploadedFiles.kbId, kbId));
  const [entityRow] = await db
    .select({ value: count() })
    .from(kgEntities)
    .where(eq(kgEntities.kbId, kbId));
  const [relationRow] = await db
    .select({ value: count() })
    .from(kgRelations)
    .where(eq(kgRelations.kbId, kbId));

  return {
    chunks: chunkRow?.value ?? 0,
    entities: entityRow?.value ?? 0,
    relations: relationRow?.value ?? 0,
  };
}

/** 文件详情页:父子分块预览。 */
export async function listFileChunks(
  userId: string,
  fileId: string,
  limit: number,
): Promise<Array<{ id: string; chunkType: string; chunkIndex: number; chunkText: string }> | null> {
  const file = await getFile(userId, fileId);
  if (file === null) return null;
  const db = getDb();
  return db
    .select({
      id: documentChunks.id,
      chunkType: documentChunks.chunkType,
      chunkIndex: documentChunks.chunkIndex,
      chunkText: documentChunks.chunkText,
    })
    .from(documentChunks)
    .where(eq(documentChunks.fileId, fileId))
    .orderBy(documentChunks.chunkIndex)
    .limit(limit);
}

/** 图谱块计数(graphSplit 阶段写完后校验用)。 */
export async function countGraphChunks(kbId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ value: count() })
    .from(graphChunks)
    .innerJoin(uploadedFiles, eq(graphChunks.fileId, uploadedFiles.id))
    .where(eq(uploadedFiles.kbId, kbId));
  return row?.value ?? 0;
}
