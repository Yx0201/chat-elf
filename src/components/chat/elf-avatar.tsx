"use client";

/**
 * chat-elf 拟人化表情头像。
 *
 * 架构移植自 /Users/bbimasheep/code/learn/bloub(对 x.ai 机器人头像的参数化复刻):
 * 表情 = 一组纯数字参数(Pose),状态切换时当前参数以指数缓动滑向目标参数,
 * rAF 每帧重算 SVG —— 无动画库、无位图、任意尺寸无损。区别于 bloub 的 14 态
 * 完整复刻,这里只保留"圆体 + 双胶囊眼"的最小表达面,参数按本项目状态语义设计。
 *
 * 鼠标跟随(followCursor)同样移植 bloub 的规则:
 * - 忽略触摸指针(抬指会把目光冻在最后一个触点,读起来像 bug);
 * - pointerleave 后目光回到原位;
 * - 每帧重读 getBoundingClientRect(球移动/变尺寸时缓存中心会瞄偏),
 *   并防御零尺寸矩形(浏览器窗口遮挡时会出现,NaN 会永久卡死表情);
 * - 偏移按"半屏"归一化:视线在光标到达屏幕边缘时饱和,与球占多大面积无关;
 * - 俯仰基准略高于中心,姿态是"专注"而不是"发呆"。
 *
 * 配色取主题变量(--foreground / --background),明暗色模式自动适配。
 */

import { useEffect, useRef, useState } from "react";
import type { ElfMood } from "@/lib/realtime/mood";

export type { ElfMood };

export type ElfAvatarState =
  | "idle"
  | "connecting"
  | "listening"
  | "user-speaking"
  | "thinking"
  | "speaking"
  | "oops";

/** 单只眼睛:相对体心偏移与胶囊尺寸(体半径 = 100)。 */
interface ElfEye {
  dx: number;
  dy: number;
  w: number;
  h: number;
  tilt: number;
}

interface ElfPose {
  sx: number;
  sy: number;
  bodyDy: number;
  rot: number;
  eyes: [ElfEye, ElfEye];
  eyeAlpha: number;
}

const BODY_R = 100;

const eye = (dx: number, dy: number, w: number, h: number, tilt = 0): ElfEye => ({
  dx,
  dy,
  w,
  h,
  tilt,
});

const mirrored = (e: ElfEye): ElfEye => ({ ...e, dx: -e.dx, tilt: -e.tilt });

function baseEyes(): [ElfEye, ElfEye] {
  // 基线:双眼微微内聚、略上扬的胶囊(亲和向)
  const left = eye(-34, -8, 24, 38, 6);
  return [left, mirrored(left)];
}

const POSES: Record<ElfAvatarState, ElfPose> = {
  // 待机:呼吸起伏,眼神平视
  idle: { sx: 1, sy: 1, bodyDy: 0, rot: 0, eyes: baseEyes(), eyeAlpha: 1 },
  // 连接中:眼睛眯成两个小点,身体轻微快速脉动
  connecting: {
    sx: 1,
    sy: 1,
    bodyDy: 0,
    rot: 0,
    eyes: [eye(-30, -8, 12, 14), eye(30, -8, 12, 14)],
    eyeAlpha: 0.9,
  },
  // 聆听:睁大眼睛、头部微前倾
  listening: {
    sx: 1,
    sy: 1,
    bodyDy: -3,
    rot: 0,
    eyes: [eye(-34, -10, 25, 44, 4), eye(34, -10, 25, 44, -4)],
    eyeAlpha: 1,
  },
  // 听用户说话:头向一侧歪,眼神专注
  "user-speaking": {
    sx: 1,
    sy: 1,
    bodyDy: -2,
    rot: 5,
    eyes: [eye(-32, -10, 25, 42, 8), eye(36, -6, 25, 42, 8)],
    eyeAlpha: 1,
  },
  // 思考:眯眼、视线上飘、身体缓慢摇摆
  thinking: {
    sx: 1,
    sy: 1,
    bodyDy: 0,
    rot: -3,
    eyes: [eye(-26, -26, 20, 22, 2), eye(26, -26, 20, 22, -2)],
    eyeAlpha: 1,
  },
  // 说话:眼睛常态,身体节奏感弹跳(参数在帧循环中调制)
  speaking: { sx: 1, sy: 1, bodyDy: 0, rot: 0, eyes: baseEyes(), eyeAlpha: 1 },
  // 出错:一高一低的歪斜眼 + 歪头
  oops: {
    sx: 1,
    sy: 1,
    bodyDy: 2,
    rot: -6,
    eyes: [eye(-30, -4, 20, 26, -20), eye(32, -14, 22, 30, 14)],
    eyeAlpha: 1,
  },
};

/**
 * 语气覆盖:调制眼形传达情绪。
 * 陪伴模式随机轮播的三种(专注/得意/羞怯)按 bloub 经验保持零 roll——
 * 跟随光标时 roll 会让眼睛在情绪切换瞬间垂直跳动,眼形才是可读的区分维度。
 */
const MOODS: Record<Exclude<ElfMood, "neutral">, (pose: ElfPose) => ElfPose> = {
  happy: (p) => ({
    ...p,
    eyes: [eye(-34, -8, 24, 40, -8), eye(34, -8, 24, 40, 8)],
  }),
  excited: (p) => ({
    ...p,
    eyes: [eye(-34, -14, 26, 48, 2), eye(34, -14, 26, 48, -2)],
  }),
  gentle: (p) => ({
    ...p,
    eyes: [eye(-34, -4, 23, 32, 8), eye(34, -4, 23, 32, -8)],
  }),
  sorry: (p) => ({
    ...p,
    rot: p.rot - 2,
    eyes: [eye(-30, 2, 21, 26, 14), eye(30, -6, 21, 26, 14)],
  }),
  curious: (p) => ({
    ...p,
    rot: 4,
    eyes: [eye(-30, -18, 27, 46, 6), eye(36, -2, 18, 26, -4)],
  }),
  // 专注:双眼收窄、目光下移聚拢
  focused: (p) => ({
    ...p,
    eyes: [eye(-28, 0, 22, 24, 0), eye(28, 0, 22, 24, 0)],
  }),
  // 得意:一只眼眯起,下巴微抬
  smug: (p) => ({
    ...p,
    bodyDy: p.bodyDy + 3,
    rot: p.rot - 4,
    eyes: [eye(-32, -10, 24, 20, 0), eye(34, -12, 24, 38, 0)],
  }),
  // 羞怯:眼睛缩小下移、头偏向一侧
  shy: (p) => ({
    ...p,
    rot: p.rot + 6,
    eyes: [eye(-38, 6, 20, 22, 0), eye(30, 2, 20, 22, 0)],
  }),
};

interface AnimatedPose {
  cur: ElfPose;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpEye(a: ElfEye, b: ElfEye, t: number): ElfEye {
  return {
    dx: lerp(a.dx, b.dx, t),
    dy: lerp(a.dy, b.dy, t),
    w: lerp(a.w, b.w, t),
    h: lerp(a.h, b.h, t),
    tilt: lerp(a.tilt, b.tilt, t),
  };
}

function lerpPose(a: ElfPose, b: ElfPose, t: number): ElfPose {
  return {
    sx: lerp(a.sx, b.sx, t),
    sy: lerp(a.sy, b.sy, t),
    bodyDy: lerp(a.bodyDy, b.bodyDy, t),
    rot: lerp(a.rot, b.rot, t),
    eyeAlpha: lerp(a.eyeAlpha, b.eyeAlpha, t),
    eyes: [lerpEye(a.eyes[0], b.eyes[0], t), lerpEye(a.eyes[1], b.eyes[1], t)],
  };
}

/** 目标参数随时间调制:呼吸、说话弹跳、思考摇摆、随机眨眼。 */
function modulate(pose: ElfPose, state: ElfAvatarState, now: number, blinkClose: number): ElfPose {
  const t = pose;
  const out: ElfPose = { ...t, eyes: [{ ...t.eyes[0] }, { ...t.eyes[1] }] };

  // 随机眨眼(思考与出错态除外——眯眼/歪眼本身即表情)
  if (state !== "thinking" && state !== "oops" && state !== "connecting") {
    out.eyes[0].h *= blinkClose;
    out.eyes[1].h *= blinkClose;
  }

  const breathHz = {
    idle: 3200,
    listening: 2600,
    "user-speaking": 2400,
    speaking: 2600,
    thinking: 3400,
    connecting: 700,
    oops: 3600,
  }[state] as number;
  const breath = Math.sin((now / breathHz) * Math.PI * 2);
  out.sy *= 1 + 0.02 * breath;
  out.sx *= 1 - 0.012 * breath;

  if (state === "speaking") {
    const bounce = Math.abs(Math.sin((now / 430) * Math.PI));
    out.sy *= 1 + 0.045 * bounce;
    out.sx *= 1 - 0.03 * bounce;
    out.bodyDy -= 5 * bounce;
  }
  if (state === "thinking") {
    out.rot += 3 * Math.sin((now / 2600) * Math.PI * 2);
  }
  if (state === "connecting") {
    const pulse = Math.abs(Math.sin((now / 600) * Math.PI));
    out.sy *= 1 + 0.03 * pulse;
    out.sx *= 1 - 0.02 * pulse;
  }
  return out;
}

/** 鼠标注视参数(bloub gaze 规则的 2D 简化版)。 */
const GAZE_DX = 16; // 光标在最右时眼睛相对体心的水平偏移上限
const GAZE_DY = 12; // 垂直偏移上限
const GAZE_BASE_DY = -4; // 俯仰基准略高于中心:专注而非发呆
const GAZE_ROT = 5; // 身体跟随转动的最大角度

/* ---------------- 爆散/重聚脚本(bloub burst 的移植) ---------------- */

const EXIT_MS = 440; // 退出爆散:憋气膨胀 → 塌缩 → 粒子飞散
const POP_MS = 360; // 进场重聚:粒子回收 + 形体带过冲弹出
const PARTICLE_COUNT = 16;

interface BurstParticle {
  angle: number;
  dist: number;
  r: number;
  delay: number;
}

interface ParticleFrame {
  x: number;
  y: number;
  r: number;
  alpha: number;
}

/** explode=退出爆散(塌缩后保持消失);pop=进场重聚;gone=爆散已毕,保持隐身直到卸载 */
interface BurstScript {
  kind: "explode" | "pop" | "gone";
  start: number;
  seeds: BurstParticle[];
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeOutBack(t: number): number {
  const s = 1.70158;
  return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
}

/** 退出爆散的形体缩放:憋气膨胀到 1.25 → 塌缩到 0(此后由 gone 保持)。 */
function exitBodyScale(t: number): number {
  if (t < 0.3) return 1 + 0.25 * easeOutCubic(t / 0.3);
  if (t < 0.5) return 1.25 * (1 - easeOutCubic((t - 0.3) / 0.2));
  return 0;
}

/** 进场重聚的形体缩放:0 → 1,easeOutBack 过冲弹出。 */
function popBodyScale(t: number): number {
  return easeOutBack(t);
}

function makeParticles(seed: number): BurstParticle[] {
  // 线性同余伪随机:同一 seed 的爆散形状一致,跨帧渲染无需存中间态
  let state = seed >>> 0 || 1;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  return Array.from({ length: PARTICLE_COUNT }, () => ({
    angle: rand() * Math.PI * 2,
    dist: 120 + rand() * 110,
    r: 4.5 + rand() * 7,
    delay: rand() * 0.12,
  }));
}

/** 爆散:粒子从中心飞出并淡出(塌缩开始后才出现)。 */
function scatterFrames(seeds: readonly BurstParticle[], t: number): ParticleFrame[] | null {
  if (t < 0.3) return null;
  const progress = Math.min(1, (t - 0.3) / 0.7);
  const frames: ParticleFrame[] = [];
  for (const p of seeds) {
    const local = Math.min(1, Math.max(0, (progress - p.delay) / (1 - p.delay)));
    if (local <= 0) continue;
    const traveled = easeOutCubic(local) * p.dist;
    frames.push({
      x: Math.cos(p.angle) * traveled,
      y: Math.sin(p.angle) * traveled,
      r: p.r * (1 - 0.4 * local),
      alpha: 1 - local,
    });
  }
  return frames.length > 0 ? frames : null;
}

/** 重聚:粒子从外环飞回中心并消失,与形体的弹出重叠进行。 */
function convergeFrames(seeds: readonly BurstParticle[], t: number): ParticleFrame[] | null {
  if (t > 0.8) return null;
  const progress = t / 0.8;
  const frames: ParticleFrame[] = [];
  for (const p of seeds) {
    const local = Math.min(1, Math.max(0, (progress - p.delay * 0.4) / (1 - p.delay * 0.4)));
    if (local <= 0) continue;
    const remaining = p.dist * 0.7 * (1 - easeOutCubic(local));
    frames.push({
      x: Math.cos(p.angle) * remaining,
      y: Math.sin(p.angle) * remaining,
      r: p.r * (0.55 + 0.45 * (1 - local)),
      alpha: Math.min(1, local * 5) * (1 - local),
    });
  }
  return frames.length > 0 ? frames : null;
}

export function ElfAvatar({
  state,
  mood = "neutral",
  size = 96,
  followCursor = false,
  entrance = "none",
  exitKey = 0,
}: {
  state: ElfAvatarState;
  mood?: ElfMood;
  size?: number;
  followCursor?: boolean;
  /** 挂载时的进场动画:"pop" = 粒子重聚 + 过冲弹出 */
  entrance?: "none" | "pop";
  /** 值变化时(同一实例存活期间)触发一次退出爆散:膨胀 → 塌缩 → 粒子飞散 */
  exitKey?: number;
}) {
  const [frame, setFrame] = useState<ElfPose>(() => POSES[state]);
  const [particles, setParticles] = useState<ParticleFrame[] | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const curRef = useRef<AnimatedPose>({ cur: POSES[state] });
  const stateRef = useRef({ state, mood, followCursor, entrance, exitKey });
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const gazeRef = useRef({ x: 0, y: 0 });
  const scriptRef = useRef<BurstScript | null>(null);
  const exitKeyRef = useRef(exitKey);

  // react-hooks/refs:渲染期禁止写 ref,渲染后同步最新状态供 rAF 读取
  useEffect(() => {
    stateRef.current = { state, mood, followCursor, entrance, exitKey };
  });

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let nextBlinkAt = performance.now() + 2600 + Math.random() * 2000;
    let blinkStart = -1;

    function onPointerMove(e: PointerEvent): void {
      if (e.pointerType === "touch") return;
      pointerRef.current = { x: e.clientX, y: e.clientY };
    }
    function onPointerLeave(): void {
      pointerRef.current = null;
    }
    if (stateRef.current.followCursor) {
      window.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerleave", onPointerLeave);
    }

    // 进场动画在挂载时触发一次(模式切换会重挂载组件,天然每次进入都播放)
    if (stateRef.current.entrance === "pop") {
      const start = performance.now();
      scriptRef.current = { kind: "pop", start, seeds: makeParticles(start) };
    }

    function blinkClose(now: number): number {
      if (now >= nextBlinkAt) {
        if (blinkStart < 0) blinkStart = now;
        const phase = (now - blinkStart) / 140;
        if (phase >= 1) {
          blinkStart = -1;
          nextBlinkAt = now + 2600 + Math.random() * 2600;
          return 1;
        }
        return Math.abs(1 - 2 * phase); // 1 → 0 → 1 三角波
      }
      return 1;
    }

    const tick = (now: number): void => {
      const dt = Math.min(64, now - last);
      last = now;
      const { state: s, mood: m, followCursor: follow, exitKey } = stateRef.current;

      // 退出爆散:exitKey 变化即触发(仅在存活实例上生效,跨重挂载由 entrance 承接)
      if (exitKey !== exitKeyRef.current) {
        exitKeyRef.current = exitKey;
        scriptRef.current = { kind: "explode", start: now, seeds: makeParticles(now) };
      }

      // 目标 Pose:状态基底 + 语气覆盖 + 时间调制
      let target = POSES[s];
      // 语气覆盖:说话期(语义/韵律)与聆听期(用户情绪镜像)生效;思考态保留标志性眯眼
      if ((s === "speaking" || s === "listening" || s === "user-speaking") && m !== "neutral") {
        target = MOODS[m](target);
      }
      target = modulate(target, s, now, blinkClose(now));

      // 鼠标注视(bloub gaze):每帧重读矩形,按半屏归一化,防御零尺寸
      const gaze = gazeRef.current;
      let gazeTargetX = 0;
      let gazeTargetY = 0;
      if (follow) {
        const box = svgRef.current?.getBoundingClientRect();
        if (box !== undefined && box.width > 0 && box.height > 0) {
          const pointer = pointerRef.current;
          const halfW = Math.max(1, window.innerWidth / 2);
          const halfH = Math.max(1, window.innerHeight / 2);
          if (pointer !== null) {
            gazeTargetX = Math.min(1, Math.max(-1, (pointer.x - (box.left + box.width / 2)) / halfW));
            gazeTargetY = Math.min(1, Math.max(-1, (pointer.y - (box.top + box.height / 2)) / halfH));
          }
        }
      }
      const kGaze = 1 - Math.exp((-dt / 1000) * 6);
      gaze.x = lerp(gaze.x, gazeTargetX, kGaze);
      gaze.y = lerp(gaze.y, gazeTargetY, kGaze);
      if (follow) {
        target = {
          ...target,
          rot: target.rot + gaze.x * GAZE_ROT,
          bodyDy: target.bodyDy + gaze.y * 2,
          eyes: [
            { ...target.eyes[0], dx: target.eyes[0].dx + gaze.x * GAZE_DX, dy: target.eyes[0].dy - gaze.y * GAZE_DY + GAZE_BASE_DY },
            { ...target.eyes[1], dx: target.eyes[1].dx + gaze.x * GAZE_DX, dy: target.eyes[1].dy - gaze.y * GAZE_DY + GAZE_BASE_DY },
          ],
        };
      }

      // 指数缓动滑向目标(bloub 式 ease-out:帧率无关的趋近系数)
      const k = 1 - Math.exp((-dt / 1000) * 10);
      let cur = lerpPose(curRef.current.cur, target, k);

      // 脚本旁路缓动:形体缩放与粒子由时间线直接驱动,不经 lerp
      const script = scriptRef.current;
      if (script !== null) {
        if (script.kind === "gone") {
          cur = { ...cur, sx: 0, sy: 0 }; // 爆散完毕保持消失,直到组件卸载
        } else {
          const t = (now - script.start) / (script.kind === "explode" ? EXIT_MS : POP_MS);
          if (t >= 1) {
            scriptRef.current =
              script.kind === "explode" ? { kind: "gone", start: 0, seeds: [] } : null;
            setParticles(null);
          } else {
            const mul = script.kind === "explode" ? exitBodyScale(t) : popBodyScale(t);
            cur = { ...cur, sx: cur.sx * mul, sy: cur.sy * mul };
            setParticles(
              script.kind === "explode"
                ? scatterFrames(script.seeds, t)
                : convergeFrames(script.seeds, t),
            );
          }
        }
      }

      curRef.current.cur = cur;
      setFrame(cur);

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  const p = frame;
  return (
    <svg
      ref={svgRef}
      viewBox={`${-BODY_R - 14} ${-BODY_R - 14} ${(BODY_R + 14) * 2} ${(BODY_R + 14) * 2}`}
      width={size}
      height={size}
      role="img"
      aria-label={`表情:${state}`}
      style={{ overflow: "visible" }} // 粒子飞出 viewBox 边界时不被裁切
    >
      <g transform={`translate(0 ${p.bodyDy}) rotate(${p.rot}) scale(${p.sx} ${p.sy})`}>
        <circle r={BODY_R} fill="var(--foreground)" />
        <g fill="var(--background)" opacity={p.eyeAlpha}>
          {p.eyes.map((e, i) => (
            <rect
              key={i}
              x={e.dx - e.w / 2}
              y={e.dy - e.h / 2}
              width={e.w}
              height={e.h}
              rx={Math.min(e.w, e.h) / 2}
              transform={`rotate(${e.tilt} ${e.dx} ${e.dy})`}
            />
          ))}
        </g>
      </g>
      {particles !== null ? (
        <g fill="var(--foreground)">
          {particles.map((pt, i) => (
            <circle key={i} cx={pt.x} cy={pt.y} r={pt.r} opacity={pt.alpha} />
          ))}
        </g>
      ) : null}
    </svg>
  );
}
