import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { BallProvider } from "@/components/mimic/ball/ball-context";
import "./globals.css";
import "./mimic.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Chat Elf",
    template: "%s | Chat Elf",
  },
  description: "AI 实时语音陪伴",
};

// H5 适配:显式视口声明,viewportFit 覆盖刘海屏安全区
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * 根布局 — 2026-08-31 UI 大一统后,拟态球界面是唯一 UI:
 * BallProvider(球常驻层)、mimic.css(设计 token)、Inter/Noto 字体
 * 全部在此全局生效。模拟球 spec §4.3:球是跨路由常驻层,不随页面卸载。
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      {/* dvh 而非 vh:移动端浏览器地址栏收展会改变视口高度,dvh 动态跟随 */}
      <body className="flex min-h-dvh flex-col">
        <div className="mimic-root">
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
          {/* 设计稿字体走运行时 link 引入,构建期不依赖网络(next/font 拉取失败会
              fail build),离线时回退系统字体栈 */}
          {/* eslint-disable-next-line @next/next/no-page-custom-font */}
          <link
            rel="stylesheet"
            href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;600;700&display=swap"
          />
          <BallProvider>{children}</BallProvider>
        </div>
      </body>
    </html>
  );
}