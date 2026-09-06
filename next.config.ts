import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,

  /**
   * 知识库模块:Rust/N-API 原生模块不打包,交给 Node 运行时 require。
   */
  serverExternalPackages: ["@node-rs/jieba"],

  /**
   * 2026-08-31 UI 大一统:拟态球界面升为根路由,旧 /mimic/* 预览路由
   * 全部 308 到新落点,老收藏链不断。具体规则在前,兜底通配在后。
   */
  async redirects() {
    return [
      { source: "/mimic/register", destination: "/hatch", permanent: true },
      { source: "/mimic/chat/:conversationId", destination: "/chat/:conversationId", permanent: true },
      { source: "/mimic", destination: "/", permanent: true },
      { source: "/mimic/:path*", destination: "/:path*", permanent: true },
    ];
  },
};

export default nextConfig;