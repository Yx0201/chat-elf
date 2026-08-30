/**
 * 人格的**类型与纯常量**(step2 T1)。
 *
 * 为什么单独一个文件、且与 `repository.ts` 分开:
 * 客户端组件(编辑器)需要 `PersonaRecord` / `PersonaDraft` 类型和长度上限常量,
 * 而 repository 依赖 `@/lib/db/client` → `pg`。若从 repository 导入这些,
 * 打包器会把整个 pg 拖进客户端 bundle,构建直接报错
 * (`Module not found: Can't resolve 'util/types'`)。
 *
 * 因此本文件的**唯一约束是:不得 import 任何服务端模块**。
 */

import type { PersonaTraits } from "./traits";

export interface PersonaRecord {
  /** 预设为 archetype(如 'xiaoyou'),自建为 uuid */
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  /** 模板来源 id;自建人格为 null */
  archetype: string | null;
  traits: PersonaTraits;
  voice: string;
  backstory: string;
  boundaries: string;
  isPreset: boolean;
}

export interface PersonaDraft {
  name: string;
  emoji: string;
  tagline: string;
  traits: PersonaTraits;
  voice: string;
  backstory: string;
  boundaries: string;
}

/** 名字 / 背景 / 边界的长度上限,防用户粘贴超长文本撑爆 prompt 与存储。 */
export const MAX_NAME_LENGTH = 24;
export const MAX_TEXTAREA_LENGTH = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 是否合法的人格主键(uuid)。
 * 预设的对外 id 是 archetype 字符串,不是 uuid —— 用它区分"库里的自建人格"
 * 与"预设",决定是否写 conversations.persona_id 外键。
 */
export function isValidPersonaId(id: string): boolean {
  return UUID_RE.test(id);
}
