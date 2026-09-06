"use client";

/**
 * 知识库详情面板 —— 上传 + 处理进度 + 文件列表(客户端,轮询驱动)。
 *
 * 处理驱动模型与 codeweaver 相同:上传成功后**顺序推进**(POST /process
 * 每次推进一个有界批次,响应即最新状态;未完成则延时后再发下一发),
 * 而非固定间隔 GET —— graphBuild 单批(8 并发 LLM 抽取)可能要跑十几秒,
 * 固定间隔会造成请求堆积。
 *
 * H5:上传按钮 44px 触区、进度块单列;桌面同构(列表本就单列,无需变形)。
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UploadPipelineState } from "@/lib/knowledge/ingestion/process-pipeline";

/** RSC 传给客户端的文件行(已序列化)。 */
export interface FileRowView {
  id: string;
  fileName: string;
  status: string;
  sizeBytes: number;
  summary: string | null;
  process: UploadPipelineState | null;
}

interface ProcessResponse {
  status?: string;
  process?: UploadPipelineState | null;
  error?: string;
}

const ADVANCE_DELAY_MS = 400;

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  uploaded: { label: "待处理", className: "bg-[#EDECE9] text-[#787671]" },
  processing: { label: "处理中", className: "bg-[#5645D4]/10 text-[#5645D4]" },
  completed: { label: "已就绪", className: "bg-[#1F8A4C]/10 text-[#1F8A4C]" },
  failed: { label: "失败", className: "bg-[#C0392B]/10 text-[#C0392B]" },
};

export function KnowledgeBaseDetailPanel({ kbId, initialFiles }: { kbId: string; initialFiles: FileRowView[] }) {
  const router = useRouter();
  const [files, setFiles] = useState<FileRowView[]>(initialFiles);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** 正在推进的 fileId 集合,防重复起循环(HMR/刷新场景)。 */
  const advancing = useRef<Set<string>>(new Set());

  const patchFile = useCallback((fileId: string, patch: Partial<FileRowView>) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, ...patch } : f)));
  }, []);

  /** 顺序推进一个文件,直到 completed/failed。 */
  const advanceLoop = useCallback(
    async (fileId: string) => {
      if (advancing.current.has(fileId)) return;
      advancing.current.add(fileId);
      try {
        for (;;) {
          const res = await fetch(`/api/knowledge/${kbId}/files/${fileId}/process`, { method: "POST" });
          if (!res.ok && res.status !== 500) {
            // 401/404/409:不再重试,交由用户刷新
            break;
          }
          const data = (await res.json()) as ProcessResponse;
          const status = data.status ?? "processing";
          patchFile(fileId, { status, process: data.process ?? null });
          if (status === "completed" || status === "failed") {
            router.refresh();
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, ADVANCE_DELAY_MS));
        }
      } catch {
        // 网络抖动:停止推进,状态留 processing,刷新页面可续
      } finally {
        advancing.current.delete(fileId);
      }
    },
    [kbId, patchFile, router],
  );

  // 进入页面时,把上次中断在 processing 的文件续上(断点恢复)。
  // setTimeout 把推进循环踢出 effect 同步作用域(React Compiler:
  // 禁止 effect 内同步 setState;循环里的 patchFile 都发生在 await 之后)。
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const file of files) {
        if (file.status === "processing" || file.status === "uploaded") {
          void advanceLoop(file.id);
        }
      }
    }, 0);
    return () => clearTimeout(timer);
    // 仅挂载时执行一次;files 变化由 advanceLoop 自身驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUpload(fileList: FileList | null) {
    if (fileList === null || fileList.length === 0 || uploading) return;
    setUploading(true);
    setUploadError(null);

    for (const file of Array.from(fileList)) {
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(`/api/knowledge/${kbId}/upload`, { method: "POST", body: formData });
        const data = (await res.json()) as { fileId?: string; error?: string; status?: string; process?: UploadPipelineState | null };
        if (!res.ok || data.fileId === undefined) {
          setUploadError(data.error ?? "上传失败");
          continue;
        }
        setFiles((prev) => [
          {
            id: data.fileId as string,
            fileName: file.name,
            status: data.status ?? "processing",
            sizeBytes: file.size,
            summary: null,
            process: data.process ?? null,
          },
          ...prev,
        ]);
        void advanceLoop(data.fileId);
      } catch {
        setUploadError("上传失败,请重试");
      }
    }
    setUploading(false);
    router.refresh();
  }

  const hasProcessing = files.some((f) => f.status === "processing" || f.status === "uploaded");

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[#1A1A1A]">
          文件{files.length > 0 ? ` · ${files.length}` : ""}
        </h2>
        <label
          className={`flex h-11 cursor-pointer items-center rounded-lg bg-[#5645D4] px-4 text-sm font-medium text-white transition-colors hover:bg-[#4536A8] ${
            uploading ? "pointer-events-none opacity-60" : ""
          }`}
        >
          {uploading ? "上传中…" : "上传文件"}
          <input
            type="file"
            accept=".txt,.md,.markdown"
            multiple
            className="sr-only"
            disabled={uploading}
            onChange={(e) => {
              void handleUpload(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {uploadError !== null ? (
        <p className="mt-3 rounded-lg border border-[#C0392B]/20 bg-[#C0392B]/5 px-3 py-2 text-xs text-[#C0392B]">
          {uploadError}
        </p>
      ) : null}

      {files.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-[#E5E3DF] bg-white px-6 py-10 text-center">
          <p className="text-sm text-[#5D5B54]">还没有文件</p>
          <p className="mt-1 text-xs text-[#A4A097]">支持 .txt / .md,上传后自动分块、建索引、抽图谱</p>
        </div>
      ) : (
        <ul className="mt-4 flex flex-col gap-3 pb-8">
          {files.map((file) => (
            <li key={file.id} className="rounded-xl bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <Link href={`/knowledge/${kbId}/files/${file.id}`} className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[#1A1A1A]">{file.fileName}</p>
                  <p className="mt-1 text-[11px] text-[#A4A097]">{formatSize(file.sizeBytes)}</p>
                </Link>
                <StatusBadge status={file.status} />
              </div>

              {file.summary !== null ? (
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-[#5D5B54]">{summaryText(file.summary)}</p>
              ) : null}

              {file.status === "processing" && file.process !== null ? (
                <ProcessProgressView state={file.process} />
              ) : null}
              {file.status === "failed" && file.process?.error !== undefined ? (
                <p className="mt-2 rounded-lg bg-[#C0392B]/5 px-3 py-2 text-xs leading-5 text-[#C0392B]">
                  {file.process.error}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {hasProcessing ? (
        <p className="pb-8 text-center text-xs text-[#A4A097]">处理中…离开本页不会中断,回来可看进度</p>
      ) : null}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.uploaded;
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${badge.className}`}>
      {badge.label}
    </span>
  );
}

/** 六阶段进度:总进度条 + 当前阶段名。窄屏只显示一行,细节留给文件详情页。 */
function ProcessProgressView({ state }: { state: UploadPipelineState }) {
  const currentStep = state.steps.find((s) => s.key === state.stage);
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-[11px] text-[#787671]">
        <span>{currentStep?.label ?? "处理中"}</span>
        <span>{state.totalPercent}%</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#EDECE9]">
        <div
          className="h-full rounded-full bg-[#5645D4] transition-[width] duration-300"
          style={{ width: `${state.totalPercent}%` }}
        />
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** summary 列存 JSON{summary, topics, exampleQuestions},展示时取可读部分。 */
function summaryText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { summary?: string };
    return parsed.summary ?? raw;
  } catch {
    return raw;
  }
}
