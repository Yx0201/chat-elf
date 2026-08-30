/**
 * 首页:进入新会话 + 历史会话列表(step1 P4 的「会话列表 + 删除会话」)。
 *
 * Server Component 直取数据库(ui spec §4:历史会话走 Server Component 直取 +
 * Server Action 变更,不建 REST 路由)。
 * `force-dynamic`:列表需要每次请求读到最新数据,不能被静态化。
 */

import Link from "next/link";
import { DeleteConversationButton } from "@/components/chat/delete-conversation-button";
import { NewConversationButton } from "@/components/chat/new-conversation-button";
import { isDatabaseConfigured } from "@/lib/db/client";
import { deleteConversationAction } from "@/lib/memory/actions";
import { listConversations } from "@/lib/memory/conversations";
import { listPersonas } from "@/lib/persona/repository";

export const dynamic = "force-dynamic";

function formatWhen(createdAt: Date): string {
  const minutes = Math.floor((Date.now() - createdAt.getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return createdAt.toLocaleDateString("zh-CN");
}

/** step1 遗留值:本地自定义文案时期存的人格 id。 */
const LEGACY_CUSTOM_ID = "custom";

export default async function Home() {
  const persistence = isDatabaseConfigured();
  // 未配置 DATABASE_URL 时不查库,页面仍可用(对话功能正常,只是不落库)
  const conversations = persistence ? await listConversations() : [];
  // 人格名用于历史列表的副标题;预设在无库时也能查到(repository 会走常量降级)
  const personaNames = new Map(
    (await listPersonas()).map((persona) => [persona.id, persona.name] as const),
  );

  return (
    <div className="text-foreground mx-auto w-full max-w-xl px-5 py-10 sm:py-16 md:max-w-2xl">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">chat-elf</h1>
      <p className="mt-3 text-sm leading-6 text-zinc-600 sm:text-base dark:text-zinc-400">
        AI 实时语音陪伴。选一个人格与音色,开一场新对话;说过的话会被记住,
        下次开场 TA 会接着你们上次的话题。
      </p>

      <NewConversationButton />

      <p className="mt-3 text-sm leading-6">
        <Link href="/persona" className="text-zinc-500 underline underline-offset-4 hover:text-zinc-800 dark:hover:text-zinc-200">
          人格库
        </Link>
        <span className="text-zinc-400"> · 调教 TA 的性格</span>
        <span className="text-zinc-300 dark:text-zinc-700"> ｜ </span>
        <Link href="/memory" className="text-zinc-500 underline underline-offset-4 hover:text-zinc-800 dark:hover:text-zinc-200">
          TA 记得你
        </Link>
        <span className="text-zinc-400"> · 查看与删除记忆</span>
      </p>

      {!persistence ? (
        <p className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-400">
          未配置 DATABASE_URL,会话不会落库也不会有历史记录。
          在 .env.local 中补上即可(参考 .env.example)。
        </p>
      ) : null}

      <section className="mt-10">
        <h2 className="text-xs font-medium tracking-wide text-zinc-400">历史会话</h2>

        {conversations.length === 0 ? (
          // 空态也是陪伴感的一部分(ui spec §3.3:不许裸列)
          <p className="mt-3 rounded-xl border border-dashed border-black/[.08] px-4 py-8 text-center text-sm text-zinc-400 dark:border-white/[.10]">
            {persistence
              ? "还没有会话记录。聊过一次,这里就会留下你们的对话。"
              : "配置数据库后,这里会列出你们的对话记录。"}
          </p>
        ) : (
          <ul className="mt-2 overflow-hidden rounded-xl border border-black/[.06] dark:border-white/[.08]">
            {conversations.map((conversation) => {
              // conversations.persona 存的是当时的 personaId(预设 archetype 或 uuid);
              // 人格若已被删除,名字查不到就直接不显示,不显示为"未选择"
              const personaName =
                conversation.persona === null
                  ? null
                  : (personaNames.get(conversation.persona) ??
                    (conversation.persona === LEGACY_CUSTOM_ID ? "自定义" : null));
              const subtitle = [
                formatWhen(conversation.createdAt),
                `${conversation.messageCount} 条`,
                personaName,
              ]
                .filter((part) => part !== null)
                .join(" · ");

              return (
                <li
                  key={conversation.id}
                  className="flex items-center gap-1 border-b border-black/[.06] px-3 last:border-b-0 dark:border-white/[.08]"
                >
                  <Link
                    href={`/chat/${conversation.id}`}
                    className="flex min-h-[56px] min-w-0 flex-1 flex-col justify-center pr-2"
                  >
                    <span className="truncate text-sm">
                      {conversation.title === "" ? "未命名会话" : conversation.title}
                    </span>
                    <span className="truncate text-xs text-zinc-400">{subtitle}</span>
                  </Link>
                  <DeleteConversationButton
                    action={deleteConversationAction.bind(null, conversation.id)}
                    title={conversation.title === "" ? "未命名会话" : conversation.title}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
