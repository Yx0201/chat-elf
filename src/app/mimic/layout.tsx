import type { Metadata } from "next";
import type { ReactNode } from "react";
import { BallProvider } from "@/components/mimic/ball/ball-context";
import "./mimic.css";

export const metadata: Metadata = {
  title: "拟态球陪伴系统",
  description: "一个会转头看你的陪伴——拟态球驱动的整套界面设计预览。",
};

/**
 * /mimic 路由组：Ardot 设计稿《Chat Elf 陪伴机器人》的 1:1 实现预览。
 *
 * 设计稿字体（Inter / Noto Sans SC）走运行时 link 引入：
 * 构建期不依赖网络（next/font 拉取失败会直接 fail build），
 * 离线时回退系统字体栈，视觉权重接近。
 */
export default function MimicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mimic-root">
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      {/* 字体作用域仅限 /mimic（不影响现有页面）；App Router 下嵌套布局按需
          加载正是预期行为，该规则针对 Pages Router 的全站字体场景，属误报 */}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;600;700&display=swap"
      />
      <BallProvider>{children}</BallProvider>
    </div>
  );
}
