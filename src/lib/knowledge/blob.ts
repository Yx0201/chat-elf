/**
 * Vercel Blob 对象存储封装(知识库模块)—— 自 codeweaver 移植。
 *
 * Store 为 private(私有)模式:原文二进制不可匿名访问,下载走
 * getDownloadUrl() 签名 URL。数据库只存 blob_url。
 *
 * 分块/embedding/图谱构建所需的文本走 uploaded_files.content(上传时同步
 * 落库的 UTF-8 缓存),流水线不回源 Blob。
 *
 * 文档:https://vercel.com/docs/vercel-blob/using-blob-sdk
 */

import { put, del, getDownloadUrl } from "@vercel/blob";

export interface UploadedBlob {
  url: string;
  downloadUrl: string;
  pathname: string;
  contentType: string;
}

function assertToken(): void {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "缺少 BLOB_READ_WRITE_TOKEN 环境变量,请在 Vercel 创建 Blob store 后通过 vercel env pull 获取",
    );
  }
}

/**
 * 上传原始文件字节到 Vercel Blob。
 *
 * @param kbId     知识库 id(uuid),用于组织存储路径
 * @param filename 原始文件名
 * @param body     Buffer | string | File | ArrayBuffer | ReadableStream
 * @param contentType MIME 类型
 */
export async function uploadKnowledgeFile(
  kbId: string,
  filename: string,
  body: Parameters<typeof put>[1],
  contentType: string,
): Promise<UploadedBlob> {
  assertToken();

  // 用 KB + 文件名组织路径;addRandomSuffix 默认开启,避免覆盖。
  const pathname = `kb/${kbId}/${filename}`;

  const blob = await put(pathname, body, {
    access: "private",
    addRandomSuffix: true,
    contentType,
    cacheControlMaxAge: 60 * 60 * 24 * 365, // 一年,原文不变可长期缓存
  });

  return {
    url: blob.url,
    downloadUrl: blob.downloadUrl,
    pathname: blob.pathname,
    contentType: blob.contentType,
  };
}

/**
 * 为 private blob 生成即时签名下载 URL(由当前 token 即时签名)。
 * 用于下载路由 302 重定向。
 */
export function getSignedDownloadUrl(blobUrl: string): string {
  return getDownloadUrl(blobUrl);
}

/**
 * 删除 Blob 对象。幂等:删不到(已不存在)也不报错。
 * 注意:del() 接收 blob.url(或 pathname),不是数据库主键;
 * 删除失败不阻断 DB 记录删除,孤儿对象可后续用 list() 清理。
 */
export async function deleteBlob(blobUrl: string | null | undefined): Promise<void> {
  if (!blobUrl) return;
  try {
    await del(blobUrl);
  } catch (error) {
    console.error(`[knowledge] 删除 Blob 对象失败 url=${blobUrl}:`, error);
  }
}

/** 批量删除 Blob 对象(删库/删文件时清理原文)。 */
export async function deleteBlobs(blobUrls: (string | null | undefined)[]): Promise<void> {
  const urls = blobUrls.filter((u): u is string => Boolean(u));
  if (urls.length === 0) return;
  try {
    await del(urls);
  } catch (error) {
    console.error(`[knowledge] 批量删除 Blob 对象失败 urls=${urls.join(",")}:`, error);
  }
}
