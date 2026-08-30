"use client";

/**
 * 人格编辑器(step2 T3)。
 *
 * 布局契约遵循 ui-设置中心与交互设计.md §3.2:H5 单列堆叠、桌面双栏(左表单 右预览)、
 * 底部固定 48px 按钮。滑块用原生 `input[type=range]` 而非 shadcn/ui slider ——
 * 沿用 step1 的决策:项目尚无 shadcn 基线,为一个组件引入整套依赖不划算。
 *
 * 两个值得说明的实现选择:
 * 1. **预览不防抖**。ui spec §3.2 写的是"防抖 300ms 后刷新预览",但那条是针对
 *    「预览要发请求」的假设;本项目的预览是 `renderPersonaBody()` 这一**纯函数**
 *    的本地调用,useMemo 即可,加防抖只会让滑块手感变钝。这是有意的偏差。
 * 2. **预览与实际下发同源**。两端都调 `render.ts` 的同一个函数,不靠约定保证一致
 *    —— ui spec 的「所见即所聊」要求。
 */

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { switchConversationAction } from "@/lib/memory/actions";
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
import { usePersonaSettings } from "@/lib/persona/use-settings";
import { REALTIME_VOICES } from "@/lib/persona/voices";
import { TRAIT_DEFINITIONS, type TraitKey } from "@/lib/persona/traits";

export interface PersonaEditorProps {
  /** 已有记录的 id;新建时为 null */
  personaId: string | null;
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
  initial,
  readOnly,
  canDelete,
}: PersonaEditorProps) {
  const { settings, update } = usePersonaSettings();
  const router = useRouter();

  const [draft, setDraft] = useState<PersonaDraft>(() => toDraft(initial, settings.voice));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const preview = useMemo(
    () => renderPersonaBody({ ...draft, traits: draft.traits }),
    [draft],
  );

  function patch(next: Partial<PersonaDraft>): void {
    setDraft((prev) => ({ ...prev, ...next }));
  }

  function patchTrait(key: TraitKey, value: number): void {
    setDraft((prev) => ({ ...prev, traits: { ...prev.traits, [key]: value } }));
  }

  /** 保存 → 写入本地当前选择 → 开新会话并跳过去(人格变更只能在新会话生效)。 */
  async function save(): Promise<void> {
    if (busy) return;
    if (draft.name.trim() === "") {
      setError("给 TA 起个名字吧");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const savedId =
        personaId === null
          ? await savePersonaAction({ draft })
          : await savePersonaAction({ id: personaId, draft });
      if (savedId === null) {
        setError("保存失败,请检查数据库配置后重试");
        return;
      }
      update({ personaId: savedId, voice: draft.voice });
      const newConversationId = await switchConversationAction({
        personaId: savedId,
        voice: draft.voice,
        fromConversationId: null,
      });
      router.push(newConversationId === null ? "/persona" : `/chat/${newConversationId}`);
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
      <div className="lg:grid lg:grid-cols-[minmax(0,30rem)_minmax(0,1fr)] lg:items-start lg:gap-8">
        {/* 左:表单 */}
        <div className="space-y-6">
          <div className="flex items-start gap-3">
            <input
              value={draft.emoji}
              onChange={(e) => patch({ emoji: e.target.value })}
              disabled={readOnly || busy}
              maxLength={4}
              aria-label="头像"
              className="h-14 w-14 shrink-0 rounded-full border border-black/[.10] bg-transparent text-center text-2xl outline-none focus:border-indigo-400 disabled:opacity-60 dark:border-white/[.12]"
            />
            <div className="min-w-0 flex-1">
              <label htmlFor="persona-name" className="block text-sm font-medium">
                名字
              </label>
              <input
                id="persona-name"
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                disabled={readOnly || busy}
                maxLength={MAX_NAME_LENGTH}
                placeholder="例如:小柚"
                className="mt-1 h-11 w-full rounded-xl border border-black/[.10] bg-transparent px-3 text-sm outline-none placeholder:text-zinc-400 focus:border-indigo-400 disabled:opacity-60 dark:border-white/[.12]"
              />
            </div>
          </div>

          <div>
            <label htmlFor="persona-tagline" className="block text-sm font-medium">
              一句话人设
            </label>
            <input
              id="persona-tagline"
              value={draft.tagline}
              onChange={(e) => patch({ tagline: e.target.value })}
              disabled={readOnly || busy}
              maxLength={60}
              placeholder="列表里显示在名字下面,例如:温和松弛的老朋友"
              className="mt-1 h-11 w-full rounded-xl border border-black/[.10] bg-transparent px-3 text-sm outline-none placeholder:text-zinc-400 focus:border-indigo-400 disabled:opacity-60 dark:border-white/[.12]"
            />
          </div>

          <section>
            <h2 className="text-sm font-medium">性格</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              拖动滑块调节 TA 的说话方式。这些描述会被写进 TA 的指令里,
              右边的预览就是 TA 实际收到的内容。
            </p>
            <div className="mt-3 space-y-4">
              {TRAIT_DEFINITIONS.map((definition) => (
                <div key={definition.key}>
                  <div className="flex items-baseline justify-between text-sm">
                    <label htmlFor={`trait-${definition.key}`}>{definition.label}</label>
                    <span className="text-xs tabular-nums text-zinc-400">
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
                    disabled={readOnly || busy}
                    // h-11 保证移动端触区 44px;accent-* 给滑块着色
                    className="mt-1 h-11 w-full accent-indigo-500 disabled:opacity-60"
                  />
                  <div className="flex justify-between text-[11px] text-zinc-400">
                    <span>{definition.lowLabel}</span>
                    <span>{definition.highLabel}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div>
            <label htmlFor="persona-backstory" className="block text-sm font-medium">
              背景故事 / 人设
            </label>
            <textarea
              id="persona-backstory"
              value={draft.backstory}
              onChange={(e) => patch({ backstory: e.target.value })}
              disabled={readOnly || busy}
              maxLength={MAX_TEXTAREA_LENGTH}
              placeholder={
                "用一段话描述 TA 是谁、什么性格、怎么说话。留空则完全由上面的滑块决定人格。"
              }
              className="mt-1 min-h-[160px] w-full resize-y rounded-xl border border-black/[.10] bg-transparent p-3 text-sm leading-6 outline-none placeholder:text-zinc-400 focus:border-indigo-400 disabled:opacity-60 dark:border-white/[.12]"
            />
          </div>

          <div>
            <label htmlFor="persona-boundaries" className="block text-sm font-medium">
              行为边界
            </label>
            <textarea
              id="persona-boundaries"
              value={draft.boundaries}
              onChange={(e) => patch({ boundaries: e.target.value })}
              disabled={readOnly || busy}
              maxLength={MAX_TEXTAREA_LENGTH}
              placeholder={"TA 绝不做什么。例如:绝不使用说教的语气,绝不评价用户的家人。"}
              className="mt-1 min-h-[88px] w-full resize-y rounded-xl border border-black/[.10] bg-transparent p-3 text-sm leading-6 outline-none placeholder:text-zinc-400 focus:border-indigo-400 disabled:opacity-60 dark:border-white/[.12]"
            />
          </div>

          <div>
            <label htmlFor="persona-voice" className="block text-sm font-medium">
              音色
            </label>
            <select
              id="persona-voice"
              value={draft.voice}
              onChange={(e) => patch({ voice: e.target.value })}
              disabled={readOnly || busy}
              className="mt-1 h-11 w-full rounded-xl border border-black/[.10] bg-transparent px-3 text-sm outline-none focus:border-indigo-400 disabled:opacity-60 dark:border-white/[.12]"
            >
              {REALTIME_VOICES.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.id}
                  {voice.note === "" ? "" : ` · ${voice.note}`}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              音色共有 5 个系统音色可选,特质描述来自同名 TTS 音色的公开资料,
              实时模型的实际听感可能不同。
            </p>
          </div>
        </div>

        {/* 右:预览。H5 下堆叠在表单之后,桌面下固定在右栏 */}
        <aside className="mt-6 lg:sticky lg:top-20 lg:mt-0">
          <div className="rounded-xl border border-black/[.06] bg-black/[.02] p-4 dark:border-white/[.08] dark:bg-white/[.03]">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium">TA 眼中的自己</h2>
              <span
                className={`text-xs tabular-nums ${overBudget ? "text-amber-600" : "text-zinc-400"}`}
              >
                {preview.length} / {MAX_BODY_CHARS}
              </span>
            </div>
            <pre className="mt-3 max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-zinc-600 dark:text-zinc-300">
              {preview}
            </pre>
            <p className="mt-3 text-xs leading-5 text-zinc-400">
              以上是人格部分。语音播报约束与 AI 身份披露等安全规则会在下发时自动追加在后,
              且不可被覆盖。
            </p>
          </div>
        </aside>
      </div>

      {error !== null ? (
        <p role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {/* 底部固定操作区,避让刘海屏安全区 */}
      <div className="sticky bottom-0 mt-8 -mx-5 border-t border-black/[.06] bg-background/95 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:px-0 lg:pb-0 lg:backdrop-blur-none dark:border-white/[.08]">
        <div className="flex flex-col gap-2 sm:flex-row">
          {readOnly ? (
            <button
              type="button"
              onClick={() => void duplicate()}
              disabled={personaId === null || busy}
              className="flex h-12 flex-1 items-center justify-center rounded-xl bg-foreground px-6 text-sm font-medium text-background transition-colors hover:opacity-90 disabled:opacity-50"
            >
              另存为我的副本
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="flex h-12 flex-1 items-center justify-center rounded-xl bg-foreground px-6 text-sm font-medium text-background transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "保存中…" : "保存并开启新会话"}
            </button>
          )}

          {canDelete ? confirmDelete ? (
            <>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                className="flex h-12 items-center justify-center rounded-xl border border-red-500/40 px-6 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
              >
                确认删除
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="flex h-12 items-center justify-center rounded-xl border border-black/[.10] px-6 text-sm transition-colors hover:bg-black/[.04] dark:border-white/[.12]"
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="flex h-12 items-center justify-center rounded-xl border border-black/[.10] px-6 text-sm transition-colors hover:bg-black/[.04] dark:border-white/[.12]"
            >
              删除
            </button>
          )
          : null}
        </div>
        {readOnly ? (
          <p className="mt-2 text-center text-xs text-zinc-400">
            预设人格不可修改。另存为副本后即可自由调整。
          </p>
        ) : null}
      </div>
    </>
  );
}
