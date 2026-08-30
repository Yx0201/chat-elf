/**
 * 人格矩阵(step2 T1)。
 *
 * 维度清单由用户于 2026-08-29 拍板:**五维 + 亲密度**(接近 Paradot 的人格矩阵),
 * 而非 MBTI 四维 —— 后者有商标与许可顾虑,且对"聊天风格"的映射不如前者直接。
 *
 * 为什么是"滑块 → 自然语言"而不是把数字直接给模型:
 * 大语言模型对 0-100 的裸数字不敏感(72 与 78 的差别它读不出来),
 * 必须把数值**分档翻译成自然语言描述**才真正影响输出风格(README §2.2 调研结论:
 * Paradot 的 UI 滑块 → 动态拼装 prompt 也是这个做法)。
 */

import { z } from "zod";

export const TRAIT_KEYS = [
  "warmth",
  "energy",
  "humor",
  "chattiness",
  "initiative",
  "closeness",
] as const;

export type TraitKey = (typeof TRAIT_KEYS)[number];

export const TRAIT_MIN = 0;
export const TRAIT_MAX = 100;

/** 分档阈值:0-33 低档 / 34-66 中档 / 67-100 高档。 */
const LOW_BAND_MAX = 33;
const MID_BAND_MAX = 66;

export interface TraitDefinition {
  key: TraitKey;
  /** UI 上的维度名 */
  label: string;
  /** 滑块左端(低分)的语义 */
  lowLabel: string;
  /** 滑块右端(高分)的语义 */
  highLabel: string;
  /** 注入 prompt 的三档描述:[低, 中, 高] */
  bands: readonly [string, string, string];
}

export const TRAIT_DEFINITIONS: readonly TraitDefinition[] = [
  {
    key: "warmth",
    label: "热情度",
    lowLabel: "冷淡",
    highLabel: "热情",
    bands: [
      "克制、有距离感,不轻易表露关心,情绪不外放。",
      "温和有礼,关心但不越界,情绪表达适中。",
      "热情外放,毫不掩饰关心,情绪表达直接而充沛。",
    ],
  },
  {
    key: "energy",
    label: "活泼度",
    lowLabel: "沉静",
    highLabel: "活泼",
    bands: [
      "沉静平缓,语速慢、语调低,不急不躁。",
      "平稳自然,语速与情绪起伏适中。",
      "活泼有劲,语速快、语调上扬,情绪饱满外显。",
    ],
  },
  {
    key: "humor",
    label: "幽默度",
    lowLabel: "正经",
    highLabel: "逗趣",
    bands: [
      "正经务实,不开玩笑,认真对待每一句话。",
      "偶尔轻松一下,适度调侃,但不喧宾夺主。",
      "逗趣幽默,爱接梗、爱调侃,整体气氛轻快。",
    ],
  },
  {
    key: "chattiness",
    label: "话痨度",
    lowLabel: "惜字如金",
    highLabel: "话多",
    bands: [
      "惜字如金,能一句说完绝不说第二句,不铺陈、不客套。",
      "长短适中,该展开时展开,不啰嗦也不敷衍。",
      "话多且密,爱展开细节,容易顺着话题聊开去。",
    ],
  },
  {
    key: "initiative",
    label: "主动性",
    lowLabel: "倾听为主",
    highLabel: "主动引导",
    bands: [
      "以倾听为主,用户不问就不主动起话题,把话筒交给对方。",
      "会顺着话题追问,也偶尔主动聊聊对方的近况。",
      "主动引导话题,会主动关心、主动提起你们之前聊过的事。",
    ],
  },
  {
    key: "closeness",
    label: "亲密度",
    lowLabel: "有分寸",
    highLabel: "很亲密",
    bands: [
      "保持礼貌的分寸感,称呼克制,不主动打探私人领域。",
      "像关系不错的朋友,可以聊私事,但不越界。",
      "非常亲近,会用亲昵的称呼,愿意聊最私密的心事与情绪。",
    ],
  },
];

export type PersonaTraits = Record<TraitKey, number>;

/** 全部维度取中间值 —— 新建人格与解析失败时的基准。 */
export const NEUTRAL_TRAITS: PersonaTraits = {
  warmth: 50,
  energy: 50,
  humor: 50,
  chattiness: 50,
  initiative: 50,
  closeness: 50,
};

function clampTrait(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(TRAIT_MAX, Math.max(TRAIT_MIN, Math.round(value)));
}

/**
 * 单个维度的 schema。
 *
 * `.catch()` 而非只做范围校验:traits 存在 jsonb 里、由 UI 或迁移写入,
 * 任何非法值(字符串、null、NaN)都应静默回落到中间值 ——
 * 一个畸形人格不该让整个对话页 500。
 */
const TraitValueSchema = z.number().catch(50).transform(clampTrait);

export const PersonaTraitsSchema = z
  .object({
    warmth: TraitValueSchema,
    energy: TraitValueSchema,
    humor: TraitValueSchema,
    chattiness: TraitValueSchema,
    initiative: TraitValueSchema,
    closeness: TraitValueSchema,
  })
  .partial()
  .transform((partial) => {
    const result = { ...NEUTRAL_TRAITS };
    for (const key of TRAIT_KEYS) {
      const value = partial[key];
      if (value !== undefined) result[key] = value;
    }
    return result;
  });

/** 解析任意来源(jsonb / 表单 / URL)的 traits,失败一律回落中性值。 */
export function parseTraits(input: unknown): PersonaTraits {
  const result = PersonaTraitsSchema.safeParse(input);
  return result.success ? result.data : { ...NEUTRAL_TRAITS };
}

/** 数值 → 档位下标(0 低 / 1 中 / 2 高)。 */
export function bandOf(value: number): 0 | 1 | 2 {
  if (value <= LOW_BAND_MAX) return 0;
  if (value <= MID_BAND_MAX) return 1;
  return 2;
}

/** 某维度在当前取值下注入 prompt 的描述文本。 */
export function describeTrait(definition: TraitDefinition, value: number): string {
  return definition.bands[bandOf(value)];
}
