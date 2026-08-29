import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

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
    default: "chat-elf",
    template: "%s | chat-elf",
  },
  description: "AI 实时语音对话",
};

// H5 适配:显式视口声明,viewportFit 覆盖刘海屏安全区
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      {/* dvh 而非 vh:移动端浏览器地址栏收展会改变视口高度,dvh 动态跟随 */}
      <body className="flex min-h-dvh flex-col">{children}</body>
    </html>
  );
}
