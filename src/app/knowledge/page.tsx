/**
 * 知识库列表页 `/knowledge`(知识库模块 step1 T7)。
 *
 * mobile-first 单列卡片(与人格库页同一视觉骨架:浅底 #F6F5F4 + 紫主色),
 * 桌面同宽居中 —— 内容量不大,不需要 PC 多列形态。
 * 精灵如何用知识库:上传资料后,语音对话中问到相关内容时精灵会自动检索引用(step2)。
 */

import Link from "next/link";
import { CreateKnowledgeBaseDialog } from "@/components/knowledge/create-kb-dialog";
import { DeleteKnowledgeBaseButton } from "@/components/knowledge/delete-kb-button";
import { PersonaPageHeader } from "@/components/persona/persona-page-header";
import { requirePageUserId } from "@/lib/auth/session";
import { isDatabaseConfigured } from "@/lib/db/client";
import { listKnowledgeBases } from "@/lib/knowledge/repository";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const userId = await requirePageUserId();
  const persistence = isDatabaseConfigured();
  const kbs = persistence ? await listKnowledgeBases(userId) : [];

  return (
    <div className="mimic-page min-h-dvh bg-[#F6F5F4] px-5 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-xl md:max-w-2xl">
        <PersonaPageHeader title="知识库" backHref="/chat">
          {persistence ? <CreateKnowledgeBaseDialog /> : null}
        </PersonaPageHeader>

        <p className="mt-4 text-sm leading-6 text-[#5D5B54]">
          把资料喂给 TA:上传小说、笔记或文档,TA 在对话里聊到相关内容时会自动翻出来引用。
          目前支持 .txt / .md 纯文本。
        </p>

        {!persistence ? (
          <p className="mt-4 rounded-lg border border-[#B7791F]/30 bg-[#B7791F]/5 px-3 py-2 text-xs leading-5 text-[#975A16]">
            未配置 DATABASE_URL,知识库不可用。在 .env.local 中补上即可(参考 .env.example)。
          </p>
        ) : kbs.length === 0 ? (
          <div className="mt-10 rounded-xl border border-dashed border-[#E5E3DF] bg-white px-6 py-12 text-center">
            <p className="text-sm text-[#5D5B54]">还没有知识库</p>
            <p className="mt-1 text-xs text-[#A4A097]">点右上角「新建知识库」,上传第一份资料</p>
          </div>
        ) : (
          <ul className="mt-8 flex flex-col gap-3 pb-8">
            {kbs.map((kb) => (
              <li key={kb.id} className="rounded-xl bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/knowledge/${kb.id}`} className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[#1A1A1A]">{kb.name}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#5D5B54]">
                      {kb.description || kb.summary || "暂无描述"}
                    </p>
                    <p className="mt-2 text-[11px] text-[#A4A097]">{kb.fileCount} 个文件</p>
                  </Link>
                  <DeleteKnowledgeBaseButton kbId={kb.id} kbName={kb.name} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
