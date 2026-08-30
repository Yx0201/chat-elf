/**
 * 记忆可视化页 `/memory`(step3 T5「TA 记得你」)。
 *
 * 存在的理由不只是"透明":Replika memory editor 模式把它当作**合规基础能力** ——
 * 用户看得见 AI 记住了什么、能删掉,才谈得上对个人信息有控制权。
 * 因此这一页也让画像(更凝练、信息密度更高)一并可见。
 */

import { MemoryList } from "@/components/memory/memory-list";
import { PersonaPageHeader } from "@/components/persona/persona-page-header";
import { isDatabaseConfigured } from "@/lib/db/client";
import { getProfile } from "@/lib/memory/profile";
import { listMemories } from "@/lib/memory/store";

// 记忆会被删除、画像会被重写,不能静态化
export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const persistence = isDatabaseConfigured();
  const [memories, profile] = persistence
    ? await Promise.all([listMemories(), getProfile()])
    : [null, null];

  return (
    <div className="text-foreground mx-auto w-full max-w-xl px-5 py-8 sm:py-12 md:max-w-2xl">
      <PersonaPageHeader title="TA 记得你" backHref="/" />

      <p className="mt-4 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        下面是 TA 从你们的对话里记住的事。删掉一条,TA 就会真的忘掉它。
      </p>

      {!persistence ? (
        <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-400">
          未配置 DATABASE_URL,记忆功能不可用。在 .env.local 中补上即可(参考 .env.example)。
        </p>
      ) : null}

      <div className="mt-8 pb-8">
        {memories === null ? null : (
          <MemoryList
            memories={memories}
            profileSummary={profile?.summary ?? ""}
            profileTraits={profile?.traits ?? {}}
            profileRefreshedAt={profile?.refreshedAt?.toISOString() ?? null}
          />
        )}
      </div>
    </div>
  );
}
