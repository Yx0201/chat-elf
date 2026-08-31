"use client";

/**
 * `/persona` 系列页面的 header(2026-08-31 拟态球化)。
 *
 * 与对话页一致:左侧整块是返回链接(触区 44px),不用额外按钮 ——
 * 窄屏放不下太多独立触区。标题旁带一颗小拟态球锚点,进出页面时
 * 球常态层会 orbit 飞过来,保持"围着这颗球转"的一致感。
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { BallAnchor } from "@/components/mimic/ball/ball-context";

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
        className="flex h-11 min-w-0 items-center gap-1 rounded-lg pr-2 text-sm text-[#5D5B54] transition-colors hover:text-[#1A1A1A]"
      >
        <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m15 6-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="truncate">返回</span>
      </Link>

      <div className="flex min-w-0 items-center gap-2.5">
        <BallAnchor state="idle" className="h-9 w-9 shrink-0" />
        <h1 className="truncate text-base font-semibold text-[#1A1A1A]">{title}</h1>
      </div>

      <span className="flex shrink-0 justify-end">{children}</span>
    </header>
  );
}