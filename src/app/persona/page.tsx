/**
 * 人格列表页 `/persona`(step2 T3)。
 *
 * 路由而非抽屉二级页 —— 用户决策项 2 的选定方案:内容量大(6 滑块 + 2 textarea +
 * 预览),挤在窄屏抽屉里体验很差。ui spec §2 也允许"内容量大的页面升级为独立路由",
 * H5 与桌面共用路由,仅靠响应式断点区分布局。
 */

import Link from "next/link";
import { PersonaList } from "@/components/persona/persona-list";
import { isDatabaseConfigured } from "@/lib/db/client";
import { listPersonas } from "@/lib/persona/repository";
import { PersonaPageHeader } from "@/components/persona/persona-page-header";

// 人格可被 Server Action 修改,列表不能被静态化
export const dynamic = "force-dynamic";

export default async function PersonaPage() {
  const persistence = isDatabaseConfigured();
  const all = await listPersonas();
  const presets = all.filter((persona) => persona.isPreset);
  const customs = all.filter((persona) => !persona.isPreset);

  return (
    <div className="text-foreground mx-auto w-full max-w-xl px-5 py-8 sm:py-12 md:max-w-2xl">
      <PersonaPageHeader title="人格" backHref="/">
        {persistence ? (
          <Link
            href="/persona/new"
            className="flex h-11 items-center rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-colors hover:opacity-90"
          >
            新建人格
          </Link>
        ) : null}
      </PersonaPageHeader>

      <p className="mt-4 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        人格决定 TA 是谁、怎么说话。切换人格会开启一场新会话 ——
        通话中的人格与音色无法中途修改。
      </p>

      {!persistence ? (
        <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-400">
          未配置 DATABASE_URL,人格库不可用:只能使用下面的预设,无法新建或复制。
          在 .env.local 中补上即可(参考 .env.example)。
        </p>
      ) : null}

      <div className="mt-8">
        <PersonaList presets={presets} customs={customs} />
      </div>
    </div>
  );
}
