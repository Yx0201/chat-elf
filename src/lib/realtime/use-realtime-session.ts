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
  type RealtimeSessionDefaults,
} from "@/lib/realtime/session-defaults";

const SESSION_SIGNALING_PATH = "/api/realtime/session";

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
}

/** 播种用的历史条目：来自数据库，id 由 Hook 生成。 */
export interface SeedTranscriptEntry {
  role: TranscriptEntry["role"];
  text: string;
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
  | { kind: "barge-in" };

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
}

export interface UseRealtimeSessionResult extends RealtimeState {
  /** 三层语气合成后的当前表情语气(见 mood.ts) */
  mood: ElfMood;
  start: () => Promise<void>;
  stop: () => void;
  toggle: () => void;
  clearError: () => void;
}

export function useRealtimeSession(options: UseRealtimeSessionOptions = {}): UseRealtimeSessionResult {
  // 播种只发生一次:用 useState 的惰性初始值,避免每次渲染重建数组导致 id 抖动
  const [seededHistory] = useState<TranscriptEntry[]>(() =>
    (options.initialHistory ?? []).map((entry, index) => ({
      id: `h-${index}`,
      role: entry.role,
      text: entry.text,
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
    const ok = sendClientEvent({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS,
        ...(opts.voice === undefined ? {} : { voice: opts.voice }),
        // 通道差异参数(转写配置 / turn_detection / idle_timeout)由预设注入
        ...defaults.sessionUpdate,
      },
    });
    if (!ok) dispatch({ kind: "error", message: "发送 session.update 失败:没有打开的数据通道" });
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
          dispatch({ kind: "barge-in" });
          dispatch({ kind: "user-emotion", emotion: null }); // 新话语,情绪待 ASR 增量刷新
          dispatch({ kind: "status", status: "user-talking" });
          break;
        case "input_audio_buffer.speech_stopped":
          // 用户话说完了:进入思考窗口(轮次检测计时 → 首包响应),打断自己会先回到 user-talking
          dispatch({ kind: "status", status: "thinking" });
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
          playerRef.current?.resume();
          if (prosodyRef.current !== null) prosodyRef.current.samples = []; // 新话语重新累积韵律
          dispatch({ kind: "response-arm" });
          dispatch({ kind: "status", status: "assistant-talking" });
          break;
        case "response.audio_transcript.delta":
          dispatch({ kind: "assistant-delta", delta: event.delta ?? "" });
          break;
        case "response.audio_transcript.done":
          // 定稿流式累积;随后的 response.done 发现已定稿仅做清理
          dispatch({ kind: "assistant-settle", fallback: event.transcript ?? "" });
          break;
        case "response.done": {
          inFlightResponseRef.current = false;
          const fallback = (event.response.output ?? [])
            .flatMap((item) => item.content ?? [])
            .map((part) => part.transcript ?? part.text ?? "")
            .find((text) => text.trim() !== "");
          dispatch({ kind: "assistant-settle", fallback: fallback ?? "" });
          dispatch({ kind: "status", status: "live" });
          break;
        }
        case "error":
          dispatch({
            kind: "error",
            message: `服务端错误:${
              event.error.message ?? event.error.code ?? JSON.stringify(event.error)
            }`,
          });
          break;
        default:
          break;
      }
    },
    [gateMedia, sendClientEvent, sendSessionUpdate],
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
    teardown();
    dispatch({ kind: "status", status: "idle" });
    dispatch({ kind: "reset-partial" });
    dispatch({ kind: "user-emotion", emotion: null });
    dispatch({ kind: "prosody-mood", mood: null });
  }, [teardown]);

  const start = useCallback(async () => {
    if (aliveRef.current) return;
    aliveRef.current = true;
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

  // 卸载时释放媒体与连接
  useEffect(() => teardown, [teardown]);

  // 语气合成:说话期 文本(语义) > 韵律(声学) > neutral;聆听/思考期镜像用户情绪
  const derivedMood: ElfMood =
    state.status === "assistant-talking"
      ? textMood(state.assistantPartial) ?? state.prosodyMood ?? "neutral"
      : state.status === "live" || state.status === "user-talking" || state.status === "thinking"
        ? moodFromUserEmotion(state.userEmotion)
        : "neutral";

  return { ...state, mood: derivedMood, start, stop, toggle, clearError };
}
