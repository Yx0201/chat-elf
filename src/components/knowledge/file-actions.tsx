"use client";

/**
 * 文件详情页操作区:下载(签名 URL 302)/ 删除 / 失败重试。
 * 三个动作都 ≥44px 触区;删除是危险动作,confirm 确认。
 */

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { deleteFileAction, retryFileAction } from "@/lib/knowledge/actions";

export function FileActions({ fileId, status }: { fileId: string; status: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    const confirmed = window.confirm("删除这个文件?\n其全部分块与图谱贡献将一并删除。");
    if (!confirmed) return;
    startTransition(async () => {
      const ok = await deleteFileAction(fileId);
      if (ok) router.back();
    });
  }

  function handleRetry() {
    startTransition(async () => {
      await retryFileAction(fileId);
      router.back();
    });
  }

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <a
        href={`/api/files/${fileId}`}
        className="flex h-11 items-center rounded-lg border border-[#E5E3DF] bg-white px-4 text-sm text-[#37352E] transition-colors hover:bg-[#F6F5F4]"
      >
        下载原文
      </a>
      {status === "failed" ? (
        <button
          type="button"
          onClick={handleRetry}
          disabled={pending}
          className="flex h-11 items-center rounded-lg bg-[#5645D4] px-4 text-sm font-medium text-white transition-colors hover:bg-[#4536A8] disabled:opacity-50"
        >
          {pending ? "重置中…" : "重新处理"}
        </button>
      ) : null}
      <button
        type="button"
        onClick={handleDelete}
        disabled={pending}
        className="flex h-11 items-center rounded-lg px-4 text-sm text-[#A4A097] transition-colors hover:bg-[#C0392B]/5 hover:text-[#C0392B] disabled:opacity-50"
      >
        {pending ? "删除中…" : "删除文件"}
      </button>
    </div>
  );
}
