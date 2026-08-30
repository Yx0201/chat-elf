"use client";

/**
 * 人格列表(step2 T3)。
 *
 * 为什么是客户端组件:「当前正在使用哪个人格」存在 localStorage,
 * Server Component 读不到 —— 与 step1 的 NewConversationButton 同一个理由。
 *
 * 布局沿用 ui spec §3.1 的列表行规范:行高 ≥56px、整行可点、右侧 chevron。
 */

import Link from "next/link";
import type { PersonaRecord } from "@/lib/persona/types";
import { usePersonaSettings } from "@/lib/persona/use-settings";

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PersonaRow({ persona, current }: { persona: PersonaRecord; current: boolean }) {
  return (
    <Link
      href={`/persona/${persona.id}`}
      className="flex min-h-[56px] items-center gap-3 border-b border-black/[.06] px-4 transition-colors last:border-b-0 hover:bg-black/[.04] dark:border-white/[.08] dark:hover:bg-white/[.06]"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/[.04] text-xl dark:bg-white/[.08]">
        {persona.emoji === "" ? "🙂" : persona.emoji}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{persona.name}</span>
          {current ? (
            <span className="shrink-0 rounded-full bg-indigo-500/10 px-2 py-0.5 text-[11px] text-indigo-600 dark:text-indigo-400">
              使用中
            </span>
          ) : null}
        </span>
        <span className="block truncate text-xs text-zinc-400">
          {persona.tagline === "" ? `音色 ${persona.voice}` : persona.tagline}
        </span>
      </span>
      <span className="shrink-0 text-zinc-300 dark:text-zinc-600">
        <ChevronIcon />
      </span>
    </Link>
  );
}

export function PersonaList({
  presets,
  customs,
}: {
  presets: readonly PersonaRecord[];
  customs: readonly PersonaRecord[];
}) {
  const { settings } = usePersonaSettings();

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-xs font-medium tracking-wide text-zinc-400">
          预设人格 · 只读,可另存副本后修改
        </h2>
        <ul className="mt-2 overflow-hidden rounded-xl border border-black/[.06] dark:border-white/[.08]">
          {presets.map((persona) => (
            <li key={persona.id}>
              <PersonaRow persona={persona} current={settings.personaId === persona.id} />
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-xs font-medium tracking-wide text-zinc-400">我的人格</h2>
        {customs.length === 0 ? (
          // ui spec §3.3:空态也是陪伴感的一部分,不许裸列
          <p className="mt-2 rounded-xl border border-dashed border-black/[.08] px-4 py-8 text-center text-sm text-zinc-400 dark:border-white/[.10]">
            还没有自己捏过的人格。从上面的预设另存一份副本,就能随意调教。
          </p>
        ) : (
          <ul className="mt-2 overflow-hidden rounded-xl border border-black/[.06] dark:border-white/[.08]">
            {customs.map((persona) => (
              <li key={persona.id}>
                <PersonaRow persona={persona} current={settings.personaId === persona.id} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
