"use client";

/**
 * 拟态球对话面板(/chat/[conversationId] 的客户端主体,2026-08-31 起为唯一对话 UI)。
 *
 * 实时链路:useRealtimeSession → WebRTC → /api/realtime/session → 千问 realtime;
 * 布局按 Ardot 设计稿 §3.3,球是 bloub 引擎的拟态球。
 *
 * 球态映射(spec §3.3,对接 RealtimeStatus;2026-09-01 修订):
 * - idle/starting/negotiating → idle(空场待机)
 * - live / user-talking → wide(聆听 = 好奇表情,bloub curieux)
 * - thinking → thinking(三点脉冲)
 * - assistant-talking → 羞怯/怀疑/平静 每 1s 轮换(不再持续 wink)
 * - 出错(active 中) → alert
 * - remember_fact 触发时 flash notify(蓝点)
 *
 * 人格 / 音色在**孵化时一次性定格**(见 /hatch),本页不再提供切换;
 * 设置抽屉只保留 记忆/历史/人格库 入口。
 *
 * 持久化:转写 appendMessagesAction 落库、会话结束 finishConversationAction
 * 兜底抽记忆。
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { BallAnchor, useBall } from "@/components/mimic/ball/ball-context";
import { MessageFeedback } from "@/components/chat/message-feedback";
import { authClient } from "@/lib/auth/client";
import type { BallState } from "@/components/mimic/ball/types";
import {
  appendMessagesAction,
  finishConversationAction,
  rememberFactAction,
} from "@/lib/memory/actions";
import { renderPersonaInstructions } from "@/lib/persona/render";
import { findPersona, resolvePersona } from "@/lib/persona/resolve";
import type { PersonaRecord } from "@/lib/persona/types";
import type { PersonaSettings } from "@/lib/persona/settings";
import { REMEMBER_FACT_USAGE_HINT, type RealtimeSessionDefaults } from "@/lib/realtime/session-defaults";
import { searchKnowledgeAction, webSearchAction } from "@/lib/knowledge/actions";
import {
  useRealtimeSession,
  type RealtimeStatus,
  type SeedTranscriptEntry,
} from "@/lib/realtime/use-realtime-session";

/**
 * RealtimeStatus → 球态(spec §3.3 映射,错误优先)。
 * 2026-09-01 拍板:说话不再持续 wink,改由 SPEAKING_FACES 每秒轮换;
 * 聆听 = 好奇表情(wide 态已按 bloub curieux 重定义)。
 */
function ballStateOf(status: RealtimeStatus, error: boolean): BallState {
  if (error) return "alert";
  switch (status) {
    case "live":
    case "user-talking":
      return "wide";
    case "thinking":
      return "thinking";
    case "assistant-talking":
      return "calm";
    default:
      return "idle";
  }
}

/** 说话表情轮换序列(每 1s 一换,数值取 bloub timide/méfiant/neutre)。 */
const SPEAKING_FACES: readonly BallState[] = ["shy", "doubt", "calm"];

const STATUS_TEXT: Record<RealtimeStatus, string> = {
  idle: "点麦克风开始通话",
  starting: "请求麦克风…",
  negotiating: "协商连接中…",
  live: "在听,请说",
  "user-talking": "在听你说…",
  thinking: "想着呢…",
  "assistant-talking": "在说",
};

/** 对话页的休眠视线(2026-08-31 拍板):三轴全归零的彻底正视(不歪头、不仰视);
 *  跟随的 pitch 基线与 roll 也取它。登录/记忆等页保持 bloub 侧脸。 */
const CHAT_REST_GAZE = { yaw: 0, pitch: 0, roll: 0 } as const;

/** 字幕条目(含播种的历史);dbId 落库后回填,有它才能打 👍/👎 */
interface CaptionEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  dbId?: string;
  feedback?: 1 | -1 | null;
}

export function MimicChatPanel({
  conversationId,
  sessionDefaults,
  memoryContext,
  persistence,
  initialMessages,
  personas,
  companionPersona,
}: {
  conversationId: string;
  sessionDefaults: RealtimeSessionDefaults;
  /** 服务端组装的记忆上下文(画像 + 召回记忆 + 最近历史) */
  memoryContext: string;
  persistence: boolean;
  initialMessages: readonly SeedTranscriptEntry[];
  personas: readonly PersonaRecord[];
  /** 孵化定格的人格/音色(服务端 companion,人格真源) */
  companionPersona: { personaId: string | null; voice: string };
}) {
  const ball = useBall();

  // 人格真源是服务端 companion(props)。personaId 为 null(人格被删)时走
  // resolvePersona 的回落链;customInstructions 属无库时代遗留,恒为空。
  const settings: PersonaSettings = {
    personaId: companionPersona.personaId ?? "",
    customInstructions: "",
    voice: companionPersona.voice,
  };

  // 人格 → instructions(客户端渲染,随 session.update 下发);
  // 展示用的名字/音色走 findPersona(查不到记录时回落渲染人格的名字)
  const persona = resolvePersona(settings, personas);
  const personaRecord = findPersona(settings, personas);
  const instructions = [
    renderPersonaInstructions(persona),
    REMEMBER_FACT_USAGE_HINT,
    memoryContext,
  ]
    .filter((part) => part !== "")
    .join("\n\n");

  // 实时记忆写入:conversationId 走 ref 保持回调稳定
  const conversationIdRef = useRef(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  });
  const handleRememberFact = useCallback(
    (fact: { content: string; category: string; importance: number }) => {
      void rememberFactAction({
        ...fact,
        conversationId: persistence ? conversationIdRef.current : null,
      }).then((added) => {
        if (added) ball.flash("notify", 1600);
      });
    },
    [persistence, ball],
  );

  const session = useRealtimeSession({
    initialHistory: initialMessages,
    instructions,
    voice: settings.voice,
    sessionDefaults,
    onRememberFact: handleRememberFact,
    // 知识库检索工具(step2 T3):realtime 模型自主判断何时查;
    // 失败降级文案在 action 内部处理,这里只透传
    onSearchKnowledge: searchKnowledgeAction,
    // 联网搜索工具(step3):时效/公域问题查网络,与知识库互补
    onWebSearch: webSearchAction,
  });
  const { attachMessageId } = session;

  const [mode, setMode] = useState<"company" | "transcript">("company");
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const modeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /** 爆散编排(bloub burst 态:0.7s 塌缩 → 粒子螺旋 → 1.7s 起重组定型) */
  function toggleMode(): void {
    if (modeBusy) return;
    if (mode === "company") {
      // 陪伴 → 字幕:彩虹爆散,粒子散开后球淡出、字幕聊天记录接上。
      // 球层淡出 300ms,提前至 850ms 发起 dismiss,让球恰好消失在字幕落地
      // (1150ms)的那一刻 —— 否则锚点卸载的 320ms 延迟会让塌缩后的小黑球
      // 与对话记录同屏约 600ms(2026-09-04 用户反馈的残留)。
      setModeBusy(true);
      ball.triggerBurst();
      dismissTimerRef.current = setTimeout(() => ball.dismiss(), 850);
      modeTimerRef.current = setTimeout(() => {
        setMode("transcript");
        setModeBusy(false);
      }, 1150);
    } else {
      // 字幕 → 陪伴:球回到舞台当场爆散(或衔接上一轮爆散的重组段),定成陪伴球
      setMode("company");
      ball.triggerBurst();
      setModeBusy(true);
      modeTimerRef.current = setTimeout(() => setModeBusy(false), 1200);
    }
  }

  // 卸载清理切换定时器
  useEffect(() => {
    return () => {
      if (modeTimerRef.current !== null) clearTimeout(modeTimerRef.current);
      if (dismissTimerRef.current !== null) clearTimeout(dismissTimerRef.current);
    };
  }, []);

  const active =
    session.status !== "idle" && session.status !== "starting" && session.status !== "negotiating";

  // 球态跟随实时状态(spec §3.3)
  const ballState = ballStateOf(session.status, session.error !== null && active);
  useEffect(() => {
    ball.setBallState(ballState);
  }, [ball, ballState]);

  // 说话表情轮换(2026-09-01 拍板,同日改 3s):assistant-talking 期间每 3s 在
  // 羞怯 → 怀疑 → 平静 间切换。声明在基础映射之后,起手即覆盖为羞怯;
  // 离开说话态时清定时器,基础映射效应把球态接到对应状态。
  useEffect(() => {
    if (session.status !== "assistant-talking") return;
    let i = 0;
    ball.setBallState(SPEAKING_FACES[0] ?? "calm");
    const timer = window.setInterval(() => {
      i = (i + 1) % SPEAKING_FACES.length;
      ball.setBallState(SPEAKING_FACES[i] ?? "calm");
    }, 3000);
    return () => window.clearInterval(timer);
  }, [ball, session.status]);

  /* ---------------- 持久化(转写落库 + 会话结束兜底抽取) ---------------- */

  const [persistFailed, setPersistFailed] = useState(false);
  const persistedCountRef = useRef<number | null>(null);

  useEffect(() => {
    if (!persistence) return;
    if (persistedCountRef.current === null) {
      persistedCountRef.current = session.history.length;
      return;
    }
    const pending = session.history.slice(persistedCountRef.current);
    if (pending.length === 0) return;
    persistedCountRef.current = session.history.length;
    // 服务端过滤空白内容后返回 ids(顺序与过滤后条目一致);这里用同样规则对齐
    const clean = pending.filter((entry) => entry.text.trim() !== "");
    void appendMessagesAction(
      conversationId,
      pending.map((entry) => ({ role: entry.role, content: entry.text })),
    ).then((result) => {
      if (!result.ok) {
        setPersistFailed(true);
        return;
      }
      // 把 messages.id 挂回字幕条目 —— 有 dbId 的回复才能打 👍/👎
      result.ids.forEach((messageId, index) => {
        const entry = clean[index];
        if (entry !== undefined) attachMessageId(entry.id, messageId);
      });
    });
  }, [session.history, conversationId, persistence, attachMessageId]);

  // 会话从活跃转非活跃:兜底触发记忆抽取
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (active) {
      wasActiveRef.current = true;
      return;
    }
    if (!wasActiveRef.current) return;
    wasActiveRef.current = false;
    if (persistence) void finishConversationAction(conversationId);
  }, [active, conversationId, persistence]);

  // 字幕模式自动滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [session.history, session.userPartial, session.assistantPartial]);

  const captions: CaptionEntry[] = session.history.map((entry) => ({
    id: entry.id,
    role: entry.role,
    text: entry.text,
    ...(entry.dbId === undefined ? {} : { dbId: entry.dbId }),
    ...(entry.feedback === undefined ? {} : { feedback: entry.feedback }),
  }));

  // 陪伴模式:字幕 = 最近一轮(user 定稿/流式 + 助手流式/定稿)
  const lastUser = [...session.history].reverse().find((entry) => entry.role === "user");
  const elfSpeaking = session.assistantPartial !== "";
  const elfLast = [...session.history].reverse().find((entry) => entry.role === "assistant");
  const companyCaption =
    session.userPartial !== ""
      ? session.userPartial
      : lastUser !== undefined
        ? lastUser.text
        : active
          ? ""
          : null;
  const companyElf = elfSpeaking
    ? session.assistantPartial
    : elfLast !== undefined && lastUser !== undefined && elfLast.id > lastUser.id
      ? elfLast.text
      : "";

  return (
    <div className="mimic-page flex h-dvh flex-col overflow-hidden bg-[#FAFAF9]">
      {/* 顶栏:H5 只留人格名 + 设置(记忆/历史收进设置抽屉,spec §3.7) */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#E5E3DF] bg-white px-4 lg:h-16 lg:px-8">
        <div className="flex items-center gap-4">
          <span className="text-base font-semibold text-[#1A1A1A]">{persona.name}</span>
          <span className="hidden rounded-md bg-[#E6E0F5] px-2.5 py-1 text-xs font-medium text-[#391C57] lg:inline">
            {persona.name} · {personaRecord?.voice ?? settings.voice ?? "默认音色"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/memory"
            className="hidden h-9 items-center rounded-md px-3 text-[13px] font-medium text-[#5D5B54] transition-colors hover:bg-[#F6F5F4] lg:flex"
          >
            记忆
          </Link>
          <Link
            href="/history"
            className="hidden h-9 items-center rounded-md px-3 text-[13px] font-medium text-[#5D5B54] transition-colors hover:bg-[#F6F5F4] lg:flex"
          >
            历史
          </Link>
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="flex h-9 items-center rounded-lg bg-[#0A0A0C] px-3 text-[13px] font-medium text-white transition-opacity hover:opacity-85"
          >
            设置
          </button>
        </div>
      </header>

      {/* 错误条(对话照常,样式贴设计稿 alert 卡) */}
      {session.error !== null ? (
        <div role="alert" className="flex items-start justify-between gap-3 border-b border-[#E03131]/20 bg-[#E03131]/5 px-4 py-2 text-sm text-[#C22525] lg:px-8">
          <span>{session.error}</span>
          <button type="button" onClick={session.clearError} className="shrink-0 underline underline-offset-2">
            知道了
          </button>
        </div>
      ) : null}
      {persistFailed ? (
        <p role="status" className="border-b border-[#B7791F]/20 bg-[#B7791F]/5 px-4 py-2 text-xs leading-5 text-[#975A16] lg:px-8">
          转写未能写入数据库,本次对话不会被记住。请检查 DATABASE_URL 与数据库连接。
        </p>
      ) : null}

      {/* 中央舞台 */}
      <main className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-6 lg:gap-5">
        {mode === "company" ? (
          <>
            <BallAnchor
              state={ballState}
              restGaze={CHAT_REST_GAZE}
              className="h-[200px] w-[200px] lg:h-[280px] lg:w-[280px]"
            />
            <p className="text-base font-medium text-[#37352E] lg:text-lg">
              {session.searching && session.status === "thinking" ? "正在查知识库…" : STATUS_TEXT[session.status]}
            </p>

            {/* 字幕矩形(2026-08-31 拍板):固定高度、内容底部对齐 —— 新字幕把旧字幕
                一点点往上顶,越过上缘即被裁掉;上缘再叠一层渐变淡出 + 渐进模糊,
                让"正在消失"过渡柔和。不可选中、无滚动条(overflow-hidden)。
                高度预算:1280×720 桌面留给正文约 150px,防页面出现滚动。 */}
            <div
              className="relative h-[160px] w-full max-w-[560px] select-none overflow-hidden lg:h-[150px] lg:max-w-[640px]"
              style={{
                maskImage:
                  "linear-gradient(to bottom, transparent 0px, rgba(0,0,0,0.3) 26px, #000 68px)",
                WebkitMaskImage:
                  "linear-gradient(to bottom, transparent 0px, rgba(0,0,0,0.3) 26px, #000 68px)",
              }}
            >
              {/* 上缘渐进模糊层:越靠上越糊,与容器淡出叠加 */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-14 backdrop-blur-[3px]"
                style={{
                  maskImage: "linear-gradient(to bottom, #000, transparent)",
                  WebkitMaskImage: "linear-gradient(to bottom, #000, transparent)",
                }}
              />
              <div className="flex h-full flex-col items-center justify-end gap-4 px-3 pb-1 text-center">
                <p className="max-w-[520px] text-sm leading-[1.55] text-[#5D5B54] lg:text-base">
                  {companyCaption === null
                    ? "点击下方麦克风,开始和 TA 说话。"
                    : companyCaption === ""
                      ? "（沉默也是陪伴的一部分）"
                      : companyCaption}
                </p>
                {companyElf !== "" ? (
                  <p className="max-w-[520px] text-sm leading-[1.55] text-[#37352E] lg:text-base">
                    “{companyElf}”
                    {elfSpeaking ? <span className="ml-0.5 animate-pulse">▍</span> : null}
                  </p>
                ) : null}
              </div>
            </div>

            <p className="hidden text-[13px] text-[#A4A097] lg:block">
              鼠标跟随转向 · 点击千鸟纹波 · 思考时裂成三点 · 说话时 wink
            </p>
          </>
        ) : (
          <div ref={scrollRef} className="flex min-h-0 w-full max-w-[560px] flex-1 flex-col gap-3 overflow-y-auto py-2">
            {captions.length === 0 && !active ? (
              <p className="mt-14 text-center text-sm text-[#A4A097]">
                点击下方麦克风开始通话,说话后此处将显示双方字幕
              </p>
            ) : null}
            {initialMessages.length > 0 ? (
              <p className="text-center text-xs text-[#A4A097]">以下是此前的对话记录 · 开启通话后继续这场对话</p>
            ) : null}
            {captions.map((entry) => (
              <div key={entry.id} className={`flex flex-col ${entry.role === "user" ? "items-end" : "items-start"}`}>
                <span className="text-xs text-[#A4A097]">{entry.role === "user" ? "你" : persona.name}</span>
                <span
                  className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-[1.55] ${
                    entry.role === "user"
                      ? "bg-[#0A0A0C] text-white"
                      : "border border-[#E5E3DF] bg-white text-[#1A1A1A]"
                  }`}
                >
                  {entry.text}
                </span>
                {/* 反馈只对 TA 的回复开放,且要等这条落库拿到 message id 之后(step2 T4) */}
                {entry.role === "assistant" && entry.dbId !== undefined ? (
                  <MessageFeedback messageId={entry.dbId} initialScore={entry.feedback ?? null} />
                ) : null}
              </div>
            ))}
            {session.userPartial !== "" ? (
              <div className="flex flex-col items-end gap-1">
                <span className="text-xs text-[#A4A097]">你</span>
                <span className="max-w-[85%] rounded-xl bg-[#0A0A0C]/60 px-4 py-2.5 text-sm italic leading-[1.55] text-white/80">
                  {session.userPartial}
                  <span className="ml-0.5 animate-pulse">▍</span>
                </span>
              </div>
            ) : null}
            {session.assistantPartial !== "" ? (
              <div className="flex flex-col items-start gap-1">
                <span className="text-xs text-[#A4A097]">{persona.name}</span>
                <span className="max-w-[85%] rounded-xl border border-[#E5E3DF] bg-white/60 px-4 py-2.5 text-sm italic leading-[1.55] text-[#5D5B54]">
                  {session.assistantPartial}
                  <span className="ml-0.5 animate-pulse">▍</span>
                </span>
              </div>
            ) : null}
          </div>
        )}
      </main>

      {/* 底部控制条 */}
      <footer className="flex h-[76px] shrink-0 items-center justify-between border-t border-[#E5E3DF] bg-white px-5 pb-[max(0px,env(safe-area-inset-bottom))] lg:h-[88px] lg:px-12">
        <button
          type="button"
          onClick={toggleMode}
          className={`flex h-11 items-center gap-1 rounded-lg bg-[#F6F5F4] p-1 transition-opacity ${modeBusy ? "opacity-60" : ""}`}
          aria-label="切换陪伴/字幕模式"
        >
          <span
            className={`flex h-9 items-center rounded-md px-3.5 text-[13px] font-medium transition-colors ${
              mode === "company" ? "bg-[#0A0A0C] text-white" : "text-[#5D5B54]"
            }`}
          >
            陪伴
          </span>
          <span
            className={`flex h-9 items-center rounded-md px-3.5 text-[13px] font-medium transition-colors ${
              mode === "transcript" ? "bg-[#0A0A0C] text-white" : "text-[#5D5B54]"
            }`}
          >
            字幕
          </span>
        </button>

        <button
          type="button"
          onClick={session.toggle}
          disabled={session.status === "starting" || session.status === "negotiating"}
          aria-label={active ? "结束通话" : "开始通话"}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-[#5645D4] text-white transition-colors hover:bg-[#4536A8] disabled:cursor-not-allowed disabled:opacity-50 lg:h-16 lg:w-16"
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
            {active ? (
              <>
                {/* 通话中:同款麦克风 + 斜线;掩码在斜线处切开麦克风留缝,白线才可见 */}
                <defs>
                  <mask id="mic-slash-cut">
                    <rect x="0" y="0" width="24" height="24" fill="#fff" />
                    <line x1="4" y1="4" x2="20" y2="20" stroke="#000" strokeWidth="4.5" strokeLinecap="round" />
                  </mask>
                </defs>
                <path
                  d="M12 15a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Zm6-4a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93V22h2v-3.07A8 8 0 0 0 20 11h-2Z"
                  fill="currentColor"
                  mask="url(#mic-slash-cut)"
                />
                <line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </>
            ) : (
              <path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Zm6-4a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93V22h2v-3.07A8 8 0 0 0 20 11h-2Z" fill="currentColor" />
            )}
          </svg>
        </button>

        <button
          type="button"
          onClick={session.stop}
          className="hidden h-11 items-center rounded-lg border border-[#C8C4BE] px-4.5 text-sm font-medium text-[#1A1A1A] transition-colors hover:border-[#A4A097] lg:flex"
        >
          结束通话
        </button>
        <button
          type="button"
          onClick={session.stop}
          className="flex h-11 items-center px-2 text-[13px] font-medium text-[#5D5B54] lg:hidden"
        >
          结束
        </button>
      </footer>

      {/* 设置抽屉(H5 全屏 / 桌面右侧面板;预设切换 = 开新会话) */}
      {sheetOpen && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="设置">
          <button
            type="button"
            aria-label="关闭设置"
            className="absolute inset-0 bg-black/30"
            onClick={() => setSheetOpen(false)}
          />
          <div className="absolute inset-y-0 right-0 flex w-full max-w-[380px] flex-col gap-1 overflow-y-auto bg-white p-5 shadow-2xl">
            <div className="flex items-center justify-between pb-3">
              <span className="text-base font-semibold text-[#1A1A1A]">设置</span>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="flex h-11 w-11 items-center justify-center rounded-md text-xl text-[#5D5B54] hover:bg-[#F6F5F4]"
                aria-label="关闭"
              >
                ✕
              </button>
            </div>

            <div className="rounded-xl bg-[#E6E0F5] p-4">
              <p className="text-sm font-semibold text-[#391C57]">
                {persona.name} · {personaRecord?.voice ?? settings.voice ?? "默认音色"}
              </p>
              <p className="mt-1 text-[13px] leading-[1.5] text-[#5D5B54]">
                {personaRecord?.tagline ?? persona.backstory.slice(0, 40)}
              </p>
              <p className="mt-2 text-xs leading-[1.5] text-[#787671]">
                人格与音色在孵化时一次性确定,不可修改。TA 就是每天陪你说话的那个角色。
              </p>
            </div>

            <SheetLink href="/persona" label="人格库 · 看 TA 与其它人格" />
            <SheetLink href="/memory" label="TA 记得什么 · 记忆" />
            <SheetLink href="/history" label="历史会话" />
            <SheetLink href="/knowledge" label="知识库 · 上传资料让 TA 引用" />

            <div className="mt-2 flex flex-col gap-1 rounded-xl border border-[#E5E3DF] p-4 opacity-55">
              <p className="text-sm font-medium text-[#37352E]">偏好与安全</p>
              <p className="text-xs text-[#A4A097]">防沉迷提醒 · 未成年人模式(未开通)</p>
            </div>
            {!persistence ? (
              <div className="flex flex-col gap-1 rounded-xl border border-[#B7791F]/30 bg-[#B7791F]/5 p-4">
                <p className="text-sm font-medium text-[#37352E]">数据</p>
                <p className="text-xs text-[#975A16]">未配置 DATABASE_URL,会话不落库、无历史与记忆。</p>
              </div>
            ) : null}

            {/* 退出登录(用户体系 step1 T5):危险动作,与导航链接视觉分层、贴抽屉底 */}
            <div className="mt-auto pt-4">
              <button
                type="button"
                disabled={signingOut}
                onClick={() => {
                  setSigningOut(true);
                  void authClient
                    .signOut({
                      fetchOptions: {
                        onSuccess: () => {
                          router.replace("/");
                        },
                      },
                    })
                    .catch(() => setSigningOut(false));
                }}
                className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-[#E5E3DF] px-4 text-sm font-medium text-[#B3261E] transition-colors hover:border-[#B3261E]/40 hover:bg-[#B3261E]/5 disabled:opacity-60"
              >
                {signingOut ? "正在退出…" : "退出登录"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SheetLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="flex min-h-[56px] items-center justify-between rounded-xl px-4 text-sm font-medium text-[#37352E] transition-colors hover:bg-[#F6F5F4]"
    >
      {label}
      <span className="text-[#A4A097]">›</span>
    </Link>
  );
}
