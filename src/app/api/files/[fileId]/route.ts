/**
 * 知识库原文下载 —— Route Handler(例外清单:二进制/重定向不适合 Server Action)。
 *
 * 归属校验(file → kb → user)后 302 到 Vercel Blob 签名 URL(走 CDN)。
 * 与 codeweaver 的差异:无 bytea 过渡兼容(本项目从一开始就走 Blob)。
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth/session";
import { getSignedDownloadUrl } from "@/lib/knowledge/blob";
import { getFile, isValidFileId } from "@/lib/knowledge/repository";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const userId = await getSessionUserId();
  if (userId === null) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { fileId } = await params;
  if (!isValidFileId(fileId)) {
    return NextResponse.json({ error: "无效的文件ID" }, { status: 400 });
  }

  const file = await getFile(userId, fileId);
  if (file === null || !file.blobUrl) {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }

  return NextResponse.redirect(getSignedDownloadUrl(file.blobUrl), { status: 302 });
}
