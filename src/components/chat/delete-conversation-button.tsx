"use client";

/**
 * 删除会话按钮(ui spec §3:所有破坏性操作二次确认)。
 *
 * 二次确认需要浏览器 API,所以这一小块必须是客户端组件;
 * 删除动作本身仍是 Server Action,由父级(Server Component)绑定后传入。
 */

export function DeleteConversationButton({
  action,
  title,
}: {
  action: () => Promise<void>;
  title: string;
}) {
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(`删除「${title}」?该会话的转写会一并删除,此操作不可恢复。`)) {
          event.preventDefault();
        }
      }}
    >
      <button
        type="submit"
        aria-label="删除会话"
        title="删除会话"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-300 transition-colors hover:bg-red-500/10 hover:text-red-500 dark:text-zinc-600"
      >
        <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 7h16M10 11v6M14 11v6" strokeLinecap="round" />
          <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" strokeLinejoin="round" />
          <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" strokeLinejoin="round" />
        </svg>
      </button>
    </form>
  );
}
