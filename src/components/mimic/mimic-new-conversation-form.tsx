"use client";

/**
 * 「开一场对话」表单(mimic 版,空库首屏用)。
 *
 * 客户端组件:人格/音色在 localStorage,Server Component 读不到,
 * 读出后随隐藏字段提交给 startConversationAction(to=mimic 跳拟态球页)。
 */

import { startConversationAction } from "@/lib/memory/actions";
import { usePersonaSettings } from "@/lib/persona/use-settings";
import { BallAnchor } from "@/components/mimic/ball/ball-context";

export function MimicNewConversationForm() {
  const { settings } = usePersonaSettings();

  return (
    <form action={startConversationAction} className="mimic-page flex min-h-dvh flex-col items-center justify-center gap-6 bg-[#FAFAF9] px-6">
      <input type="hidden" name="persona" value={settings.personaId} />
      <input type="hidden" name="voice" value={settings.voice ?? ""} />
      <input type="hidden" name="to" value="mimic" />
      <BallAnchor state="idle" className="h-[200px] w-[200px] lg:h-[240px] lg:w-[240px]" />
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-xl font-semibold text-[#1A1A1A] lg:text-2xl">还没有说过话</h1>
        <p className="max-w-[360px] text-sm leading-[1.55] text-[#5D5B54]">
          点麦克风开始和 TA 说话。说过的话会被记住,下次开场 TA 会接着上次的话题。
        </p>
      </div>
      <button
        type="submit"
        className="flex h-12 items-center justify-center rounded-full bg-[#5645D4] px-8 text-base font-medium text-white transition-colors hover:bg-[#4536A8]"
      >
        开始对话
      </button>
    </form>
  );
}
