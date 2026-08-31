"use client";

/**
 * 历史列表客户端主体(拟态球 comet/orbit 交互 + 真实会话数据 + 删除)。
 *
 * 会话列表由服务端直取注入;本组件只做:彗尾跟手、点进对话的 orbit 转场、
 * 新开一场(带上 localStorage 的人格/音色)、删除会话(两次确认,物理删除)。
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BallAnchor, useBall } from "@/components/mimic/ball/ball-context";
import { deleteConversationAction, startConversationAction } from "@/lib/memory/actions";
import { usePersonaSettings } from "@/lib/persona/use-settings";

export interface HistorySession {
  id: string;
  title: string;
  createdAt: string;
  messageCount: number;
  personaName: string | null;
}

function formatWhen(iso: string): string {
  const created = new Date(iso);
  const minutes = Math.floor((Date.now() - created.getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return created.toLocaleDateString("zh-CN");
}

export function MimicHistoryList({
  sessions,
  persistence,
}: {
  sessions: readonly HistorySession[];
  persistence: boolean;
}) {
  const router = useRouter();
  const ball = useBall();
  const { settings } = usePersonaSettings();
  const [entering, setEntering] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 滚动 → 彗尾相位(±14° 跟随滚动条位置)
  useEffect(() => {
    let raf = 0;
    const onScroll = (): void => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        const p = window.scrollY / max;
        ball.setTilt(p * 28 - 14);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, [ball]);

  /** 点进一场:球 orbit 转场后路由进 /chat/<id>(spec §3.5) */
  function enterChat(conversationId: string): void {
    if (entering || confirmingId !== null) return;
    setEntering(true);
    ball.setTilt(0);
    ball.flash("orbit", 700);
    setTimeout(() => router.push(`/chat/${conversationId}`), 650);
  }

  async function handleDelete(id: string): Promise<void> {
    setConfirmingId(null);
    setDeletingId(id);
    await deleteConversationAction(id);
    // 删除的是硬约束语义"彻底删掉":球 sleep 一下再回弹,列表刷新
    ball.flash("sleep", 800);
    router.refresh();
    setDeletingId(null);
  }

  return (
    <div className="mimic-page min-h-dvh bg-white">
      {/* 顶栏 */}
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-[#E5E3DF] bg-white/95 px-4 backdrop-blur lg:h-16 lg:px-12">
        <span className="text-base font-semibold text-[#1A1A1A]">Chat Elf · 历史</span>
        <form action={startConversationAction}>
          <input type="hidden" name="persona" value={settings.personaId} />
          <input type="hidden" name="voice" value={settings.voice ?? ""} />
          <button
            type="submit"
            disabled={entering}
            className="h-10 rounded-lg bg-[#5645D4] px-4.5 text-sm font-medium text-white transition-colors hover:bg-[#4536A8] disabled:opacity-70"
          >
            新开一场
          </button>
        </form>
      </header>

      <div className="lg:flex">
        {/* 左舞台:米色 */}
        <section className="flex flex-col items-center justify-center gap-3 bg-[#F8F5E8] px-6 py-10 lg:min-h-[calc(100dvh-64px)] lg:w-[420px] lg:shrink-0 lg:gap-4">
          <BallAnchor state="comet" className="h-40 w-40 lg:h-[200px] lg:w-[200px]" />
          <h1 className="text-xl font-semibold text-[#1A1A1A] lg:text-2xl">穿过旧日子</h1>
          <p className="max-w-[300px] text-center text-[13px] leading-[1.6] text-[#5D5B54] lg:text-sm">
            滚动列表时彗尾跟着走;点进一场对话,球体 orbit 转场回到聆听。删除会连转写一起删掉。
          </p>
        </section>

        {/* 会话列表 */}
        <section className="mx-auto flex w-full max-w-[1000px] flex-col gap-3 px-4 py-6 lg:px-10 lg:py-8">
          <h2 className="px-1 text-xs font-semibold text-[#A4A097]">最近</h2>

          {sessions.length === 0 ? (
            <div className="flex items-center rounded-xl bg-[#F6F5F4] p-5">
              <p className="text-[13px] leading-[1.5] text-[#5D5B54]">
                {persistence
                  ? "还没有会话记录。聊过一次,这里就会留下你们的对话。"
                  : "未配置 DATABASE_URL,会话不会落库也没有历史。"}
              </p>
            </div>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className={`flex items-center gap-2 rounded-xl border border-[#E5E3DF] bg-white pl-4 pr-2 transition-colors hover:border-[#C8C4BE] ${
                  deletingId === s.id ? "opacity-50" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => enterChat(s.id)}
                  className="flex min-h-[64px] min-w-0 flex-1 items-center justify-between gap-3 py-3 text-left"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-sm font-medium text-[#1A1A1A]">
                      {s.title === "" ? "未命名会话" : s.title}
                    </span>
                    <span className="truncate text-xs text-[#A4A097]">
                      {[
                        formatWhen(s.createdAt),
                        `${s.messageCount} 条`,
                        s.personaName,
                      ]
                        .filter((part) => part !== null)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 font-['Inter'] text-lg font-medium text-[#787671]">→</span>
                </button>

                {confirmingId === s.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void handleDelete(s.id)}
                      disabled={deletingId !== null}
                      className="h-11 rounded-lg bg-[#E03131] px-3 text-[13px] font-medium text-white"
                    >
                      确认删除
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      className="h-11 rounded-lg border border-[#E5E3DF] px-3 text-[13px] font-medium text-[#5D5B54]"
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingId(s.id)}
                    aria-label={`删除会话 ${s.title === "" ? "未命名会话" : s.title}`}
                    className="flex h-11 shrink-0 items-center px-2 text-[13px] font-medium text-[#E03131] transition-colors hover:text-[#C22525]"
                  >
                    删除
                  </button>
                )}
              </div>
            ))
          )}

          <p className="px-1 pt-2 text-xs leading-[1.6] text-[#A4A097]">
            历史会话与转写来自 conversations / messages 表;记忆抽取在会话结束与每 8 条消息后自动触发。
          </p>
        </section>
      </div>
    </div>
  );
}