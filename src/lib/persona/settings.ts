/**
 * 人格 / 音色设置的本地持久化(step1 P1、P2)。
 *
 * 本期存 localStorage(spec P1 明确要求),P4 落库后迁移至 conversations.persona。
 * key 前缀统一 `chat-elf:`(ui spec §4 约定)。
 *
 * SSR 安全:本模块会被 Server Component 间接引用(经客户端组件),
 * 所有 localStorage 访问都做 `typeof window` 守卫并吞掉异常
 * (Safari 无痕模式、配额耗尽、用户禁用存储都会抛错,设置项失败不应拖垮对话页)。
 */

import {
  CUSTOM_PERSONA_ID,
  DEFAULT_PERSONA_ID,
  findPreset,
  PERSONA_PRESETS,
} from "./presets";
import { DEFAULT_VOICE, isKnownVoice } from "./voices";

const STORAGE_PREFIX = "chat-elf:";
const SETTINGS_KEY = `${STORAGE_PREFIX}settings`;

/** 单条设置的最大存储长度,防用户粘贴超长文本撑爆配额。 */
const MAX_CUSTOM_LENGTH = 4000;

export interface PersonaSettings {
  /** 预设人格 id,或 CUSTOM_PERSONA_ID */
  personaId: string;
  /** personaId === CUSTOM_PERSONA_ID 时生效的自定义人设文案 */
  customInstructions: string;
  /** session.update.voice 取值 */
  voice: string;
}

function defaultVoiceFor(personaId: string): string {
  return findPreset(personaId)?.voice ?? DEFAULT_VOICE;
}

export const DEFAULT_SETTINGS: PersonaSettings = {
  personaId: DEFAULT_PERSONA_ID,
  customInstructions: "",
  voice: defaultVoiceFor(DEFAULT_PERSONA_ID),
};

/** localStorage 的内容是用户可改的不可信输入,逐字段收窄后再用。 */
function parseSettings(raw: unknown): PersonaSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const personaId =
    typeof record.personaId === "string" &&
    (record.personaId === CUSTOM_PERSONA_ID ||
      PERSONA_PRESETS.some((p) => p.id === record.personaId))
      ? record.personaId
      : null;

  const customInstructions =
    typeof record.customInstructions === "string"
      ? record.customInstructions.slice(0, MAX_CUSTOM_LENGTH)
      : "";

  // 音色允许任意非空字符串:声音复刻音色的 voice_id 不在系统清单内
  const voice =
    typeof record.voice === "string" && record.voice.trim() !== ""
      ? record.voice.trim()
      : null;

  if (personaId === null) return null;

  return {
    personaId,
    customInstructions,
    voice: voice ?? defaultVoiceFor(personaId),
  };
}

/** 读取设置;无存储 / 存储损坏 / 环境不支持时回落到默认值。 */
export function loadPersonaSettings(): PersonaSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    return parseSettings(JSON.parse(raw)) ?? DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/* ------------------------------------------------------------------ */
/* 外部存储订阅(供 useSyncExternalStore 使用)                          */
/* ------------------------------------------------------------------ */

const listeners = new Set<() => void>();

let cachedSnapshot: PersonaSettings = DEFAULT_SETTINGS;
/** false = 尚未读取,或已被其他标签页的写入作废 —— 下次 getSnapshot 重读。 */
let snapshotFresh = false;

/**
 * useSyncExternalStore 的快照必须返回**稳定引用**(每次返回新对象会导致无限重渲染),
 * 故解析结果在此缓存。
 */
export function getPersonaSettingsSnapshot(): PersonaSettings {
  if (!snapshotFresh) {
    cachedSnapshot = loadPersonaSettings();
    snapshotFresh = true;
  }
  return cachedSnapshot;
}

/** SSR / hydration 阶段一律返回默认值常量(引用稳定,不会触发 hydration 报错)。 */
export function getServerPersonaSettingsSnapshot(): PersonaSettings {
  return DEFAULT_SETTINGS;
}

function emitChange(): void {
  for (const listener of listeners) listener();
}

/** 跨标签页同步:storage 事件只在**其他**标签页写入时触发。 */
function handleStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== SETTINGS_KEY) return;
  snapshotFresh = false;
  emitChange();
}

export function subscribePersonaSettings(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

/** 写入设置;失败静默(设置属非关键路径,不打断对话)。 */
export function savePersonaSettings(settings: PersonaSettings): void {
  const next: PersonaSettings = {
    personaId: settings.personaId,
    customInstructions: settings.customInstructions.slice(0, MAX_CUSTOM_LENGTH),
    voice: settings.voice,
  };
  // 先更新内存快照:即使写入失败(配额/无痕模式),本会话内的 UI 仍保持一致
  cachedSnapshot = next;
  snapshotFresh = true;

  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // 忽略:配额耗尽或无痕模式
  }
  emitChange();
}

/** 当前设置对应的音色是否在官方清单内(UI 用于提示"非系统音色")。 */
export function usesCustomVoice(settings: PersonaSettings): boolean {
  return !isKnownVoice(settings.voice);
}
