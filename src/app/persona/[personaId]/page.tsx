/**
 * 人格编辑页 `/persona/[personaId]`(step2 T3;2026-08-31 拟态球化)。
 *
 * 预设人格进入时只读(顶部只提供「另存为我的副本」);自建人格可编辑可删除;
 * **陪伴中的人格(孵化时定格)只读不删**(见 PersonaEditor 的锁定逻辑)。
 */

import { notFound } from "next/navigation";
import { PersonaEditor } from "@/components/persona/persona-editor";
import { PersonaPageHeader } from "@/components/persona/persona-page-header";
import { requirePageUserId } from "@/lib/auth/session";
import { getCompanion } from "@/lib/companion/repository";
import { isDatabaseConfigured } from "@/lib/db/client";
import { getPersona } from "@/lib/persona/repository";

export const dynamic = "force-dynamic";

export default async function PersonaEditPage({ params }: PageProps<"/persona/[personaId]">) {
  const userId = await requirePageUserId();
  const { personaId } = await params;
  const persona = await getPersona(userId, personaId);
  if (persona === null) notFound();
  const companionPersonaId = (await getCompanion(userId))?.personaId ?? null;

  const persistence = isDatabaseConfigured();

  return (
    <div className="mimic-page min-h-dvh bg-[#F6F5F4] px-5 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-xl md:max-w-4xl">
        <PersonaPageHeader title={persona.name} backHref="/persona" />

        <div className="mt-6 pb-8">
          <PersonaEditor
            personaId={persona.id}
            companionPersonaId={companionPersonaId}
            initial={persona}
            // 无数据库时预设仍可浏览(走常量降级),但不能改也不能复制
            readOnly={persona.isPreset || !persistence}
            canDelete={!persona.isPreset && persistence}
          />
        </div>
      </div>
    </div>
  );
}