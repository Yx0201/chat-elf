"use client";

/**
 * 孵化流程(2026-08-31 UI 大一统新增)— /hatch 的客户端主体。
 *
 * 两个阶段:
 *   1. egg —— 深色舞台 + 蛋形球,点「唤醒它」:egg → burst → idle;
 *   2. persona —— 一次性性格设置(设计稿 3.2 布局):预设/自建人格 chips +
 *      五维滑块 + 音色 + 预览卡。确认即定格,不可修改。
 *
 * 一次性语义(产品硬约束):
 *   - 滑块/音色相对所选人格有改动时,生成一份**快照型自建人格**入库
 *     (无库时降级为 CUSTOM_PERSONA_ID + 渲染后的本地文案),让"定格"有据可依;
 *   - 确认前弹 shadcn Dialog 明确告知不可修改(已弃用原生 confirm);
 *   - 确认后写 localStorage(settings + hatched 标记)→ 开新会话 → 进对话;
 *   - 已孵化过的浏览器再进本页直接回 /chat。
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { BallAnchor, useBall } from "@/components/mimic/ball/ball-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { switchConversationAction } from "@/lib/memory/actions";
import { savePersonaAction } from "@/lib/persona/actions";
import { completeHatch, isHatched } from "@/lib/persona/hatch-state";
import { CUSTOM_PERSONA_ID, PERSONA_PRESETS } from "@/lib/persona/presets";
import { renderPersonaBody } from "@/lib/persona/render";
import type { PersonaTraits, TraitKey } from "@/lib/persona/traits";
import type { PersonaRecord } from "@/lib/persona/types";
import { usePersonaSettings } from "@/lib/persona/use-settings";
import { REALTIME_VOICES } from "@/lib/persona/voices";

/** 展示的 5 个滑块(设计稿维度;closeness 属六维矩阵但本期不进孵化屏)。 */
const SLIDERS: Array<{ key: Exclude<TraitKey, "closeness">; label: string }> = [
  { key: "warmth", label: "热情度" },
  { key: "energy", label: "活泼度" },
  { key: "humor", label: "幽默度" },
  { key: "chattiness", label: "话痨度" },
  { key: "initiative", label: "主动性" },
];

/** 孵化候选:预设(常量)与自建(库)。 */
interface HatchBase {
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  voice: string;
  backstory: string;
  boundaries: string;
  traits: PersonaTraits;
}

function traitsEqual(a: PersonaTraits, b: PersonaTraits): boolean {
  return (
    a.warmth === b.warmth &&
    a.energy === b.energy &&
    a.humor === b.humor &&
    a.chattiness === b.chattiness &&
    a.initiative === b.initiative &&
    a.closeness === b.closeness
  );
}

export function HatchFlow({
  customs,
  persistence,
}: {
  customs: readonly PersonaRecord[];
  persistence: boolean;
}) {
  const router = useRouter();
  const ball = useBall();
  const { update } = usePersonaSettings();

  const bases = useMemo<HatchBase[]>(
    () => [
      ...PERSONA_PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        emoji: p.emoji,
        tagline: p.tagline,
        voice: p.voice,
        backstory: p.instructions,
        boundaries: "",
        traits: { ...p.traits },
      })),
      ...customs.map((p) => ({
        id: p.id,
        name: p.name,
        emoji: p.emoji,
        tagline: p.tagline,
        voice: p.voice,
        backstory: p.backstory,
        boundaries: p.boundaries,
        traits: { ...p.traits },
      })),
    ],
    [customs],
  );

  const [stage, setStage] = useState<"egg" | "persona">("egg");
  const [baseId, setBaseId] = useState<string>(bases[0].id);
  const [traits, setTraits] = useState<PersonaTraits>(() => ({ ...bases[0].traits }));
  const [voice, setVoice] = useState<string>(bases[0].voice);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "playing" | "error">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 预设常量恒非空(5 个),bases 至少含预设 → 直接索引安全
  const base = bases.find((b) => b.id === baseId) ?? bases[0];

  // 已孵化过的浏览器直接回对话(孵化是一次性的)
  useEffect(() => {
    if (isHatched()) router.replace("/chat");
  }, [router]);

  function switchBase(id: string) {
    const next = bases.find((b) => b.id === id);
    if (next === undefined) return;
    stopPreview();
    setPreviewState("idle");
    setBaseId(id);
    setTraits({ ...next.traits });
    setVoice(next.voice);
    ball.swirl();
    // 切换人格 = 换音色,直接自动试听新音色
    previewVoice(next.voice);
  }

  /** 终止正在进行的试听(切音色 / 换人格 / 卸载时调用)。 */
  function stopPreview(): void {
    if (previewTimeoutRef.current !== null) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    const audio = audioRef.current;
    if (audio !== null) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audioRef.current = null;
    }
  }

  function previewVoice(voiceId: string): void {
    stopPreview();
    setPreviewState("loading");

    const audio = new Audio();
    audio.preload = "auto";
    audioRef.current = audio;

    audio.addEventListener("playing", () => {
      if (previewTimeoutRef.current !== null) {
        clearTimeout(previewTimeoutRef.current);
        previewTimeoutRef.current = null;
      }
      setPreviewState("playing");
    });
    audio.addEventListener("ended", () => {
      stopPreview();
      setPreviewState("idle");
    });
    audio.addEventListener("error", () => {
      stopPreview();
      setPreviewState("error");
    });

    audio.src = `/api/voice-preview?voice=${encodeURIComponent(voiceId)}`;
    void audio.play().catch(() => {
      stopPreview();
      setPreviewState("error");
    });

    // 合成 + 传输兜底;进入播放态后由 playing 事件清除
    previewTimeoutRef.current = setTimeout(() => {
      setPreviewState((s) => (s === "loading" ? "error" : s));
      stopPreview();
    }, 15_000);

    ball.flash("wink", 600);
  }

  // 卸载时清理在播音频
  useEffect(() => {
    return () => {
      if (previewTimeoutRef.current !== null) {
        clearTimeout(previewTimeoutRef.current);
      }
    };
  }, []);

  function handleSlider(key: Exclude<TraitKey, "closeness">, value: number, row: number) {
    setTraits((t) => ({ ...t, [key]: value }));
    // 滑块在右、球在左 → gaze 转向该行(设计稿:拖滑块时头转向该行)
    ball.setGazeDir({ x: 1, y: -0.35 + row * 0.18 });
  }

  const dirty = !traitsEqual(base.traits, traits);
  const preview = useMemo(
    () =>
      renderPersonaBody({
        name: base.name,
        backstory: base.backstory,
        boundaries: base.boundaries,
        traits,
      }),
    [base, traits],
  );

  async function confirmHatch(): Promise<void> {
    if (saving) return;

    setSaving(true);

    // 有改动 → 快照成自建人格定格;无库退化为本地自定义文案
    let personaId = base.id;
    let customInstructions = "";
    if (dirty) {
      const savedId = await savePersonaAction({
        draft: {
          name: base.name,
          emoji: base.emoji,
          tagline: base.tagline,
          traits,
          voice,
          backstory: base.backstory,
          boundaries: base.boundaries,
        },
      });
      if (savedId !== null) {
        personaId = savedId;
      } else {
        personaId = CUSTOM_PERSONA_ID;
        customInstructions = renderPersonaBody({
          name: base.name,
          backstory: base.backstory,
          boundaries: base.boundaries,
          traits,
        });
      }
    }

    update({ personaId, voice, customInstructions });
    completeHatch({ personaId, voice });

    ball.swirl();
    ball.setBallState("idle");
    ball.setGazeDir(null);

    try {
      const newId = await switchConversationAction({
        personaId,
        voice,
        fromConversationId: null,
      });
      setTimeout(() => router.replace(newId !== null ? `/chat/${newId}` : "/chat"), 950);
    } catch {
      setSaving(false);
      setTimeout(() => router.replace("/chat"), 950);
    }
  }

  const walkBack = (
    <Link href="/" className="text-[13px] text-[#787671] transition-colors hover:text-[#A4A097]">
      ← 登录
    </Link>
  );

  if (stage === "egg") {
    return (
      <div className="mimic-page flex min-h-dvh flex-col items-center justify-center gap-6 bg-[#0A1530] px-6 py-12">
        <BallAnchor state="egg" variant="light" className="h-40 w-40 lg:h-[260px] lg:w-[260px]" />
        <h1 className="text-center text-3xl font-semibold text-white lg:text-[40px]">把它孵出来</h1>
        <p className="max-w-[420px] text-center text-sm leading-[1.55] text-[#A4A097]">
          它还没出生,目光会跟着你的光标。唤醒后,再为它定一次格 —— 性格与音色,一生只选一次。
        </p>
        <button
          type="button"
          onClick={() => {
            ball.triggerBurst();
            ball.setBallState("idle");
            setTimeout(() => setStage("persona"), 900);
          }}
          className="h-12 rounded-lg bg-[#5645D4] px-8 text-sm font-medium text-white transition-colors hover:bg-[#4536A8] active:bg-[#4536A8]"
        >
          唤醒它
        </button>
        {walkBack}
      </div>
    );
  }

  return (
    <div className="mimic-page min-h-dvh bg-[#F6F5F4] lg:flex">
      {/* 左舞台(H5 顶部紧凑区) */}
      <section className="relative flex flex-col items-center gap-4 border-b border-[#E5E3DF] bg-white px-6 pb-8 pt-6 lg:w-[480px] lg:min-h-dvh lg:shrink-0 lg:border-r lg:border-b-0 lg:gap-5 lg:px-10 lg:py-10">
        <p className="text-[11px] font-semibold tracking-wide text-[#5645D4]">第二步 · 一次性定格</p>
        <BallAnchor state="hexagon" className="h-44 w-44 lg:h-[220px] lg:w-[220px]" />
        <h1 className="text-2xl font-semibold text-[#1A1A1A] lg:text-[28px]">{base.name}</h1>
        <p className="max-w-[320px] text-center text-sm leading-[1.5] text-[#5D5B54]">{base.tagline}</p>

        <div className="flex h-11 w-full max-w-[360px] items-center justify-between rounded-lg bg-[#F6F5F4] px-4">
          <span className="text-sm font-medium text-[#37352E]">
            音色 · {voice}
          </span>
          <button
            type="button"
            onClick={() => previewVoice(voice)}
            disabled={previewState === "loading" || previewState === "playing"}
            className="flex min-h-[44px] items-center px-1 text-[13px] font-medium text-[#0075DE] transition-colors hover:text-[#4536A8] disabled:opacity-60"
          >
            {previewState === "loading"
              ? "合成中…"
              : previewState === "playing"
                ? "播放中…"
                : previewState === "error"
                  ? "重试"
                  : "试听"}
          </button>
        </div>
        {previewState === "error" ? (
          <p className="text-xs text-red-500">试听失败,请稍后再试</p>
        ) : null}

        <p className="hidden max-w-[360px] text-center text-xs leading-[1.6] text-[#787671] lg:block">
          hexagon 态。拖滑块时球转向该行;确认时 swirl 转一圈,再 morph 回 idle。
        </p>
        <span className="lg:absolute lg:left-10 lg:top-6">{walkBack}</span>
      </section>

      {/* 右表单区(H5 吸底确认条) */}
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-5 px-4 pb-28 pt-6 lg:px-14 lg:pb-12 lg:pt-12">
        <header className="flex flex-col gap-1 lg:flex-row lg:items-baseline lg:justify-between">
          <h2 className="text-2xl font-semibold text-[#1A1A1A] lg:text-[28px]">调一调 TA 是谁</h2>
          <span className="text-[13px] text-[#787671]">所见即所聊 · 确认后不可修改</span>
        </header>

        {/* 人格 chips(预设 + 自建) */}
        <div className="flex flex-wrap gap-2">
          {bases.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => switchBase(p.id)}
              className={`h-9 rounded-lg px-3.5 text-sm font-medium transition-colors ${
                p.id === baseId
                  ? "bg-[#0A0A0C] text-white"
                  : "border border-[#E5E3DF] bg-white text-[#37352E] hover:border-[#C8C4BE]"
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>

        {/* 性格滑块组 */}
        <div className="flex flex-col gap-1 rounded-xl border border-[#E5E3DF] bg-white p-5 lg:p-6">
          {SLIDERS.map((s, i) => (
            <div key={s.key} className="flex items-center gap-4 py-2 lg:gap-5">
              <span className="w-[60px] shrink-0 text-sm font-medium text-[#37352E] lg:w-[72px]">{s.label}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={traits[s.key]}
                onChange={(e) => handleSlider(s.key, Number(e.target.value), i)}
                onPointerUp={() => ball.setGazeDir(null)}
                onBlur={() => ball.setGazeDir(null)}
                className="mimic-slider h-6 flex-1"
                style={{ "--mimic-fill": `${traits[s.key]}%` } as CSSProperties}
                aria-label={s.label}
              />
              <span className="w-7 shrink-0 text-right font-['Inter'] text-[13px] font-medium text-[#787671]">
                {traits[s.key]}
              </span>
            </div>
          ))}
        </div>

        {/* 音色 */}
        <div className="flex flex-col gap-2 rounded-xl border border-[#E5E3DF] bg-white p-5 lg:p-6">
          <label htmlFor="hatch-voice" className="text-sm font-medium text-[#37352E]">
            音色(与人格一起定格)
          </label>
          <select
            id="hatch-voice"
            value={voice}
            onChange={(e) => {
              stopPreview();
              setPreviewState("idle");
              setVoice(e.target.value);
              // 换音色即自动试听新音色
              previewVoice(e.target.value);
            }}
            className="h-11 rounded-lg border border-[#E5E3DF] bg-white px-3 text-sm text-[#1A1A1A] focus:border-[#5645D4] focus:outline-none"
          >
            {REALTIME_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
                {v.note === "" ? "" : ` · ${v.note}`}
              </option>
            ))}
          </select>
          <p className="text-xs leading-5 text-[#A4A097]">
            5 个系统音色。试听以同名 TTS 音色实时合成,与实时模型听感可能略有差异。
          </p>
        </div>

        {/* 预览卡(所见即所聊) */}
        <div className="flex flex-col gap-2 rounded-xl bg-[#FEF7D6] p-5">
          <p className="text-xs font-semibold text-[#523410]">TA 眼中的自己</p>
          <p className="whitespace-pre-wrap text-sm leading-[1.5] text-[#37352E]">{preview}</p>
        </div>

        {/* 一次性硬提示 */}
        <div className="flex flex-col gap-2 rounded-xl border border-[#F5D75E] bg-[#FEF7D6] p-5">
          <p className="text-sm font-semibold text-[#523410]">一次性选择 · 之后无法修改</p>
          <p className="text-[13px] leading-[1.6] text-[#37352E]">
            人格与音色在孵化时一次性确定,之后不再提供修改入口。确定后,TA 就是往后一直陪伴你的那个角色。
          </p>
        </div>

        {/* 确认(H5 吸底 / 桌面流内) */}
        <div className="fixed inset-x-0 bottom-0 z-30 bg-[#F6F5F4]/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:static lg:bg-transparent lg:px-0 lg:pt-0 lg:pb-0 lg:backdrop-blur-none">
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={saving}
            className="h-12 w-full rounded-lg bg-[#5645D4] text-sm font-semibold text-white transition-colors hover:bg-[#4536A8] active:bg-[#4536A8] disabled:opacity-70"
          >
            {saving ? "定稿中…" : dirty ? "确定,这就是 TA(有改动,将定格为当前设置)" : "确定,这就是 TA"}
          </button>

          {persistence ? null : (
            <p className="pt-2 text-center text-xs text-[#A4A097]">
              未配置数据库时,新的人格改动以本地方式定格,不会落库。
            </p>
          )}
        </div>

        {/* 孵化确认弹窗(原生 confirm 已弃用,统一 shadcn Dialog) */}
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>一次性选择 · 确定孵化?</DialogTitle>
              <DialogDescription>
                人格与音色在孵化时一次性确定,之后无法修改 —— TA 就是往后一直陪伴你的那个角色。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                className="min-h-11 flex-1"
                onClick={() => setConfirmOpen(false)}
              >
                再想想
              </Button>
              <Button
                className="min-h-11 flex-1"
                onClick={() => {
                  setConfirmOpen(false);
                  void confirmHatch();
                }}
              >
                确定孵化
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 试听合成全局 loading:等待音频加载期间遮罩全屏 */}
        {previewState === "loading" ? (
          <div
            className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-[#F6F5F4]/80 backdrop-blur-sm"
            role="status"
            aria-label="正在合成试听音频"
          >
            <Spinner className="size-8 text-primary" />
            <p className="text-[13px] font-medium text-[#5D5B54]">正在合成试听音频…</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}