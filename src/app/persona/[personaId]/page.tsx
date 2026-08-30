/**
 * 人格编辑页 `/persona/[personaId]`(step2 T3)。
 *
 * 预设人格进入时只读(顶部只提供「另存为我的副本」),自建人格可编辑可删除。
 */

import { notFound } from "next/navigation";
import { PersonaEditor } from "@/components/persona/persona-editor";
import { PersonaPageHeader } from "@/components/persona/persona-page-header";
import { isDatabaseConfigured } from "@/lib/db/client";
import { getPersona } from "@/lib/persona/repository";

export const dynamic = "force-dynamic";

export default async function PersonaEditPage({ params }: PageProps<"/persona/[personaId]">) {
  const { personaId } = await params;
  const persona = await getPersona(personaId);
  if (persona === null) notFound();

  const persistence = isDatabaseConfigured();

  return (
    <div className="text-foreground mx-auto w-full max-w-xl px-5 py-8 sm:py-12 md:max-w-4xl">
      <PersonaPageHeader title={persona.name} backHref="/persona" />

      <div className="mt-6">
        <PersonaEditor
          personaId={persona.id}
          initial={persona}
          // 无数据库时预设仍可浏览(走常量降级),但不能改也不能复制
          readOnly={persona.isPreset || !persistence}
          canDelete={!persona.isPreset && persistence}
        />
      </div>
    </div>
  );
}
