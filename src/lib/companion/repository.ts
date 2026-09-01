/**
 * 陪伴精灵的服务端数据访问(用户体系 step1 T4)。
 *
 * 语义:用户 1:1,孵化一次性定格。personaId 指向孵化时的人格(预设 archetype
 * 无法写外键,此时只有 personaName 快照);personaName / voice 永远可读 ——
 * 人格被删后精灵的名字与音色不受影响。
 */

import { eq } from "drizzle-orm";
import { getDb, isDatabaseConfigured } from "@/lib/db/client";
import { companions } from "@/lib/db/schema";
import { isValidPersonaId } from "@/lib/persona/types";

/** 页面与 action 需要的精灵信息。 */
export interface CompanionRecord {
  /** 定格的人格 id(预设 archetype / 自建 uuid);人格删除后为 null */
  personaId: string | null;
  /** 定格时的人格名快照 */
  personaName: string | null;
  voice: string;
  hatchedAt: Date;
}

/**
 * 取该用户的精灵;未孵化返回 null。
 * 调用方以此判定登录落点(/hatch 还是 /chat)与"已孵化回对话"守卫。
 */
export async function getCompanion(userId: string): Promise<CompanionRecord | null> {
  if (!isDatabaseConfigured()) return null;
  try {
    const [row] = await getDb()
      .select({
        personaId: companions.personaId,
        personaName: companions.personaName,
        voice: companions.voice,
        hatchedAt: companions.hatchedAt,
      })
      .from(companions)
      .where(eq(companions.userId, userId))
      .limit(1);
    return row ?? null;
  } catch (error) {
    console.error("[companion] 读取精灵失败:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * 完成孵化:写入一次性定格记录。已存在时**不覆盖**(一次性语义)。
 *
 * personaId 写外键的前提是它是自建人格的 uuid;预设 archetype 不是 uuid,
 * 只落 personaName 快照 —— 解析人格时两者都走 resolvePersona 的回落链,
 * 不需要区分来源。
 */
export async function createCompanion(input: {
  userId: string;
  personaId: string | null;
  personaName: string;
  voice: string;
}): Promise<CompanionRecord | null> {
  if (!isDatabaseConfigured()) return null;
  const personaId =
    input.personaId !== null && isValidPersonaId(input.personaId) ? input.personaId : null;

  const [row] = await getDb()
    .insert(companions)
    .values({
      userId: input.userId,
      personaId,
      personaName: input.personaName,
      voice: input.voice,
    })
    // user_id UNIQUE:重复确认(理论上不会发生)保持首次定格不变
    .onConflictDoNothing({ target: companions.userId })
    .returning({
      personaId: companions.personaId,
      personaName: companions.personaName,
      voice: companions.voice,
      hatchedAt: companions.hatchedAt,
    });

  if (row !== undefined) return row;
  // 冲突(已有精灵):读回既有记录,保证调用方拿到一致的值
  return getCompanion(input.userId);
}
