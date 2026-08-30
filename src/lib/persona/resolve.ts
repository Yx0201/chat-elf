/**
 * 「当前选中的人格」解析 —— 把 localStorage 里的 personaId 解析成可渲染的人格。
 *
 * 纯函数、零 IO:服务端(对话页渲染 instructions)与客户端(切换人格后立刻重算)
 * 共用同一份逻辑。客户端之所以需要它,是因为 instructions 在客户端组装后
 * 随 `session.update` 下发,而人格列表由服务端一次性下发到客户端。
 *
 * 三条回落路径,按优先级:
 *   1. 命中人格库里的记录(预设 archetype 或自建 uuid);
 *   2. `CUSTOM_PERSONA_ID` —— step1 遗留的本地自定义文案,当 backstory 用;
 *   3. 默认预设。
 *
 * 第 3 条不是"理论上不会发生"的兜底:用户可以在另一个标签页删掉当前人格,
 * 而本标签页的 localStorage 还指向它 —— 此时必须有个可用的人格,而不是渲染失败。
 */

import { CUSTOM_PERSONA_ID, DEFAULT_PERSONA_ID, findPreset } from "./presets";
import type { RenderablePersona } from "./render";
import type { PersonaSettings } from "./settings";
import type { PersonaRecord } from "./types";
import { NEUTRAL_TRAITS } from "./traits";

/** step1 遗留自定义文案的展示名(它只存在 localStorage,没有正式的人格记录)。 */
const LEGACY_CUSTOM_NAME = "自定义";

export function resolvePersona(
  settings: PersonaSettings,
  personas: readonly PersonaRecord[],
): RenderablePersona {
  const matched = personas.find((persona) => persona.id === settings.personaId);
  if (matched !== undefined) {
    return {
      name: matched.name,
      backstory: matched.backstory,
      boundaries: matched.boundaries,
      traits: matched.traits,
    };
  }

  if (settings.personaId === CUSTOM_PERSONA_ID) {
    return {
      name: LEGACY_CUSTOM_NAME,
      backstory: settings.customInstructions,
      boundaries: "",
      traits: { ...NEUTRAL_TRAITS },
    };
  }

  // 人格被删 / 数据被清 / 旧值失效 → 回落到默认预设
  const fallback = findPreset(DEFAULT_PERSONA_ID);
  if (fallback === null) {
    return { name: "", backstory: "", boundaries: "", traits: { ...NEUTRAL_TRAITS } };
  }
  return {
    name: fallback.name,
    backstory: fallback.instructions,
    boundaries: "",
    traits: fallback.traits,
  };
}

/** 当前选择对应的人格记录(供 UI 显示名字 / 音色);查不到返回 null。 */
export function findPersona(
  settings: PersonaSettings,
  personas: readonly PersonaRecord[],
): PersonaRecord | null {
  return personas.find((persona) => persona.id === settings.personaId) ?? null;
}
