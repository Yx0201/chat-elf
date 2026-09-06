/**
 * 文件详情页 `/knowledge/[kbId]/files/[fileId]`(step1 T7)。
 * 基本信息 + 内容摘要 + 父子分块预览 + 下载/删除/重试。
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { FileActions } from "@/components/knowledge/file-actions";
import { PersonaPageHeader } from "@/components/persona/persona-page-header";
import { requirePageUserId } from "@/lib/auth/session";
import { getFile, isValidFileId, isValidKbId, listFileChunks } from "@/lib/knowledge/repository";
import { parseFileSummary } from "@/lib/knowledge/ingestion/summary";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  uploaded: "待处理",
  processing: "处理中",
  completed: "已就绪",
  failed: "失败",
};

export default async function FileDetailPage({
  params,
}: {
  params: Promise<{ kbId: string; fileId: string }>;
}) {
  const userId = await requirePageUserId();
  const { kbId, fileId } = await params;
  if (!isValidKbId(kbId) || !isValidFileId(fileId)) notFound();

  const file = await getFile(userId, fileId);
  if (file === null || file.kbId !== kbId) notFound();

  const [chunks, summary] = await Promise.all([
    listFileChunks(userId, fileId, 20),
    Promise.resolve(parseFileSummary(file.summary)),
  ]);

  return (
    <div className="mimic-page min-h-dvh bg-[#F6F5F4] px-5 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-xl md:max-w-2xl">
        <PersonaPageHeader title={file.fileName} backHref={`/knowledge/${kbId}`} />

        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#A4A097]">
          <span>{STATUS_LABEL[file.status] ?? file.status}</span>
          <span>·</span>
          <span>{formatSize(file.sizeBytes)}</span>
          <span>·</span>
          <Link href={`/knowledge/${kbId}`} className="hover:text-[#1A1A1A]">
            所属知识库
          </Link>
        </div>

        <FileActions fileId={file.id} status={file.status} />

        {summary !== null ? (
          <section className="mt-6 rounded-xl bg-[#E6E0F5] p-4">
            <p className="text-xs font-semibold text-[#391C57]">内容摘要</p>
            <p className="mt-1.5 text-xs leading-5 text-[#5D5B54]">{summary.summary}</p>
            {summary.topics.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {summary.topics.map((topic) => (
                  <span key={topic} className="rounded-full bg-white/70 px-2 py-0.5 text-[11px] text-[#391C57]">
                    {topic}
                  </span>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="mt-6 pb-10">
          <h2 className="text-sm font-semibold text-[#1A1A1A]">分块预览(前 20 块)</h2>
          {chunks === null || chunks.length === 0 ? (
            <p className="mt-3 rounded-lg bg-white px-3 py-4 text-center text-xs text-[#A4A097]">
              还没有分块 —— 文件处理完成后这里会出现父子块
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {chunks.map((chunk) => (
                <li key={chunk.id} className="rounded-lg bg-white p-3 shadow-sm">
                  <div className="flex items-center justify-between text-[11px] text-[#A4A097]">
                    <span>#{chunk.chunkIndex}</span>
                    <span>{chunk.chunkType === "parent" ? "父块 · 供上下文" : "子块 · 供命中"}</span>
                  </div>
                  <p className="mt-1.5 line-clamp-4 whitespace-pre-line text-xs leading-5 text-[#5D5B54]">
                    {chunk.chunkText}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
