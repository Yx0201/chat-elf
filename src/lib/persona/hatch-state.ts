/**
 * 孵化一次性状态(2026-08-31 UI 大一统新增)。
 *
 * 产品语义:人格与音色只在**孵化时设置一次**,确认后不可修改 ——
 * 「TA 就是往后一直陪伴你的那个角色」。
 *
 * 当前无账号体系,此标记存 localStorage(与 use-settings.ts 同前缀、
 * 同 SSR 守卫策略)。未来引入账号体系时,孵化的"一次性"约束应归入
 * user 记录(用户级一次性),此标记随之废弃。
 */

const STORAGE_PREFIX = "chat-elf:";
const HATCH_KEY = `${STORAGE_PREFIX}hatched`;

export interface HatchRecord {
  /** 定格的人格 id(预设 archetype / 自建 uuid / CUSTOM_PERSONA_ID) */
  personaId: string;
  /** 定格的音色 */
  voice: string;
  /** 孵化完成时刻(ISO),仅做记录用途 */
  hatchedAt: string;
}

/** 是否已完成孵化;SSR 与服务端一律 false(登录跳转只会发生在浏览器)。 */
export function isHatched(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(HATCH_KEY) !== null;
  } catch {
    return false;
  }
}

/** 完成孵化:写入一次性标记(调用方已同步把人格/音色写入 settings)。 */
export function completeHatch(input: { personaId: string; voice: string }): void {
  if (typeof window === "undefined") return;
  const record: HatchRecord = {
    personaId: input.personaId,
    voice: input.voice,
    hatchedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(HATCH_KEY, JSON.stringify(record));
  } catch {
    // 忽略:配额耗尽/无痕模式(标记失败只影响下次进站的跳转,不打断当前流程)
  }
}