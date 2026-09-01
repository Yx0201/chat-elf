"use server";

/**
 * 记忆层 Server Actions —— 客户端与数据库的唯一通道。
 *
 * 分工原则(ARCHITECTURE.md):能用 Server Action 的就不建 REST 路由。
 * 全部入参视为**不可信输入**:会话 id 一律先过 UUID 校验。
 *
 * `after()`(next/server)用于把记忆抽取排到响应之后执行 ——
 * 抽取要调两次大模型(抽取 + 向量化),不能阻塞转写落库的返回。
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { requireActionUserId } from "@/lib/auth/session";
import { getCompanion } from "@/lib/companion/repository";
import {
  appendMessages,
  createConversation,
  deleteConversation,
  discardIfEmpty,
  isValidConversationId,
  type MessageInput,
} from "./conversations";
import { rateMessage } from "./feedback";
import { noteConversationFinished, refreshProfile } from "./profile";
import { deleteMemory, isValidMemoryId } from "./store";
import { extractMemories, upsertMemory } from "./tasks";

/** 每积累这么多条消息触发一次会话中抽取;会话结束时再抽一次兜底。 */
const EXTRACTION_EVERY_N_MESSAGES = 8;

/**
 * 新建会话并跳转。
 *
 * persona / voice 快照**服务端自取 companion**(用户体系 step1:客户端传的
 * 人格不可信,且孵化定格后真源只有 companion)。未登录(会话过期)回登录页。
 *
 * 2026-08-31 UI 大一统后落点唯一:/chat/<id>(拟态球对话页)。
 */
export async function startConversationAction(): Promise<void> {
  const userId = await requireActionUserId();
  if (userId === null) redirect("/");

  const companion = await getCompanion(userId);
  if (companion === null) redirect("/hatch");

  const id = await createConversation(userId, {
    personaId: companion.personaId,
    persona: companion.personaName,
    voice: companion.voice,
  });
  redirect(`/chat/${id}`);
}

/**
 * 切换人格 / 音色 —— 新建一条会话记录并返回其 id。
 *
 * 为什么不是原地改 persona 列:spec 的硬约束是「切换人格 = 开新会话」,
 * 一个 conversation 里混着两种人格的转写没有意义。
 * 返回 id 而不是在服务端 redirect,是为了让客户端用 router.push 显式导航 ——
 * 语义更可控,也不依赖 redirect 穿透 Server Action 的行为。
 *
 * 顺带清理:来源会话若还没有任何转写就删掉,避免列表堆积空的"未命名会话"。
 * 已有内容的会话一律保留。
 *
 * 客户端传入的 personaId/voice 仅供会话快照;鉴权后数据归属一律取
 * 服务端会话的 userId。
 *
 * @returns 新会话 id;未登录时返回 null
 */
export async function switchConversationAction(input: {
  personaId: string;
  voice: string;
  fromConversationId: string | null;
}): Promise<string | null> {
  const userId = await requireActionUserId();
  if (userId === null) return null;

  if (input.fromConversationId !== null) {
    await discardIfEmpty(userId, input.fromConversationId);
  }

  const id = await createConversation(userId, {
    personaId: input.personaId,
    persona: input.personaId,
    voice: input.voice,
  });
  revalidatePath("/history");
  return id;
}

export interface AppendMessagesResult {
  /** 落库是否成功;false 表示持久化不可用(页面据此提示用户) */
  ok: boolean;
  /**
   * 本次落库得到的 message id,顺序与入参 entries 一致(已过滤空内容)。
   * 客户端用它把字幕条目对应到库里的行,才能给某条回复打 👍/👎(step2 T4)。
   */
  ids: string[];
}

/** 转写落库。 */
export async function appendMessagesAction(
  conversationId: string,
  entries: readonly MessageInput[],
): Promise<AppendMessagesResult> {
  const userId = await requireActionUserId();
  if (userId === null || !isValidConversationId(conversationId)) {
    return { ok: false, ids: [] };
  }
  if (entries.length === 0) return { ok: true, ids: [] };

  let inserted = 0;
  let total = 0;
  let ids: string[] = [];
  try {
    const result = await appendMessages(userId, conversationId, entries);
    inserted = result.inserted;
    total = result.total;
    ids = result.ids;
  } catch (error) {
    console.error("[memory] 转写落库失败:", error instanceof Error ? error.message : error);
    return { ok: false, ids: [] };
  }

  // 跨过 N 的整数倍就抽一次(用区间跨越判断,避免一次插入多条时错过触发点)
  if (inserted > 0) {
    const before = Math.floor((total - inserted) / EXTRACTION_EVERY_N_MESSAGES);
    const afterCount = Math.floor(total / EXTRACTION_EVERY_N_MESSAGES);
    if (afterCount > before) after(() => extractMemories(userId, conversationId));
  }

  return { ok: true, ids };
}

/**
 * 给一条回复打 👍/👎,返回**生效后**的分数(null = 已撤销)。
 *
 * 幂等:打同一个分是撤销,打不同的分是改判。只埋点,不做任何自动调优。
 */
export async function submitFeedbackAction(
  messageId: string,
  score: 1 | -1,
): Promise<1 | -1 | null> {
  const userId = await requireActionUserId();
  if (userId === null) return null;
  try {
    return await rateMessage(userId, messageId, score);
  } catch (error) {
    console.error("[feedback] 反馈写入失败:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** 会话结束:兜底触发一次记忆抽取。 */
export async function finishConversationAction(conversationId: string): Promise<void> {
  const userId = await requireActionUserId();
  if (userId === null || !isValidConversationId(conversationId)) return;
  // 会话收尾:兜底抽一次记忆,再累加"已结束会话数"以触发画像整合(step3 T4)。
  // **顺序有意义** —— 先抽记忆再整画像,否则刚聊完的事要等下一轮才进画像。
  // 两者都是纯后台任务,排在响应之后,不阻塞返回。
  after(async () => {
    await extractMemories(userId, conversationId);
    await noteConversationFinished(userId);
  });
}

export async function deleteConversationAction(conversationId: string): Promise<void> {
  const userId = await requireActionUserId();
  if (userId === null || !isValidConversationId(conversationId)) return;
  await deleteConversation(userId, conversationId);
  revalidatePath("/history");
}

/**
 * 删除一条记忆(step3 T5)。物理删除而非 archived ——
 * 用户主动删除的语义是"彻底忘掉",不是"暂时不检索"。
 */
export async function deleteMemoryAction(memoryId: string): Promise<boolean> {
  const userId = await requireActionUserId();
  if (userId === null || !isValidMemoryId(memoryId)) return false;
  const ok = await deleteMemory(userId, memoryId);
  if (ok) revalidatePath("/memory");
  return ok;
}

/**
 * 会话中实时标记轨(step3 T2):模型听到值得记的事实时调用。
 *
 * 与批量轨共用 `upsertMemory`,去重规则一致 —— 否则同一件事会被记两遍。
 * 失败只记日志:模型那边已经收到"记下了"的回执,这里抛错也于事无补。
 */
export async function rememberFactAction(input: {
  content: string;
  category: string;
  importance: number;
  conversationId: string | null;
}): Promise<boolean> {
  const userId = await requireActionUserId();
  if (userId === null) return false;
  const conversationId =
    input.conversationId !== null && isValidConversationId(input.conversationId)
      ? input.conversationId
      : null;

  try {
    const added = await upsertMemory(
      userId,
      {
        content: input.content,
        category: input.category,
        importance: input.importance,
        // 情绪浓度未知:实时工具只让模型给 content/category/importance,
        // 不让它猜情绪 —— 猜出来的值会直接进入检索打分,不如给 0 中性。
        emotionScore: 0,
      },
      conversationId,
      "realtime",
    );
    if (added) revalidatePath("/memory");
    return added;
  } catch (error) {
    console.error("[memory] 实时记忆写入失败:", error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * 立即重新整理画像(step3 T4),不等会话计数到达阈值。
 *
 * 用户点了就是想马上看到效果,所以**同步等待**结果 —— 与自动触发的
 * `noteConversationFinished`(走 after(),不阻塞)刻意不同。
 */
export async function refreshProfileAction(): Promise<boolean> {
  const userId = await requireActionUserId();
  if (userId === null) return false;
  const summary = await refreshProfile(userId);
  if (summary !== null) revalidatePath("/memory");
  return summary !== null;
}
