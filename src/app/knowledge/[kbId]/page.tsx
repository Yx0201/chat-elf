/**
 * 知识库详情页 `/knowledge/[kbId]`(step1 T7)。
 *
 * RSC 直查:KB 信息 + 图谱规模统计(chunks/entities/relations 计数,
 * spec 决策:不做 echarts 可视化)+ 文件列表;上传/进度轮询/检索测试
 * 是客户端面板。处理中的文件由面板断点续推(见 kb-detail-panel)。
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { KnowledgeBaseDetailPanel, type FileRowView } from "@/components/knowledge/kb-detail-panel";
import { PersonaPageHeader } from "@/components/persona/persona-page-header";
import { DeleteKnowledgeBaseButton } from "@/components/knowledge/delete-kb-button";
import { SearchTestPanel } from "@/components/knowledge/search-test-panel";
import { requirePageUserId } from "@/lib/auth/session";
import { getKbStats, getKnowledgeBase, isValidKbId, listFiles } from "@/lib/knowledge/repository";
import { parseUploadPipelineState } from "@/lib/knowledge/ingestion/process-pipeline";

export const dynamic = "force-dynamic";

export default async function KnowledgeBaseDetailPage({ params }: { params: Promise<{ kbId: string }> }) {
  const userId = await requirePageUserId();
  const { kbId } = await params;
  if (!isValidKbId(kbId)) notFound();

  const kb = await getKnowledgeBase(userId, kbId);
  if (kb === null) notFound();

  const [stats, fileRows] = await Promise.all([getKbStats(userId, kbId), listFiles(userId, kbId)]);

  const files: FileRowView[] = (fileRows ?? []).map((file) => ({
    id: file.id,
    fileName: file.fileName,
    status: file.status,
    sizeBytes: file.sizeBytes,
    summary: file.summary,
    process: parseUploadPipelineState(file.metadata),
  }));

  return (
    <div className="mimic-page min-h-dvh bg-[#F6F5F4] px-5 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-xl md:max-w-2xl">
        <PersonaPageHeader title={kb.name} backHref="/knowledge">
          <div className="flex items-center gap-1">
            <Link
              href={`/knowledge/${kb.id}/chat`}
              className="flex h-11 items-center rounded-lg bg-[#5645D4] px-4 text-xs font-medium text-white transition-colors hover:bg-[#4536A8]"
            >
              问 TA
            </Link>
            <DeleteKnowledgeBaseButton kbId={kb.id} kbName={kb.name} />
          </div>
        </PersonaPageHeader>

        {kb.description !== "" ? (
          <p className="mt-4 text-sm leading-6 text-[#5D5B54]">{kb.description}</p>
        ) : null}

        {/* 图谱规模统计(决策 4:不做可视化,只做计数) */}
        <div className="mt-5 grid grid-cols-3 gap-2">
          <StatBox label="分块" value={stats?.chunks ?? 0} />
          <StatBox label="实体 node" value={stats?.entities ?? 0} />
          <StatBox label="关系 edge" value={stats?.relations ?? 0} />
        </div>

        {kb.summary !== null ? (
          <div className="mt-4 rounded-xl bg-[#E6E0F5] p-4">
            <p className="text-xs font-semibold text-[#391C57]">TA 对这个库的了解</p>
            <p className="mt-1.5 text-xs leading-5 text-[#5D5B54]">{kb.summary}</p>
          </div>
        ) : null}

        <KnowledgeBaseDetailPanel kbId={kb.id} initialFiles={files} />

        <SearchTestPanel kbId={kb.id} />
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-white p-3 text-center shadow-sm">
      <p className="text-lg font-semibold text-[#1A1A1A]">{value}</p>
      <p className="mt-0.5 text-[11px] text-[#A4A097]">{label}</p>
    </div>
  );
}
