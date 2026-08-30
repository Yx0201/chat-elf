"use client";

/**
 * 00 封面 · 拟态球陪伴系统（Ardot 设计稿 3:119）。
 *
 * 深色舞台 #0A1530，垂直三段：顶栏（品牌 + 徽章）/ Hero（220px idle 球 +
 * 主副标题 + 双按钮）/ 底部五彩圆点。H5 单列、球 160px、标题 30px。
 */

import Link from "next/link";
import { BallAnchor } from "@/components/mimic/ball/ball-context";

const DOTS = ["#DD5B00", "#FF64C8", "#7B3FF2", "#2A9D99", "#F5D75E"];

export default function CoverPage() {
  return (
    <div className="mimic-page flex min-h-dvh flex-col gap-8 bg-[#0A1530] px-6 pb-10 pt-8 sm:px-10 lg:gap-10 lg:px-20 lg:pb-16 lg:pt-20">
      {/* 顶栏 */}
      <header className="flex items-center justify-between">
        <span className="font-['Inter'] text-lg font-semibold text-white">Chat Elf</span>
        <span className="rounded-full bg-[#5645D4] px-2.5 py-1 text-xs font-semibold text-white">
          拟态球操作系统
        </span>
      </header>

      {/* Hero */}
      <main className="flex flex-1 flex-col items-center justify-center gap-6 lg:gap-8">
        <BallAnchor state="idle" variant="light" className="h-40 w-40 lg:h-[220px] lg:w-[220px]" />

        <h1 className="text-center text-[30px] font-semibold leading-tight text-white lg:text-[56px]">
          一个会转头看你的陪伴。
        </h1>

        <p className="max-w-xl text-center text-sm leading-[1.6] text-[#A4A097] lg:max-w-[720px] lg:text-lg lg:leading-[1.5]">
          从注册孵化到记忆翻阅，整套系统都围着这颗拟态球转。跟随鼠标、点击彩虹、切页转场。
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/mimic/register"
            className="flex h-11 items-center rounded-lg bg-[#5645D4] px-5 text-sm font-medium text-white transition-colors hover:bg-[#4536A8] active:bg-[#4536A8] lg:h-11"
          >
            开始孵化
          </Link>
          <Link
            href="/mimic/language"
            className="flex h-11 items-center rounded-lg border border-[#A4A097] px-5 text-sm font-medium text-white transition-colors hover:border-white hover:bg-white/10"
          >
            看状态语言
          </Link>
        </div>
      </main>

      {/* 底部五彩圆点 */}
      <footer className="flex items-center justify-center gap-2">
        {DOTS.map((c) => (
          <span key={c} className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c }} />
        ))}
      </footer>
    </div>
  );
}
