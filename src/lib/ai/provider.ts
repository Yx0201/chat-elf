/**
 * AI SDK 的模型通道 —— 服务端专用(ARCHITECTURE.md「Agentic 层架构」)。
 *
 * 通道:@ai-sdk/openai-compatible → 百炼 DashScope **OpenAI 兼容模式**。
 * 复用 DASHSCOPE_API_KEY,密钥只在本文件所属的服务端路径出现。
 *
 * ⚠️ baseURL 的两种官方写法(2026-08-29 核实):
 *   A. `https://dashscope.aliyuncs.com/compatible-mode/v1`
 *      —— ARCHITECTURE.md【已确认】采用的公共云端点,只需 API Key。
 *   B. `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`
 *      —— 官方文档(通用文本向量同步接口 API 详情)给出的业务空间端点。
 * 两者阿里云均有文档。默认沿用 A(已确认决策),可用环境变量切到 B。
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { resolveDashScopeConfig } from "@/lib/dashscope/config";

/** 百炼兼容模式默认端点(ARCHITECTURE.md 已确认)。 */
export const DEFAULT_COMPATIBLE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/**
 * 文本向量模型。
 * 维度 1024 是 v3 / v4 / qwen3.7-text-embedding 三者的**默认**维度,
 * 与 `EMBEDDING_DIMENSIONS` 一致;换模型若改了 dimensions,需同步改表。
 */
export const EMBEDDING_MODEL = process.env.DASHSCOPE_EMBEDDING_MODEL?.trim() || "text-embedding-v3";

/** 文本模型(记忆抽取 / 会话摘要)。 */
export const TEXT_MODEL = process.env.DASHSCOPE_TEXT_MODEL?.trim() || "qwen-plus";

/**
 * 构造 provider。每次调用都重新读环境变量 —— 配置缺失应在使用点报错,
 * 而不是在模块加载期炸掉整个进程(页面渲染不应因缺 key 而 500)。
 */
export function getDashScopeProvider(): ReturnType<typeof createOpenAICompatible> {
  const { apiKey } = resolveDashScopeConfig();
  return createOpenAICompatible({
    name: "dashscope",
    apiKey,
    baseURL: process.env.DASHSCOPE_COMPATIBLE_BASE_URL?.trim() || DEFAULT_COMPATIBLE_BASE_URL,
  });
}

/** AI 文本通道是否可用(缺 DASHSCOPE_API_KEY 时为 false,记忆抽取降级为跳过)。 */
export function isAiConfigured(): boolean {
  const key = process.env.DASHSCOPE_API_KEY;
  return typeof key === "string" && key.trim() !== "";
}
