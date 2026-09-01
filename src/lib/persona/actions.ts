"use server";

/**
 * 人格的 Server Actions(step2 T3)。
 *
 * 入参一律视为不可信输入:名字与文本在 repository 层裁剪,traits 走 zod 解析,
 * id 走 UUID 校验 —— 预设人格(archetype 形式)只读,任何写操作都会被引擎挡回。
 */

import { revalidatePath } from "next/cache";
import { requireActionUserId } from "@/lib/auth/session";
import {
  createPersona,
  deletePersona,
  getPersona,
  isValidPersonaId,
  updatePersona,
  type PersonaDraft,
} from "./repository";

function revalidatePersona(): void {
  revalidatePath("/persona");
}

export interface SavePersonaInput {
  /** 省略则新建 */
  id?: string;
  draft: PersonaDraft;
}

/**
 * 新建或更新人格,返回其 id;失败返回 null。
 *
 * 只允许改自建人格:预设的 id 不是 uuid,`updatePersona` 会直接拒绝 ——
 * 想改预设必须"另存为副本"(用户决策项 3 的选定方案)。
 */
export async function savePersonaAction(input: SavePersonaInput): Promise<string | null> {
  const userId = await requireActionUserId();
  if (userId === null) return null;

  if (input.id === undefined) {
    const id = await createPersona(userId, input.draft);
    if (id !== null) revalidatePersona();
    return id;
  }
  if (!isValidPersonaId(input.id)) return null;

  const ok = await updatePersona(userId, input.id, input.draft);
  if (ok) revalidatePersona();
  return ok ? input.id : null;
}

/**
 * 复制一份人格(预设"另存为我的副本" / 自建人格"复制一份")。
 *
 * 副本的 archetype 置空、is_preset 置 false —— 它必须可编辑,
 * 且与"改坏了还有原版可对照"这个目的保持一致。
 */
export async function duplicatePersonaAction(id: string): Promise<string | null> {
  const userId = await requireActionUserId();
  if (userId === null) return null;

  const source = await getPersona(userId, id);
  if (source === null) return null;

  const newId = await createPersona(userId, {
    name: `${source.name} 的副本`,
    emoji: source.emoji,
    tagline: source.tagline,
    traits: source.traits,
    voice: source.voice,
    backstory: source.backstory,
    boundaries: source.boundaries,
  });
  if (newId !== null) revalidatePersona();
  return newId;
}

export async function deletePersonaAction(id: string): Promise<boolean> {
  const userId = await requireActionUserId();
  if (userId === null || !isValidPersonaId(id)) return false;
  const ok = await deletePersona(userId, id);
  if (ok) revalidatePersona();
  return ok;
}
