/**
 * Token Plan(百炼订阅服务)服务端专用配置。
 * 本文件只能被服务端代码路径引用;密钥绝不进入前端 bundle。
 *
 * 端点与鉴权依据官方文档核实(2026-08):
 *   - Realtime Token 鉴权: https://help.aliyun.com/zh/model-studio/realtime-token-authentication
 *     WebRTC 无需临时令牌,SDP 交换 HTTP 请求直接携带 Bearer API Key;
 *     "如果使用 Token Plan,接入域名中的 WorkspaceId 固定为 token-plan"。
 *   - 模型: https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides
 */

export const TOKENPLAN_DEFAULT_REGION = "cn-beijing";

/** Token Plan 接入域名中 WorkspaceId 固定为 token-plan(官方 Token 鉴权文档)。 */
const TOKENPLAN_HOST = "token-plan";

/** Token Plan 通道默认模型:Qwen-Audio-Realtime 系列。 */
export const TOKENPLAN_DEFAULT_MODEL = "qwen-audio-3.0-realtime-plus" as const;

export interface TokenPlanConfig {
  apiKey: string;
  model: string;
  /** 完整 WebRTC 信令端点(含 ?model= 查询参数) */
  signalingUrl: string;
}

export class TokenPlanConfigError extends Error {
  constructor(missingVars: readonly string[]) {
    super(
      `缺少必需的环境变量: ${missingVars.join(", ")}。` +
        `请在 .env.local 中配置(参考 .env.example)。`,
    );
    this.name = "TokenPlanConfigError";
  }
}

/**
 * 读取并校验 Token Plan 服务端配置。
 * TOKENPLAN_SIGNALING_URL 可整段覆盖信令端点(平台文档形态变化时无需改代码)。
 */
export function resolveTokenPlanConfig(): TokenPlanConfig {
  const apiKey = process.env.TOKENPLAN_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new TokenPlanConfigError(["TOKENPLAN_API_KEY"]);
  }

  const model = process.env.TOKENPLAN_MODEL?.trim() || TOKENPLAN_DEFAULT_MODEL;
  const region = process.env.TOKENPLAN_REGION?.trim() || TOKENPLAN_DEFAULT_REGION;
  const explicitUrl = process.env.TOKENPLAN_SIGNALING_URL?.trim();

  const signalingUrl =
    explicitUrl !== undefined && explicitUrl !== ""
      ? explicitUrl
      : `https://${TOKENPLAN_HOST}.${region}.maas.aliyuncs.com` +
        `/api/v1/webrtc/realtime?model=${encodeURIComponent(model)}`;

  return { apiKey: apiKey.trim(), model, signalingUrl };
}
