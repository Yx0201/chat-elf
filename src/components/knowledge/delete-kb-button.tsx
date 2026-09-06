"use client";

/**
 * 删除知识库 —— 危险动作:confirm 二次确认(级联删除文件/分块/图谱与远端原文)。
 * 触区 44px,与列表卡片视觉分层(幽灵样式 + hover 转警示色)。
 */

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { deleteKnowledgeBaseAction } from "@/lib/knowledge/actions";

export function DeleteKnowledgeBaseButton({ kbId, kbName }: { kbId: string; kbName: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    const confirmed = window.confirm(`删除知识库「${kbName}」?\n库内全部文件、分块与图谱将一并删除,不可恢复。`);
    if (!confirmed) return;
    startTransition(async () => {
      const ok = await deleteKnowledgeBaseAction(kbId);
      if (ok) router.push("/knowledge");
    });
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={pending}
      className="flex h-11 items-center rounded-lg px-3 text-xs text-[#A4A097] transition-colors hover:bg-[#C0392B]/5 hover:text-[#C0392B] disabled:opacity-50"
    >
      {pending ? "删除中…" : "删除知识库"}
    </button>
  );
}
