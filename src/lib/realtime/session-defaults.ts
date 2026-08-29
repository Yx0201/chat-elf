/**
 * 各接入通道(provider)的 session.update 差异化参数预设。
 *
 * 纯数据模块(不读环境变量),服务端 provider 解析与客户端 Hook 均可引用。
 * 差异依据官方文档核实(2026-08):
 *   - Qwen-Omni-Realtime(qwen3.5 系列):
 *       https://help.aliyun.com/zh/model-studio/client-events
 *       支持 input_audio_transcription 显式配置;idle_timeout_ms 仅
 *       qwen3.5-omni-plus/flash-realtime + server_vad 生效。
 *   - Qwen-Audio-Realtime(qwen-audio-3.0 系列):
 *       https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides
 *       turn_detection 仅支持 server_vad / smart_turn / null(语义模式名为
 *       smart_turn,非 semantic_vad);无 idle_timeout_ms;无独立输入转写
 *       配置项(转写默认开启);音色仅首次 session.update 可设,默认 longanqian。
 */

import type { SessionUpdateParams } from "./events";

export type RealtimeProviderId = "dashscope" | "tokenplan";

export interface RealtimeSessionDefaults {
  provider: RealtimeProviderId;
  /** session.update 中随 provider/模型差异化的字段(与通用字段合并下发) */
  sessionUpdate: Partial<SessionUpdateParams>;
}

export const DASHSCOPE_SESSION_DEFAULTS: RealtimeSessionDefaults = {
  provider: "dashscope",
  sessionUpdate: {
    input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
    // 闲聊定位:静默 8s 后模型主动抛话头(仅 qwen3.5 omni 系列支持)
    turn_detection: { type: "server_vad", idle_timeout_ms: 8000 },
  },
};

export const TOKENPLAN_SESSION_DEFAULTS: RealtimeSessionDefaults = {
  provider: "tokenplan",
  sessionUpdate: {
    // qwen-audio-3.0 系列:不下发 input_audio_transcription(无此配置项,
    // 转写默认开启);turn_detection 只取 server_vad,不带 idle_timeout_ms
    turn_detection: { type: "server_vad" },
  },
};
