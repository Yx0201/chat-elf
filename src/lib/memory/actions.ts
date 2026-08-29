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
import { isDatabaseConfigured } from "@/lib/db/client";
import {
  appendMessages,
  createConversation,
  deleteConversation,
  discardIfEmpty,
  isValidConversationId,
  type MessageInput,
} from "./conversations";
import { extractMemories } from "./tasks";

/** 每积累这么多条消息触发一次会话中抽取;会话结束时再抽一次兜底。 */
const EXTRACTION_EVERY_N_MESSAGES = 8;

/** FormData 取字符串;空串与缺失一律视为 null(表单值是不可信输入)。 */
function readStringField(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 新建会话并跳转。
 *
 * persona / voice 由客户端表单传入 —— 它们当前只存在 localStorage,服务端读不到,
 * 不传的话历史列表就显示不出人格名(方案 1:首页按钮改为客户端组件读取后提交)。
 *
 * 未配置数据库时退回占位会话(对话仍可用,只是不落库)。
 */
export async function startConversationAction(formData: FormData): Promise<void> {
  const persona = readStringField(formData, "persona");
  const voice = readStringField(formData, "voice");

  if (!isDatabaseConfigured()) redirect("/chat/local-demo");
  const id = await createConversation({ persona, voice });
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
 * @returns 新会话 id;未配置数据库时返回 null(此时设置已存进 localStorage,
 *          客户端留在原地即可 —— 重新开启通话就会带上新人格)
 */
export async function switchConversationAction(input: {
  personaId: string;
  voice: string;
  fromConversationId: string | null;
}): Promise<string | null> {
  if (!isDatabaseConfigured()) return null;

  if (input.fromConversationId !== null) {
    await discardIfEmpty(input.fromConversationId);
  }

  const id = await createConversation({
    persona: input.personaId,
    voice: input.voice,
  });
  revalidatePath("/");
  return id;
}

/** 转写落库。返回 false 表示持久化不可用(页面据此提示用户)。 */
export async function appendMessagesAction(
  conversationId: string,
  entries: readonly MessageInput[],
): Promise<boolean> {
  if (!isDatabaseConfigured() || !isValidConversationId(conversationId)) return false;
  if (entries.length === 0) return true;

  let inserted = 0;
  let total = 0;
  try {
    const result = await appendMessages(conversationId, entries);
    inserted = result.inserted;
    total = result.total;
  } catch (error) {
    console.error("[memory] 转写落库失败:", error instanceof Error ? error.message : error);
    return false;
  }

  // 跨过 N 的整数倍就抽一次(用区间跨越判断,避免一次插入多条时错过触发点)
  if (inserted > 0) {
    const before = Math.floor((total - inserted) / EXTRACTION_EVERY_N_MESSAGES);
    const afterCount = Math.floor(total / EXTRACTION_EVERY_N_MESSAGES);
    if (afterCount > before) after(() => extractMemories(conversationId));
  }

  return true;
}

/** 会话结束:兜底触发一次记忆抽取。 */
export async function finishConversationAction(conversationId: string): Promise<void> {
  if (!isDatabaseConfigured() || !isValidConversationId(conversationId)) return;
  after(() => extractMemories(conversationId));
}

export async function deleteConversationAction(conversationId: string): Promise<void> {
  if (!isDatabaseConfigured() || !isValidConversationId(conversationId)) return;
  await deleteConversation(conversationId);
  revalidatePath("/");
}
