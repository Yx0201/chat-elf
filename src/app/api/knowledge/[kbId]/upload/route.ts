/**
 * 上传知识库文件 —— Route Handler(例外清单:大文件 multipart 不适合 Server Action)。
 *
 * 流程:归属校验 → 扩展名/内容校验 → 原文上 Vercel Blob → 文本缓存落库
 * (status=processing,metadata 携带六阶段流水线初始状态)。
 * 后续处理由客户端轮询 /process 逐阶段推进。
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth/session";
import { uploadKnowledgeFile } from "@/lib/knowledge/blob";
import { getKnowledgeBase, isValidKbId } from "@/lib/knowledge/repository";
import { createInitialProcessState } from "@/lib/knowledge/ingestion/process-pipeline";
import { getDb } from "@/lib/db/client";
import { uploadedFiles } from "@/lib/db/schema";

export const runtime = "nodejs";

/** 仅纯文本(codeweaver 同口径;PDF/Word 不在本期范围)。 */
const ALLOWED_EXT = /\.(txt|md|markdown)$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ kbId: string }> }) {
  const userId = await getSessionUserId();
  if (userId === null) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { kbId } = await params;
  if (!isValidKbId(kbId)) {
    return NextResponse.json({ error: "无效的知识库ID" }, { status: 400 });
  }

  const kb = await getKnowledgeBase(userId, kbId);
  if (kb === null) {
    return NextResponse.json({ error: "知识库不存在" }, { status: 404 });
  }

  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "未上传文件" }, { status: 400 });
  }
  if (!ALLOWED_EXT.test(file.name)) {
    return NextResponse.json({ error: "仅支持 .txt / .md / .markdown 文件" }, { status: 400 });
  }

  const fileData = Buffer.from(await file.arrayBuffer());
  const content = fileData.toString("utf-8").replace(/\r\n?/g, "\n");
  if (!content.trim()) {
    return NextResponse.json({ error: "文件内容为空" }, { status: 400 });
  }

  // 原文二进制上 Blob(private),数据库只存 URL 与文本缓存。
  const contentType = file.type || "application/octet-stream";
  const blob = await uploadKnowledgeFile(kbId, file.name, fileData, contentType);

  const processState = createInitialProcessState();
  const db = getDb();
  const [record] = await db
    .insert(uploadedFiles)
    .values({
      kbId,
      fileName: file.name,
      sizeBytes: file.size,
      blobUrl: blob.url,
      content,
      status: "processing",
      metadata: { process: processState },
    })
    .returning({ id: uploadedFiles.id, fileName: uploadedFiles.fileName, status: uploadedFiles.status });

  return NextResponse.json({
    success: true,
    fileId: record.id,
    filename: record.fileName,
    status: record.status,
    process: processState,
  });
}
