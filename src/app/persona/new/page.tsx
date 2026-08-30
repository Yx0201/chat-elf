/**
 * 新建人格 `/persona/new`(step2 T3)。
 *
 * 静态段优先于 `[personaId]` 动态段,故不需要额外排除 'new' 这个 id。
 */

import { PersonaEditor } from "@/components/persona/persona-editor";
import { PersonaPageHeader } from "@/components/persona/persona-page-header";
import { isDatabaseConfigured } from "@/lib/db/client";

export default function NewPersonaPage() {
  const persistence = isDatabaseConfigured();

  return (
    <div className="text-foreground mx-auto w-full max-w-xl px-5 py-8 sm:py-12 md:max-w-4xl">
      <PersonaPageHeader title="新建人格" backHref="/persona" />

      {!persistence ? (
        <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-400">
          未配置 DATABASE_URL,新建的人格无法保存。在 .env.local 中补上即可(参考 .env.example)。
        </p>
      ) : null}

      <div className="mt-6">
        <PersonaEditor personaId={null} initial={null} readOnly={false} canDelete={false} />
      </div>
    </div>
  );
}
