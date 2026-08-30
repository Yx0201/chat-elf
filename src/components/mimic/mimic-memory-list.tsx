"use client";

/**
 * 记忆列表客户端主体(拟态球交互 + 真实删除)。
 *
 * 数据由服务端直取(listMemories / getProfile)注入;本组件只做:
 * 分组渲染、球态交互(点条目 wink / 删除 sleep)、deleteMemoryAction 落库。
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BallAnchor, useBall } from "@/components/mimic/ball/ball-context";
import { deleteMemoryAction } from "@/lib/memory/actions";
import type { MemoryListItem } from "@/lib/memory/store";

/** category(库中为英文枚举)→ 分组标题 */
const CATEGORY_LABELS: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  event: "事件",
  relationship: "关系",
  emotion: "情绪",
};

/** 未知 category 的兜底组。 */
const OTHER_LABEL = "其他";

function formatWhen(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 1) return "今天";
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

interface MemoryGroup {
  label: string;
  items: MemoryListItem[];
}

function groupMemories(items: readonly MemoryListItem[]): MemoryGroup[] {
  const groups = new Map<string, MemoryListItem[]>();
  for (const item of items) {
    const label = CATEGORY_LABELS[item.category] ?? OTHER_LABEL;
    const bucket = groups.get(label);
    if (bucket === undefined) groups.set(label, [item]);
    else bucket.push(item);
  }
  // 按设计稿的分组建模:事实/偏好在前,其余按出现顺序
  const order = ["事实", "偏好", "事件", "关系", "情绪", OTHER_LABEL];
  return [...groups.entries()]
    .map(([label, list]) => ({ label, items: list }))
    .sort((a, b) => {
      const ia = order.indexOf(a.label);
      const ib = order.indexOf(b.label);
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    });
}

export function MimicMemoryList({
  memories,
  profileSummary,
  persistence,
}: {
  memories: readonly MemoryListItem[];
  /** user_profile.summary 的文本;无画像时为空 */
  profileSummary: string;
  persistence: boolean;
}) {
  const ball = useBall();
  const router = useRouter();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const groups = groupMemories(memories);

  function handleItemClick(): void {
    ball.flash("wink", 650);
  }

  async function handleDelete(id: string): Promise<void> {
    setDeletingId(id);
    setConfirmingId(null);
    const ok = await deleteMemoryAction(id);
    if (ok) {
      ball.flash("sleep", 800);
      router.refresh();
    }
    setDeletingId(null);
  }

  function renderGroup(group: MemoryGroup): React.ReactNode {
    if (group.items.length === 0) return null;
    return (
      <section key={group.label} className="flex flex-col gap-2">
        <h2 className="px-1 text-[13px] font-semibold text-[#787671]">
          {group.label} · {group.items.length}
        </h2>
        {group.items.map((m) => (
          <article
            key={m.id}
            onClick={handleItemClick}
            className={`flex min-h-[64px] items-center justify-between gap-3 rounded-xl border border-[#E5E3DF] bg-white px-4 py-3 transition-colors hover:border-[#C8C4BE] ${
              deletingId === m.id ? "opacity-50" : ""
            }`}
          >
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-[#1A1A1A]">{m.content}</p>
              <p className="text-xs text-[#A4A097]">
                {`记住于 ${formatWhen(m.createdAt)}`}
                {m.importance >= 0.75 ? " · 重要" : ""}
              </p>
            </div>
            {confirmingId === m.id ? (
              <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => void handleDelete(m.id)}
                  className="h-9 rounded-lg bg-[#E03131] px-3 text-[13px] font-medium text-white"
                >
                  确认删除
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingId(null)}
                  className="h-9 rounded-lg border border-[#E5E3DF] px-3 text-[13px] font-medium text-[#5D5B54]"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmingId(m.id);
                }}
                className="flex h-11 shrink-0 items-center px-2 text-[13px] font-medium text-[#E03131] transition-colors hover:text-[#C22525]"
              >
                删除
              </button>
            )}
          </article>
        ))}
      </section>
    );
  }

  return (
    <div className="mimic-page min-h-dvh bg-[#F6F5F4] lg:flex">
      {/* 左舞台(H5 顶部紧凑区) */}
      <section className="flex flex-col items-center justify-center gap-3 bg-[#0A1530] px-6 py-10 lg:w-[440px] lg:min-h-dvh lg:shrink-0 lg:gap-5 lg:py-12">
        <p className="text-[11px] font-semibold tracking-wide text-[#8B7BF6]">TA 的记忆</p>
        <BallAnchor state="notify" variant="light" className="h-40 w-40 lg:h-[200px] lg:w-[200px]" />
        <h1 className="text-xl font-semibold text-white lg:text-[28px]">TA 记得你</h1>
        <p className="max-w-[320px] text-center text-[13px] leading-[1.5] text-[#A4A097] lg:text-sm">
          蓝点 = 有新写入的记忆。点一条记忆,球眨一下眼;删掉一条,TA 就真的忘了它。
        </p>
      </section>

      {/* 右列表区 */}
      <section className="mx-auto flex w-full max-w-[1000px] flex-col gap-4 px-4 py-6 lg:gap-4 lg:px-12 lg:py-10">
        <header className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold text-[#1A1A1A] lg:text-[22px]">在你眼中</h2>
          <Link href="/mimic/chat" className="text-[13px] font-medium text-[#0075DE] hover:text-[#4536A8]">
            ← 回到对话
          </Link>
        </header>

        {!persistence ? (
          <div className="flex items-center rounded-xl border border-[#B7791F]/30 bg-[#B7791F]/5 p-5">
            <p className="text-[13px] leading-[1.5] text-[#975A16]">
              未配置 DATABASE_URL,记忆功能不可用。在 .env.local 中补上即可(参考 .env.example)。
            </p>
          </div>
        ) : null}

        {/* 画像卡(user_profile.summary,LLM 整合的凝练速写) */}
        {profileSummary !== "" ? (
          <div className="flex flex-col gap-2 rounded-xl bg-[#E6E0F5] p-5 lg:p-6">
            <p className="text-xs font-semibold text-[#391C57]">画像</p>
            <p className="text-base leading-[1.5] text-[#37352E]">{profileSummary}</p>
          </div>
        ) : null}

        {groups.length > 0 ? (
          <div className="flex flex-col gap-4">{groups.map((group) => renderGroup(group))}</div>
        ) : (
          <div className="flex items-center rounded-xl bg-[#D9F3E1] p-5">
            <p className="text-[13px] leading-[1.5] text-[#37352E]">
              {persistence ? "多和 TA 聊聊,这里会渐渐装满。" : "配置数据库后,这里会显示 TA 记住的事。"}
            </p>
          </div>
        )}

        <p className="hidden px-1 text-xs leading-[1.6] text-[#A4A097] lg:block">
          删除是物理删除 —— 用户主动删掉的语义是「彻底忘掉」;对话里再提到,TA 会当作第一次听说。
        </p>
      </section>
    </div>
  );
}
