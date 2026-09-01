/**
 * 人格列表页 `/persona`(step2 T3;2026-08-31 拟态球化)。
 *
 * 路由而非抽屉二级页 —— 内容量大(编辑器 6 滑块 + 2 textarea + 预览),
 * 挤在窄屏抽屉里体验很差(ui spec §2 允许内容量大的页面升级为独立路由)。
 *
 * 与"换人格"相关的旧语义已移除:陪伴人格在孵化时一次性定格,
 * 本页只管理人格**定义**(预设只读,自建可编辑)。
 */

import Link from "next/link";
import { PersonaList } from "@/components/persona/persona-list";
import { requirePageUserId } from "@/lib/auth/session";
import { getCompanion } from "@/lib/companion/repository";
import { isDatabaseConfigured } from "@/lib/db/client";
import { listPersonas } from "@/lib/persona/repository";
import { PersonaPageHeader } from "@/components/persona/persona-page-header";

// 人格可被 Server Action 修改,列表不能被静态化
export const dynamic = "force-dynamic";

export default async function PersonaPage() {
  const userId = await requirePageUserId();
  const persistence = isDatabaseConfigured();
  const companion = await getCompanion(userId);
  const all = await listPersonas(userId);
  const presets = all.filter((persona) => persona.isPreset);
  const customs = all.filter((persona) => !persona.isPreset);

  return (
    <div className="mimic-page min-h-dvh bg-[#F6F5F4] px-5 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-xl md:max-w-2xl">
        <PersonaPageHeader title="人格库" backHref="/chat">
          {persistence ? (
            <Link
              href="/persona/new"
              className="flex h-11 items-center rounded-lg bg-[#5645D4] px-4 text-sm font-medium text-white transition-colors hover:bg-[#4536A8]"
            >
              新建人格
            </Link>
          ) : null}
        </PersonaPageHeader>

        <p className="mt-4 text-sm leading-6 text-[#5D5B54]">
          人格决定 TA 是谁、怎么说话。你的陪伴人格在孵化时已经定格(标「陪伴中」的那位,
          不可修改);这里可以浏览、另存副本、调教新的定义。
        </p>

        {!persistence ? (
          <p className="mt-4 rounded-lg border border-[#B7791F]/30 bg-[#B7791F]/5 px-3 py-2 text-xs leading-5 text-[#975A16]">
            未配置 DATABASE_URL,人格库不可用:只能使用下面的预设,无法新建或复制。
            在 .env.local 中补上即可(参考 .env.example)。
          </p>
        ) : null}

        <div className="mt-8 pb-8">
          <PersonaList presets={presets} customs={customs} companionPersonaId={companion?.personaId ?? null} />
        </div>
      </div>
    </div>
  );
}