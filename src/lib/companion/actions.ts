"use server";

/**
 * 孵化完成(用户体系 step1 T4):一次性定格入库 + 开新会话。
 *
 * 客户端在 confirmHatch 里先(若有人格改动)保存快照人格拿到 uuid,
 * 再调本 action:服务端建 companion 记录并开新会话。
 * personaId/voice 一律以服务端写入的 companion 为准 —— 客户端传参只用于
 * 定格时的快照记录,不可作为后续会话的信任来源。
 */

import { revalidatePath } from "next/cache";
import { requireActionUserId } from "@/lib/auth/session";
import { createCompanion } from "./repository";
import { createConversation, discardIfEmpty } from "@/lib/memory/conversations";

export async function completeHatchAction(input: {
  personaId: string | null;
  personaName: string;
  voice: string;
  fromConversationId: string | null;
}): Promise<string | null> {
  const userId = await requireActionUserId();
  if (userId === null) return null;

  await createCompanion({
    userId,
    personaId: input.personaId,
    personaName: input.personaName,
    voice: input.voice,
  });

  if (input.fromConversationId !== null) {
    await discardIfEmpty(userId, input.fromConversationId);
  }

  const conversationId = await createConversation(userId, {
    personaId: input.personaId,
    persona: input.personaName,
    voice: input.voice,
  });
  revalidatePath("/history");
  return conversationId;
}
