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

import type { FunctionTool, SessionUpdateParams } from "./events";

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

/* ------------------------------------------------------------------ */
/* Function Calling:会话中实时标记记忆(step3 T2)                        */
/* ------------------------------------------------------------------ */

export const REMEMBER_FACT_TOOL_NAME = "remember_fact";

/**
 * 配套写进 instructions 的使用说明。
 *
 * 为什么description 之外还要在 instructions 里再说一遍:description 决定
 * "什么时候调用",而"调用之后怎么表现"要交给指令 —— 否则模型很可能
 * 对麦克风说一句"我记下了",那是最破坏陪伴感的打断。
 */
export const REMEMBER_FACT_USAGE_HINT =
  "【记性】你有一个 remember_fact 工具:用户说出长期有效的信息时,调用它记下来。" +
  "只在真的值得长期记住时才用,不要为了用而用。" +
  "调用后自然接话,**不要向用户提起\"我记下了\"或复述你记住的内容** —— 默默记住就好。";

/**
 * 让模型在听到"长期有效的事实"时当场调用,不等会话结束后批量抽取。
 *
 * 官方协议(2026-08 核实,客户端事件文档):
 *   `{ type:"function", function:{ name, description, parameters:{type:"object", properties, required} } }`
 * description 是模型判断"要不要调用"的唯一依据,所以规则都写在里面 ——
 * 模型和人不同,它看不到我们的代码注释。
 *
 * 注意 `tools` 与 `enable_search` 互斥(官方文档明确),本项目不开联网搜索。
 */
export const REMEMBER_FACT_TOOL: FunctionTool = {
  type: "function",
  function: {
    name: REMEMBER_FACT_TOOL_NAME,
    description:
      "把用户刚透露的、长期有效的信息记下来,以后还能用上。\n" +
      "只在用户明确说出下列内容时调用:\n" +
      "- 身份与背景(职业、年龄、家乡、现居地、家庭情况)\n" +
      "- 长期偏好(喜欢/讨厌什么、习惯、口味)\n" +
      "- 持续的状态或计划(在健身、在找工作、下个月要搬家)\n" +
      "- 重要人际关系(恋人、家人、朋友的姓名与关系)\n" +
      "- 反复出现的情绪模式(长期焦虑、最近一直失眠)\n" +
      "不要记录:今天吃了什么等一次性琐事、你自己说过的话、客套寒暄。\n" +
      "content 用第三人称客观陈述(如'养了一只叫年糕的猫'),不要带'用户说'这类前缀,不超过 60 字。\n" +
      "一次调用只记一件事;同一轮里没有值得记的就不要调用。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要记住的信息,客观陈述,不超过 60 字" },
        category: {
          type: "string",
          description: "信息的类别",
          enum: ["fact", "preference", "event", "relationship", "emotion"],
        },
        importance: { type: "number", description: "0 到 1,对以后的陪伴对话有多有用" },
      },
      required: ["content", "category"],
    },
  },
};
