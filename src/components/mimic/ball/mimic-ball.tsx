"use client";

/**
 * 拟态球本体（bloub 引擎的 React 驱动层）。
 *
 * 几何与动画不再取自 Ardot 设计稿的平面坐标——按用户拍板（2026-08-30），
 * 整体切换为 bloub 仓库的同源引擎（./engine/，自 src/bot/* 移植）：
 * 眼睛是画在球面上的 3D 切面投影（正视镜头、双眼正中对称），
 * 状态切换走 easeOutQuint morph，眨眼/漂移/呼吸全部为确定性函数。
 * 各状态姿态、时长、缓动的实测值见 ./engine/states.ts。
 *
 * 交互硬规则（spec §4）：
 * - 状态切换走 morph（指数缓出，禁弹簧过冲）；
 * - 鼠标跟随只改 gaze（绝对 yaw/pitch 替换姿态轴），忽略触摸指针；
 * - burst / swirl 是短暂过渡态，执行完自动落回当前常态。
 *
 * 渲染：rAF 逐帧采样引擎并直写 DOM refs（不经 React 状态），
 * 与 bloub 的 BloubBot.vue 同构。逐帧读取的可变值（颜色/方向覆盖/
 * 交互开关）一律走 ref 同步——主循环只在挂载时启动一次，
 * 时钟（clockRef）单调递增，重启会让引擎时间轴（按旧时钟记录的
 * morph 起点）整体错位、动画冻住。
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { BotEngine, type BotFrame } from "./engine/engine";
import { NOTIF_BLUE, type DotRender, mixHex } from "./engine/decor";
import { STATE_BY_ID } from "./engine/states";
import { clamp, easings } from "./engine/math";
import type { BallApi, BallState, BallVariant, RestGaze } from "./types";

/* ---------- 常量 ---------- */

const INK = "#0A0A0C"; // ballInk（深色球体）
const LIGHT = "#F6F5F4"; // surface（浅色球体，深色舞台反色用）
const PAPER = "#FFFFFF"; // 眼白（ink 变体）/ 眼黑（light 变体）

/** 球静止半径，viewBox 单位（bloub RAYON=100，这里按 120 视窗折算）。 */
const R = 54;
/** 视窗半宽。环的最远 1.4R≈76 超出视窗，由 svg overflow-visible 兜住。 */
const VB = 60;

/** 光标跟随的注视角幅（bloub src/ui/gaze.ts：CHOISI 值）。 */
const YAW_MAX = 16;
const PITCH_MAX = 13;
/** 光标居中时的注视高度（微仰，显得 attent）。 */
const PITCH = 10;
/**
 * 鼠标跟随的入场一整圈（SPIN 360° / TURN_TIME 1.1s，bloub 的「Le tour」）
 * 已按用户拍板移除（2026-08-31）：目光直接跟随光标,只保留引擎默认的
 * LOOK_MORPH 0.24s 快速追赶。SPIN 仍被 swirl(千鸟纹波)使用。
 */
const SPIN = 360;
/** swirl 脚本时长（bloub TOUR_TIME）。 */
const SWIRL_TIME = 1.5;

/** 状态展示名（aria 用）。 */
const STATE_LABEL: Record<BallState, string> = {
  idle: "待机",
  wide: "聆听",
  thinking: "思考",
  wink: "回应",
  notify: "有新记忆",
  egg: "孵化中",
  sleep: "休眠",
  orbit: "转场",
  hexagon: "性格",
  comet: "历史",
  alert: "出错了",
  exclaim: "感叹号",
  shy: "羞怯",
  doubt: "怀疑",
  calm: "平静",
};

/** 装饰槽位上限：最坏的交叉淡入（orbit 6 环 + comet 4 缎带）需要 10。 */
const ARC_SLOTS = 10;
/** 圆点槽位上限：burst 5 粒 + 前态 2 点的交叉。 */
const DOT_SLOTS = 8;

export interface MimicBallProps {
  state: BallState;
  /** 深色舞台用 light（浅体深眼），默认 ink（深体白眼） */
  variant?: BallVariant;
  className?: string;
  /** gaze 方向覆盖（-1..1，用于滑块联动）；null 时回退鼠标跟随 */
  gazeOverride?: { x: number; y: number } | null;
  /**
   * 页面级休眠视线（度）。提供时覆盖引擎默认 REST_GAZE（bloub 右上侧脸）——
   * 如 chat 页传 {yaw:0, pitch:0, roll:0} 用彻底正视。同时是跟随的
   * pitch 基线与 roll;仅作用于静止脸状态,指针跟随仍优先。
   */
  restGaze?: RestGaze | null;
  /** 是否启用点击 burst 与鼠标 gaze（默认 true） */
  interactive?: boolean;
  /** 暴露命令式 API（burst / swirl） */
  onReady?: (api: BallApi) => void;
}

/* ---------- 组件 ---------- */

export function MimicBall({
  state,
  variant = "ink",
  className,
  gazeOverride = null,
  restGaze = null,
  interactive = true,
  onReady,
}: MimicBallProps) {
  const inkColor = variant === "ink" ? INK : LIGHT;
  const paperColor = variant === "ink" ? PAPER : INK;

  // 引擎惰性初始化（useState initializer 只跑一次，纯函数、非空）
  const [engine] = useState(() => new BotEngine(R, state));
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const clipId = `mimic-clip-${uid}`;
  const maskId = `mimic-mask-${uid}`;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const clockRef = useRef(0);
  /** 鼠标最后已知位置（client 坐标）；null = 无指针。 */
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const aimingRef = useRef(false);
  /** swirl 脚本的起始时钟；null = 未在播。 */
  const swirlSinceRef = useRef<number | null>(null);
  /** burst 结束时刻；null = 未在播。 */
  const burstUntilRef = useRef<number | null>(null);
  /** 最新常态（burst/swirl 结束后落回）。 */
  const stateRef = useRef<BallState>(state);

  // 逐帧循环读取的可变值走 ref（见文件头说明）
  const inkRef = useRef(inkColor);
  const paperRef = useRef(paperColor);
  const gazeOverrideRef = useRef(gazeOverride);
  const restGazeRef = useRef(restGaze);
  const interactiveRef = useRef(interactive);
  useEffect(() => {
    inkRef.current = inkColor;
    paperRef.current = paperColor;
    gazeOverrideRef.current = gazeOverride;
    restGazeRef.current = restGaze;
    interactiveRef.current = interactive;
  }, [inkColor, paperColor, gazeOverride, restGaze, interactive]);

  /* ----- DOM refs（逐帧直写） ----- */
  const bodyGroupRef = useRef<SVGGElement | null>(null);
  const bodyFillRef = useRef<SVGPathElement | null>(null);
  const maskBodyRef = useRef<SVGPathElement | null>(null);
  const clipBodyRef = useRef<SVGPathElement | null>(null);
  const notchRef = useRef<SVGCircleElement | null>(null);
  const eyeRefs = useRef<Array<SVGPathElement | null>>([null, null]);
  const notifRef = useRef<SVGCircleElement | null>(null);
  /** 画在身体之前的圆点槽（burst 粒子从球后绕行） */
  const dotSlotsBehind = useRef<Array<SVGGElement | null>>([]);
  /** 画在身体之后的圆点槽（thinking 三点 / alert 泪滴） */
  const dotSlotsFront = useRef<Array<SVGGElement | null>>([]);
  const arcFront = useRef<Array<SVGPathElement | null>>([]);
  const arcBack = useRef<Array<SVGPathElement | null>>([]);

  /* ----- 指针监听（桌面精确指针；H5 不跟随手指，spec §4.1） ----- */
  useEffect(() => {
    if (!interactive) return;
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    const onMove = (e: MouseEvent): void => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
    };
    const onLeave = (): void => {
      pointerRef.current = null;
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, [interactive]);

  /* ----- 状态 prop → 引擎（clock 由循环推进） ----- */
  useEffect(() => {
    stateRef.current = state;
    engine.setState(state, clockRef.current);
  }, [engine, state]);

  /* ----- 命令式 API ----- */
  const burst = useCallback(() => {
    if (burstUntilRef.current !== null || swirlSinceRef.current !== null) return;
    const now = clockRef.current;
    engine.setState("burst", now);
    // minDuration 2.4 + 0.05 缓冲后落回常态
    burstUntilRef.current = now + 2.45;
  }, [engine]);

  const swirl = useCallback(() => {
    if (burstUntilRef.current !== null || swirlSinceRef.current !== null) return;
    const now = clockRef.current;
    engine.setState("swirl", now);
    swirlSinceRef.current = now;
  }, [engine]);

  const api = useMemo<BallApi>(() => ({ burst, swirl }), [burst, swirl]);

  useEffect(() => {
    onReady?.(api);
  }, [api, onReady]);

  /* ----- 主循环：采样 + 直写 DOM（只在挂载时启动一次） ----- */
  useEffect(() => {
    const t0 = performance.now();
    let raf = requestAnimationFrame(tick);

    function tick(nowMs: number): void {
      const now = (nowMs - t0) / 1000;
      clockRef.current = now;

      // burst 到点落回常态
      if (burstUntilRef.current !== null && now >= burstUntilRef.current) {
        burstUntilRef.current = null;
        engine.setState(stateRef.current, now);
      }

      // swirl 脚本：眼绕球面整一圈（ease-in-out 是「物体在转」，
      // 不是「数值落定」——勿改成 ease-out），结束释放回指针/常态
      const swirlSince = swirlSinceRef.current;
      if (swirlSince !== null) {
        const t = now - swirlSince;
        if (t <= SWIRL_TIME) {
          engine.setLook(
            {
              yaw: 0,
              pitch: 0,
              mix: 0,
              spin: SPIN * (1 - easings.easeInOutCubic(clamp(t / SWIRL_TIME))),
              wander: 1,
            },
            now,
            1 / 60,
          );
        } else {
          swirlSinceRef.current = null;
          engine.setLook(null, now);
          engine.setState(stateRef.current, now);
        }
      } else {
        const gazeOverride = gazeOverrideRef.current;
        if (gazeOverride !== null) {
          // 外部方向覆盖（滑块联动）：绝对瞄准，无漂移
          engine.setLook(
            {
              yaw: clamp(gazeOverride.x) * YAW_MAX,
              pitch: PITCH - clamp(gazeOverride.y) * PITCH_MAX,
              mix: 1,
              spin: 0,
              wander: 0,
            },
            now,
          );
        } else {
          // 指针跟随：静止脸状态 + 聆听态(wide)都跟随 —— 录音中球也要看着
          // 用户(2026-08-31 用户反馈"点击录音后视角锁定")。2026-08-31 同日
          // 拍板移除「入场整圈」：目光直接追光标，由引擎默认 LOOK_MORPH
          // 0.24s 快速追赶,不再绕球面旋转。
          const def = STATE_BY_ID.get(stateRef.current);
          const pointer = pointerRef.current;
          const followable = def?.baseFace === true || stateRef.current === "wide";
          if (followable && pointer !== null && interactiveRef.current) {
            const box = wrapRef.current?.getBoundingClientRect();
            // 无面积的盒子（浏览器窗格隐藏时会出现）没有可瞄准的东西，
            // 且下面的归一化会变成 0/0 —— NaN 会被引擎永久保留
            if (box !== undefined && box.width > 0 && box.height > 0) {
              aimingRef.current = true;
              const demiW = Math.max(1, window.innerWidth / 2);
              const demiH = Math.max(1, window.innerHeight / 2);
              // 页面休眠视线同时是跟随的基线(正视页 pitch 基线 0、roll 0)
              const base = restGazeRef.current;
              engine.setLook(
                {
                  yaw: clamp((pointer.x - (box.left + box.width / 2)) / demiW, -1, 1) * YAW_MAX,
                  pitch: (base?.pitch ?? PITCH) - clamp((pointer.y - (box.top + box.height / 2)) / demiH, -1, 1) * PITCH_MAX,
                  mix: 1,
                  spin: 0,
                  wander: 0,
                  ...(base?.roll === undefined ? {} : { roll: base.roll }),
                },
                now,
              );
            }
          } else if (aimingRef.current) {
            // 光标离开：同样快速回落到休眠姿态，不绕圈
            engine.setLook(null, now);
            aimingRef.current = false;
          }
          // 页面级休眠视线（如 chat 页正视）:静止脸且无指针跟随时,
          // 每帧锚定到页面指定朝向,覆盖引擎默认的 bloub 右上侧脸
          const rest = restGazeRef.current;
          if (rest !== null && def?.baseFace === true && !aimingRef.current) {
            engine.setLook(
              {
                yaw: rest.yaw,
                pitch: rest.pitch,
                mix: 1,
                spin: 0,
                wander: 1,
                ...(rest.roll === undefined ? {} : { roll: rest.roll }),
              },
              now,
            );
          }
        }
      }

      apply(engine.sample(now));
      raf = requestAnimationFrame(tick);
    }

    function apply(frame: BotFrame): void {
      const ink = inkRef.current;
      const paper = paperRef.current;

      if (bodyGroupRef.current !== null) bodyGroupRef.current.setAttribute("opacity", `${frame.bodyAlpha}`);
      const d = frame.bodyPath;
      bodyFillRef.current?.setAttribute("d", d);
      maskBodyRef.current?.setAttribute("d", d);
      clipBodyRef.current?.setAttribute("d", d);

      // 身体豁口（notify 蓝点周围）
      if (notchRef.current !== null) {
        if (frame.notch !== null) {
          notchRef.current.setAttribute("cx", `${frame.notch.x}`);
          notchRef.current.setAttribute("cy", `${frame.notch.y}`);
          notchRef.current.setAttribute("r", `${frame.notch.r}`);
        } else {
          notchRef.current.setAttribute("r", "0");
        }
      }

      // 双眼
      for (let i = 0; i < 2; i++) {
        const el = eyeRefs.current[i];
        if (el === null || el === undefined) continue;
        const eye = frame.eyes[i];
        if (eye === undefined) {
          el.setAttribute("opacity", "0");
        } else {
          el.setAttribute("d", eye.d);
          el.setAttribute("transform", eye.matrix);
          el.setAttribute("opacity", `${eye.alpha}`);
          el.setAttribute("fill", paper);
        }
      }

      // notify 蓝点
      if (notifRef.current !== null) {
        if (frame.notif !== null) {
          notifRef.current.setAttribute("cx", `${frame.notif.x}`);
          notifRef.current.setAttribute("cy", `${frame.notif.y}`);
          notifRef.current.setAttribute("r", `${frame.notif.r}`);
          notifRef.current.setAttribute("opacity", "1");
        } else {
          notifRef.current.setAttribute("opacity", "0");
        }
      }

      // 圆点（burst 粒子 / thinking / alert 泪滴）：
      // dotsBehind 时画进身后的槽（被身体吞没），否则画在身前
      const activeSlots = frame.dotsBehind ? dotSlotsBehind : dotSlotsFront;
      const clearedSlots = frame.dotsBehind ? dotSlotsFront : dotSlotsBehind;
      for (let i = 0; i < DOT_SLOTS; i++) {
        const slot = activeSlots.current[i];
        const clear = clearedSlots.current[i];
        const dot = frame.dots[i];
        if (slot !== undefined && slot !== null) applyDot(slot, dot, ink, paper);
        if (clear !== undefined && clear !== null) applyDot(clear, undefined, ink, paper);
      }

      // 弧（环 / 缎带）：front 段盖在身体上，back 段被身体遮挡
      for (let i = 0; i < ARC_SLOTS; i++) {
        const frontEl = arcFront.current[i];
        const backEl = arcBack.current[i];
        if (frontEl === undefined || frontEl === null) continue;
        if (backEl === undefined || backEl === null) continue;
        const arc = frame.arcs[i];
        if (arc === undefined) {
          frontEl.setAttribute("d", "");
          frontEl.setAttribute("opacity", "0");
          backEl.setAttribute("d", "");
          backEl.setAttribute("opacity", "0");
          continue;
        }
        frontEl.setAttribute("d", arc.front);
        frontEl.setAttribute("stroke-width", `${arc.width}`);
        frontEl.setAttribute("opacity", `${arc.opacity}`);
        backEl.setAttribute("d", arc.back);
        backEl.setAttribute("stroke-width", `${arc.width}`);
        backEl.setAttribute("opacity", `${arc.opacity}`);
        const grad = document.getElementById(`${uid}-arc-grad-${i}`);
        if (grad !== null && grad instanceof SVGLinearGradientElement) {
          grad.setAttribute("x1", `${arc.grad.x1}`);
          grad.setAttribute("y1", `${arc.grad.y1}`);
          grad.setAttribute("x2", `${arc.grad.x2}`);
          grad.setAttribute("y2", `${arc.grad.y2}`);
          const stops = grad.querySelectorAll("stop");
          arc.grad.stops.forEach((c, j) => {
            stops[j]?.setAttribute("stop-color", c);
          });
        }
      }
    }

    function applyDot(slot: SVGGElement, dot: DotRender | undefined, ink: string, paper: string): void {
      const circleEl = slot.querySelector("circle");
      const pathEl = slot.querySelector("path");
      if (dot === undefined) {
        slot.setAttribute("opacity", "0");
        return;
      }
      slot.setAttribute("opacity", "1");
      const fill = dot.color ?? (dot.depth === undefined ? ink : mixHex(paper, ink, dot.depth));
      if (dot.d !== undefined && pathEl instanceof SVGPathElement) {
        pathEl.setAttribute("d", dot.d);
        pathEl.setAttribute(
          "transform",
          `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${R})`,
        );
        pathEl.setAttribute("fill", fill);
        pathEl.setAttribute("opacity", `${dot.opacity}`);
        if (circleEl !== null) circleEl.setAttribute("opacity", "0");
      } else if (circleEl !== null) {
        circleEl.setAttribute("cx", `${dot.x}`);
        circleEl.setAttribute("cy", `${dot.y}`);
        circleEl.setAttribute("r", `${dot.r}`);
        circleEl.setAttribute("fill", fill);
        circleEl.setAttribute("opacity", `${dot.opacity}`);
        if (pathEl !== null) pathEl.setAttribute("opacity", "0");
      }
    }

    return () => cancelAnimationFrame(raf);
  }, [engine, uid]);

  const label = STATE_LABEL[state] ?? (state as string);

  return (
    <div
      ref={wrapRef}
      className={`h-full w-full ${className ?? ""} ${interactive ? "pointer-events-auto" : "pointer-events-none"}`}
      onClick={interactive ? swirl : undefined}
      style={{ cursor: interactive ? "pointer" : "default" }}
      role="img"
      aria-label={`拟态球：${label}`}
    >
      <svg viewBox={`${-VB} ${-VB} ${VB * 2} ${VB * 2}`} className="h-full w-full overflow-visible">
        <defs>
          {/* 眼是画上去的（双变体需要反色眼），但裁进身体轮廓防止滑出边缘 */}
          <clipPath id={clipId}>
            <path ref={clipBodyRef} d="" />
          </clipPath>
          {/* 身体的豁口罩：notify 蓝点周围的环形空隙（bloub 的 mask 方案） */}
          <mask id={maskId} maskUnits="userSpaceOnUse" x={-VB * 1.5} y={-VB * 1.5} width={VB * 3} height={VB * 3}>
            <path ref={maskBodyRef} d="" fill="#fff" />
            <circle ref={notchRef} cx="0" cy="0" r="0" fill="#000" />
          </mask>
          {Array.from({ length: ARC_SLOTS }, (_, i) => (
            <linearGradient
              key={i}
              id={`${uid}-arc-grad-${i}`}
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1="0"
              x2="0"
              y2="0"
            >
              <stop offset="0" />
              <stop offset="0.5" />
              <stop offset="1" />
            </linearGradient>
          ))}
        </defs>

        {/* 身体后的一半弧线（被身体遮挡 → 读作轨道） */}
        <g fill="none" strokeLinecap="round">
          {Array.from({ length: ARC_SLOTS }, (_, i) => (
            <path
              key={i}
              ref={(el) => {
                arcBack.current[i] = el;
              }}
              d=""
              stroke={`url(#${uid}-arc-grad-${i})`}
            />
          ))}
        </g>

        {/* 身后圆点（burst 粒子绕到球后被吞没） */}
        <g>
          {Array.from({ length: DOT_SLOTS }, (_, i) => (
            <g
              key={i}
              ref={(el) => {
                dotSlotsBehind.current[i] = el;
              }}
            >
              <circle opacity="0" />
              <path opacity="0" />
            </g>
          ))}
        </g>

        {/* 身体（mask 且回 notify 豁口）+ 双眼（裁进轮廓） */}
        <g ref={bodyGroupRef}>
          <path ref={bodyFillRef} d="" fill={inkColor} mask={`url(#${maskId})`} />
          <g clipPath={`url(#${clipId})`}>
            <path
              ref={(el) => {
                eyeRefs.current[0] = el;
              }}
              d=""
              fill={paperColor}
              opacity="0"
            />
            <path
              ref={(el) => {
                eyeRefs.current[1] = el;
              }}
              d=""
              fill={paperColor}
              opacity="0"
            />
          </g>
        </g>

        {/* 身前圆点（thinking 三点 / alert 泪滴） */}
        <g>
          {Array.from({ length: DOT_SLOTS }, (_, i) => (
            <g
              key={i}
              ref={(el) => {
                dotSlotsFront.current[i] = el;
              }}
            >
              <circle opacity="0" />
              <path opacity="0" />
            </g>
          ))}
        </g>

        {/* notify 蓝点 */}
        <circle ref={notifRef} cx="0" cy="0" r="0" fill={NOTIF_BLUE} opacity="0" />

        {/* 身前的一半弧线 */}
        <g fill="none" strokeLinecap="round">
          {Array.from({ length: ARC_SLOTS }, (_, i) => (
            <path
              key={i}
              ref={(el) => {
                arcFront.current[i] = el;
              }}
              d=""
              stroke={`url(#${uid}-arc-grad-${i})`}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}
