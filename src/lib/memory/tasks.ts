/**
 * 记忆抽取(会话后批量轨)—— step3 T1 的内容,按用户决策提前纳入 Step1 的 P4。
 *
 * 流程:会话转写 → `generateObject` + zod schema 抽候选 → 逐条与既有记忆做
 * 向量相似度比对 → 重复则刷新确认时间与重要度,否则新增。
 *
 * 失败策略:抽取是**后台增强**,任何异常都只记录日志并返回 0,绝不影响语音链路。
 */

import { generateObject } from "ai";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm";
import { z } from "zod";
import { getDashScopeProvider, isAiConfigured, TEXT_MODEL } from "@/lib/ai/provider";
import { getDb, isDatabaseConfigured } from "@/lib/db/client";
import { memories } from "@/lib/db/schema";
import { loadTranscript } from "./conversations";
import { embedText } from "./embedding";

const MEMORY_CATEGORIES = ["fact", "preference", "event", "relationship", "emotion"] as const;

/** 与既有记忆的余弦相似度超过此值视为同一件事 —— 只更新,不新增。 */
const DUPLICATE_SIMILARITY = 0.9;

/** 少于此条数的对话不抽取(噪音多、价值低)。 */
const MIN_TRANSCRIPT_MESSAGES = 4;

/** 抽取时回看的最大条数。 */
const TRANSCRIPT_LIMIT = 60;

/**
 * 单条记忆。
 *
 * 每个字段都带 `.catch()`:抽取是**整批**的 —— 一条里有个字段不合法,
 * 整个数组都会解析失败,这一轮就一条都记不住。宁可让个别字段回落到
 * 安全值,也不要全批报废(clamp01 在写入前还会再夹一次)。
 */
const MemoryItemSchema = z.object({
  /** 一条精炼的长期信息,客观陈述,不超过 60 字 */
  content: z.string(),
  /** fact 事实 / preference 偏好 / event 事件 / relationship 人际关系 / emotion 情绪状态 */
  category: z.enum(MEMORY_CATEGORIES).catch("fact"),
  /** 0-1,对后续陪伴对话的有用程度 */
  importance: z.coerce.number().catch(0.5),
  /** 0-1,该信息本身的情感浓度 */
  emotionScore: z.coerce.number().catch(0),
});

/**
 * 顶层 schema。
 * `facts` 是同义兜底 —— 实测模型会把数组字段叫成别的名字(见 profile.ts 的
 * 同类问题),而 zod 的 object 对改名是直接判失败的。
 */
const ExtractionSchema = z
  .object({
    memories: z.array(MemoryItemSchema).max(8).optional(),
    facts: z.array(MemoryItemSchema).max(8).optional(),
  })
  .transform((raw) => ({ memories: raw.memories ?? raw.facts ?? [] }));

const EXTRACTION_SYSTEM = `你是记忆抽取器。阅读一段 AI 语音陪伴助手与用户的中文对话转写,抽取**关于用户的、长期有效**的信息。

抽取规则:
1. 只抽未来仍然成立的信息:身份与背景、长期偏好、持续的状态或计划、重要人际关系、反复出现的情绪模式。
2. 不抽:一次性琐事(今天吃了什么、临时安排)、助手自己说过的话、寒暄客套、纯粹的观点讨论。
3. 每条独立成条、客观陈述,不超过 60 字,不要带"用户说""用户提到"这类前缀。
4. 没有值得记住的信息就返回空数组,不要为了凑数而抽取。
5. importance(0-1):对后续陪伴对话越有用越高。长期身份与重大事件 0.8 以上,一般偏好约 0.5,细节 0.2。
6. emotion_score(0-1):该信息本身的情感浓度。分离、丧失、长期焦虑、强烈的喜事等取 0.8 以上;中性事实取 0。
7. 输出严格为 json,顶层**只有一个 memories 数组**字段(不要用 facts、items 之类的同义词);
   数组里每个元素含 content、category、importance、emotion_score 四个字段。

输出结构示例:
{"memories":[{"content":"养了一只叫年糕的猫","category":"fact","importance":0.7,"emotion_score":0.3}]}

(末句不是废话:DashScope 的 OpenAI 兼容层在 response_format=json_object 模式下,
 会校验提示词里有没有出现 "json" 这个词,没有就直接报 400。)`;

export interface CandidateMemory {
  content: string;
  category: string;
  importance: number;
  emotionScore: number;
}

/** 记忆的两条写入轨(spec §4 双轨写入);值由 memories.source 的 CHECK 约束强制。 */
export type MemorySource = "batch" | "realtime";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 写入一条候选记忆;命中重复时返回 false(表示只是刷新了旧记忆)。
 *
 * 两条轨共用此函数(step3 T2):批量抽取与实时标记走同一套去重逻辑,
 * 否则"用户说了两次同一件事"会被写成两条。
 */
export async function upsertMemory(
  userId: string,
  candidate: CandidateMemory,
  conversationId: string | null,
  source: MemorySource = "batch",
): Promise<boolean> {
  const db = getDb();
  const content = candidate.content.trim();
  if (content === "") return false;

  const vector = await embedText(content);

  if (vector !== null) {
    const similarity = sql<number>`1 - (${cosineDistance(memories.embedding, vector)})`;
    const [existing] = await db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.userId, userId),
          eq(memories.archived, false),
          sql`${memories.embedding} is not null`,
          gt(similarity, DUPLICATE_SIMILARITY),
        ),
      )
      .orderBy(desc(similarity))
      .limit(1);

    if (existing !== undefined) {
      await db
        .update(memories)
        .set({
          lastConfirmedAt: new Date(),
          // 重要度只升不降:重复提及说明这件事确实重要
          importance: sql`greatest(${memories.importance}, ${clamp01(candidate.importance)})`,
          emotionScore: sql`greatest(${memories.emotionScore}, ${clamp01(candidate.emotionScore)})`,
        })
        .where(eq(memories.id, existing.id));
      return false;
    }
  }

  await db.insert(memories).values({
    userId,
    content,
    category: candidate.category,
    importance: clamp01(candidate.importance),
    emotionScore: clamp01(candidate.emotionScore),
    source,
    embedding: vector,
    sourceConversationId: conversationId,
    lastConfirmedAt: new Date(),
    lastAccessedAt: new Date(),
  });
  return true;
}

/** 对一个会话执行记忆抽取,返回**新增**的记忆条数(刷新旧记忆不计入)。 */
export async function extractMemories(userId: string, conversationId: string): Promise<number> {
  if (!isDatabaseConfigured() || !isAiConfigured()) return 0;

  const transcript = await loadTranscript(userId, conversationId, TRANSCRIPT_LIMIT);
  if (transcript.length < MIN_TRANSCRIPT_MESSAGES) return 0;

  const text = transcript
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`)
    .join("\n");

  let candidates: readonly CandidateMemory[];
  try {
    const result = await generateObject({
      model: getDashScopeProvider().chatModel(TEXT_MODEL),
      schema: ExtractionSchema,
      system: EXTRACTION_SYSTEM,
      prompt: text,
    });
    candidates = result.object.memories;
  } catch (error) {
    console.error("[memory] 记忆抽取失败:", error instanceof Error ? error.message : error);
    return 0;
  }

  let written = 0;
  for (const candidate of candidates) {
    try {
      if (await upsertMemory(userId, candidate, conversationId)) written += 1;
    } catch (error) {
      console.error("[memory] 记忆写入失败:", error instanceof Error ? error.message : error);
    }
  }
  if (written > 0) console.log(`[memory] 会话 ${conversationId} 新增 ${written} 条记忆`);
  return written;
}
