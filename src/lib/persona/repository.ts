/**
 * 人格的服务端数据访问(step2 T1)。
 *
 * ## id 约定(重要)
 * 对外暴露的 `PersonaRecord.id`:
 *   - 预设 → **archetype 字符串**(如 `'xiaoyou'`);
 *   - 用户自建 → **personas 表的 uuid**。
 *
 * 为什么预设不直接用表里的 uuid:预设同时是「未配置 DATABASE_URL 时的降级数据源」
 * (见 `presetRecords()`),它必须有一个**不依赖数据库也存在**的稳定 id ——
 * 否则同一份 localStorage 设置在有库/无库两种环境下的指向会不同。
 *
 * ## 降级
 * 未配置 DATABASE_URL 时全部函数走预设常量,不抛错(ARCHITECTURE 编码约定:
 * 增强能力失败必须降级而非抛错)。此时人格只能读、不能改。
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb, isDatabaseConfigured } from "@/lib/db/client";
import { personas, LOCAL_USER_ID } from "@/lib/db/schema";
import { PERSONA_PRESETS } from "./presets";
import {
  isValidPersonaId,
  MAX_NAME_LENGTH,
  MAX_TEXTAREA_LENGTH,
  type PersonaDraft,
  type PersonaRecord,
} from "./types";
import { NEUTRAL_TRAITS, parseTraits } from "./traits";

// 类型与常量实际定义在 types.ts(可被客户端安全导入),此处转出以保持调用点不变
export { isValidPersonaId, MAX_NAME_LENGTH, MAX_TEXTAREA_LENGTH };
export type { PersonaDraft, PersonaRecord };

/** 预设常量 → PersonaRecord(无数据库时的全部数据源)。 */
function presetRecords(): PersonaRecord[] {
  return PERSONA_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    emoji: preset.emoji,
    tagline: preset.tagline,
    archetype: preset.id,
    traits: { ...preset.traits },
    voice: preset.voice,
    backstory: preset.instructions,
    boundaries: "",
    isPreset: true,
  }));
}

function toRecord(row: typeof personas.$inferSelect): PersonaRecord {
  return {
    // 预设以 archetype 作为对外 id,保证跨环境稳定(见文件头)
    id: row.archetype ?? row.id,
    name: row.name,
    emoji: row.emoji,
    tagline: row.tagline,
    archetype: row.archetype,
    traits: parseTraits(row.traits),
    voice: row.voice,
    backstory: row.backstory,
    boundaries: row.boundaries,
    isPreset: row.archetype !== null,
  };
}

/** 列出全部可用人格:预设在前(按预设顺序),自建在后(按更新时间倒序)。 */
export async function listPersonas(): Promise<PersonaRecord[]> {
  if (!isDatabaseConfigured()) return presetRecords();

  try {
    const rows = await getDb()
      .select()
      .from(personas)
      .where(eq(personas.userId, LOCAL_USER_ID))
      .orderBy(desc(personas.updatedAt));

    const presets: PersonaRecord[] = [];
    const custom: PersonaRecord[] = [];
    for (const row of rows) {
      (row.archetype === null ? custom : presets).push(toRecord(row));
    }

    // 预设按常量顺序展示(库里的 updated_at 会随种子刷新变化,不能作展示序)
    const order = new Map(PERSONA_PRESETS.map((p, index) => [p.id, index]));
    presets.sort((a, b) => {
      const ia = a.archetype === null ? Number.MAX_SAFE_INTEGER : (order.get(a.archetype) ?? 0);
      const ib = b.archetype === null ? Number.MAX_SAFE_INTEGER : (order.get(b.archetype) ?? 0);
      return ia - ib;
    });

    // 库里还没播种(只跑了 0001 就用到了 step2 的 UI)时,用常量补齐预设
    if (presets.length === 0) return [...presetRecords(), ...custom];
    return [...presets, ...custom];
  } catch (error) {
    console.error("[persona] 读取人格列表失败:", error instanceof Error ? error.message : error);
    return presetRecords();
  }
}

/**
 * 按对外 id 取人格。
 * 预设 id 走 archetype 查询,自建 id 走主键查询;查不到返回 null。
 */
export async function getPersona(id: string): Promise<PersonaRecord | null> {
  if (!isDatabaseConfigured()) {
    return presetRecords().find((p) => p.id === id) ?? null;
  }

  try {
    const [row] = await getDb()
      .select()
      .from(personas)
      .where(
        isValidPersonaId(id)
          ? and(eq(personas.id, id), eq(personas.userId, LOCAL_USER_ID))
          : and(eq(personas.archetype, id), eq(personas.userId, LOCAL_USER_ID)),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  } catch (error) {
    console.error("[persona] 读取人格失败:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** 收窄并裁剪用户输入(表单是不可信输入)。 */
export function normalizeDraft(input: PersonaDraft): PersonaDraft {
  return {
    name: input.name.trim().slice(0, MAX_NAME_LENGTH),
    emoji: [...input.emoji.trim()].slice(0, 4).join(""),
    tagline: input.tagline.trim().slice(0, 60),
    traits: parseTraits(input.traits),
    voice: input.voice.trim(),
    backstory: input.backstory.trim().slice(0, MAX_TEXTAREA_LENGTH),
    boundaries: input.boundaries.trim().slice(0, MAX_TEXTAREA_LENGTH),
  };
}

/** 新建人格,返回新 id。 */
export async function createPersona(draft: PersonaDraft): Promise<string | null> {
  if (!isDatabaseConfigured()) return null;
  const clean = normalizeDraft(draft);
  if (clean.name === "") return null;

  const [row] = await getDb()
    .insert(personas)
    .values({
      userId: LOCAL_USER_ID,
      name: clean.name,
      emoji: clean.emoji,
      tagline: clean.tagline,
      archetype: null,
      traits: clean.traits,
      voice: clean.voice,
      backstory: clean.backstory,
      boundaries: clean.boundaries,
      isPreset: false,
    })
    .returning({ id: personas.id });
  return row.id;
}

/** 更新自建人格。预设一律拒绝(只读模板,要走"另存为副本")。 */
export async function updatePersona(id: string, draft: PersonaDraft): Promise<boolean> {
  if (!isDatabaseConfigured() || !isValidPersonaId(id)) return false;
  const clean = normalizeDraft(draft);
  if (clean.name === "") return false;

  const result = await getDb()
    .update(personas)
    .set({ ...clean, updatedAt: new Date() })
    .where(
      and(
        eq(personas.id, id),
        eq(personas.userId, LOCAL_USER_ID),
        // 双保险:即使 id 是 uuid 也不会误改预设
        eq(personas.isPreset, false),
      ),
    )
    .returning({ id: personas.id });
  return result.length > 0;
}

/** 删除自建人格。预设拒绝。 */
export async function deletePersona(id: string): Promise<boolean> {
  if (!isDatabaseConfigured() || !isValidPersonaId(id)) return false;
  const result = await getDb()
    .delete(personas)
    .where(
      and(eq(personas.id, id), eq(personas.userId, LOCAL_USER_ID), eq(personas.isPreset, false)),
    )
    .returning({ id: personas.id });
  return result.length > 0;
}

/** 新建人格的初始草稿:中性 traits + 默认音色。 */
export function blankDraft(voice: string): PersonaDraft {
  return {
    name: "",
    emoji: "✨",
    tagline: "",
    traits: { ...NEUTRAL_TRAITS },
    voice,
    backstory: "",
    boundaries: "",
  };
}
