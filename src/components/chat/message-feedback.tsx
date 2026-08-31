"use client";

/**
 * 单条回复的 👍/👎(step2 T4)。
 *
 * 只埋点、不分析:点一下写一条 feedback 记录,再点一下撤销。
 * 没有比这更强的反馈 —— 不会弹出"说说哪里不满意",也不会改变 AI 的行为,
 * 攒下来的数据留待将来做人设调优。
 *
 * 视觉上刻意做得轻(低对比度小图标),避免每条回复下面都挂一排按钮把字幕区
 * 变成评论区;但触区仍是 44px(AGENTS.md H5 约束)。
 */

import { useState } from "react";
import { submitFeedbackAction } from "@/lib/memory/actions";

function ThumbIcon({ up }: { up: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={`h-4 w-4 ${up ? "" : "rotate-180"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    >
      <path d="M7 10.5V20H4.5A1.5 1.5 0 0 1 3 18.5v-6.5a1.5 1.5 0 0 1 1.5-1.5H7Zm0 0 4.2-7a1.9 1.9 0 0 1 3.4 1.6L13.7 10.5h4.6a2 2 0 0 1 2 2.4l-1.3 6.3a2 2 0 0 1-2 1.6H7v-10.3Z" />
    </svg>
  );
}

export function MessageFeedback({
  messageId,
  initialScore,
}: {
  messageId: string;
  initialScore: 1 | -1 | null;
}) {
  const [score, setScore] = useState<1 | -1 | null>(initialScore);
  const [pending, setPending] = useState(false);

  async function rate(next: 1 | -1): Promise<void> {
    if (pending) return;
    setPending(true);
    // 乐观更新:反馈是次要交互,等服务端往返会让点击"没反应"
    setScore(score === next ? null : next);
    try {
      const result = await submitFeedbackAction(messageId, next);
      setScore(result);
    } catch {
      // 失败回滚到操作前的值
      setScore(score);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="mt-1 flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => void rate(1)}
        disabled={pending}
        aria-label="这条回复不错"
        aria-pressed={score === 1}
        className={`flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-black/[.05] dark:hover:bg-white/[.08] ${
          score === 1 ? "text-indigo-500" : "text-zinc-300 dark:text-zinc-600"
        }`}
      >
        <ThumbIcon up />
      </button>
      <button
        type="button"
        onClick={() => void rate(-1)}
        disabled={pending}
        aria-label="这条回复不太好"
        aria-pressed={score === -1}
        className={`flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-black/[.05] dark:hover:bg-white/[.08] ${
          score === -1 ? "text-red-500" : "text-zinc-300 dark:text-zinc-600"
        }`}
      >
        <ThumbIcon up={false} />
      </button>
    </span>
  );
}
