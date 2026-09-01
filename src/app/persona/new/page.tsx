/**
 * 新建人格 `/persona/new`(step2 T3;2026-08-31 拟态球化)。
 *
 * 静态段优先于 `[personaId]` 动态段,故不需要额外排除 'new' 这个 id。
 *
 * 注意:新建只写人格**定义**,不会把陪伴人格换掉 —— 陪伴人格在孵化时定格。
 */

import { PersonaEditor } from "@/components/persona/persona-editor";
import { PersonaPageHeader } from "@/components/persona/persona-page-header";
import { requirePageUserId } from "@/lib/auth/session";
import { getCompanion } from "@/lib/companion/repository";
import { isDatabaseConfigured } from "@/lib/db/client";

export default async function NewPersonaPage() {
  const userId = await requirePageUserId();
  const persistence = isDatabaseConfigured();
  const companionPersonaId = (await getCompanion(userId))?.personaId ?? null;

  return (
    <div className="mimic-page min-h-dvh bg-[#F6F5F4] px-5 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-xl md:max-w-4xl">
        <PersonaPageHeader title="新建人格" backHref="/persona" />

        {!persistence ? (
          <p className="mt-4 rounded-lg border border-[#B7791F]/30 bg-[#B7791F]/5 px-3 py-2 text-xs leading-5 text-[#975A16]">
            未配置 DATABASE_URL,新建的人格无法保存。在 .env.local 中补上即可(参考 .env.example)。
          </p>
        ) : null}

        <div className="mt-6 pb-8">
          <PersonaEditor personaId={null} companionPersonaId={companionPersonaId} initial={null} readOnly={false} canDelete={false} />
        </div>
      </div>
    </div>
  );
}