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
import { memories, LOCAL_USER_ID } from "@/lib/db/schema";
import { loadTranscript } from "./conversations";
import { embedText } from "./embedding";

const MEMORY_CATEGORIES = ["fact", "preference", "event", "relationship", "emotion"] as const;

/** 与既有记忆的余弦相似度超过此值视为同一件事 —— 只更新,不新增。 */
const DUPLICATE_SIMILARITY = 0.9;

/** 少于此条数的对话不抽取(噪音多、价值低)。 */
const MIN_TRANSCRIPT_MESSAGES = 4;

/** 抽取时回看的最大条数。 */
const TRANSCRIPT_LIMIT = 60;

const ExtractionSchema = z.object({
  memories: z
    .array(
      z.object({
        /** 一条精炼的长期信息,客观陈述,不超过 60 字 */
        content: z.string(),
        /** fact 事实 / preference 偏好 / event 事件 / relationship 人际关系 / emotion 情绪状态 */
        category: z.enum(MEMORY_CATEGORIES),
        /** 0-1,对后续陪伴对话的有用程度 */
        importance: z.number(),
        /** 0-1,该信息本身的情感浓度 */
        emotionScore: z.number(),
      }),
    )
    .max(8),
});

const EXTRACTION_SYSTEM = `你是记忆抽取器。阅读一段 AI 语音陪伴助手与用户的中文对话转写,抽取**关于用户的、长期有效**的信息。

抽取规则:
1. 只抽未来仍然成立的信息:身份与背景、长期偏好、持续的状态或计划、重要人际关系、反复出现的情绪模式。
2. 不抽:一次性琐事(今天吃了什么、临时安排)、助手自己说过的话、寒暄客套、纯粹的观点讨论。
3. 每条独立成条、客观陈述,不超过 60 字,不要带"用户说""用户提到"这类前缀。
4. 没有值得记住的信息就返回空数组,不要为了凑数而抽取。
5. importance(0-1):对后续陪伴对话越有用越高。长期身份与重大事件 0.8 以上,一般偏好约 0.5,细节 0.2。
6. emotion_score(0-1):该信息本身的情感浓度。分离、丧失、长期焦虑、强烈的喜事等取 0.8 以上;中性事实取 0。`;

interface CandidateMemory {
  content: string;
  category: string;
  importance: number;
  emotionScore: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 写入一条候选记忆;命中重复时返回 false(表示只是刷新了旧记忆)。 */
async function upsertMemory(
  candidate: CandidateMemory,
  conversationId: string,
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
          eq(memories.userId, LOCAL_USER_ID),
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
    userId: LOCAL_USER_ID,
    content,
    category: candidate.category,
    importance: clamp01(candidate.importance),
    emotionScore: clamp01(candidate.emotionScore),
    embedding: vector,
    sourceConversationId: conversationId,
    lastConfirmedAt: new Date(),
    lastAccessedAt: new Date(),
  });
  return true;
}

/** 对一个会话执行记忆抽取,返回**新增**的记忆条数(刷新旧记忆不计入)。 */
export async function extractMemories(conversationId: string): Promise<number> {
  if (!isDatabaseConfigured() || !isAiConfigured()) return 0;

  const transcript = await loadTranscript(conversationId, TRANSCRIPT_LIMIT);
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
      if (await upsertMemory(candidate, conversationId)) written += 1;
    } catch (error) {
      console.error("[memory] 记忆写入失败:", error instanceof Error ? error.message : error);
    }
  }
  if (written > 0) console.log(`[memory] 会话 ${conversationId} 新增 ${written} 条记忆`);
  return written;
}
