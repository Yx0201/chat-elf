/**
 * 实时语音接入通道(provider)解析层 —— 服务端专用。
 *
 * 两条通道(2026-08-28 引入双通道,默认 tokenplan):
 *   - tokenplan:百炼 Token Plan 订阅,域名 token-plan.{region}.maas.aliyuncs.com,
 *     模型 qwen-audio-3.0-realtime-plus(Qwen-Audio-Realtime 系列);
 *   - dashscope:百炼业务空间按量计费,{WorkspaceId}.{region}.maas.aliyuncs.com,
 *     模型 qwen3.5-omni-flash-realtime(Qwen-Omni-Realtime 系列)。
 *
 * 由环境变量 REALTIME_PROVIDER 切换;两套配置互不影响、可随时切回。
 */

import {
  buildWebRTCSignalingEndpoint,
  DashScopeConfigError,
  REALTIME_MODEL,
  resolveDashScopeConfig,
} from "@/lib/dashscope/config";
import {
  resolveTokenPlanConfig,
  TokenPlanConfigError,
} from "@/lib/tokenplan/config";
import {
  DASHSCOPE_SESSION_DEFAULTS,
  TOKENPLAN_SESSION_DEFAULTS,
  type RealtimeProviderId,
  type RealtimeSessionDefaults,
} from "./session-defaults";

/** 默认通道(2026-08-28 修订:当前使用 Token Plan)。 */
export const DEFAULT_REALTIME_PROVIDER: RealtimeProviderId = "tokenplan";

export interface RealtimeEndpoint {
  provider: RealtimeProviderId;
  model: string;
  apiKey: string;
  /** 完整 WebRTC 信令端点(POST Offer SDP,响应 Answer SDP) */
  signalingUrl: string;
}

export class RealtimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealtimeConfigError";
  }
}

function readProviderEnv(): string {
  return (process.env.REALTIME_PROVIDER ?? DEFAULT_REALTIME_PROVIDER).trim().toLowerCase();
}

/** 解析当前通道的完整信令端点与密钥;配置缺失时抛 RealtimeConfigError。仅在 Node runtime 调用。 */
export function resolveRealtimeEndpoint(): RealtimeEndpoint {
  const provider = readProviderEnv();

  if (provider === "dashscope") {
    try {
      const config = resolveDashScopeConfig();
      return {
        provider: "dashscope",
        model: REALTIME_MODEL,
        apiKey: config.apiKey,
        signalingUrl: buildWebRTCSignalingEndpoint(config),
      };
    } catch (error) {
      if (error instanceof DashScopeConfigError) {
        throw new RealtimeConfigError(error.message);
      }
      throw error;
    }
  }

  if (provider === "tokenplan") {
    try {
      const config = resolveTokenPlanConfig();
      return {
        provider: "tokenplan",
        model: config.model,
        apiKey: config.apiKey,
        signalingUrl: config.signalingUrl,
      };
    } catch (error) {
      if (error instanceof TokenPlanConfigError) {
        throw new RealtimeConfigError(error.message);
      }
      throw error;
    }
  }

  throw new RealtimeConfigError(
    `REALTIME_PROVIDER 仅支持 tokenplan 或 dashscope,当前值: "${provider}"`,
  );
}

/**
 * 当前通道的 session.update 参数预设(供页面注入客户端 Hook)。
 * 只读通道选择、不校验密钥——密钥缺失只应让信令路由报错,不应影响页面渲染。
 */
export function resolveRealtimeSessionDefaults(): RealtimeSessionDefaults {
  const provider = readProviderEnv();
  if (provider === "dashscope") return DASHSCOPE_SESSION_DEFAULTS;
  return TOKENPLAN_SESSION_DEFAULTS;
}
