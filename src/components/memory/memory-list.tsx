"use client";

/**
 * 记忆列表(step3 T5「TA 记得你」)。
 *
 * 布局契约遵循 ui-设置中心与交互设计.md §3.3:
 *   - 顶部画像段落卡(样式与单条记忆明确区分)
 *   - 按 category 分组
 *   - 删除需二次确认(破坏性操作,ui spec §1 硬约束)
 *   - 空态给引导文案,不许裸列
 *
 * 客户端组件的唯一理由:删除要做二次确认,而 confirm() 只能在浏览器里跑
 * (与 step1 的 DeleteConversationButton 同一个约束)。
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteMemoryAction, refreshProfileAction } from "@/lib/memory/actions";
import type { MemoryListItem } from "@/lib/memory/store";

/** category → 中文分组名;未知类别兜底到"其它"。 */
const CATEGORY_LABELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "fact", label: "事实" },
  { key: "preference", label: "偏好" },
  { key: "event", label: "事件" },
  { key: "relationship", label: "人际关系" },
  { key: "emotion", label: "情绪" },
];

function categoryLabel(category: string): string {
  return CATEGORY_LABELS.find((item) => item.key === category)?.label ?? "其它";
}

/** 展示顺序按上面的分组顺序;未列出的类别排在最后。 */
function groupOrder(category: string): number {
  const index = CATEGORY_LABELS.findIndex((item) => item.key === category);
  return index === -1 ? CATEGORY_LABELS.length : index;
}

function daysAgo(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MemoryList({
  memories,
  profileSummary,
  profileTraits,
  profileRefreshedAt,
}: {
  memories: readonly MemoryListItem[];
  profileSummary: string;
  profileTraits: Record<string, string>;
  /** 画像最近一次整合时间(ISO 字符串);从未整合过为 null */
  profileRefreshedAt: string | null;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(id: string): Promise<void> {
    setPendingId(id);
    setError(null);
    try {
      const ok = await deleteMemoryAction(id);
      if (!ok) setError("删除失败,请稍后重试");
      else router.refresh();
    } catch {
      setError("删除失败,请稍后重试");
    } finally {
      setPendingId(null);
      setConfirmId(null);
    }
  }

  async function refresh(): Promise<void> {
    setRefreshing(true);
    setError(null);
    try {
      const ok = await refreshProfileAction();
      if (!ok) setError("整理失败,请稍后重试");
      else router.refresh();
    } catch {
      setError("整理失败,请稍后重试");
    } finally {
      setRefreshing(false);
    }
  }

  const groups = [...new Set(memories.map((m) => m.category))].sort(
    (a, b) => groupOrder(a) - groupOrder(b),
  );
  const traitEntries = Object.entries(profileTraits);

  return (
    <div className="space-y-8">
      {/* 画像卡:样式与单条记忆明确区分(ui spec §3.3) */}
      <section>
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs font-medium tracking-wide text-zinc-400">TA 眼里的你</h2>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing || memories.length === 0}
            className="h-11 rounded-lg px-2 text-xs text-zinc-500 transition-colors hover:text-zinc-800 disabled:opacity-50 dark:hover:text-zinc-200"
          >
            {refreshing ? "整理中…" : "重新整理"}
          </button>
        </div>
        <div className="mt-2 rounded-xl border border-indigo-500/20 bg-indigo-500/[.04] p-4">
          {profileSummary === "" ? (
            <p className="text-sm leading-6 text-zinc-400">
              还没有画像。多聊几次,TA 会把零散的印象整理成一段关于你的速写。
            </p>
          ) : (
            <>
              <p className="text-sm leading-7">{profileSummary}</p>
              {traitEntries.length > 0 ? (
                <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-indigo-500/15 pt-3 text-xs">
                  {traitEntries.map(([key, value]) => (
                    <div key={key} className="flex gap-1">
                      <dt className="text-zinc-400">{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {profileRefreshedAt !== null ? (
                <p className="mt-3 text-[11px] text-zinc-400">
                  整理于 {daysAgo(new Date(profileRefreshedAt))}
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>

      {error !== null ? (
        <p
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}

      {memories.length === 0 ? (
        // 空态也是陪伴感的一部分,不许裸列(ui spec §3.3)
        <p className="rounded-xl border border-dashed border-black/[.08] px-4 py-10 text-center text-sm text-zinc-400 dark:border-white/[.10]">
          还什么都没记住呢。多和 TA 聊聊,这里会渐渐装满。
        </p>
      ) : (
        groups.map((category) => {
          const items = memories.filter((m) => m.category === category);
          return (
            <section key={category}>
              <h2 className="text-xs font-medium tracking-wide text-zinc-400">
                {categoryLabel(category)} ({items.length})
              </h2>
              <ul className="mt-2 overflow-hidden rounded-xl border border-black/[.06] dark:border-white/[.08]">
                {items.map((memory) => (
                  <li
                    key={memory.id}
                    className="flex min-h-[56px] items-center gap-2 border-b border-black/[.06] px-4 last:border-b-0 dark:border-white/[.08]"
                  >
                    <div className="min-w-0 flex-1 py-2">
                      <p className="break-words text-sm leading-6">{memory.content}</p>
                      <p className="mt-0.5 text-xs text-zinc-400">
                        记住于 {daysAgo(memory.createdAt)}
                        {memory.lastConfirmedAt !== null &&
                        memory.lastConfirmedAt.getTime() - memory.createdAt.getTime() > 86_400_000
                          ? ` · 最近一次确认 ${daysAgo(memory.lastConfirmedAt)}`
                          : ""}
                      </p>
                    </div>

                    {confirmId === memory.id ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void remove(memory.id)}
                          disabled={pendingId !== null}
                          className="flex h-11 items-center rounded-lg border border-red-500/40 px-3 text-xs text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
                        >
                          {pendingId === memory.id ? "删除中…" : "确认删除"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmId(null)}
                          disabled={pendingId !== null}
                          className="flex h-11 items-center rounded-lg px-3 text-xs text-zinc-500 transition-colors hover:text-zinc-800 dark:hover:text-zinc-200"
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmId(memory.id)}
                        aria-label={`删除记忆:${memory.content}`}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-300 transition-colors hover:bg-black/[.05] hover:text-red-500 dark:text-zinc-600 dark:hover:bg-white/[.08]"
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
