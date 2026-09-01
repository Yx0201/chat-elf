/**
 * 上下文组装 —— 每次新建 realtime 会话前调用(ARCHITECTURE.md「Agentic 层架构」:
 * 长对话记忆的唯一来源是落库文本 + 注入的 instructions,不能依赖模型会话内存)。
 *
 * 注入两段:
 *   1. 语义记忆:向量检索 + **遗忘衰减**(README §2.3 调研结论 —— 没有遗忘机制的
 *      记忆系统会像"全知监控",破坏人感);
 *   2. 最近历史:最近 N 条转写,按时间正序。
 *
 * 输出是纯文本段落,由客户端拼在人格 instructions 之后一起下发。
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm";
import { isAiConfigured } from "@/lib/ai/provider";
import { getDb, isDatabaseConfigured } from "@/lib/db/client";
import { memories } from "@/lib/db/schema";
import { loadRecentMessages } from "./conversations";
import { embedText } from "./embedding";
import { getProfile } from "./profile";

/** 注入的最近历史条数(spec:起步取 20 条)。 */
export const RECENT_MESSAGE_LIMIT = 20;

/** 注入的语义记忆条数上限 —— 不要全量塞上下文(调研结论第 4 点)。 */
export const RECALL_LIMIT = 8;

/** 先按向量相似度取这么多候选,再用综合打分重排。 */
const CANDIDATE_POOL = 30;

/** 遗忘衰减因子:情感浓度高的记忆衰减更慢(README §2.3 的调研经验值)。 */
const DECAY_EMOTIONAL = 0.98;
const DECAY_NORMAL = 0.95;
const EMOTION_DECAY_THRESHOLD = 0.8;
const EMOTION_WEIGHT = 0.5;

interface RecalledMemory {
  id: string;
  content: string;
  /** 排序基准:向量路径为余弦相似度,冷启动路径为 importance */
  base: number;
  emotionScore: number;
  createdAt: Date;
}

/** 综合打分 = 相似度/重要度 × 时间衰减 × 情感加权。 */
function scoreOf(memory: RecalledMemory, now: number): number {
  const days = Math.max(0, (now - memory.createdAt.getTime()) / 86_400_000);
  const decay = memory.emotionScore > EMOTION_DECAY_THRESHOLD ? DECAY_EMOTIONAL : DECAY_NORMAL;
  return memory.base * Math.pow(decay, days) * (1 + memory.emotionScore * EMOTION_WEIGHT);
}

async function recallMemories(
  userId: string,
  recent: readonly { role: string; content: string }[],
): Promise<RecalledMemory[]> {
  const db = getDb();

  // 用最近几条用户消息拼成查询文本 —— 冷启动(无历史)时退化为按重要度取
  const queryText = recent
    .filter((m) => m.role === "user")
    .slice(-5)
    .map((m) => m.content)
    .join("\n");

  const vector = queryText === "" || !isAiConfigured() ? null : await embedText(queryText);

  if (vector !== null) {
    const similarity = sql<number>`1 - (${cosineDistance(memories.embedding, vector)})`;
    const rows = await db
      .select({
        id: memories.id,
        content: memories.content,
        emotionScore: memories.emotionScore,
        createdAt: memories.createdAt,
        similarity,
      })
      .from(memories)
      .where(
        and(
          eq(memories.userId, userId),
          eq(memories.archived, false),
          sql`${memories.embedding} is not null`,
        ),
      )
      .orderBy(desc(similarity))
      .limit(CANDIDATE_POOL);
    return rows.map((r) => ({ ...r, base: r.similarity }));
  }

  const rows = await db
    .select({
      id: memories.id,
      content: memories.content,
      emotionScore: memories.emotionScore,
      createdAt: memories.createdAt,
      importance: memories.importance,
    })
    .from(memories)
    .where(and(eq(memories.userId, userId), eq(memories.archived, false)))
    .orderBy(desc(memories.importance), desc(memories.createdAt))
    .limit(CANDIDATE_POOL);
  return rows.map((r) => ({ ...r, base: r.importance }));
}

/** 命中检索的记忆刷新 last_accessed_at(访问频率加权,防"越用越忘")。 */
async function touchMemories(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await getDb()
    .update(memories)
    .set({ lastAccessedAt: new Date() })
    .where(inArray(memories.id, ids));
}

/**
 * 组装注入到 instructions 的记忆上下文段落。
 *
 * 查询报错时返回空字符串 —— 记忆是增强项,失败不能让对话页 500。
 */
export async function buildMemoryContext(userId: string): Promise<string> {
  if (!isDatabaseConfigured()) return "";

  try {
    const recent = await loadRecentMessages(userId, RECENT_MESSAGE_LIMIT);
    const pool = await recallMemories(userId, recent);
    // 画像层(step3 T4)是 LLM 整合过的、已消解冲突的用户速写,
    // 比碎片记忆更凝练可靠,故注入优先级最高
    const profile = await getProfile(userId);
    const now = Date.now();
    const top = [...pool].sort((a, b) => scoreOf(b, now) - scoreOf(a, now)).slice(0, RECALL_LIMIT);

    if (recent.length === 0 && top.length === 0 && profile === null) return "";

    void touchMemories(top.map((m) => m.id)).catch((error: unknown) => {
      console.error("[memory] 刷新 last_accessed_at 失败:", error);
    });

    const parts: string[] = [];

    if (profile !== null) {
      const fields = Object.entries(profile.traits)
        .map(([key, value]) => `${key}=${value}`)
        .join(" · ");
      parts.push(
        `【用户画像(长期整理所得,以它为准)】\n${profile.summary}` +
          (fields === "" ? "" : `\n关键事实:${fields}`),
      );
    }

    if (top.length > 0) {
      parts.push(
        "【你记住的关于用户的事】\n" + top.map((m) => `- ${m.content}`).join("\n"),
      );
    }

    if (recent.length > 0) {
      const lines = recent.map((m) => `${m.role === "user" ? "用户" : "你"}: ${m.content}`);
      // 措辞对"继续旧会话"和"开新会话"两种情况都成立:这些片段可能来自当前会话,
      // 也可能来自上一场
      parts.push("【你们此前说过的(按时间顺序)】\n" + lines.join("\n"));
    }

    parts.push(
      "【怎么用这些信息】它们来自你们此前的对话。可以在合适的时机自然带出来," +
        "但不要机械复述、不要主动声明\"我记得\"、不要一次全说完。" +
        "若用户否认或纠正了其中某条,以用户当前的说法为准。",
    );

    return parts.join("\n\n");
  } catch (error) {
    console.error("[memory] 组装记忆上下文失败:", error instanceof Error ? error.message : error);
    return "";
  }
}
