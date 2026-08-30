"use client";

/**
 * 设置抽屉 / 侧边面板(step1 P1 + P2 的 UI)。
 *
 * 布局契约遵循 ui-设置中心与交互设计.md §2、§3.1、§3.4:
 * - H5:从右缘滑入的全屏抽屉;桌面(lg 以上):右侧固定面板 380px;
 * - 内部两级导航(分组首页 → 二级页),不新建路由,保持对话页沉浸;
 * - 分组行高 ≥56px、整行可点;所有触区 ≥44px(AGENTS.md H5 约束);
 * - 底部固定确认按钮高 48px,避让刘海屏安全区。
 *
 * 硬约束(ARCHITECTURE.md + voices.ts):instructions 与 voice 都随**新会话**生效,
 * 会话进行中不可改。故任何变更都先结束当前会话,并由父组件以 toast 告知用户。
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { PersonaRecord } from "@/lib/persona/types";
import { findPersona } from "@/lib/persona/resolve";
import type { PersonaSettings } from "@/lib/persona/settings";
import { CUSTOM_PERSONA_ID } from "@/lib/persona/presets";
import { REALTIME_VOICES } from "@/lib/persona/voices";

type SheetView = "root" | "persona" | "voice" | "custom";

export interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  settings: PersonaSettings;
  /** 可用人格(预设 + 自建);step2 起人格在库里,不能再硬编码常量列表 */
  personas: readonly PersonaRecord[];
  /** 会话进行中:变更需要先结束它 */
  sessionActive: boolean;
  /** 应用人格(带它绑定的音色);由父组件负责结束会话与提示 */
  onApplyPersona: (personaId: string, voice: string) => void;
  /** 应用音色 */
  onApplyVoice: (voice: string) => void;
  /** 保存自定义人设文案 */
  onSaveCustom: (instructions: string) => void;
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m15 6-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 分组列表行:整行可点,行高 ≥56px,触区充裕。 */
function Row({
  onClick,
  children,
  selected = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  selected?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[56px] w-full items-center gap-3 px-4 text-left transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06]"
    >
      <span className="min-w-0 flex-1">{children}</span>
      {selected ? (
        <span className="shrink-0 text-indigo-500">
          <CheckIcon />
        </span>
      ) : (
        <span className="shrink-0 text-zinc-300 dark:text-zinc-600">
          <ChevronIcon />
        </span>
      )}
    </button>
  );
}

const VIEW_TITLE: Record<SheetView, string> = {
  root: "设置",
  persona: "选择人格",
  voice: "选择音色",
  custom: "自定义人设",
};

export function SettingsSheet({
  open,
  onClose,
  settings,
  personas,
  sessionActive,
  onApplyPersona,
  onApplyVoice,
  onSaveCustom,
}: SettingsSheetProps) {
  const router = useRouter();
  const [view, setView] = useState<SheetView>("root");
  const [draftPersona, setDraftPersona] = useState(settings.personaId);
  const [draftVoice, setDraftVoice] = useState(settings.voice);
  const [draftCustom, setDraftCustom] = useState(settings.customInstructions);

  const [lastOpened, setLastOpened] = useState(open);

  // 每次打开都从当前生效值重新起稿,避免上次未确认的选择残留。
  // 用 React 官方的「props 变化时调整 state」写法(渲染期校正),而非放进 effect ——
  // 后者会触发级联渲染,并命中 react-hooks/set-state-in-effect 规则。
  if (open !== lastOpened) {
    setLastOpened(open);
    if (open) {
      setView("root");
      setDraftPersona(settings.personaId);
      setDraftVoice(settings.voice);
      setDraftCustom(settings.customInstructions);
    }
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const currentPersona = findPersona(settings, personas);
  const isCustom = settings.personaId === CUSTOM_PERSONA_ID;
  const displayName = isCustom ? "自定义" : (currentPersona?.name ?? "未选择");
  const displayEmoji = isCustom ? "✏️" : (currentPersona?.emoji ?? "🙂");

  const hint = sessionActive
    ? "当前通话会结束,并为这个人格开启一场新会话"
    : "会为这个人格新建一场会话并跳转过去";

  return (
    <div
      className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      {/* 遮罩 */}
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        aria-label="关闭设置"
        onClick={onClose}
        className={`absolute inset-0 w-full bg-black/40 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={VIEW_TITLE[view]}
        className={`absolute inset-y-0 right-0 flex w-full flex-col border-l border-black/[.06] bg-background shadow-2xl transition-transform duration-200 dark:border-white/[.08] lg:w-[380px] ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-black/[.06] px-2 dark:border-white/[.08]">
          {view === "root" ? (
            <span className="flex-1 px-2 text-base font-medium">{VIEW_TITLE[view]}</span>
          ) : (
            <button
              type="button"
              onClick={() => setView("root")}
              aria-label="返回"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-black/[.05] dark:hover:bg-white/[.08]"
            >
              <BackIcon />
            </button>
          )}
          {view !== "root" ? (
            <span className="flex-1 truncate text-base font-medium">{VIEW_TITLE[view]}</span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            tabIndex={open ? 0 : -1}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-black/[.05] hover:text-zinc-600 dark:hover:bg-white/[.08]"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {view === "root" ? (
            <div className="pb-4">
              {/* 当前人格卡片:本页唯一的"丰富组件"(ui spec §3.1)。
                  step2 起整卡可点 → 跳人格库页面(编辑/新建都收在那里) */}
              <div className="px-4 py-4">
                <button
                  type="button"
                  onClick={() => router.push("/persona")}
                  className="flex w-full items-center gap-3 rounded-xl border border-black/[.06] p-3 text-left transition-colors hover:bg-black/[.04] dark:border-white/[.08] dark:hover:bg-white/[.06]"
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/[.04] text-2xl dark:bg-white/[.08]">
                    {displayEmoji}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{displayName}</span>
                    <span className="block truncate text-xs text-zinc-400">
                      音色 {settings.voice}
                    </span>
                  </span>
                  <span className="shrink-0 text-zinc-300 dark:text-zinc-600">
                    <ChevronIcon />
                  </span>
                </button>
              </div>

              <div className="border-t border-black/[.06] dark:border-white/[.08]">
                <Row onClick={() => setView("persona")}>切换人格</Row>
                <Row onClick={() => setView("voice")}>音色</Row>
              </div>

              {/* 「记忆」分组(ui spec §2);内容量大,独立路由 */}
              <div className="border-t border-black/[.06] dark:border-white/[.08]">
                <Row onClick={() => router.push("/memory")}>TA 记得你</Row>
              </div>

              <p className="px-4 pt-4 text-xs leading-5 text-zinc-400">
                人格与音色在建立通话连接时下发,通话中无法修改。切换后会新建一场会话并
                跳转过去;此前的对话仍留在历史列表里,带着它当时的人格。
              </p>
            </div>
          ) : null}

          {view === "persona" ? (
            <div>
              {personas.map((persona) => (
                <button
                  key={persona.id}
                  type="button"
                  onClick={() => setDraftPersona(persona.id)}
                  className="flex min-h-[56px] w-full items-center gap-3 px-4 text-left transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                >
                  <span className="shrink-0 text-2xl">
                    {persona.emoji === "" ? "🙂" : persona.emoji}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{persona.name}</span>
                    <span className="block truncate text-xs text-zinc-400">
                      {persona.tagline === "" ? `音色 ${persona.voice}` : persona.tagline}
                    </span>
                  </span>
                  {draftPersona === persona.id ? (
                    <span className="shrink-0 text-indigo-500">
                      <CheckIcon />
                    </span>
                  ) : null}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setDraftPersona(CUSTOM_PERSONA_ID);
                  setView("custom");
                }}
                className="flex min-h-[56px] w-full items-center gap-3 border-t border-black/[.06] px-4 text-left transition-colors hover:bg-black/[.04] dark:border-white/[.08] dark:hover:bg-white/[.06]"
              >
                <span className="shrink-0 text-2xl">✏️</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">自定义</span>
                  <span className="block truncate text-xs text-zinc-400">
                    自己写一段人设描述
                  </span>
                </span>
                <span className="shrink-0 text-zinc-300 dark:text-zinc-600">
                  <ChevronIcon />
                </span>
              </button>
            </div>
          ) : null}

          {view === "voice" ? (
            <div className="pb-2">
              {REALTIME_VOICES.map((voice) => (
                <button
                  key={voice.id}
                  type="button"
                  onClick={() => setDraftVoice(voice.id)}
                  className="flex min-h-[56px] w-full items-center gap-3 px-4 text-left transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-sm">{voice.id}</span>
                    <span className="block truncate text-xs text-zinc-400">
                      {voice.note === "" ? "模型默认音色" : voice.note}
                    </span>
                  </span>
                  {draftVoice === voice.id ? (
                    <span className="shrink-0 text-indigo-500">
                      <CheckIcon />
                    </span>
                  ) : null}
                </button>
              ))}
              <p className="px-4 pt-3 text-xs leading-5 text-zinc-400">
                音色特质描述来自同名 TTS 音色的公开资料,实时模型的实际听感可能不同,
                建议逐个试听后选择。
              </p>
            </div>
          ) : null}

          {view === "custom" ? (
            <div className="space-y-3 px-4 py-4">
              <label htmlFor="custom-persona" className="block text-sm font-medium">
                人设描述
              </label>
              <textarea
                id="custom-persona"
                value={draftCustom}
                onChange={(e) => setDraftCustom(e.target.value)}
                placeholder={"例如:你叫阿阮,一个爱看书、说话慢条斯理的女生……"}
                className="min-h-[180px] w-full resize-y rounded-xl border border-black/[.10] bg-transparent p-3 text-sm leading-6 outline-none placeholder:text-zinc-400 focus:border-indigo-400 dark:border-white/[.12]"
              />
              <p className="text-xs leading-5 text-zinc-400">
                语音播报约束与 AI 身份披露等安全规则会自动追加在你的人设之后,
                且不可被覆盖。留空则只使用安全规则。
              </p>
            </div>
          ) : null}
        </div>

        {view === "persona" ? (
          <div className="shrink-0 border-t border-black/[.06] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] dark:border-white/[.08]">
            <p className="pb-2 text-center text-xs text-zinc-400">{hint}</p>
            <button
              type="button"
              onClick={() => {
                // 人格-音色成套:音色取人格记录上绑定的那个(step2 T3)
                const persona = personas.find((p) => p.id === draftPersona);
                onApplyPersona(draftPersona, persona?.voice ?? settings.voice);
              }}
              className="flex h-12 w-full items-center justify-center rounded-xl bg-foreground text-sm font-medium text-background transition-colors hover:opacity-90"
            >
              使用此人格(开启新会话)
            </button>
          </div>
        ) : null}

        {view === "voice" ? (
          <div className="shrink-0 border-t border-black/[.06] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] dark:border-white/[.08]">
            <p className="pb-2 text-center text-xs text-zinc-400">{hint}</p>
            <button
              type="button"
              onClick={() => onApplyVoice(draftVoice)}
              className="flex h-12 w-full items-center justify-center rounded-xl bg-foreground text-sm font-medium text-background transition-colors hover:opacity-90"
            >
              使用此音色(开启新会话)
            </button>
          </div>
        ) : null}

        {view === "custom" ? (
          <div className="shrink-0 border-t border-black/[.06] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] dark:border-white/[.08]">
            <p className="pb-2 text-center text-xs text-zinc-400">{hint}</p>
            <button
              type="button"
              onClick={() => onSaveCustom(draftCustom)}
              className="flex h-12 w-full items-center justify-center rounded-xl bg-foreground text-sm font-medium text-background transition-colors hover:opacity-90"
            >
              保存并开启新会话
            </button>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

/** 对话页 header 上的设置入口按钮(触区 44px)。 */
export function SettingsTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="设置"
      aria-label="设置"
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-black/[.05] hover:text-zinc-600 dark:hover:bg-white/[.08] dark:hover:text-zinc-300"
    >
      <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
      </svg>
    </button>
  );
}
