/**
 * 知识库 metadata 摘要生成(本模块新增,codeweaver 无此能力)。
 *
 * 两级摘要,均为 LLM 生成:
 *  - 文件级:finalize 阶段为每篇文档生成「内容范围归纳」——
 *    输入 = 卷章结构清单 + 首尾采样(不送全文,控 token);
 *    输出 JSON{summary, topics, exampleQuestions} 存 uploaded_files.summary。
 *  - KB 级:聚合全部文件摘要;超预算(1500 字符)时再调一次 LLM 压缩。
 *    存 knowledge_bases.summary,step2 注入 realtime instructions,
 *    作为「闲聊直答 / 触发检索」前置判断的依据。
 *
 * 失败语义:摘要属增强能力 —— 文件级失败该文件摘要留 null;
 * KB 级失败保留旧摘要;都不回滚摄取流水线。
 */

import { generateObject, generateText } from "ai";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDashScopeProvider, isAiConfigured, TEXT_MODEL } from "@/lib/ai/provider";
import { getDb } from "@/lib/db/client";
import { knowledgeBases, uploadedFiles } from "@/lib/db/schema";
import { buildNovelGraphChunks } from "@/lib/knowledge/chunking";

/** instructions 中 KB 段的字符预算(超出触发 LLM 压缩)。 */
export const KB_SUMMARY_BUDGET_CHARS = 1500;

/** 摘要输入的首/尾采样长度(字符)。 */
const SAMPLE_CHARS = 2000;

/** 卷章标题清单最多取多少条(控 token)。 */
const MAX_TITLES = 50;

const FileSummarySchema = z.object({
  /** 内容范围归纳,中文,≤200 字 */
  summary: z.string().catch(""),
  /** 涉及主题,≤6 个 */
  topics: z.array(z.string()).catch([]),
  /** 适合向这份资料问什么,≤3 个 */
  exampleQuestions: z.array(z.string()).catch([]),
});

export interface FileSummary {
  summary: string;
  topics: string[];
  exampleQuestions: string[];
}

/** 解析存储的文件摘要 JSON(容错:坏数据返回 null)。 */
export function parseFileSummary(raw: string | null): FileSummary | null {
  if (!raw) return null;
  try {
    const parsed = FileSummarySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * 为一篇文档生成内容摘要并写入 uploaded_files.summary(JSON 文本)。
 */
export async function generateFileSummary(fileId: string, fileName: string, content: string): Promise<void> {
  if (!isAiConfigured()) return;

  const graphChunks = buildNovelGraphChunks(content);
  const titles: string[] = [];
  for (const chunk of graphChunks) {
    const title = chunk.volumeTitle ?? chunk.chapterTitle;
    if (title && !titles.includes(title)) titles.push(title);
    if (titles.length >= MAX_TITLES) break;
  }

  const head = content.slice(0, SAMPLE_CHARS);
  const tail = content.length > SAMPLE_CHARS * 2 ? content.slice(-SAMPLE_CHARS) : "";

  const result = await generateObject({
    model: getDashScopeProvider().chatModel(TEXT_MODEL),
    schema: FileSummarySchema,
    maxOutputTokens: 4000,
    system:
      "你是文档内容归纳器。根据给定的文档结构清单与首尾节选,归纳这份资料的内容范围,以 JSON 对象返回。" +
      "summary 用中文客观描述这份资料讲了什么、覆盖哪些内容,不超过 200 字;" +
      "topics 列出 3-6 个主题词;exampleQuestions 列出 2-3 个用户可能基于这份资料提出的问题。",
    prompt:
      `文件名:${fileName}\n\n` +
      `结构清单(卷/章标题,共 ${titles.length} 条):\n${titles.join("\n")}\n\n` +
      `开头节选:\n${head}\n\n` +
      (tail ? `结尾节选:\n${tail}` : "(文档较短,无结尾节选)"),
  });

  await getDb()
    .update(uploadedFiles)
    .set({ summary: JSON.stringify(result.object), updatedAt: new Date() })
    .where(eq(uploadedFiles.id, fileId));
}

/**
 * 聚合 KB 内全部文档摘要 → knowledge_bases.summary。
 * 直接拼接为主;超预算才调一次 LLM 压缩(控成本)。
 */
export async function rebuildKnowledgeBaseSummary(kbId: string): Promise<void> {
  const db = getDb();
  const files = await db
    .select({ fileName: uploadedFiles.fileName, summary: uploadedFiles.summary })
    .from(uploadedFiles)
    .where(eq(uploadedFiles.kbId, kbId));

  const entries: string[] = [];
  for (const file of files) {
    const parsed = parseFileSummary(file.summary);
    if (parsed === null || parsed.summary === "") continue;
    const topics = parsed.topics.length > 0 ? `(主题:${parsed.topics.join("、")})` : "";
    entries.push(`《${file.fileName}》${parsed.summary}${topics}`);
  }

  if (entries.length === 0) return;
  let digest = entries.join(";");

  if (digest.length > KB_SUMMARY_BUDGET_CHARS && isAiConfigured()) {
    const compressed = await generateText({
      model: getDashScopeProvider().chatModel(TEXT_MODEL),
      system:
        `你是知识库摘要压缩器。把给定的文档摘要清单压缩成不超过 ${KB_SUMMARY_BUDGET_CHARS} 字的连续摘要,` +
        "保留每个文档的主题与内容范围(文件名可简化),直接输出摘要正文,不要解释。",
      prompt: digest,
      maxOutputTokens: 1200,
    });
    const text = compressed.text.trim();
    if (text.length > 0) digest = text;
  }

  await db
    .update(knowledgeBases)
    .set({ summary: digest, summaryGeneratedAt: sql`now()`, updatedAt: new Date() })
    .where(eq(knowledgeBases.id, kbId));
}
