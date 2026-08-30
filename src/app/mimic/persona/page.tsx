"use client";

/**
 * 02 性格设置（Ardot 设计稿 3:163）。
 *
 * 桌面：左 480px 白卡舞台（hexagon 球 220px + 人格名 + 一句话人设 + 音色条），
 * 右表单区（预设 chips + 5 滑块 + 预览卡 + 保存按钮）。H5 单列，保存按钮吸底。
 *
 * 交互（spec §3.2）：
 * - 拖滑块 → 球 gaze 转向该行（「正在调我」的临场感）；
 * - 切预设 → 球 swirl 转一圈（morph 表达差异）；
 * - 保存 → swirl 一圈 → morph 回 idle → 跳对话页。
 *
 * 数据来自 src/lib/persona/presets.ts（纯常量，无服务端依赖）。
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CSSProperties } from "react";
import { BallAnchor, useBall } from "@/components/mimic/ball/ball-context";
import { switchConversationAction } from "@/lib/memory/actions";
import { PERSONA_PRESETS } from "@/lib/persona/presets";
import { usePersonaSettings } from "@/lib/persona/use-settings";
import type { PersonaTraits } from "@/lib/persona/traits";

/** 展示的 5 个滑块（设计稿维度；closeness 属六维矩阵但不进本屏） */
const SLIDERS: Array<{ key: keyof Pick<PersonaTraits, "warmth" | "energy" | "humor" | "chattiness" | "initiative">; label: string }> = [
  { key: "warmth", label: "热情度" },
  { key: "energy", label: "活泼度" },
  { key: "humor", label: "幽默度" },
  { key: "chattiness", label: "话痨度" },
  { key: "initiative", label: "主动性" },
];

/** 音色 id → 展示名（设计稿示例为「音色 · 聆心」） */
const VOICE_LABEL: Record<string, string> = {
  longanqian: "默认",
  longanlingxin: "聆心",
  longanlingxi: "灵犀",
  longanxiaoxin: "小新",
  longanlufeng: "陆风",
};

function bucket(v: number): string {
  if (v >= 70) return "偏高";
  if (v >= 40) return "适中";
  return "偏低";
}

function previewText(name: string, tagline: string, t: PersonaTraits): string {
  return `你叫${name}，${tagline}。热情${bucket(t.warmth)}、活泼${bucket(t.energy)}、幽默${bucket(t.humor)}，${
    t.chattiness >= 70 ? "爱接话" : t.chattiness >= 40 ? "话量看心情" : "话不多催"
  }，${t.initiative >= 60 ? "会主动找话题" : "多听少问"}。说话短句、口语，会记住小事并在合适时候提起。`;
}

export default function PersonaPage() {
  const router = useRouter();
  const ball = useBall();
  const { settings, update } = usePersonaSettings();
  const savedPreset = PERSONA_PRESETS.find((p) => p.id === settings.personaId);
  const [presetId, setPresetId] = useState(savedPreset?.id ?? PERSONA_PRESETS[0].id);
  const [traits, setTraits] = useState<PersonaTraits>({ ...(savedPreset ?? PERSONA_PRESETS[0]).traits });
  const [saving, setSaving] = useState(false);

  const preset = PERSONA_PRESETS.find((p) => p.id === presetId) ?? PERSONA_PRESETS[0];

  function switchPreset(id: string) {
    const next = PERSONA_PRESETS.find((p) => p.id === id);
    if (next === undefined) return;
    setPresetId(id);
    setTraits({ ...next.traits });
    ball.swirl();
  }

  function handleSlider(key: keyof PersonaTraits, value: number, row: number) {
    setTraits((t) => ({ ...t, [key]: value }));
    // 球在左舞台，滑块在右 → gaze 转向该行（设计稿：拖滑块时头转向该行）
    ball.setGazeDir({ x: 1, y: -0.35 + row * 0.18 });
  }

  /**
   * 保存:写 localStorage(personaId + voice),然后真的开新会话
   * (realtime 会话不可变参数,切人设 = 开新会话,spec §3.2 / voices.ts 硬约束),
   * 跳到 /mimic/chat/<新 id>。无库时 switchConversationAction 返回 null,
   * 直接进 /mimic/chat 入口(重新点麦克风即带新人格)。
   */
  function handleSave() {
    if (saving) return;
    setSaving(true);
    ball.swirl();
    ball.setBallState("idle");
    ball.setGazeDir(null);
    update({ personaId: preset.id, voice: preset.voice });
    void switchConversationAction({
      personaId: preset.id,
      voice: preset.voice,
      fromConversationId: null,
    })
      .then((newId) => {
        setTimeout(() => router.push(newId !== null ? `/mimic/chat/${newId}` : "/mimic/chat"), 950);
      })
      .catch(() => {
        setSaving(false);
        setTimeout(() => router.push("/mimic/chat"), 950);
      });
  }

  return (
    <div className="mimic-page min-h-dvh bg-[#F6F5F4] lg:flex">
      {/* 左舞台：白卡 */}
      <section className="relative flex flex-col items-center gap-4 border-b border-[#E5E3DF] bg-white px-6 pb-8 pt-6 lg:w-[480px] lg:shrink-0 lg:min-h-dvh lg:border-r lg:border-b-0 lg:gap-5 lg:px-10 lg:py-10">
        <p className="text-[11px] font-semibold tracking-wide text-[#5645D4]">第二步 · 性格</p>
        <BallAnchor state="hexagon" className="h-44 w-44 lg:h-[220px] lg:w-[220px]" />
        <h1 className="text-2xl font-semibold text-[#1A1A1A] lg:text-[28px]">{preset.name}</h1>
        <p className="max-w-[320px] text-center text-sm leading-[1.5] text-[#5D5B54]">{preset.tagline}</p>

        <div className="flex h-11 w-full max-w-[360px] items-center justify-between rounded-lg bg-[#F6F5F4] px-4">
          <span className="text-sm font-medium text-[#37352E]">音色 · {VOICE_LABEL[preset.voice] ?? preset.voice}</span>
          <button
            type="button"
            onClick={() => ball.flash("wink", 600)}
            className="min-h-[44px] px-1 text-[13px] font-medium text-[#0075DE] transition-colors hover:text-[#4536A8]"
          >
            试听
          </button>
        </div>

        <p className="hidden max-w-[360px] text-center text-xs leading-[1.6] text-[#787671] lg:block">
          hexagon 态。拖滑块时球转向该行；保存时 swirl 转一圈，再 morph 回 idle。换人格 = 开新会话。
        </p>
        <a href="/mimic/register" className="hidden text-[13px] text-[#787671] hover:text-[#A4A097] lg:absolute lg:left-10 lg:top-6">
          ← 注册
        </a>
      </section>

      {/* 右表单区 */}
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-5 px-4 pb-28 pt-6 lg:px-14 lg:pb-12 lg:pt-12">
        <header className="flex flex-col gap-1 lg:flex-row lg:items-baseline lg:justify-between">
          <h2 className="text-2xl font-semibold text-[#1A1A1A] lg:text-[28px]">调一调 TA 是谁</h2>
          <span className="text-[13px] text-[#787671]">所见即所聊</span>
        </header>

        {/* 预设人格行 */}
        <div className="flex flex-wrap gap-2">
          {PERSONA_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => switchPreset(p.id)}
              className={`h-9 rounded-lg px-3.5 text-sm font-medium transition-colors ${
                p.id === presetId
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

        {/* 预览卡（TA 眼中的自己） */}
        <div className="flex flex-col gap-2 rounded-xl bg-[#FEF7D6] p-5">
          <p className="text-xs font-semibold text-[#523410]">TA 眼中的自己</p>
          <p className="text-sm leading-[1.5] text-[#37352E]">{previewText(preset.name, preset.tagline, traits)}</p>
        </div>

        {/* 保存（H5 吸底 / 桌面流内） */}
        <div className="fixed inset-x-0 bottom-0 z-30 bg-[#F6F5F4]/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:static lg:bg-transparent lg:px-0 lg:pt-0 lg:pb-0 lg:backdrop-blur-none">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="h-12 w-full rounded-lg bg-[#5645D4] text-sm font-medium text-white transition-colors hover:bg-[#4536A8] active:bg-[#4536A8] disabled:opacity-70"
          >
            {saving ? " swirl 转场中…" : "保存并开启新会话"}
          </button>
        </div>
      </section>
    </div>
  );
}
