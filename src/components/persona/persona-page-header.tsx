/**
 * `/persona` 系列页面的 header。
 *
 * 与对话页一致:左侧整块是返回链接(触区 44px),不用额外按钮 ——
 * 窄屏放不下太多独立触区。
 */

import Link from "next/link";
import type { ReactNode } from "react";

export function PersonaPageHeader({
  title,
  backHref,
  children,
}: {
  title: string;
  backHref: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-3">
      <Link
        href={backHref}
        className="flex h-11 min-w-0 items-center gap-1 rounded-lg pr-2 text-sm text-zinc-500 transition-colors hover:text-zinc-800 dark:hover:text-zinc-200"
      >
        <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m15 6-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="truncate">返回</span>
      </Link>

      <h1 className="truncate text-base font-medium">{title}</h1>

      <span className="flex shrink-0 justify-end">{children}</span>
    </header>
  );
}
