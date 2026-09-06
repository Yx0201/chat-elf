/**
 * 画像整合(step3 T4)—— 借鉴 Letta/MemGPT 的 Core Memory 与 sleep-time compute。
 *
 * ## 双层分工(为什么画像要"整体重写"而碎片层不删)
 * - **碎片层 `memories`**:ADD-only。"住北京"与"搬上海"共存,靠时间戳消解,
 *   保留时序可追溯 —— 这也是"用户删错了记忆还能靠转写找回"的基础。
 * - **画像层 `user_profile`**:每次**整体重写**。冲突在画像层消解成
 *   "现居上海(此前在北京)"。重写而非追加,才能得到凝练、无矛盾的一段速写。
 *
 * ## 触发时机
 * 每 N 个会话结束后(N = `PROFILE_REFRESH_EVERY`),而不是每会话都做 ——
 * 每会话重写成本高(一次 LLM 调用 + 全量记忆读取),且画像本就是慢变量。
 * 这是 sleep-time compute 思想:异步、不在语音延迟的关键路径上。
 *
 * 失败策略:画像只依赖 memories 表,记不住就下次再记,语音链路完全不受影响。
 */

import { generateObject } from "ai";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDashScopeProvider, isAiConfigured, TEXT_MODEL, textModelProviderOptions } from "@/lib/ai/provider";
import { getDb, isDatabaseConfigured } from "@/lib/db/client";
import { memories, userProfile } from "@/lib/db/schema";

/** 距上次整合以来,结束多少个会话才重写一次画像(spec 待决策项 2 的选定值)。 */
export const PROFILE_REFRESH_EVERY = 3;

/** 整合一次最多读取多少条碎片记忆(按重要度 × 时间取)。 */
const MAX_SOURCE_MEMORIES = 60;

export interface UserProfile {
  summary: string;
  /** 结构化画像字段,如 { "职业": "后端", "居住": "杭州" } */
  traits: Record<string, string>;
  updatedAt: Date | null;
  refreshedAt: Date | null;
}

/**
 * 画像输出 schema。
 *
 * `summary` 之外的同义字段不是冗余:实测 qwen-plus 会把速写字段擅自叫成 `bio`,
 * 而 zod 的 object 对未知/改名是**直接判失败**的 —— 一次字段名漂移就让
 * `generateObject` 抛 "did not match schema",画像永远生成不出来。
 * 提示词里也给了结构示例,两道防线。
 */
const ProfileSchema = z
  .object({
    summary: z.string().optional(),
    bio: z.string().optional(),
    profile: z.string().optional(),
    traits: z.record(z.string(), z.string()).default({}),
  })
  .transform((raw) => ({
    summary: (raw.summary ?? raw.bio ?? raw.profile ?? "").trim(),
    traits: raw.traits,
  }));

const PROFILE_SYSTEM = `你是用户画像整合器。下面是 AI 语音陪伴助手长期记住的关于同一位用户的碎片事实,每条都带有首次记录时间。
请把它们整合为一段人物速写和一组结构化字段,供助手在后续对话中了解这位用户。

规则:
1. **只依据给出的碎片,严禁编造或推测**碎片之外的信息。
2. 碎片之间冲突时,以**记录时间更晚**的为准,并在速写里体现这个变化(例如"现居上海,此前在北京")。
3. 用第三人称写速写(用"这个人"或"用户"作主语),语气客观平实,不评价、不建议、不抒情。
4. 速写控制在 300 字以内,只保留对长期陪伴真正有用的信息:身份背景、长期偏好、持续状态与计划、重要关系、反复出现的情绪模式。
5. 明显过期的临时状态(如很久以前的"下周要去出差")不要写进速写。
6. traits 只填确信且长期成立的字段,用简短中文键值对(如 {"职业":"后端","居住":"杭州","宠物":"猫,叫年糕"}),没有把握就留空对象。
7. 输出严格为 json,顶层**只能有 summary 与 traits 两个字段**,名称一字不改(不要用 bio、profile 之类的同义词)。

输出结构示例:
{"summary":"这个人正在准备明年的研究生考试,养了一只叫年糕的猫,不吃香菜。","traits":{"宠物":"猫,叫年糕","饮食":"不吃香菜"}}

(第 7 条不是废话:DashScope 的 OpenAI 兼容层在 response_format=json_object 模式下,
 会校验提示词里有没有出现 "json" 这个词,没有就直接报 400。)`;

/** 读当前画像;没有记录时返回 null(而不是空对象 —— 让调用方能区分"还没整合过")。 */
export async function getProfile(userId: string): Promise<UserProfile | null> {
  if (!isDatabaseConfigured()) return null;
  try {
    const [row] = await getDb()
      .select()
      .from(userProfile)
      .where(eq(userProfile.userId, userId))
      .limit(1);
    if (row === undefined || row.summary.trim() === "") return null;
    return {
      summary: row.summary,
      traits: parseTraits(row.traits),
      updatedAt: row.updatedAt,
      refreshedAt: row.refreshedAt,
    };
  } catch (error) {
    console.error("[profile] 读取画像失败:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** jsonb 来自数据库,可能被人手工改坏 —— 逐项收窄,不信任形状。 */
function parseTraits(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" && raw.trim() !== "" && key.trim() !== "") {
      result[key.trim()] = raw.trim();
    }
  }
  return result;
}

/** 拼出喂给整合模型的碎片文本(带时间,供冲突消解)。 */
async function loadSourceText(userId: string): Promise<string | null> {
  const rows = await getDb()
    .select({
      content: memories.content,
      category: memories.category,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(and(eq(memories.userId, userId), eq(memories.archived, false)))
    // 重要度优先,同等重要度下新的优先
    .orderBy(desc(memories.importance), desc(memories.createdAt))
    .limit(MAX_SOURCE_MEMORIES);

  if (rows.length === 0) return null;
  return rows
    .map((row) => {
      const days = Math.floor((Date.now() - row.createdAt.getTime()) / 86_400_000);
      const when = days <= 0 ? "今天" : `${days} 天前`;
      return `- [${row.category} | ${when}] ${row.content}`;
    })
    .join("\n");
}

/**
 * 立刻重写画像(不管有没有到阈值)。导出是为了手动触发/将来做定时任务。
 * 返回新的速写;失败返回 null。
 */
export async function refreshProfile(userId: string): Promise<string | null> {
  if (!isDatabaseConfigured() || !isAiConfigured()) return null;

  let source: string | null;
  try {
    source = await loadSourceText(userId);
  } catch (error) {
    console.error("[profile] 读取碎片记忆失败:", error instanceof Error ? error.message : error);
    return null;
  }
  if (source === null) return null;

  try {
    const result = await generateObject({
      model: getDashScopeProvider().chatModel(TEXT_MODEL),
      schema: ProfileSchema,
      system: PROFILE_SYSTEM,
      prompt: source,
      providerOptions: textModelProviderOptions(),
    });

    const summary = result.object.summary.trim().slice(0, 1000);
    // 空速写不落库:覆盖掉一份已存在的画像,比这次整合失败更糟
    if (summary === "") {
      console.warn("[profile] 模型未给出速写内容,保留原画像");
      return null;
    }
    const traits = parseTraits(result.object.traits);
    const now = new Date();

    await getDb()
      .insert(userProfile)
      .values({
        userId,
        summary,
        traits,
        pendingConversations: 0,
        updatedAt: now,
        refreshedAt: now,
      })
      .onConflictDoUpdate({
        target: userProfile.userId,
        set: { summary, traits, pendingConversations: 0, updatedAt: now, refreshedAt: now },
      });

    console.log(`[profile] 画像已整合(${summary.length} 字,${Object.keys(traits).length} 个字段)`);
    return summary;
  } catch (error) {
    console.error("[profile] 画像整合失败:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * 会话结束时调用:累加待整合计数,达到阈值就重写画像。
 *
 * 计数先落库再整合 —— 即使整合失败,计数也不会丢,下次会话结束后会再试。
 */
export async function noteConversationFinished(userId: string): Promise<void> {
  if (!isDatabaseConfigured()) return;
  const db = getDb();
  try {
    const [row] = await db
      .insert(userProfile)
      .values({ userId, pendingConversations: 1 })
      // 没有记录时插入;已有记录则 +1
      .onConflictDoUpdate({
        target: userProfile.userId,
        set: { pendingConversations: sql`${userProfile.pendingConversations} + 1` },
      })
      .returning({ pending: userProfile.pendingConversations });

    if (row === undefined || row.pending < PROFILE_REFRESH_EVERY) return;
    console.log(`[profile] 已结束 ${row.pending} 个会话,触发画像整合`);
  } catch (error) {
    console.error("[profile] 累加会话计数失败:", error instanceof Error ? error.message : error);
    return;
  }
  await refreshProfile(userId);
}
