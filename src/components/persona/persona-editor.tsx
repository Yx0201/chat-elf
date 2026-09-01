"use client";

/**
 * 人格编辑器(step2 T3;2026-08-31 拟态球化 + 保存语义收窄)。
 *
 * 布局契约遵循 ui-设置中心与交互设计.md §3.2:H5 单列堆叠、桌面双栏(左表单 右预览)、
 * 底部固定 48px 按钮。滑块用原生 input[type=range] + 项目自有的 .mimic-slider 样式,
 * 不为一个组件引入 shadcn 依赖。
 *
 * 两个值得说明的实现选择:
 * 1. **预览不防抖**。ui spec §3.2 的"防抖 300ms"针对"预览要发请求"的假设,
 *    本项目预览是 renderPersonaBody() 纯函数本地调用,不加防抖。
 * 2. **预览与实际下发同源**。两端都调 render.ts 的同一函数(所见即所聊)。
 *
 * **保存语义(2026-08-31 起)**:保存只写人格定义,不再"开启新会话" ——
 * 陪伴人格已在孵化时定格(见 /hatch),人格库仅管理定义。
 * **锁定**:当前陪伴中的人格(id 命中 companionPersonaId)只读,
 * 不可编辑、不可删除;想调整先另存副本。
 */

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  deletePersonaAction,
  duplicatePersonaAction,
  savePersonaAction,
} from "@/lib/persona/actions";
import { MAX_BODY_CHARS, renderPersonaBody } from "@/lib/persona/render";
import {
  MAX_NAME_LENGTH,
  MAX_TEXTAREA_LENGTH,
  type PersonaDraft,
  type PersonaRecord,
} from "@/lib/persona/types";
import { DEFAULT_VOICE, REALTIME_VOICES } from "@/lib/persona/voices";
import { TRAIT_DEFINITIONS, type TraitKey } from "@/lib/persona/traits";

export interface PersonaEditorProps {
  /** 已有记录的 id;新建时为 null */
  personaId: string | null;
  /** 孵化定格的人格 id(服务端 companion);命中则锁定只读 */
  companionPersonaId: string | null;
  /** 已有记录;新建时为 null */
  initial: PersonaRecord | null;
  /** 预设人格与"无数据库"降级态:只读,只能另存副本 */
  readOnly: boolean;
  /** 是否显示删除(只有库里已存在的自建人格可删) */
  canDelete: boolean;
}

function toDraft(record: PersonaRecord | null, fallbackVoice: string): PersonaDraft {
  if (record === null) {
    return {
      name: "",
      emoji: "✨",
      tagline: "",
      traits: { warmth: 50, energy: 50, humor: 50, chattiness: 50, initiative: 50, closeness: 50 },
      voice: fallbackVoice,
      backstory: "",
      boundaries: "",
    };
  }
  return {
    name: record.name,
    emoji: record.emoji,
    tagline: record.tagline,
    traits: { ...record.traits },
    voice: record.voice,
    backstory: record.backstory,
    boundaries: record.boundaries,
  };
}

export function PersonaEditor({
  personaId,
  companionPersonaId,
  initial,
  readOnly,
  canDelete,
}: PersonaEditorProps) {
  const router = useRouter();

  const [draft, setDraft] = useState<PersonaDraft>(() => toDraft(initial, DEFAULT_VOICE));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 陪伴中的人格 = 孵化时定格的那个,只读不删(一次性语义,H5 与桌面一致)
  const activeCompanion = initial !== null && initial.id === companionPersonaId;
  const effectiveReadOnly = readOnly || activeCompanion;
  const effectiveCanDelete = canDelete && !activeCompanion;

  const preview = useMemo(
    () => renderPersonaBody({ ...draft, traits: draft.traits }),
    [draft],
  );

  function patch(next: Partial<PersonaDraft>): void {
    setDraft((prev) => ({ ...prev, ...next }));
    setSaved(false);
  }

  function patchTrait(key: TraitKey, value: number): void {
    setDraft((prev) => ({ ...prev, traits: { ...prev.traits, [key]: value } }));
    setSaved(false);
  }

  /** 保存:只写人格定义(不再切陪伴人格/开新会话 —— 孵化定格的硬约束)。 */
  async function save(): Promise<void> {
    if (busy) return;
    if (draft.name.trim() === "") {
      setError("给 TA 起个名字吧");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const savedId =
        personaId === null
          ? await savePersonaAction({ draft })
          : await savePersonaAction({ id: personaId, draft });
      if (savedId === null) {
        setError("保存失败,请检查数据库配置后重试");
        return;
      }
      setSaved(true);
    } catch {
      setError("保存失败,请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function duplicate(): Promise<void> {
    if (personaId === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const newId = await duplicatePersonaAction(personaId);
      if (newId === null) setError("复制失败,请检查数据库配置后重试");
      else router.push(`/persona/${newId}`);
    } catch {
      setError("复制失败,请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (personaId === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await deletePersonaAction(personaId);
      if (!ok) setError("删除失败");
      else router.push("/persona");
    } catch {
      setError("删除失败");
    } finally {
      setBusy(false);
    }
  }

  const overBudget = preview.length > MAX_BODY_CHARS;

  return (
    <>
      {activeCompanion ? (
        <div className="mb-5 rounded-xl bg-[#E6E0F5] p-4">
          <p className="text-sm font-semibold text-[#391C57]">陪伴中的人格</p>
          <p className="mt-1 text-[13px] leading-[1.5] text-[#5D5B54]">
            TA 是孵化时定格的陪伴人格,不可修改或删除。想调教可以「另存为我的副本」后再改。
          </p>
        </div>
      ) : null}

      <div className="lg:grid lg:grid-cols-[minmax(0,30rem)_minmax(0,1fr)] lg:items-start lg:gap-8">
        {/* 左:表单 */}
        <div className="flex flex-col gap-6">
          <div className="flex items-start gap-3">
            <input
              value={draft.emoji}
              onChange={(e) => patch({ emoji: e.target.value })}
              disabled={effectiveReadOnly || busy}
              maxLength={4}
              aria-label="头像"
              className="h-14 w-14 shrink-0 rounded-full border border-[#E5E3DF] bg-white text-center text-2xl outline-none focus:border-[#5645D4] disabled:opacity-60"
            />
            <div className="min-w-0 flex-1">
              <label htmlFor="persona-name" className="block text-sm font-medium text-[#1A1A1A]">
                名字
              </label>
              <input
                id="persona-name"
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                disabled={effectiveReadOnly || busy}
                maxLength={MAX_NAME_LENGTH}
                placeholder="例如:小柚"
                className="mt-1 h-11 w-full rounded-xl border border-[#E5E3DF] bg-white px-3 text-sm text-[#1A1A1A] outline-none placeholder:text-[#A4A097] focus:border-[#5645D4] disabled:opacity-60"
              />
            </div>
          </div>

          <div>
            <label htmlFor="persona-tagline" className="block text-sm font-medium text-[#1A1A1A]">
              一句话人设
            </label>
            <input
              id="persona-tagline"
              value={draft.tagline}
              onChange={(e) => patch({ tagline: e.target.value })}
              disabled={effectiveReadOnly || busy}
              maxLength={60}
              placeholder="列表里显示在名字下面,例如:温和松弛的老朋友"
              className="mt-1 h-11 w-full rounded-xl border border-[#E5E3DF] bg-white px-3 text-sm text-[#1A1A1A] outline-none placeholder:text-[#A4A097] focus:border-[#5645D4] disabled:opacity-60"
            />
          </div>

          <section>
            <h2 className="text-sm font-medium text-[#1A1A1A]">性格</h2>
            <p className="mt-1 text-xs leading-5 text-[#A4A097]">
              拖动滑块调节 TA 的说话方式。这些描述会被写进 TA 的指令里,
              右边的预览就是 TA 实际收到的内容。
            </p>
            <div className="mt-3 flex flex-col gap-3">
              {TRAIT_DEFINITIONS.map((definition) => (
                <div key={definition.key}>
                  <div className="flex items-baseline justify-between text-sm">
                    <label htmlFor={`trait-${definition.key}`} className="text-[#37352E]">
                      {definition.label}
                    </label>
                    <span className="text-xs tabular-nums text-[#A4A097]">
                      {draft.traits[definition.key]}
                    </span>
                  </div>
                  <input
                    id={`trait-${definition.key}`}
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={draft.traits[definition.key]}
                    onChange={(e) => patchTrait(definition.key, Number(e.target.value))}
                    disabled={effectiveReadOnly || busy}
                    // h-11 保证移动端触区 44px;.mimic-slider 给轨道/圆钮上设计稿样式
                    className="mimic-slider mt-1 h-11 w-full disabled:opacity-60"
                    style={{ "--mimic-fill": `${draft.traits[definition.key]}%` } as CSSProperties}
                  />
                  <div className="flex justify-between text-[11px] text-[#A4A097]">
                    <span>{definition.lowLabel}</span>
                    <span>{definition.highLabel}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div>
            <label htmlFor="persona-backstory" className="block text-sm font-medium text-[#1A1A1A]">
              背景故事 / 人设
            </label>
            <textarea
              id="persona-backstory"
              value={draft.backstory}
              onChange={(e) => patch({ backstory: e.target.value })}
              disabled={effectiveReadOnly || busy}
              maxLength={MAX_TEXTAREA_LENGTH}
              placeholder={
                "用一段话描述 TA 是谁、什么性格、怎么说话。留空则完全由上面的滑块决定人格。"
              }
              className="mt-1 min-h-[160px] w-full resize-y rounded-xl border border-[#E5E3DF] bg-white p-3 text-sm leading-6 text-[#1A1A1A] outline-none placeholder:text-[#A4A097] focus:border-[#5645D4] disabled:opacity-60"
            />
          </div>

          <div>
            <label htmlFor="persona-boundaries" className="block text-sm font-medium text-[#1A1A1A]">
              行为边界
            </label>
            <textarea
              id="persona-boundaries"
              value={draft.boundaries}
              onChange={(e) => patch({ boundaries: e.target.value })}
              disabled={effectiveReadOnly || busy}
              maxLength={MAX_TEXTAREA_LENGTH}
              placeholder={"TA 绝不做什么。例如:绝不使用说教的语气,绝不评价用户的家人。"}
              className="mt-1 min-h-[88px] w-full resize-y rounded-xl border border-[#E5E3DF] bg-white p-3 text-sm leading-6 text-[#1A1A1A] outline-none placeholder:text-[#A4A097] focus:border-[#5645D4] disabled:opacity-60"
            />
          </div>

          <div>
            <label htmlFor="persona-voice" className="block text-sm font-medium text-[#1A1A1A]">
              音色
            </label>
            <select
              id="persona-voice"
              value={draft.voice}
              onChange={(e) => patch({ voice: e.target.value })}
              disabled={effectiveReadOnly || busy}
              className="mt-1 h-11 w-full rounded-xl border border-[#E5E3DF] bg-white px-3 text-sm text-[#1A1A1A] outline-none focus:border-[#5645D4] disabled:opacity-60"
            >
              {REALTIME_VOICES.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.id}
                  {voice.note === "" ? "" : ` · ${voice.note}`}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs leading-5 text-[#A4A097]">
              音色共有 5 个系统音色可选,特质描述来自同名 TTS 音色的公开资料,
              实时模型的实际听感可能不同。
            </p>
          </div>
        </div>

        {/* 右:预览。H5 下堆叠在表单之后,桌面下固定在右栏 */}
        <aside className="mt-6 lg:sticky lg:top-20 lg:mt-0">
          <div className="rounded-xl border border-[#E5E3DF] bg-white p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium text-[#1A1A1A]">TA 眼中的自己</h2>
              <span
                className={`text-xs tabular-nums ${overBudget ? "text-amber-600" : "text-[#A4A097]"}`}
              >
                {preview.length} / {MAX_BODY_CHARS}
              </span>
            </div>
            <pre className="mt-3 max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-[#37352E]">
              {preview}
            </pre>
            <p className="mt-3 text-xs leading-5 text-[#A4A097]">
              以上是人格部分。语音播报约束与 AI 身份披露等安全规则会在下发时自动追加在后,
              且不可被覆盖。
            </p>
          </div>
        </aside>
      </div>

      {error !== null ? (
        <p role="alert" className="mt-4 rounded-lg border border-[#E03131]/30 bg-[#E03131]/5 px-3 py-2 text-sm text-[#C22525]">
          {error}
        </p>
      ) : null}

      {/* 底部固定操作区,避让刘海屏安全区 */}
      <div className="sticky bottom-0 mt-8 -mx-5 border-t border-[#E5E3DF] bg-[#F6F5F4]/95 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:px-0 lg:pb-0 lg:backdrop-blur-none">
        <div className="flex flex-col gap-2 sm:flex-row">
          {effectiveReadOnly ? (
            <button
              type="button"
              onClick={() => void duplicate()}
              disabled={personaId === null || busy}
              className="flex h-12 flex-1 items-center justify-center rounded-xl bg-[#5645D4] px-6 text-sm font-medium text-white transition-colors hover:bg-[#4536A8] disabled:opacity-50"
            >
              另存为我的副本
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="flex h-12 flex-1 items-center justify-center rounded-xl bg-[#5645D4] px-6 text-sm font-medium text-white transition-colors hover:bg-[#4536A8] disabled:opacity-50"
            >
              {busy ? "保存中…" : saved ? "已保存" : "保存"}
            </button>
          )}

          {effectiveCanDelete ? confirmDelete ? (
            <>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                className="flex h-12 items-center justify-center rounded-xl border border-[#E03131]/40 px-6 text-sm font-medium text-[#C22525] transition-colors hover:bg-[#E03131]/5"
              >
                确认删除
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="flex h-12 items-center justify-center rounded-xl border border-[#E5E3DF] px-6 text-sm text-[#5D5B54] transition-colors hover:bg-[#F6F5F4]"
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="flex h-12 items-center justify-center rounded-xl border border-[#E5E3DF] px-6 text-sm text-[#5D5B54] transition-colors hover:bg-[#F6F5F4]"
            >
              删除
            </button>
          )
          : null}
        </div>
        {effectiveReadOnly ? (
          <p className="mt-2 text-center text-xs text-[#A4A097]">
            {activeCompanion
              ? "陪伴人格在孵化时定格,这里只支持另存副本后调教。"
              : "预设人格不可修改。另存为副本后即可自由调整。"}
          </p>
        ) : null}
      </div>
    </>
  );
}