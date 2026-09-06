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

/**
 * 向量通道覆盖(2026-09-06):设 EMBEDDING_BASE_URL 后向量走独立的 OpenAI 兼容
 * 端点(本地 Ollama 等),文本/重排/realtime 不受影响。
 * 本地开发例:EMBEDDING_BASE_URL=http://localhost:11434/v1
 *           DASHSCOPE_EMBEDDING_MODEL=qwen3-embedding:4b(原生 2560 维,
 *           经 MRL dimensions=1024 截断,与库列保持一致)。
 * 生产不设 = 与文本同走 DashScope 兼容端点。
 * ⚠️ 不同模型的向量空间互不兼容:切换后旧向量需重新生成(知识库重新摄取,
 *   记忆向量置 NULL 降级),不可混用。
 */
export const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL?.trim() || null;
/** 覆盖端点的 API Key(Ollama 无鉴权,占位即可)。 */
export const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY?.trim() || "ollama";

const EMBEDDING_OVERRIDE_PROVIDER_NAME = "local-embedding";

/** 向量模型 + 其 provider 名(providerOptions 的 dimensions 要按名挂)。 */
export function getEmbeddingChannel(): {
  model: ReturnType<ReturnType<typeof createOpenAICompatible>["textEmbeddingModel"]>;
  providerName: string;
} {
  if (EMBEDDING_BASE_URL !== null) {
    const provider = createOpenAICompatible({
      name: EMBEDDING_OVERRIDE_PROVIDER_NAME,
      apiKey: EMBEDDING_API_KEY,
      baseURL: EMBEDDING_BASE_URL,
    });
    return { model: provider.textEmbeddingModel(EMBEDDING_MODEL), providerName: EMBEDDING_OVERRIDE_PROVIDER_NAME };
  }
  return { model: getDashScopeProvider().textEmbeddingModel(EMBEDDING_MODEL), providerName: "dashscope" };
}

/**
 * 文本模型(记忆抽取 / 画像 / 知识库图谱抽取与摘要 / 文本问答)。
 * 2026-09-06 由 ZHIPU/GLM-5.3-Flash 切换为 qwen3.7-flash 并设为默认:
 * GLM 强制思考(单次 3-8s)+ 200RPM 限流,图谱抽取一部 2.5MB 小说要一小时+;
 * qwen3.7-flash 非思考 0.6-1.5s、30000RPM、输入0.2/输出0.8元,同小说 14 分钟
 * 且抽取质量不降(1073 实体/4950 关系验证)。
 */
export const TEXT_MODEL = process.env.DASHSCOPE_TEXT_MODEL?.trim() || "qwen3.7-flash";

/**
 * TEXT_MODEL 调用的统一 providerOptions(2026-09-06):
 * qwen3 系默认开思考(实测 qwen3.7-flash 返回 reasoning_content),结构化抽取/
 * 摘要场景不需要,关掉可把单次调用从 2-8s 压到亚秒级;GLM 不接受该参数
 * (会报"始终思考"),非 qwen3 模型返回空对象跳过。
 */
export function textModelProviderOptions(): Record<string, Record<string, boolean>> {
  return TEXT_MODEL.toLowerCase().includes("qwen3")
    ? { dashscope: { enable_thinking: false } }
    : {};
}

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
