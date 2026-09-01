"use client";

/**
 * WebRTC 实时会话状态机(浏览器端唯一与模型交互的通道 —— 编码约定)。
 *
 * 流程对齐官方 WebRTC 最佳实践(2026-08 核实):
 * https://help.aliyun.com/zh/model-studio/best-practice-webrtc-omni-realtime
 * - getUserMedia 后立即门控静默(track.enabled=false + replaceTrack(null)),
 *   session.created 到达前发送的音频会被服务端丢弃;
 * - 客户端自建 "oai-events" DataChannel 发送命令,同时监听 pc.ondatachannel
 *   接收服务端创建的通道(txt)推送的事件;
 * - Offer 必须等 iceGatheringState === "complete";Answer 设置前做 CRLF 规范化。
 *
 * 已知模型约束(ARCHITECTURE.md「模型已知约束」):单会话最长 120 分钟,
 * 断线即新会话、无续接——自动重连与历史注入依赖落库文本,属后续记忆层工作,
 * 当前版本遇到断线仅上报错误并终止会话。
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { RemoteAudioPlayer, type ProsodyTap } from "@/lib/realtime/audio-playback";
import type { ClientEvent } from "@/lib/realtime/events";
import { PROSODY_CALIBRATED_VOICE } from "@/lib/persona/voices";
import { moodFromUserEmotion, prosodyToMood, textMood, type ElfMood, type ProsodySample } from "@/lib/realtime/mood";
import { parseServerEvent } from "@/lib/realtime/parse-events";
import {
  DASHSCOPE_SESSION_DEFAULTS,
  REMEMBER_FACT_TOOL,
  REMEMBER_FACT_TOOL_NAME,
  type RealtimeSessionDefaults,
} from "@/lib/realtime/session-defaults";

const SESSION_SIGNALING_PATH = "/api/realtime/session";

/** 单会话内模型调用工具的次数上限(spec T2 的防滥用要求)。 */
const MAX_TOOL_CALLS_PER_SESSION = 10;

/* ------- thinking 导演(2026-09-01 拍板):防思考态闪烁 ------- */
/** 用户说完后超过此时长仍无回复,才显示 thinking(之前保持聆听态)。 */
const THINK_DELAY_MS = 2000;
/** thinking 一旦显示,至少演示此时长才放出语音与字幕(防一闪而过)。 */
const THINK_MIN_MS = 1000;

const REMEMBER_FACT_CATEGORIES: readonly string[] = [
  "fact",
  "preference",
  "event",
  "relationship",
  "emotion",
];

/**
 * 解析模型给出的工具入参 —— arguments 是 JSON 字符串,且模型可能不按 schema 来
 * (缺字段、字段类型不对、塞进多余内容),逐字段收窄后才敢用。
 */
function parseRememberFactArguments(
  raw: string | undefined,
): { content: string; category: string; importance: number } | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (content === "") return null;

  const category =
    typeof record.category === "string" && REMEMBER_FACT_CATEGORIES.includes(record.category)
      ? record.category
      : "fact";
  const importance =
    typeof record.importance === "number" && Number.isFinite(record.importance)
      ? Math.min(1, Math.max(0, record.importance))
      : 0.6; // 模型没给就取中间值,不要按 0 处理 —— 0 会让记忆几乎检索不到

  return { content: content.slice(0, 200), category, importance };
}

/** 默认人设(instructions);后续由记忆层 context-builder 动态组装。 */
export const DEFAULT_INSTRUCTIONS =
  "你是 chat-elf,一个友好的中文语音助手。回答保持口语化、简洁,适合语音播报。";

export type RealtimeStatus =
  | "idle"
  | "starting"
  | "negotiating"
  | "live"
  | "user-talking"
  /** 用户说完话到模型开始应答之间的窗口(轮次检测计时/生成首包前) */
  | "thinking"
  | "assistant-talking";

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  /**
   * 落库后回填的 `messages.id`(step2 T4 的反馈埋点需要它)。
   * 播种的历史条目在服务端读取时就带上;会话中新产生的条目要等落库返回才有值。
   */
  dbId?: string;
  /** 该条已收到的反馈(👍 = 1 / 👎 = -1);历史条目从库里带出 */
  feedback?: 1 | -1 | null;
}

/** 播种用的历史条目：来自数据库，id 由 Hook 生成。 */
export interface SeedTranscriptEntry {
  role: TranscriptEntry["role"];
  text: string;
  /** 该条在 messages 表的主键；有了它历史消息也能打 👍/👎 */
  dbId?: string;
  /** 该条已收到的反馈 */
  feedback?: 1 | -1 | null;
}

interface RealtimeState {
  status: RealtimeStatus;
  error: string | null;
  /** 用户语音转写的流式中间结果(text + stash) */
  userPartial: string;
  /** 助手字幕流式增量 */
  assistantPartial: string;
  /**
   * 当前一轮响应是否已把助手文本定稿过一次。
   * audio_transcript.done 与 response.done 都会尝试收尾,
   * 后者只做清理不重复入列 —— 防止完整内容被打印两份。
   */
  assistantSettled: boolean;
  /** 用户当前话语的 ASR 情绪(协议原生 emotion 字段,流式更新) */
  userEmotion: string | null;
  /** 远端语音韵律启发式的最近结论(采样级更新,仅说话期有意义) */
  prosodyMood: ElfMood | null;
  history: TranscriptEntry[];
}

type RealtimeAction =
  | { kind: "reset-partial" }
  | { kind: "status"; status: RealtimeStatus }
  | { kind: "error"; message: string }
  | { kind: "clear-error" }
  | { kind: "user-partial"; text: string }
  | { kind: "user-final"; text: string }
  | { kind: "user-emotion"; emotion: string | null }
  | { kind: "prosody-mood"; mood: ElfMood | null }
  | { kind: "assistant-delta"; delta: string }
  /** 新一轮响应开始:复位定稿标记与残留流 */
  | { kind: "response-arm" }
  /** 一轮响应收尾(每次响应只采纳第一个到达的收尾事件) */
  | { kind: "assistant-settle"; fallback: string }
  /** 用户打断:丢弃尚未播完的助手字幕残留 */
  | { kind: "barge-in" }
  /** 转写落库后把 messages.id 挂到对应字幕条目上(供 👍/👎 反馈定位) */
  | { kind: "attach-db-id"; entryId: string; messageId: string };

let entrySeq = 0;

function pushEntry(
  history: TranscriptEntry[],
  role: TranscriptEntry["role"],
  text: string,
): TranscriptEntry[] {
  entrySeq += 1;
  return [...history, { id: `${role[0]}-${entrySeq}`, role, text }];
}

function initialState(history: TranscriptEntry[]): RealtimeState {
  return {
    status: "idle",
    error: null,
    userPartial: "",
    assistantPartial: "",
    assistantSettled: false,
    userEmotion: null,
    prosodyMood: null,
    history,
  };
}

function reducer(state: RealtimeState, action: RealtimeAction): RealtimeState {
  switch (action.kind) {
    case "reset-partial":
      return state.userPartial === "" && state.assistantPartial === ""
        ? state
        : { ...state, userPartial: "", assistantPartial: "" };
    case "status":
      return state.status === action.status ? state : { ...state, status: action.status };
    case "error": {
      const message = action.message.trim();
      if (message === "") return state;
      return { ...state, error: message };
    }
    case "clear-error":
      return state.error === null ? state : { ...state, error: null };
    case "user-partial":
      return state.userPartial === action.text ? state : { ...state, userPartial: action.text };
    case "user-final": {
      const text = action.text.trim();
      if (text === "") return { ...state, userPartial: "" };
      return { ...state, userPartial: "", history: pushEntry(state.history, "user", text) };
    }
    case "assistant-delta":
      return { ...state, assistantPartial: state.assistantPartial + action.delta };
    case "user-emotion":
      return state.userEmotion === action.emotion ? state : { ...state, userEmotion: action.emotion };
    case "prosody-mood":
      return state.prosodyMood === action.mood ? state : { ...state, prosodyMood: action.mood };
    case "response-arm":
      return state.assistantPartial === "" && !state.assistantSettled
        ? state
        : { ...state, assistantPartial: "", assistantSettled: false };
    case "assistant-settle": {
      // 已被更早的收尾事件(audio_transcript.done 通常先到)定稿,不再重复入列
      if (state.assistantSettled) {
        return state.assistantPartial === ""
          ? state
          : { ...state, assistantPartial: "" };
      }
      const text = state.assistantPartial.trim() !== ""
        ? state.assistantPartial.trim()
        : action.fallback.trim();
      const history = text === "" ? state.history : pushEntry(state.history, "assistant", text);
      return { ...state, assistantPartial: "", assistantSettled: true, history };
    }
    case "barge-in":
      return state.assistantPartial === ""
        ? state
        : { ...state, assistantPartial: "" };
    case "attach-db-id": {
      const index = state.history.findIndex((entry) => entry.id === action.entryId);
      if (index === -1 || state.history[index].dbId === action.messageId) return state;
      const history = [...state.history];
      history[index] = { ...history[index], dbId: action.messageId };
      return { ...state, history };
    }
  }
}

function normalizeAnswerSdp(answer: string): string {
  let sdp = answer.replace(/\r\n/g, "\n").trim().replace(/\n/g, "\r\n");
  if (!sdp.endsWith("\r\n")) sdp += "\r\n";
  return sdp;
}

/** 等待 ICE 收集完成;5 秒兜底超时后按当前进度放行。 */
function waitForIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(finish, 5000);
    function finish(): void {
      window.clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    function check(): void {
      if (pc.iceGatheringState === "complete") finish();
    }
    pc.addEventListener("icegatheringstatechange", check);
  });
}

async function extractSignalingError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const message = (body as Record<string, unknown>).error;
      if (typeof message === "string" && message.trim() !== "") return message;
    }
  } catch {}
  return `信令交换失败(HTTP ${response.status})`;
}

export interface UseRealtimeSessionOptions {
  /**
   * 进入已有会话时从数据库读出的历史转写,作为字幕区的初始内容。
   * 只在挂载时播种一次;id 由 Hook 生成(`h-<序号>`),与会话内新条目
   * (`u-` / `a-` 前缀)不会冲突。
   */
  initialHistory?: readonly SeedTranscriptEntry[];
  /** 人设与目标(system instructions),默认 DEFAULT_INSTRUCTIONS */
  instructions?: string;
  /** 音色,不传则使用服务端默认(qwen3.5-Omni 为 Tina,qwen-audio-3.0 为 longanqian) */
  voice?: string;
  /**
   * 接入通道的会话参数预设(由页面从服务端注入)。
   * 未注入时按 dashscope 旧行为兜底,保证 Hook 可独立使用。
   */
  sessionDefaults?: RealtimeSessionDefaults;
  /**
   * 模型在会话中调用 `remember_fact` 工具时的回调(step3 T2 实时标记轨)。
   * 不传 = 不注册该工具(对话照常,记忆只走会话后的批量抽取兜底)。
   */
  onRememberFact?: (fact: { content: string; category: string; importance: number }) => void;
}

export interface UseRealtimeSessionResult extends RealtimeState {
  /** 三层语气合成后的当前表情语气(见 mood.ts) */
  mood: ElfMood;
  start: () => Promise<void>;
  stop: () => void;
  toggle: () => void;
  clearError: () => void;
  /**
   * 转写落库后把 `messages.id` 挂回字幕条目(step2 T4)。
   * 只有带 dbId 的条目才能打 👍/👎 —— 反馈要能定位到库里那一行才有分析价值。
   */
  attachMessageId: (entryId: string, messageId: string) => void;
}

export function useRealtimeSession(options: UseRealtimeSessionOptions = {}): UseRealtimeSessionResult {
  // 播种只发生一次:用 useState 的惰性初始值,避免每次渲染重建数组导致 id 抖动
  const [seededHistory] = useState<TranscriptEntry[]>(() =>
    (options.initialHistory ?? []).map((entry, index) => ({
      id: `h-${index}`,
      role: entry.role,
      text: entry.text,
      ...(entry.dbId === undefined ? {} : { dbId: entry.dbId }),
      ...(entry.feedback === undefined ? {} : { feedback: entry.feedback }),
    })),
  );
  const [state, dispatch] = useReducer(reducer, seededHistory, initialState);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelsRef = useRef<Set<RTCDataChannel>>(new Set());
  const activeChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const gatedRef = useRef<Array<{ sender: RTCRtpSender; track: MediaStreamTrack }>>([]);
  const playerRef = useRef<RemoteAudioPlayer | null>(null);
  const aliveRef = useRef(false);
  /** 是否有待完成的模型响应(response.created 之后、response.done 之前) */
  const inFlightResponseRef = useRef(false);
  const prosodyRef = useRef<{
    tap: ProsodyTap;
    samples: Array<{ rms: number; pitch: number | null }>;
    timer: number;
    ticks: number;
  } | null>(null);
  const optionsRef = useRef(options);
  /** 本会话已处理的工具调用次数(防滥用上限);每次 start 重置 */
  const toolCallsRef = useRef(0);

  /* ------- thinking 导演的运行件(全部 ref,事件回调内读写) -------
   * 生命周期:speech_stopped 起 2s 计时 → 到点仍无回复则显示 thinking 并
   * 进入 held(音频 hold + 字幕缓冲);回复到达后,补足 1s 最短演示再放出。
   * 用户在任意时刻重新说话 = 打断,丢弃 held 缓存(与 barge-in 语义一致)。 */
  const thinkTimerRef = useRef<number | null>(null);
  const thinkingSinceRef = useRef<number | null>(null);
  const heldRef = useRef(false);
  const replyArrivedRef = useRef(false);
  const heldDeltasRef = useRef("");
  const heldSettleRef = useRef<{ fallback: string } | null>(null);
  const releaseTimerRef = useRef<number | null>(null);

  const clearThinkTimers = useCallback(() => {
    if (thinkTimerRef.current !== null) {
      window.clearTimeout(thinkTimerRef.current);
      thinkTimerRef.current = null;
    }
    if (releaseTimerRef.current !== null) {
      window.clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
  }, []);

  /** 放弃 held 缓存(用户打断 / 会话结束)。 */
  const abortHold = useCallback(() => {
    clearThinkTimers();
    thinkingSinceRef.current = null;
    heldRef.current = false;
    replyArrivedRef.current = false;
    heldDeltasRef.current = "";
    heldSettleRef.current = null;
  }, [clearThinkTimers]);

  /** 释放闸门:冲刷缓冲的助手字幕、恢复播放、切入说话态。 */
  const releaseHold = useCallback(() => {
    releaseTimerRef.current = null;
    if (!heldRef.current) return;
    heldRef.current = false;
    thinkingSinceRef.current = null;
    if (heldDeltasRef.current !== "") {
      dispatch({ kind: "assistant-delta", delta: heldDeltasRef.current });
      heldDeltasRef.current = "";
    }
    if (heldSettleRef.current !== null) {
      dispatch({ kind: "assistant-settle", fallback: heldSettleRef.current.fallback });
      heldSettleRef.current = null;
    }
    playerRef.current?.resume();
    dispatch({ kind: "status", status: "assistant-talking" });
  }, []);

  /** held 中回复事件到达时调用:最短演示期未满则预约到点释放。 */
  const scheduleRelease = useCallback(() => {
    if (!heldRef.current || !replyArrivedRef.current) return;
    if (releaseTimerRef.current !== null) return;
    const since = thinkingSinceRef.current ?? performance.now();
    const wait = Math.max(0, since + THINK_MIN_MS - performance.now());
    releaseTimerRef.current = window.setTimeout(() => releaseHold(), wait);
  }, [releaseHold]);

  // react-hooks/refs:渲染期禁止写 ref,统一在渲染后同步
  useEffect(() => {
    optionsRef.current = options;
  });

  /* ---------------- 出站命令 ---------------- */

  const sendClientEvent = useCallback((event: ClientEvent): boolean => {
    const channel = activeChannelRef.current;
    if (channel === null || channel.readyState !== "open") return false;
    channel.send(JSON.stringify(event));
    return true;
  }, []);

  const sendSessionUpdate = useCallback(() => {
    const opts = optionsRef.current;
    const defaults = opts.sessionDefaults ?? DASHSCOPE_SESSION_DEFAULTS;
    // 音色只在支持它的通道下发:longan* 系统音色属于 qwen-audio-3.0 系列
    // (tokenplan 通道);dashscope 的 qwen3.5-omni 有自己的音色集(默认 Tina),
    // 把 longan* 传过去会 400 InvalidParameter(2026-08-31 实测踩坑)。
    const voice =
      opts.voice !== undefined && defaults.provider === "tokenplan"
        ? { voice: opts.voice }
        : {};
    const ok = sendClientEvent({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS,
        ...voice,
        // 通道差异参数(转写配置 / turn_detection / idle_timeout)由预设注入
        ...defaults.sessionUpdate,
      },
    });
    if (!ok) dispatch({ kind: "error", message: "发送 session.update 失败:没有打开的数据通道" });

    // 工具在**第二条** session.update 里单独注册(step3 T2)。
    // 分两次发是为了隔离风险:这条请求若被服务端以"不支持 tools"拒绝,
    // 上面的核心配置已经生效,对话照常进行,只是没有实时记忆标记 ——
    // 记忆还有会话后的批量抽取兜底。合在一条里发则一次失败全盘皆输。
    if (ok && opts.onRememberFact !== undefined) {
      sendClientEvent({
        type: "session.update",
        session: { tools: [REMEMBER_FACT_TOOL] },
      });
    }
  }, [sendClientEvent]);

  const gateMedia = useCallback((enabled: boolean) => {
    for (const { sender, track } of gatedRef.current) {
      void sender.replaceTrack(enabled ? track : null).catch(() => {});
    }
    const stream = localStreamRef.current;
    if (stream !== null) {
      for (const track of stream.getAudioTracks()) track.enabled = enabled;
    }
  }, []);

  /** 远端流就绪后启动韵律采样(150ms/次;每 4 次归纳一次语气结论)。 */
  const startProsody = useCallback((player: RemoteAudioPlayer) => {
    if (prosodyRef.current !== null) return;
    // 韵律阈值只对一个音色标定过(见 mood.ts / voices.ts)。非标定音色直接不采样:
    // 既避免错误的情绪映射,也省掉一个 150ms 的定时器。
    if (optionsRef.current.voice !== PROSODY_CALIBRATED_VOICE) return;
    const tap = player.enableAnalysis();
    if (tap === null) return;
    const entry: {
      tap: ProsodyTap;
      samples: ProsodySample[];
      timer: number;
      ticks: number;
    } = { tap, samples: [], timer: 0, ticks: 0 };
    entry.timer = window.setInterval(() => {
      const sample = entry.tap.sample();
      if (sample !== null) {
        entry.samples.push(sample);
        if (entry.samples.length > 12) entry.samples.shift();
      }
      entry.ticks += 1;
      if (entry.ticks % 4 === 0) {
        dispatch({ kind: "prosody-mood", mood: prosodyToMood(entry.samples) });
      }
    }, 150);
    prosodyRef.current = entry;
  }, []);

  /* ---------------- 入站事件分发 ---------------- */

  const handleServerEvent = useCallback(
    (raw: unknown) => {
      if (!aliveRef.current) return;
      const event = parseServerEvent(raw);
      if (event === null) return;

      switch (event.type) {
        case "session.created":
          gateMedia(true);
          dispatch({ kind: "status", status: "live" });
          sendSessionUpdate();
          break;
        case "input_audio_buffer.speech_started":
          // 客户端停播放只是"自己听不见";显式取消才能让服务端停止生成旧答案
          // (response.cancel 是文档唯一保证的取消手段;若恰逢响应已结束,
          //  服务端会回一个 error 事件,属可忽略的竞态噪声)。
          if (inFlightResponseRef.current) {
            inFlightResponseRef.current = false;
            sendClientEvent({ type: "response.cancel" });
          }
          playerRef.current?.interrupt();
          abortHold(); // 用户重新说话 = 打断:丢弃 thinking 计时与 held 缓存
          dispatch({ kind: "barge-in" });
          dispatch({ kind: "user-emotion", emotion: null }); // 新话语,情绪待 ASR 增量刷新
          dispatch({ kind: "status", status: "user-talking" });
          break;
        case "input_audio_buffer.speech_stopped":
          // 用户话说完了:2s 内回复到达则全程不显示 thinking(response.created
          // 会清掉计时);超时才演示 thinking,并闸住语音与字幕防一闪而过。
          abortHold(); // 清掉上一轮可能残留的计时/缓存
          thinkTimerRef.current = window.setTimeout(() => {
            thinkTimerRef.current = null;
            if (!aliveRef.current) return;
            thinkingSinceRef.current = performance.now();
            heldRef.current = true;
            replyArrivedRef.current = false;
            heldDeltasRef.current = "";
            heldSettleRef.current = null;
            playerRef.current?.hold(); // 暂停但保留抖动缓冲,释放时接着播
            dispatch({ kind: "status", status: "thinking" });
          }, THINK_DELAY_MS);
          break;
        case "conversation.item.input_audio_transcription.delta": {
          const combined = (event.text ?? "") + (event.stash ?? "");
          dispatch({ kind: "user-partial", text: combined });
          // 第一层:ASR 原生情绪字段,流式镜像用户语气
          if (event.emotion !== undefined) {
            dispatch({ kind: "user-emotion", emotion: event.emotion });
          }
          break;
        }
        case "conversation.item.input_audio_transcription.completed":
          dispatch({ kind: "user-final", text: event.transcript ?? "" });
          break;
        case "conversation.item.input_audio_transcription.failed":
          dispatch({
            kind: "error",
            message: `语音转写失败:${event.error.message ?? event.error.code ?? "未知原因"}`,
          });
          break;
        case "response.created":
          inFlightResponseRef.current = true;
          if (prosodyRef.current !== null) prosodyRef.current.samples = []; // 新话语重新累积韵律
          dispatch({ kind: "response-arm" });
          if (heldRef.current) {
            // thinking 演示中:回复已到,补足最短演示期后统一放出
            replyArrivedRef.current = true;
            scheduleRelease();
            break;
          }
          clearThinkTimers(); // 2s 内回复:全程不显示 thinking
          playerRef.current?.resume();
          dispatch({ kind: "status", status: "assistant-talking" });
          break;
        case "response.audio_transcript.delta":
          if (heldRef.current) {
            // 闸门期:字幕先进缓冲,释放时一次性冲刷
            heldDeltasRef.current += event.delta ?? "";
            break;
          }
          dispatch({ kind: "assistant-delta", delta: event.delta ?? "" });
          break;
        case "response.audio_transcript.done":
          // 定稿流式累积;随后的 response.done 发现已定稿仅做清理
          if (heldRef.current) {
            heldSettleRef.current = { fallback: event.transcript ?? "" };
            replyArrivedRef.current = true;
            scheduleRelease();
            break;
          }
          dispatch({ kind: "assistant-settle", fallback: event.transcript ?? "" });
          break;
        case "response.done": {
          inFlightResponseRef.current = false;
          const fallback = (event.response.output ?? [])
            .flatMap((item) => item.content ?? [])
            .map((part) => part.transcript ?? part.text ?? "")
            .find((text) => text.trim() !== "");
          if (heldRef.current) {
            // 整个回复在闸门期内就生成完了:同样等最短演示期后一并放出
            heldSettleRef.current = { fallback: fallback ?? "" };
            replyArrivedRef.current = true;
            scheduleRelease();
            break;
          }
          dispatch({ kind: "assistant-settle", fallback: fallback ?? "" });
          dispatch({ kind: "status", status: "live" });
          break;
        }
        case "response.function_call_arguments.done": {
          if (event.name !== REMEMBER_FACT_TOOL_NAME || event.call_id === undefined) break;

          // **先回执、再落库**。模型在等 function_call_output,不回就不继续说 ——
          // 用户会听到一段没有尽头的沉默。回执内容固定为 ok,不携带落库结果:
          // 模型不需要知道数据库是否写成功,而且它也没法重试。
          const callId = event.call_id;
          sendClientEvent({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify({ ok: true }),
            },
          });
          sendClientEvent({ type: "response.create" });

          toolCallsRef.current += 1;
          if (toolCallsRef.current > MAX_TOOL_CALLS_PER_SESSION) {
            console.warn("[realtime] 已达单会话工具调用上限,忽略本次标记");
            break;
          }
          const fact = parseRememberFactArguments(event.arguments);
          if (fact !== null) optionsRef.current.onRememberFact?.(fact);
          break;
        }
        case "error": {
          // 注册工具失败是可接受的降级(见 sendSessionUpdate 的注释):
          // 只记日志,不打断用户 —— 记忆仍有会话后的批量抽取兜底
          const param = event.error.param ?? "";
          if (param.includes("tools")) {
            console.warn("[realtime] 工具注册被服务端拒绝,实时记忆标记不可用:", event.error.message ?? param);
            break;
          }
          dispatch({
            kind: "error",
            message: `服务端错误:${
              event.error.message ?? event.error.code ?? JSON.stringify(event.error)
            }`,
          });
          break;
        }
        default:
          break;
      }
    },
    [gateMedia, sendClientEvent, sendSessionUpdate, abortHold, clearThinkTimers, scheduleRelease],
  );

  const bindChannel = useCallback(
    (channel: RTCDataChannel) => {
      channelsRef.current.add(channel);
      channel.onopen = () => {
        // 官方示例:session.update 经送达 session.created 的同一条通道发回
        if (activeChannelRef.current === null) activeChannelRef.current = channel;
      };
      channel.onmessage = (e: MessageEvent<unknown>) => {
        if (typeof e.data !== "string") return;
        try {
          handleServerEvent(JSON.parse(e.data));
        } catch {
          // 非法报文静默忽略,不打断会话
        }
      };
      channel.onclose = () => {
        channelsRef.current.delete(channel);
        if (activeChannelRef.current === channel) activeChannelRef.current = null;
      };
    },
    [handleServerEvent],
  );

  /* ---------------- 会话生命周期 ---------------- */

  const teardown = useCallback(() => {
    aliveRef.current = false;
    inFlightResponseRef.current = false;
    if (prosodyRef.current !== null) {
      window.clearInterval(prosodyRef.current.timer);
      prosodyRef.current.tap.dispose();
      prosodyRef.current = null;
    }
    for (const channel of channelsRef.current) channel.close();
    channelsRef.current.clear();
    activeChannelRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    gatedRef.current = [];
    playerRef.current?.dispose();
    playerRef.current = null;
  }, []);

  const stop = useCallback(() => {
    abortHold();
    teardown();
    dispatch({ kind: "status", status: "idle" });
    dispatch({ kind: "reset-partial" });
    dispatch({ kind: "user-emotion", emotion: null });
    dispatch({ kind: "prosody-mood", mood: null });
  }, [abortHold, teardown]);

  const start = useCallback(async () => {
    if (aliveRef.current) return;
    aliveRef.current = true;
    toolCallsRef.current = 0;
    dispatch({ kind: "clear-error" });

    let pc: RTCPeerConnection | null = null;
    let stream: MediaStream | null = null;
    try {
      dispatch({ kind: "status", status: "starting" });

      // 非安全上下文(局域网 IP + HTTP)下 navigator.mediaDevices 为 undefined,
      // 直接访问会抛出难懂的 TypeError——提前拦截并给出可行动的提示。
      if (
        typeof navigator === "undefined" ||
        navigator.mediaDevices?.getUserMedia === undefined
      ) {
        throw new Error(
          "浏览器已禁用麦克风:当前地址不是安全上下文(需 HTTPS 或 localhost)。" +
            "手机端请通过 HTTPS 访问(如部署到 Vercel),本机调试请用 localhost。",
        );
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!aliveRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      localStreamRef.current = stream;

      const peer = new RTCPeerConnection({ iceServers: [] });
      pc = peer;
      pcRef.current = peer;
      const player = new RemoteAudioPlayer();
      playerRef.current = player;
      peer.ontrack = (e) => {
        player.attach(e.streams[0]);
        startProsody(player);
      };

      // 门控:session.created 之前不发任何音频帧(官方文档明确会被丢弃)
      for (const track of stream.getAudioTracks()) track.enabled = false;
      gatedRef.current = [];
      for (const track of stream.getAudioTracks()) {
        const sender = peer.addTrack(track, stream);
        await sender.replaceTrack(null).catch(() => {});
        gatedRef.current.push({ sender, track });
      }

      bindChannel(peer.createDataChannel("oai-events"));
      peer.ondatachannel = (e) => bindChannel(e.channel);

      peer.onconnectionstatechange = () => {
        if (
          aliveRef.current &&
          (peer.connectionState === "failed" || peer.connectionState === "closed")
        ) {
          dispatch({ kind: "error", message: `WebRTC 连接异常(${peer.connectionState})` });
          stop();
        }
      };

      dispatch({ kind: "status", status: "negotiating" });
      const offer = await peer.createOffer({ offerToReceiveAudio: true });
      await peer.setLocalDescription(offer);
      await waitForIceComplete(peer);

      const localDescription = pc.localDescription;
      if (localDescription === null) throw new Error("本地 SDP 描述为空");

      const response = await fetch(SESSION_SIGNALING_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: localDescription.sdp,
      });
      if (!response.ok) throw new Error(await extractSignalingError(response));
      const answerSdp = normalizeAnswerSdp(await response.text());
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      dispatch({ kind: "status", status: "live" });
    } catch (cause) {
      dispatch({
        kind: "error",
        message: cause instanceof Error ? cause.message : "启动实时会话失败",
      });
      teardown();
      dispatch({ kind: "status", status: "idle" });
    }
  }, [bindChannel, startProsody, stop, teardown]);

  const toggle = useCallback(() => {
    if (aliveRef.current) stop();
    else void start();
  }, [start, stop]);

  const clearError = useCallback(() => dispatch({ kind: "clear-error" }), []);

  const attachMessageId = useCallback((entryId: string, messageId: string) => {
    dispatch({ kind: "attach-db-id", entryId, messageId });
  }, []);

  // 卸载时释放媒体与连接
  useEffect(() => teardown, [teardown]);

  // 语气合成:说话期 文本(语义) > 韵律(声学) > neutral;聆听/思考期镜像用户情绪
  const derivedMood: ElfMood =
    state.status === "assistant-talking"
      ? textMood(state.assistantPartial) ?? state.prosodyMood ?? "neutral"
      : state.status === "live" || state.status === "user-talking" || state.status === "thinking"
        ? moodFromUserEmotion(state.userEmotion)
        : "neutral";

  return { ...state, mood: derivedMood, start, stop, toggle, clearError, attachMessageId };
}
