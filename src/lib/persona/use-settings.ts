"use client";

/**
 * 人格 / 音色设置的客户端状态(step1 P1、P2)。
 *
 * 为什么用 useSyncExternalStore:localStorage 是 React 之外的外部数据源,
 * 这正是该 Hook 的设计场景。
 *   - SSR / hydration 阶段走 getServerSnapshot 返回默认值常量(引用稳定),
 *     水合完成后自动切换到 getSnapshot 的真实值,不会触发 hydration 报错;
 *   - 相比"挂载后用 useEffect 校正"的写法,少一次级联渲染,也不命中
 *     react-hooks/set-state-in-effect 规则。
 *
 * 关于状态管理选型:ui spec §4 建议用 zustand store,但当前状态只有 3 个字段
 * (personaId / customInstructions / voice),组件树只有两层
 * (ChatPanel → SettingsSheet),props + 本 hook 完全够用。
 * 按 AGENTS.md「写到哪个功能才装哪个依赖」的约定,此处不引入 zustand;
 * 待 step2 人格入库、需要在多处共享人格列表时再评估。
 */

import { useCallback, useSyncExternalStore } from "react";
import {
  getPersonaSettingsSnapshot,
  getServerPersonaSettingsSnapshot,
  savePersonaSettings,
  subscribePersonaSettings,
  type PersonaSettings,
} from "./settings";

export interface UsePersonaSettingsResult {
  settings: PersonaSettings;
  update: (patch: Partial<PersonaSettings>) => void;
}

export function usePersonaSettings(): UsePersonaSettingsResult {
  const settings = useSyncExternalStore(
    subscribePersonaSettings,
    getPersonaSettingsSnapshot,
    getServerPersonaSettingsSnapshot,
  );

  const update = useCallback((patch: Partial<PersonaSettings>) => {
    savePersonaSettings({ ...getPersonaSettingsSnapshot(), ...patch });
  }, []);

  return { settings, update };
}
