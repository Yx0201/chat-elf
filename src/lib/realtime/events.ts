/**
 * DashScope Qwen-Omni Realtime 协议事件的显式类型定义。
 *
 * 事件清单与字段依据官方文档核实(2026-08):
 *   - 服务端事件: https://help.aliyun.com/zh/model-studio/server-events
 *   - 客户端事件: https://help.aliyun.com/zh/model-studio/client-events
 *   - WebRTC 接入: https://help.aliyun.com/zh/model-studio/realtime
 *
 * 与一般 OpenAI Realtime 兼容协议的差异点已在对应类型处注明。
 * 传输层:服务端通过名为 "txt" 的 DataChannel 推送 JSON 事件(WebRTC 模式);
 * 音频走 RTP 轨道,不使用 input_audio_buffer.append / input_image_buffer.append。
 */

/* ------------------------------------------------------------------ */
/* 公共基础                                                            */
/* ------------------------------------------------------------------ */

interface EventEnvelope {
  /** 服务端事件的唯一 ID(如 evt_xxx);可选。 */
  event_id?: string;
}

export type Modality = "text" | "audio";

/** WebRTC 下仅支持服务端 VAD,不支持手动模式(null)。 */
export type TurnDetectionType = "server_vad" | "semantic_vad";

export interface TurnDetection {
  type: TurnDetectionType;
  /** [-1.0, 1.0],默认 0.5,越低越灵敏 */
  threshold?: number;
  /** 语音开始前的padding,官方 WebRTC 示例取 500 ms */
  prefix_padding_ms?: number;
  /** [200, 6000] ms,默认 800 */
  silence_duration_ms?: number;
  /** [5000, 30000] ms;仅 qwen3.5 omni 系列 + server_vad 生效 */
  idle_timeout_ms?: number;
}

export interface AudioFormat {
  /** pcm(默认,单声道 16bit)| wav */
  type: "pcm" | "wav";
  /** 8000 | 16000(默认) | 24000 | 48000;输出侧默认 24000 */
  sample_rate?: number;
}

/**
 * 函数工具定义(type 固定为 "function")。
 * 注意:enable_search 与 tools 互斥,不可同时开启。
 */
export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  };
}

/** search_options 子对象。 */
export interface SearchOptions {
  enable_source?: boolean;
}

/** usage 输出(respondse.done 携带)。 */
export interface ResponseUsage {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { text_tokens: number; audio_tokens: number };
  output_tokens_details?: { text_tokens: number; audio_tokens: number };
}

/* ------------------------------------------------------------------ */
/* 会话对象                                                            */
/* ------------------------------------------------------------------ */

/** 对话项内容片段(text 或 audio 转写)。 */
export interface ItemContentPart {
  type: "text" | "audio";
  text?: string;
  transcript?: string;
}

/** 对话项(message 或 function_call)。 */
export interface ConversationItem {
  id?: string;
  object?: "realtime.item";
  status?: string;
  role?: "user" | "assistant" | "system";
  type?: "message" | "function_call";
  content?: ItemContentPart[];
  /** function_call 时存在 */
  name?: string;
  call_id?: string;
  arguments?: string;
}

/** 输出项(response.output 内元素),结构同对话项。 */
export type ResponseOutputItem = ConversationItem;

export interface RealtimeResponse {
  id?: string;
  conversation_id?: string;
  object?: "realtime.response";
  status?: "in_progress" | "completed" | "failed" | "incomplete";
  modalities?: Modality[];
  voice?: string;
  output?: ResponseOutputItem[];
  usage?: ResponseUsage;
}

/* ------------------------------------------------------------------ */
/* 客户端 → 服务端事件                                                  */
/* ------------------------------------------------------------------ */

/**
 * session.update 的会话配置。
 * 字段取值来自客户端事件文档;qwen3.5-Omni 默认音色 Tina、温度 0.7、top_p 0.8、top_k 20。
 * 注:输入转写在 session.created 中默认启用(input_audio_transcription.model = qwen3-asr-flash-realtime);
 * 其是否可通过 session.update 调整未在客户端事件文档中列明,接入时按官方文档核对。
 */
export interface SessionUpdateParams {
  modalities?: Modality[];
  voice?: string;
  instructions?: string;

  /** qwen3.5 系列新结构(推荐) */
  audio?: {
    input?: { format?: AudioFormat };
    output?: { format?: AudioFormat };
  };
  /** 历史兼容字段,文档建议改用 audio 结构 */
  input_audio_format?: string;
  output_audio_format?: string;

  turn_detection?: TurnDetection;
  /**
   * 输入语音转写配置;官方 WebRTC 示例显式下发 qwen3-asr-flash-realtime,
   * 该字段同样出现在 session.created 返回中(默认启用)。
   */
  input_audio_transcription?: { model?: string };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  presence_penalty?: number;
  seed?: number;

  enable_search?: boolean;
  search_options?: SearchOptions;
  tools?: FunctionTool[];
}

export type ClientEvent =
  | (EventEnvelope & { type: "session.update"; session: SessionUpdateParams })
  // VAD 模式下自动生成响应,仅在回传工具结果后必须发送
  | (EventEnvelope & { type: "response.create" })
  | (EventEnvelope & { type: "response.cancel" })
  /** WebSocket 模式专用;WebRTC 音频走 RTP,不需要 append */
  | (EventEnvelope & { type: "input_audio_buffer.append"; audio: string })
  | (EventEnvelope & { type: "input_audio_buffer.commit" })
  | (EventEnvelope & { type: "input_audio_buffer.clear" })
  /** WebSocket 模式专用;WebRTC 图片走视频轨道 */
  | (EventEnvelope & { type: "input_image_buffer.append"; image_url: string })
  /** 当前仅支持回传 function_call_output */
  | (EventEnvelope & { type: "conversation.item.create"; item: ConversationItem });

/* ------------------------------------------------------------------ */
/* 服务端 → 客户端事件(discriminated union)                            */
/* ------------------------------------------------------------------ */

export interface RealtimeErrorBody {
  type?: string;
  code?: string;
  message?: string;
  /** 出错的参数路径,如 session.modalities */
  param?: string;
}

// 会话与错误 ---------------------------------------------------------

export interface ErrorEvent extends EventEnvelope {
  type: "error";
  error: RealtimeErrorBody;
}

export interface SessionCreatedEvent extends EventEnvelope {
  type: "session.created";
  /** 连接建立后服务端经 txt 通道推送的首个事件 */
  session: {
    object?: string;
    model?: string;
    modalities?: Modality[];
    voice?: string;
    input_audio_format?: string;
    output_audio_format?: string;
    input_audio_transcription?: { model?: string };
    turn_detection?: TurnDetection;
    enable_search?: boolean;
    search_options?: SearchOptions;
    temperature?: number;
  };
}

export interface SessionUpdatedEvent extends EventEnvelope {
  type: "session.updated";
  session: SessionUpdateParams;
}

// 音频缓冲区(主要用于打断处理与状态反馈) -----------------------------

export interface SpeechStartedEvent extends EventEnvelope {
  type: "input_audio_buffer.speech_started";
  /** 相对当前音频块的起始毫秒 */
  audio_start_ms?: number;
  item_id?: string;
}

export interface SpeechStoppedEvent extends EventEnvelope {
  type: "input_audio_buffer.speech_stopped";
  audio_end_ms?: number;
  item_id?: string;
}

export interface InputAudioBufferCommittedEvent extends EventEnvelope {
  type: "input_audio_buffer.committed";
  item_id?: string;
}

export interface InputAudioBufferClearedEvent extends EventEnvelope {
  type: "input_audio_buffer.cleared";
}

// 对话项与用户语音转录 -----------------------------------------------

export interface ConversationItemCreatedEvent extends EventEnvelope {
  type: "conversation.item.created";
  previous_item_id?: string;
  item: ConversationItem;
}

export interface InputTranscriptionDeltaEvent extends EventEnvelope {
  type: "conversation.item.input_audio_transcription.delta";
  item_id?: string;
  content_index?: number;
  /** 已确认前缀;完整句子 = text + stash */
  text?: string;
  stash?: string;
  language?: string;
  emotion?: string;
}

export interface InputTranscriptionCompletedEvent extends EventEnvelope {
  type: "conversation.item.input_audio_transcription.completed";
  item_id?: string;
  content_index?: number;
  transcript?: string;
}

export interface InputTranscriptionFailedEvent extends EventEnvelope {
  type: "conversation.item.input_audio_transcription.failed";
  item_id?: string;
  content_index?: number;
  error: RealtimeErrorBody;
}

// 响应流 -------------------------------------------------------------

export interface OutputItemAddedEvent extends EventEnvelope {
  type: "response.output_item.added";
  response_id?: string;
  output_index?: number;
  item: ResponseOutputItem;
}

export interface OutputItemDoneEvent extends EventEnvelope {
  type: "response.output_item.done";
  response_id?: string;
  output_index?: number;
  item: ResponseOutputItem;
}

export interface ContentPartAddedEvent extends EventEnvelope {
  type: "response.content_part.added";
  response_id?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  part: ItemContentPart;
}

export interface ContentPartDoneEvent extends EventEnvelope {
  type: "response.content_part.done";
  response_id?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  part: ItemContentPart;
}

/** 用户语音→字幕的增量由 transcription 事件承担;此为纯文本模态输出。 */
export interface TextDeltaEvent extends EventEnvelope {
  type: "response.text.delta";
  response_id?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  delta?: string;
}

export interface TextDoneEvent extends EventEnvelope {
  type: "response.text.done";
  response_id?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  text?: string;
}

/** 增量音频(Base64 编码 PCM 分片),用于播放队列。 */
export interface AudioDeltaEvent extends EventEnvelope {
  type: "response.audio.delta";
  response_id?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  delta?: string;
}

export interface AudioDoneEvent extends EventEnvelope {
  type: "response.audio.done";
  response_id?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
}

/** 助手字幕增量;architecture:消费 delta/done 作为助手字幕。 */
export interface AudioTranscriptDeltaEvent extends EventEnvelope {
  type: "response.audio_transcript.delta";
  response_id?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  delta?: string;
}

export interface AudioTranscriptDoneEvent extends EventEnvelope {
  type: "response.audio_transcript.done";
  response_id?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  transcript?: string;
}

export interface FunctionCallArgumentsDeltaEvent extends EventEnvelope {
  type: "response.function_call_arguments.delta";
  response_id?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  call_id?: string;
  delta?: string;
}

export interface FunctionCallArgumentsDoneEvent extends EventEnvelope {
  type: "response.function_call_arguments.done";
  response_id?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  call_id?: string;
  name?: string;
  /** 完整参数 JSON 字符串,以此为准 */
  arguments?: string;
}

export interface ResponseCreatedEvent extends EventEnvelope {
  type: "response.created";
  response: RealtimeResponse;
}

export interface ResponseDoneEvent extends EventEnvelope {
  type: "response.done";
  response: RealtimeResponse;
}

/**
 * 服务端全部 25 种事件(已对照官方文档逐条核实)。
 * 新增成员时同步维护 SERVER_EVENT_TYPE_TUPLE。
 */
export type ServerEvent =
  | ErrorEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SpeechStartedEvent
  | SpeechStoppedEvent
  | InputAudioBufferCommittedEvent
  | InputAudioBufferClearedEvent
  | ConversationItemCreatedEvent
  | InputTranscriptionDeltaEvent
  | InputTranscriptionCompletedEvent
  | InputTranscriptionFailedEvent
  | OutputItemAddedEvent
  | OutputItemDoneEvent
  | ContentPartAddedEvent
  | ContentPartDoneEvent
  | TextDeltaEvent
  | TextDoneEvent
  | AudioDeltaEvent
  | AudioDoneEvent
  | AudioTranscriptDeltaEvent
  | AudioTranscriptDoneEvent
  | FunctionCallArgumentsDeltaEvent
  | FunctionCallArgumentsDoneEvent
  | ResponseCreatedEvent
  | ResponseDoneEvent;

export type ServerEventTypeName = ServerEvent["type"];
export type ClientEventTypeName = ClientEvent["type"];

/** 运行时可用的服务端事件名集合;编译期校验与 ServerEvent union 保持一致。 */
export const SERVER_EVENT_TYPE_TUPLE = [
  "error",
  "session.created",
  "session.updated",
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.committed",
  "input_audio_buffer.cleared",
  "conversation.item.created",
  "conversation.item.input_audio_transcription.delta",
  "conversation.item.input_audio_transcription.completed",
  "conversation.item.input_audio_transcription.failed",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.text.delta",
  "response.text.done",
  "response.audio.delta",
  "response.audio.done",
  "response.audio_transcript.delta",
  "response.audio_transcript.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.created",
  "response.done",
] as const satisfies readonly ServerEventTypeName[];

const SERVER_EVENT_TYPE_SET: ReadonlySet<string> = new Set(SERVER_EVENT_TYPE_TUPLE);

export function isServerEventTypeName(type: string): type is ServerEventTypeName {
  return SERVER_EVENT_TYPE_SET.has(type);
}
