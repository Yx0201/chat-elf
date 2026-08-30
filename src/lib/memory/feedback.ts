/**
 * 反馈埋点的数据访问(step2 T4)。
 *
 * 只埋点、不分析 —— step2 明确不做自动人设调优,先把数据攒下来,
 * 对应 README §2.2 调研结论里 Character.AI 的星级反馈闭环。
 *
 * 幂等语义(由 `feedback.message_id` 的唯一索引强制):
 *   - 打同一个分 = 撤销(删记录);
 *   - 打不同的分 = 改判(upsert)。
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { feedback } from "@/lib/db/schema";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 👍 = 1,👎 = -1 */
export type FeedbackScore = 1 | -1;

/** 客户端传来的 message id 是不可信输入,先校验形状。 */
export function isValidMessageId(id: string): boolean {
  return UUID_RE.test(id);
}

function toScore(value: number | null): FeedbackScore | null {
  return value === 1 ? 1 : value === -1 ? -1 : null;
}

export async function getFeedbackScore(messageId: string): Promise<FeedbackScore | null> {
  if (!isValidMessageId(messageId)) return null;
  const [row] = await getDb()
    .select({ score: feedback.score })
    .from(feedback)
    .where(eq(feedback.messageId, messageId))
    .limit(1);
  return row === undefined ? null : toScore(row.score);
}

/**
 * 给一条消息打分,返回**生效后**的分数(null = 已撤销)。
 *
 * 先读后写而不是直接 upsert:需要知道"这次点击是不是撤销"。
 * 同一条消息的反馈量极低(一个人一次点击),多一次查询没有压力。
 */
export async function rateMessage(
  messageId: string,
  score: FeedbackScore,
): Promise<FeedbackScore | null> {
  if (!isValidMessageId(messageId)) return null;
  const db = getDb();
  const [existing] = await db
    .select({ score: feedback.score })
    .from(feedback)
    .where(eq(feedback.messageId, messageId))
    .limit(1);

  if (existing !== undefined && existing.score === score) {
    await db.delete(feedback).where(eq(feedback.messageId, messageId));
    return null;
  }

  await db
    .insert(feedback)
    .values({ messageId, score })
    .onConflictDoUpdate({
      target: feedback.messageId,
      set: { score, createdAt: new Date() },
    });
  return score;
}
