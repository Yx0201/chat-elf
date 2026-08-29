"use client";

/**
 * 「开始新会话」按钮。
 *
 * 为什么必须是客户端组件:人格与音色当前只存在 localStorage(settings 表的
 * persona / voice 列需要它们,否则历史列表显示不出人格名),而 Server Component
 * 读不到浏览器存储。所以这里读出设置、放进隐藏字段,由 Server Action 一起带走。
 *
 * 取值走 `usePersonaSettings()`(内部是 `useSyncExternalStore`):SSR/hydration 阶段
 * 用默认值的稳定引用,水合后自动切到 localStorage 的真实值 —— 不会触发 hydration 报错。
 */

import { startConversationAction } from "@/lib/memory/actions";
import { usePersonaSettings } from "@/lib/persona/use-settings";

export function NewConversationButton() {
  const { settings } = usePersonaSettings();

  return (
    <form action={startConversationAction} className="mt-7">
      <input type="hidden" name="persona" value={settings.personaId} />
      <input type="hidden" name="voice" value={settings.voice} />
      <button
        type="submit"
        className="flex h-12 w-full items-center justify-center rounded-full bg-foreground px-8 text-base font-medium text-background transition-colors hover:opacity-90 sm:w-auto"
      >
        开始新会话
      </button>
    </form>
  );
}
