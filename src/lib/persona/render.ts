/**
 * instructions 渲染器(step2 T2)。
 *
 * 把「人格参数」翻译成「prompt」:三段式
 *   身份与背景(name + backstory)→ 性格参数(traits 分档描述)→ 行为边界(boundaries)
 * 之后再拼上固定两段(语音播报约束 + 安全段),顺序与 step1 的 `buildInstructions` 一致。
 *
 * 设计要点:
 * - **纯函数、无 IO**:服务端(会话建连)与客户端(编辑器实时预览)共用同一份实现,
 *   保证"编辑器里看到的"与"真正下发的"逐字一致 —— 这是 ui spec「所见即所聊」的
 *   硬性要求,靠共享代码而非靠约定来保证。
 * - **硬上限**:人格本体超过 MAX_BODY_CHARS 就按优先级截断。realtime 的 instructions
 *   挤占上下文窗口会直接劣化长对话表现(ARCHITECTURE.md 模型已知约束)。
 * - **极端值不矛盾**:全 0 与全 100 都只输出对应档位的描述,不会同时出现
 *   "惜字如金"与"话多且密"。
 */

import { buildInstructions } from "./presets";
import {
  describeTrait,
  TRAIT_DEFINITIONS,
  type PersonaTraits,
} from "./traits";

/**
 * 人格本体(不含固定两段)的字符上限。
 * 固定两段(SPEECH_STYLE_RULES + SAFETY_RULES)另约 500 字,合计仍在千字量级。
 */
export const MAX_BODY_CHARS = 800;

export interface RenderablePersona {
  name: string;
  /** 背景故事 / 人设本体;可为空(纯滑块捏出的人格) */
  backstory: string;
  /** 行为边界(绝不做什么);可为空 */
  boundaries: string;
  traits: PersonaTraits;
}

/** 背景故事最多占用的预算比例(剩余留给行为边界)。 */
const BACKSTORY_BUDGET_RATIO = 0.6;

function normalize(value: string): string {
  return value.trim();
}

/** 按预算截断;超长时补省略号,避免出现半截句子。 */
function clampText(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (text.length <= budget) return text;
  return `${text.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
}

/** 性格参数段:六维各一句,拼成一段。 */
function renderTraitsSection(traits: PersonaTraits): string {
  const lines = TRAIT_DEFINITIONS.map((definition) =>
    `${definition.label}:${describeTrait(definition, traits[definition.key])}`,
  );
  return `【性格】\n${lines.join("\n")}`;
}

/**
 * 渲染人格本体(不含语音播报约束与安全段)。
 * 导出的目的是让编辑器的预览只展示人格部分,避免固定两段淹没用户的修改。
 */
export function renderPersonaBody(persona: RenderablePersona): string {
  const name = normalize(persona.name);
  const backstory = normalize(persona.backstory);
  const boundaries = normalize(persona.boundaries);
  const traitsSection = renderTraitsSection(persona.traits);

  // 身份行:backstory 非空时它通常自带"你叫X",不再重复声明
  const head = backstory === "" && name !== "" ? `你叫${name},是用户的专属陪伴伙伴。` : "";

  // 分隔符开销取决于**实际会输出几段**(空段不参与 join),先定段数再算预算 ——
  // 按固定值预留会在"恰好三段"的情况下超上限 2 个字符。
  const sections = [head, backstory, traitsSection, boundaries].filter((part) => part !== "");
  const separatorCost = Math.max(0, sections.length - 1) * 2;
  const budget = MAX_BODY_CHARS - traitsSection.length - head.length - separatorCost;

  // 极端情况:性格段本身就占满预算。此时保留性格段 —— 它是人格的核心描述,
  // 背景与边界只是补充,丢掉它们比丢掉性格更安全。
  if (budget <= 0) {
    return [head, traitsSection]
      .filter((part) => part !== "")
      .join("\n\n")
      .slice(0, MAX_BODY_CHARS);
  }

  const backstoryBudget = Math.floor(budget * BACKSTORY_BUDGET_RATIO);
  const backstoryPart = backstory === "" ? "" : clampText(backstory, backstoryBudget);
  const boundariesPart =
    boundaries === "" ? "" : clampText(boundaries, budget - backstoryPart.length);

  return [head, backstoryPart, traitsSection, boundariesPart]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** 渲染完整 instructions(人格本体 + 语音播报约束 + 安全段)。 */
export function renderPersonaInstructions(persona: RenderablePersona): string {
  return buildInstructions(renderPersonaBody(persona));
}
