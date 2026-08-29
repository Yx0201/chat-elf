/**
 * DashScope(阿里云百炼)服务端专用配置。
 * 本文件只能被服务端代码路径引用(Route Handlers / Server Actions)。
 * 密钥绝不进入前端 bundle —— 见 ARCHITECTURE.md「环境变量」与「编码约定」。
 *
 * 信令端点形态已按官方文档核实(2026-08):
 * https://help.aliyun.com/zh/model-studio/realtime
 */

export const DEFAULT_REGION = "cn-beijing";

/** 实时语音模型【ARCHITECTURE.md 已确认】 */
export const REALTIME_MODEL = "qwen3.5-omni-flash-realtime" as const;

export interface DashScopeConfig {
  apiKey: string;
  workspaceId: string;
  region: string;
}

export class DashScopeConfigError extends Error {
  constructor(missingVars: readonly string[]) {
    super(
      `缺少必需的环境变量: ${missingVars.join(", ")}。` +
        `请在 .env.local 中配置(参考 .env.example)。`,
    );
    this.name = "DashScopeConfigError";
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DashScopeConfigError([name]);
  }
  return value.trim();
}

/** 读取并校验服务端环境;缺失时抛出带明确提示的错误。仅在 Node runtime 调用。 */
export function resolveDashScopeConfig(): DashScopeConfig {
  const missing: string[] = [];
  for (const name of ["DASHSCOPE_API_KEY", "DASHSCOPE_WORKSPACE_ID"] as const) {
    const value = process.env[name];
    if (typeof value !== "string" || value.trim() === "") {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new DashScopeConfigError(missing);
  }

  return {
    apiKey: requireEnv("DASHSCOPE_API_KEY"),
    workspaceId: requireEnv("DASHSCOPE_WORKSPACE_ID"),
    region: process.env.DASHSCOPE_REGION?.trim() || DEFAULT_REGION,
  };
}

/**
 * 拼装 WebRTC 信令端点:
 * POST https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1/webrtc/realtime?model={model}
 * 请求体为 Offer SDP(application/sdp),响应体为 Answer SDP。
 */
export function buildWebRTCSignalingEndpoint(
  config: DashScopeConfig,
  model: string = REALTIME_MODEL,
): string {
  return (
    `https://${config.workspaceId}.${config.region}.maas.aliyuncs.com` +
    `/api/v1/webrtc/realtime?model=${encodeURIComponent(model)}`
  );
}
