"use client";

/**
 * 对话面板:实时语音会话的客户端 UI。
 * 涉及麦克风与 RTCPeerConnection 的逻辑全部收敛在 use-realtime-session 内,
 * 本组件只负责状态展示(ElfAvatar 表情 + 文字)与启停控制。
 *
 * 两种模式:
 * - 对话模式(默认):表情球 + 双向字幕 + 控制条;
 * - 陪伴模式:只保留大号表情球与语音按钮,无字幕;思考/聆听之外的语气从
 *   固定集合随机轮播;球跟随鼠标转动。
 *
 * H5 适配(AGENTS.md「UI 与 H5 适配约束」):
 * - mobile-first,视口高布局(h-dvh)让字幕区内部滚动、控制条常驻;
 * - header 信息层级按屏幕取舍:会话 ID 仅 sm 以上显示,窄屏只留产品名;
 * - 底部控制条避让刘海屏安全区;触控目标 ≥ 44px(ui spec §3 要求)。
 *
 * 人格 / 音色(step1 P1、P2):设置走右上角抽屉,instructions 与 voice 只在
 * **新建连接**时下发(realtime 会话不可变参数),故任何变更都先结束当前会话。
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ElfAvatar, type ElfAvatarState } from "@/components/chat/elf-avatar";
import { MessageFeedback } from "@/components/chat/message-feedback";
import { SettingsSheet, SettingsTrigger } from "@/components/chat/settings-sheet";
import {
  appendMessagesAction,
  finishConversationAction,
  rememberFactAction,
  switchConversationAction,
} from "@/lib/memory/actions";
import { renderPersonaInstructions } from "@/lib/persona/render";
import { resolvePersona } from "@/lib/persona/resolve";
import type { PersonaRecord } from "@/lib/persona/types";
import type { PersonaSettings } from "@/lib/persona/settings";
import { CUSTOM_PERSONA_ID } from "@/lib/persona/presets";
import { usePersonaSettings } from "@/lib/persona/use-settings";
import type { ElfMood } from "@/lib/realtime/mood";
import { REMEMBER_FACT_USAGE_HINT, type RealtimeSessionDefaults } from "@/lib/realtime/session-defaults";
import {
  useRealtimeSession,
  type RealtimeStatus,
  type SeedTranscriptEntry,
} from "@/lib/realtime/use-realtime-session";

const AVATAR_STATE: Record<RealtimeStatus, ElfAvatarState> = {
  idle: "idle",
  starting: "connecting",
  negotiating: "connecting",
  live: "listening",
  "user-talking": "user-speaking",
  thinking: "thinking",
  "assistant-talking": "speaking",
};

const STATUS_LABEL: Record<RealtimeStatus, string> = {
  idle: "点击开始通话",
  starting: "请求麦克风…",
  negotiating: "协商连接中…",
  live: "在听,请说",
  "user-talking": "正在听你说…",
  thinking: "思考中…",
  "assistant-talking": "回答中…",
};

/** 陪伴模式随机轮播的语气集合(用户指定:好奇、平静、专注、得意、羞怯) */
const COMPANION_MOODS: readonly ElfMood[] = ["curious", "neutral", "focused", "smug", "shy"];

function nextCompanionMood(current: ElfMood): ElfMood {
  const pool = COMPANION_MOODS.filter((m) => m !== current);
  return pool[Math.floor(Math.random() * pool.length)] ?? "neutral";
}

function isListeningFamily(status: RealtimeStatus): boolean {
  return status === "live" || status === "user-talking" || status === "thinking";
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-6 w-6" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-8 w-8" fill="currentColor">
      <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" />
      <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.08A7 7 0 0 0 19 11Z" />
    </svg>
  );
}

/** 模式切换按钮:聊天气泡 ↔ 陪伴小球(触区 40px,移动端可点) */
function ModeToggle({ companion, onToggle }: { companion: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={companion ? "切换到对话模式" : "切换到陪伴模式"}
      aria-label={companion ? "切换到对话模式" : "切换到陪伴模式"}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-black/[.05] hover:text-zinc-600 dark:hover:bg-white/[.08] dark:hover:text-zinc-300"
    >
      {companion ? (
        // 对话模式图标:气泡
        <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" strokeLinejoin="round" />
        </svg>
      ) : (
        // 陪伴模式图标:小球
        <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="8" />
          <circle cx="9.5" cy="11" r="0.8" fill="currentColor" stroke="none" />
          <circle cx="14.5" cy="11" r="0.8" fill="currentColor" stroke="none" />
        </svg>
      )}
    </button>
  );
}

export function ChatPanel({
  conversationId,
  sessionDefaults,
  memoryContext,
  persistence,
  initialMessages,
  personas,
}: {
  conversationId: string;
  sessionDefaults: RealtimeSessionDefaults;
  /** 服务端组装的记忆上下文(语义记忆 + 最近历史);无内容时为空字符串 */
  memoryContext: string;
  /** 持久化是否可用(未配置 DATABASE_URL 时为 false) */
  persistence: boolean;
  /** 进入已有会话时从数据库读出的历史转写(按时间正序) */
  initialMessages: readonly SeedTranscriptEntry[];
  /** 可用人格(预设 + 该用户自建);由服务端一次性下发,供客户端渲染 instructions */
  personas: readonly PersonaRecord[];
}) {
  const { settings, update } = usePersonaSettings();
  // 人格 → instructions 的渲染在客户端完成:instructions 随 session.update 下发,
  // 而人格库由服务端一次性下发过来。渲染器与编辑器预览共用 render.ts。
  const personaInstructions = renderPersonaInstructions(resolvePersona(settings, personas));
  // 顺序:人格定调 → 工具使用说明 → 记忆补充事实。
  // 工具说明只在确实注册了工具时才拼(见 useRealtimeSession:没传 onRememberFact 就不注册)。
  const instructions = [personaInstructions, REMEMBER_FACT_USAGE_HINT, memoryContext]
    .filter((part) => part !== "")
    .join("\n\n");
  /**
   * 会话中实时记忆标记(step3 T2)。
   *
   * 回调要稳定(onRememberFact 会被写进 hook 内部的 ref,但引用变化会
   * 让 useCallback 的依赖变化)。用 ref 持有 conversationId,使回调本身
   * 只依赖 conversationId 这一个值。
   */
  const conversationIdRef = useRef(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  });
  const handleRememberFact = useCallback(
    (fact: { content: string; category: string; importance: number }) => {
      void rememberFactAction({
        ...fact,
        // 无持久化时 conversationId 是占位会话 id,传 null 让它不写外键
        conversationId: persistence ? conversationIdRef.current : null,
      });
    },
    [persistence],
  );

  const session = useRealtimeSession({
    initialHistory: initialMessages,
    instructions,
    voice: settings.voice,
    sessionDefaults,
    onRememberFact: handleRememberFact,
  });
  // 引用稳定(useCallback),可以安全放进 effect 依赖
  const { attachMessageId } = session;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    },
    [],
  );

  /**
   * 两阶段切换:chat → leaving(聊天球爆散、字幕淡出)→ companion(大球重聚进场)。
   * 直接调换分支会瞬间卸载/挂载两个头像实例,只能得到"传送+放大"的硬切。
   */
  const [phase, setPhase] = useState<"chat" | "leaving" | "companion">("chat");
  const [cycleMood, setCycleMood] = useState<ElfMood>("neutral");
  /** 递增让当前存活的聊天头像播放一次"膨胀→塌缩→粒子飞散" */
  const [exitKey, setExitKey] = useState(0);
  const leaveTimerRef = useRef<number | null>(null);
  const companion = phase === "companion";

  const goCompanion = () => {
    if (phase !== "chat") return;
    setCycleMood("neutral");
    setExitKey((k) => k + 1);
    setPhase("leaving");
    // 爆散脚本 440ms,留 60ms 空拍再挂载大球,重聚进场正好接上
    leaveTimerRef.current = window.setTimeout(() => setPhase("companion"), 500);
  };

  const goChat = () => {
    if (leaveTimerRef.current !== null) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    setPhase("chat");
  };

  useEffect(() => {
    return () => {
      if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
    };
  }, []);

  const active =
    session.status !== "idle" && session.status !== "starting" && session.status !== "negotiating";
  const avatarState: ElfAvatarState =
    session.error !== null && active ? "oops" : AVATAR_STATE[session.status];

  /**
   * 人格 / 音色变更 = 开新会话(realtime 会话的不可变参数,见 voices.ts)。
   *
   * 采用方案 2:**真的新建一条 conversation 记录并跳转过去** —— 换了个 TA 就是另一场
   * 对话,旧转写留在原会话里、仍带着它当时的人格。若来源会话还一条消息都没有,
   * Server Action 会顺手删掉它,免得列表堆满空的"未命名会话"。
   *
   * 未配置数据库时 Action 返回 null,此时留在原地即可:设置已写进 localStorage,
   * 重新点麦克风就会带上新人格。
   */
  const stopSession = session.stop;
  const router = useRouter();
  const applySettings = useCallback(
    (patch: Partial<PersonaSettings>, message: string) => {
      const next: PersonaSettings = { ...settings, ...patch };
      update(patch);
      if (active) stopSession();
      setSettingsOpen(false);
      showToast(message);

      void switchConversationAction({
        personaId: next.personaId,
        voice: next.voice,
        fromConversationId: persistence ? conversationId : null,
      })
        .then((newId) => {
          if (newId !== null) router.push(`/chat/${newId}`);
        })
        .catch(() => {
          showToast("新建会话失败;设置已保存,可从首页开始新会话");
        });
    },
    [
      active,
      stopSession,
      showToast,
      update,
      settings,
      persistence,
      conversationId,
      router,
    ],
  );

  const applyPersona = useCallback(
    (personaId: string, voice: string) => {
      // 人格-音色成套生效(step2 T3):音色取人格记录上绑定的那个,
      // 查不到记录(如 step1 遗留的 'custom')时沿用当前音色
      const persona = personas.find((p) => p.id === personaId) ?? null;
      applySettings(
        { personaId, voice },
        `已切换到「${persona?.name ?? "自定义"}」,正在开启新会话`,
      );
    },
    [applySettings, personas],
  );

  const applyVoice = useCallback(
    (voice: string) => {
      applySettings({ voice }, `音色已改为 ${voice},正在开启新会话`);
    },
    [applySettings],
  );

  const saveCustom = useCallback(
    (instructions: string) => {
      applySettings(
        { personaId: CUSTOM_PERSONA_ID, customInstructions: instructions },
        "自定义人设已保存,正在开启新会话",
      );
    },
    [applySettings],
  );

  /* ---------------- 持久化(step1 P4) ---------------- */

  const [persistFailed, setPersistFailed] = useState(false);
  /**
   * 已落库的条数;用 ref 而非 state,避免在 effect 体内 setState。
   * `null` = 尚未初始化:首次运行时把服务端读出的历史**整段标记为已落库**,
   * 否则进入已有会话会把历史全部重复写回数据库。
   */
  const persistedCountRef = useRef<number | null>(null);

  // 新增的转写条目异步落库。这是「把 React 状态同步到外部系统」的正当 effect 用法:
  // 副作用是发起请求,而不是在 effect 体内同步 setState。
  useEffect(() => {
    if (!persistence) return;
    if (persistedCountRef.current === null) {
      persistedCountRef.current = session.history.length;
      return;
    }
    const pending = session.history.slice(persistedCountRef.current);
    if (pending.length === 0) return;
    persistedCountRef.current = session.history.length;
    // 服务端会过滤掉空白内容的条目,返回的 ids 顺序与**过滤后**的条目一致;
    // 这里用同样的规则过滤一遍再按位对齐(两端规则必须保持一致)
    const clean = pending.filter((entry) => entry.text.trim() !== "");
    void appendMessagesAction(
      conversationId,
      pending.map((entry) => ({ role: entry.role, content: entry.text })),
    ).then((result) => {
      if (!result.ok) {
        setPersistFailed(true);
        return;
      }
      // 把 messages.id 挂回字幕条目 —— 只有带 dbId 的回复才能打 👍/👎
      result.ids.forEach((messageId, index) => {
        const entry = clean[index];
        if (entry !== undefined) attachMessageId(entry.id, messageId);
      });
    });
  }, [session.history, conversationId, persistence, attachMessageId]);

  // 会话从活跃转为非活跃时兜底触发一次记忆抽取(会话中还有按消息数触发的一路)
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

  // 陪伴模式:思考/聆听之外的语气随机轮播
  useEffect(() => {
    if (!companion) return;
    const id = window.setInterval(() => {
      setCycleMood((prev) => nextCompanionMood(prev));
    }, 4500);
    return () => window.clearInterval(id);
  }, [companion]);

  const mood: ElfMood = companion
    ? isListeningFamily(session.status)
      ? "neutral"
      : cycleMood
    : session.mood;

  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [session.history, session.userPartial, session.assistantPartial]);

  const micButton = (
    <button
      type="button"
      onClick={session.toggle}
      disabled={session.status === "starting" || session.status === "negotiating"}
      aria-label={active ? "结束通话" : "开始通话"}
      className={`relative flex h-16 w-16 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? "bg-red-500 text-white hover:bg-red-600"
          : "bg-foreground text-background hover:bg-[#383838] dark:hover:bg-[#ccc]"
      }`}
    >
      {active ? <StopIcon /> : <MicIcon />}
    </button>
  );

  return (
    // h-dvh 视口固定高:字幕区内部滚动,控制条常驻不被顶出屏
    <main className="text-foreground mx-auto flex h-dvh w-full max-w-xl flex-col gap-3 px-4 pt-4 md:max-w-2xl">
      <header className="flex items-center justify-between gap-1 text-xs text-zinc-400">
        {/* 返回历史列表。做成左侧整块链接而非额外按钮,窄屏才放得下三个触区 */}
        <Link
          href="/"
          className="flex h-11 min-w-0 items-center gap-1 rounded-lg px-1 transition-colors hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m15 6-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="truncate sm:hidden">返回</span>
          <span className="hidden truncate sm:inline">返回列表</span>
        </Link>
        <span className="flex shrink-0 items-center gap-0.5">
          {companion ? (
            <ModeToggle companion onToggle={goChat} />
          ) : (
            <>
              {/* 陪伴模式状态在球体下方展示,此处只在对话模式占位;限宽防窄屏挤压按钮 */}
              <span className="max-w-[7rem] truncate">{STATUS_LABEL[session.status]}</span>
              <ModeToggle companion={false} onToggle={goCompanion} />
            </>
          )}
          <SettingsTrigger onClick={() => setSettingsOpen(true)} />
        </span>
      </header>

      {session.error !== null ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
        >
          <span>{session.error}</span>
          <button
            type="button"
            onClick={session.clearError}
            className="shrink-0 underline underline-offset-2"
          >
            知道了
          </button>
        </div>
      ) : null}

      {persistFailed ? (
        <p
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-400"
        >
          转写未能写入数据库,本次对话不会被记住。请检查 DATABASE_URL 与数据库连接。
        </p>
      ) : null}

      {companion ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6">
          <ElfAvatar state={avatarState} mood={mood} size={208} followCursor entrance="pop" />
          <p className="text-sm text-zinc-500">{STATUS_LABEL[session.status]}</p>
          {micButton}
        </div>
      ) : (
        <>
          <div className="flex shrink-0 justify-center">
            <ElfAvatar
              state={avatarState}
              mood={mood}
              size={92}
              entrance="pop"
              exitKey={exitKey}
            />
          </div>

          {/* min-h-0 保证 flex 子项正确收缩,内部滚动 */}
          <div
            ref={scrollRef}
            className={`min-h-0 flex-1 space-y-3 overflow-y-auto rounded-xl border border-black/[.06] p-4 transition-opacity duration-200 dark:border-white/[.08] ${
              phase === "leaving" ? "opacity-0" : "opacity-100"
            }`}
          >
            {session.history.length === 0 && !active ? (
              <p className="mt-14 text-center text-sm text-zinc-400">
                点击下方按钮开始通话,说话后此处将显示双方字幕
              </p>
            ) : null}

            {initialMessages.length > 0 ? (
              <p className="text-center text-xs text-zinc-400">
                以下是此前的对话记录 · 开启通话后继续这场对话
              </p>
            ) : null}

            {session.history.map((entry) => (
              <div
                key={entry.id}
                className={`flex flex-col ${entry.role === "user" ? "items-end" : "items-start"}`}
              >
                <p
                  className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-6 ${
                    entry.role === "user"
                      ? "bg-indigo-500/90 text-white"
                      : "bg-zinc-500/10 text-zinc-800 dark:bg-white/[.08] dark:text-zinc-100"
                  }`}
                >
                  {entry.text}
                </p>
                {/* 反馈只对 AI 的回复开放,且要等这条落库拿到 message id 之后 */}
                {entry.role === "assistant" && entry.dbId !== undefined ? (
                  <MessageFeedback messageId={entry.dbId} initialScore={entry.feedback ?? null} />
                ) : null}
              </div>
            ))}

            {session.userPartial !== "" ? (
              <div className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl bg-indigo-500/40 px-3 py-2 text-sm italic leading-6 text-white/80">
                  {session.userPartial}
                  <span className="ml-0.5 animate-pulse">▍</span>
                </p>
              </div>
            ) : null}
            {session.assistantPartial !== "" ? (
              <div className="flex justify-start">
                <p className="max-w-[85%] rounded-2xl bg-zinc-500/10 px-3 py-2 text-sm italic leading-6 text-zinc-600 dark:bg-white/[.06] dark:text-zinc-300">
                  {session.assistantPartial}
                  <span className="ml-0.5 animate-pulse">▍</span>
                </p>
              </div>
            ) : null}
          </div>

          {/* 底部避让刘海屏 Home 指示条安全区 */}
          <div className="flex shrink-0 flex-col items-center gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {micButton}
            <p
              className={`text-xs text-zinc-400 transition-opacity duration-200 ${
                phase === "leaving" ? "opacity-0" : "opacity-100"
              }`}
            >
              建议佩戴耳机以避免回声 · 麦克风需在浏览器弹窗中授权
            </p>
          </div>
        </>
      )}

      {/* 抽屉与 toast 均为 fixed 定位,挂在 main 内不影响 flex 布局 */}
      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        personas={personas}
        sessionActive={active}
        onApplyPersona={applyPersona}
        onApplyVoice={applyVoice}
        onSaveCustom={saveCustom}
      />
      {toast !== null ? (
        <p
          role="status"
          className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] mx-auto w-fit max-w-[85vw] rounded-full bg-zinc-900/90 px-4 py-2 text-center text-xs text-white shadow-lg dark:bg-zinc-100/95 dark:text-zinc-900"
        >
          {toast}
        </p>
      ) : null}
    </main>
  );
}
