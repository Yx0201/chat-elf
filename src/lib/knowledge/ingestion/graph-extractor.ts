/**
 * 图谱实体/关系抽取器 —— 自 codeweaver 移植,LLM 调用层重构:
 * 裸 JSON + jsonrepair 的三重修复链(JSON.parse → jsonrepair → 模型修复)
 * 收敛为 `generateObject` + zod(结构化输出由 AI SDK 保证,模式对齐
 * memory/tasks.ts);模型统一 DashScope TEXT_MODEL(ZHIPU/GLM-5.3-Flash)。
 *
 * 保留 codeweaver 的两个关键机制:
 *  - 429 计数器(consumeRateLimitHits):graph-build 的 AIMD 并发控制依赖它;
 *  - 实体类型/字符串的归一化(中英文别名 → 5 类枚举,长度截断,去Markdown)。
 */

import { generateObject, generateText } from "ai";
import { APICallError } from "ai";
import { z } from "zod";
import { getDashScopeProvider, isAiConfigured, TEXT_MODEL, textModelProviderOptions } from "@/lib/ai/provider";

/** 实体类型的 5 个规范值(约定,不建 DB enum)。 */
type EntityType = "person" | "location" | "organization" | "event" | "concept";

const GRAPH_EXTRACT_SYSTEM = `
你是知识图谱抽取器。
任务:从给定文本中抽取实体和关系,以 JSON 对象形式返回,包含两个数组字段:

- entities:每项 {"name": "...", "entity_type": "...", "description": "..."}
- relations:每项 {"source": "...", "target": "...", "relation": "...", "description": "..."}
  source 与 target 必须使用 entities 里出现过的实体名称。

实体类型只能使用以下 5 个英文值:
- person:人物、角色
- location:地点、地名
- organization:组织、势力、机构
- event:事件、行动、冲突
- concept:概念、物品、能力、术语、设定

关系是必须抽取的部分:只要文中两个实体之间存在联系(亲属、所属、位于、
拥有、参与、对立、发现…),就必须输出对应的 relation 项。确实没有任何
关系时才允许输出空数组。

命名规范(非常重要):
- 实体 name 必须使用文中最完整、最正式的名称(全名优先于昵称/简称/代称)
- 同一实体的昵称、绰号、简称、代称要归一到同一个正式名称,不要输出为多个实体
- 不要把代词(他、她、它、对方、那人)当成实体
- relation 用 2~6 个字的动词短语(如「父亲是」「位于」「属于」「参与」「拥有」),不要写完整句子

限制:
- 最多输出 20 个 entities
- 最多输出 30 个 relations
- description 尽量简洁,每条不超过 40 个字
`.trim();

const QUERY_ENTITY_SYSTEM = `
你是查询实体提取器。
只输出纯文本,每行一个实体名称。
不要编号,不要解释。
如果没有实体,输出空字符串。
`.trim();

const EntitySchema = z.object({
  name: z.string(),
  entity_type: z.string().catch(""),
  description: z.string().optional().catch(undefined),
});

const RelationSchema = z.object({
  source: z.string(),
  target: z.string(),
  relation: z.string(),
  description: z.string().optional().catch(undefined),
});

const ExtractionSchema = z.object({
  entities: z.array(EntitySchema).max(20).catch([]),
  relations: z.array(RelationSchema).max(30).catch([]),
});

export type ExtractedEntity = z.infer<typeof EntitySchema>;
export type ExtractedRelation = z.infer<typeof RelationSchema>;

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

/**
 * 自上次 consume 以来观测到的 429 次数 —— graph-build 管线的
 * AIMD 自适应并发控制依赖此计数决定减半还是 +1。
 */
let rateLimitHits = 0;

export function consumeRateLimitHits(): number {
  const hits = rateLimitHits;
  rateLimitHits = 0;
  return hits;
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof APICallError && error.statusCode === 429;
}

/**
 * 实体类型归一化(自 codeweaver 移植):模型经常吐中文类型词,
 * 直接进 enum 会被兜底成 concept,先归一到 5 类规范值。
 */
function normalizeEntityType(value: string): EntityType {
  switch (value.trim().toLowerCase()) {
    case "person":
    case "人物":
    case "角色":
    case "人":
    case "character":
      return "person";
    case "location":
    case "地点":
    case "地名":
    case "地域":
    case "place":
      return "location";
    case "organization":
    case "组织":
    case "机构":
    case "势力":
    case "团体":
    case "组织机构":
      return "organization";
    case "event":
    case "事件":
    case "剧情":
    case "行动":
    case "冲突":
      return "event";
    default:
      return "concept";
  }
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 从图谱块文本抽取实体与关系。
 * 失败抛错(由 graph-build 阶段按块记 failed,不中断整个批次)。
 */
export async function extractEntitiesAndRelations(chunkText: string): Promise<ExtractionResult> {
  if (!isAiConfigured()) {
    throw new Error("未配置 DASHSCOPE_API_KEY,无法执行图谱抽取");
  }

  let result: { entities: ExtractedEntity[]; relations: ExtractedRelation[] };
  const traceStart = Date.now();
  try {
    const response = await generateObject({
      model: getDashScopeProvider().chatModel(TEXT_MODEL),
      schema: ExtractionSchema,
      system: GRAPH_EXTRACT_SYSTEM,
      prompt: `请从下面这段小说文本中抽取知识图谱实体和关系。\n\n文本:\n${chunkText}`,
      // 若模型支持思考(GLM/部分 qwen),思考 + 结构化输出共用额度,放宽防截断
      maxOutputTokens: 4000,
      providerOptions: textModelProviderOptions(),
    });
    result = response.object;
    console.log(
      `[knowledge][trace] LLM图谱抽取 model=${TEXT_MODEL} 耗时=${Date.now() - traceStart}ms`,
    );
  } catch (error) {
    if (isRateLimitError(error)) {
      rateLimitHits += 1;
      console.warn("[knowledge][trace] LLM图谱抽取 429 限流(AIMD 将降并发)");
    }
    throw new Error(`图谱抽取失败: ${extractErrorMessage(error)}`);
  }

  // 归一化:实体类型中英文归一 + 去 Markdown 残留/空字符 + 长度截断,过滤缺关键字段的条目
  return {
    entities: result.entities
      .map((entity) => ({
        name: sanitize(entity.name, 120),
        entity_type: normalizeEntityType(entity.entity_type),
        description: sanitize(entity.description, 80) || undefined,
      }))
      .filter((entity) => entity.name !== ""),
    relations: result.relations
      .map((relation) => ({
        source: sanitize(relation.source, 120),
        target: sanitize(relation.target, 120),
        relation: sanitize(relation.relation, 80),
        description: sanitize(relation.description, 80) || undefined,
      }))
      .filter((relation) => relation.source !== "" && relation.target !== "" && relation.relation !== ""),
  };
}

/** 清洗模型输出:去 Markdown 围栏/空字符,截断长度;空串表示该字段无效。 */
function sanitize(value: string | undefined, maxLength: number): string {
  return (value ?? "")
    .replace(/```/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

/**
 * 从用户查询中提取实体名(图谱检索的实体链接入口)。
 * 失败降级为空数组:图谱通道是增强,不拖垮整个检索。
 */
export async function extractQueryEntities(query: string): Promise<string[]> {
  if (!isAiConfigured()) return [];
  const traceStart = Date.now();
  try {
    const response = await generateText({
      model: getDashScopeProvider().chatModel(TEXT_MODEL),
      system: QUERY_ENTITY_SYSTEM,
      prompt: `查询:${query}\n\n请提取关键实体:`,
      maxOutputTokens: 256,
      providerOptions: textModelProviderOptions(),
    });
    console.log(
      `[knowledge][trace] LLM查询实体 model=${TEXT_MODEL} 耗时=${Date.now() - traceStart}ms 命中=${response.text.trim().split("\n").filter(Boolean).length}`,
    );
    return response.text
      .split("\n")
      .map((line) => line.replace(/^\d+[.、)\s]*/, "").trim())
      .filter((line) => line.length > 0)
      .slice(0, 5);
  } catch (error) {
    if (isRateLimitError(error)) rateLimitHits += 1;
    console.error("[knowledge] 查询实体提取失败:", extractErrorMessage(error));
    return [];
  }
}
