"use client";

/**
 * 拟态球常驻层（跨路由共享，spec §4.3 硬规则）。
 *
 * 架构：球本体渲染在 Provider 的 fixed 层里，随路由切换**不卸载**；
 * 各页面用 <BallAnchor> 在自己的布局里放一个占位 div（尺寸即球的尺寸），
 * Anchor 测量占位 rect 后注册给 Provider，球从旧位置 morph/飞行到新位置，
 * 页面内容同时做 180ms 淡入 —— 这就是「球跟着转，页面围着球转」。
 *
 * 交互命令（setBallState / flash / swirl / triggerBurst / setGazeDir / setTilt）
 * 由页面通过 useBall() 调用，全部作用在同一个球实例上。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { MimicBall } from "./mimic-ball";
import type { BallApi, BallState, BallVariant, RestGaze } from "./types";

export interface BallAnchorData {
  x: number;
  y: number;
  size: number;
  variant: BallVariant;
  state: BallState;
  /** 页面级休眠视线(见 types.ts):不传保持引擎默认的 bloub 右上侧脸 */
  restGaze?: RestGaze;
}

export interface BallCtl {
  /** 注册/更新锚点（幂等更新；size 取占位元素实测宽度） */
  registerAnchor(data: BallAnchorData): void;
  /** 锚点卸载：延迟 320ms 再隐藏，给下一个页面的锚点留出接管窗口 */
  unregisterAnchor(): void;
  /** 设置常态球态 */
  setBallState(state: BallState): void;
  /** 临时态（wink/sleep/alert 等一闪而过，ms 后回落） */
  flash(state: BallState, ms: number): void;
  /** 触发彩虹爆散(陪伴/字幕切换等编排用;点击球的默认反应已改为千鸟纹波) */
  triggerBurst(): void;
  /** 旋转一圈（保存人格 / 换预设的转场） */
  swirl(): void;
  /** 路由跳转前预演下一场景的常态球态：morph 立刻开始，与页面切换时间重叠 */
  presetMorph(state: BallState): void;
  /**
   * 立即开始隐藏常驻球层(模式切换编排用)。与 unregisterAnchor 的 320ms
   * 延迟不同——那是给路由转场留"下一页锚点接管"的窗口;同页模式切换
   * 没有下一个锚点,不该等,否则缩小中的球会与新模式内容同屏残留。
   */
  dismiss(): void;
  /** gaze 方向覆盖（-1..1），null 回退鼠标跟随 */
  setGazeDir(dir: { x: number; y: number } | null): void;
  /** 整球倾斜角（历史页滚动 → 彗星尾巴相位） */
  setTilt(deg: number): void;
}

const BallContext = createContext<BallCtl | null>(null);

export function BallProvider({ children }: { children: ReactNode }) {
  const [anchor, setAnchor] = useState<BallAnchorData | null>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<BallState>("idle");
  const [flashState, setFlashState] = useState<BallState | null>(null);
  const [tilt, setTiltState] = useState(0);
  const [gazeDir, setGazeDirState] = useState<{ x: number; y: number } | null>(null);

  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ballApiRef = useRef<BallApi | null>(null);
  /** 跳转前预演的球态:同位置的重复测量不得把它冲掉(见 registerAnchor) */
  const pendingStateRef = useRef<{ state: BallState; x: number; y: number; size: number; at: number } | null>(null);
  const anchorRef = useRef<BallAnchorData | null>(null);

  useEffect(() => {
    anchorRef.current = anchor;
  }, [anchor]);

  const registerAnchor = useCallback((data: BallAnchorData) => {
    clearTimeout(hideTimer.current);
    setAnchor(data);
    setVisible(true);
    // 预演窗口(2s)内、位置基本未变的注册 = 本页锚点的重复测量:
    // 只更新坐标,不覆盖 presetMorph 预演的球态;
    // 位置明显改变 = 新页面接管锚点,预演结束,球态以新页面为准。
    const pending = pendingStateRef.current;
    const sameSpot =
      pending !== null &&
      performance.now() - pending.at < 2000 &&
      Math.abs(data.x - pending.x) < 40 &&
      Math.abs(data.y - pending.y) < 40 &&
      data.size === pending.size;
    if (!sameSpot) {
      pendingStateRef.current = null;
      setState(data.state);
    }
  }, []);

  const unregisterAnchor = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), 320);
  }, []);

  const setBallState = useCallback((s: BallState) => setState(s), []);

  const flash = useCallback((s: BallState, ms: number) => {
    clearTimeout(flashTimer.current);
    setFlashState(s);
    flashTimer.current = setTimeout(() => setFlashState(null), ms);
  }, []);

  const triggerBurst = useCallback(() => {
    ballApiRef.current?.burst();
  }, []);

  /** bloub swirl 态：三环入场 + 眼绕球面整圈（球本体不卸载，spec §4.3） */
  const swirl = useCallback(() => {
    ballApiRef.current?.swirl();
  }, []);

  /**
   * 跳转前的球态预演:引擎立刻开始 morph,让变形与随后的页面切换重叠。
   * 预演的球态在 2s 窗口内免疫本页锚点的重复测量(registerAnchor 同位置判定)。
   */
  const presetMorph = useCallback((s: BallState) => {
    const a = anchorRef.current;
    pendingStateRef.current =
      a === null ? null : { state: s, x: a.x, y: a.y, size: a.size, at: performance.now() };
    setState(s);
  }, []);

  const setGazeDir = useCallback((dir: { x: number; y: number } | null) => {
    setGazeDirState(dir);
  }, []);

  const setTilt = useCallback((deg: number) => {
    setTiltState(deg);
  }, []);

  const dismiss = useCallback(() => {
    clearTimeout(hideTimer.current);
    setVisible(false);
  }, []);

  const ctl = useMemo<BallCtl>(
    () => ({
      registerAnchor,
      unregisterAnchor,
      setBallState,
      flash,
      triggerBurst,
      swirl,
      presetMorph,
      setGazeDir,
      setTilt,
      dismiss,
    }),
    [registerAnchor, unregisterAnchor, setBallState, flash, triggerBurst, swirl, presetMorph, setGazeDir, setTilt, dismiss],
  );

  useEffect(
    () => () => {
      clearTimeout(hideTimer.current);
      clearTimeout(flashTimer.current);
    },
    [],
  );

  const handleReady = useCallback((api: BallApi) => {
    ballApiRef.current = api;
  }, []);

  const displayState = flashState ?? state;
  const variant = anchor?.variant ?? "ink";

  return (
    <BallContext.Provider value={ctl}>
      {children}
      {/* 常驻球层：fixed 定位，位置/尺寸向锚点过渡 */}
      <div
        aria-hidden
        className="pointer-events-none fixed z-40"
        style={{
          left: `${anchor?.x ?? 0}px`,
          top: `${anchor?.y ?? 0}px`,
          width: `${anchor?.size ?? 0}px`,
          height: `${anchor?.size ?? 0}px`,
          opacity: visible ? 1 : 0,
          transform: visible ? "scale(1)" : "scale(0.6)",
          transition:
            "left 300ms cubic-bezier(0.22,1,0.36,1), top 300ms cubic-bezier(0.22,1,0.36,1), width 400ms cubic-bezier(0.22,1,0.36,1), height 400ms cubic-bezier(0.22,1,0.36,1), opacity 300ms ease, transform 400ms cubic-bezier(0.22,1,0.36,1)",
          visibility: visible ? "visible" : "hidden",
        }}
      >
        <div
          className="h-full w-full"
          style={{ transform: tilt !== 0 ? `rotate(${tilt}deg)` : undefined, transition: "transform 200ms ease-out" }}
        >
          <MimicBall
            state={displayState}
            variant={variant}
            gazeOverride={gazeDir}
            restGaze={anchor?.restGaze ?? null}
            onReady={handleReady}
          />
        </div>
      </div>
    </BallContext.Provider>
  );
}

export function useBall(): BallCtl {
  const ctx = useContext(BallContext);
  if (ctx === null) throw new Error("useBall 必须在 <BallProvider> 内使用");
  return ctx;
}

/* ---------- 锚点占位组件 ---------- */

export interface BallAnchorProps {
  /** 进入页面时的初始球态 */
  state: BallState;
  variant?: BallVariant;
  /** 页面级休眠视线(如 chat 页传 {yaw:0,pitch:10} 正视);不传用引擎默认 */
  restGaze?: RestGaze;
  /** 尺寸由 className 控制（如 w-40 h-40 lg:w-56 lg:h-56），实测取宽 */
  className?: string;
}

export function BallAnchor({ state, variant = "ink", restGaze, className }: BallAnchorProps) {
  const ctl = useBall();
  const ref = useRef<HTMLDivElement | null>(null);

  // 挂载期注册 + 卸载期注销（不依赖 state，避免状态更新引发注销闪隐）
  useEffect(() => {
    return () => {
      ctl.unregisterAnchor();
    };
  }, [ctl]);

  // 测量与更新（state/variant 变化、窗口缩放、页面滚动都重测）
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;

    let raf = 0;
    const measure = () => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = el.getBoundingClientRect();
        if (r.width === 0) return;
        ctl.registerAnchor({
          x: r.left,
          y: r.top,
          size: r.width,
          variant,
          state,
          ...(restGaze === undefined ? {} : { restGaze }),
        });
      });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true });
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
    };
  }, [ctl, state, variant, restGaze]);

  return <div ref={ref} aria-hidden className={className} />;
}
