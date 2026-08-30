/**
 * 拟态球引擎 · 装饰层：轨道环 / 彗尾 / 三点 / 粒子 / notify 蓝点。
 *
 * 自 bloub src/bot/decor.ts 原样移植。所有几何以球半径为单位，
 * 由引擎（唯一知道 viewBox 尺度的一方）负责光栅化。
 */

import { TAU, clamp, createRng, mixHex, r2 } from "./math";

/* --------------------------------------------------------- 渲染类型 */

export interface DotRender {
  x: number;
  y: number;
  r: number;
  opacity: number;
  /** 显式颜色；缺省由渲染方取身体色 */
  color?: string;
  /** 纵深雾化：0 = 淡入背景，1 = 身体色全量。由渲染方混色。 */
  depth?: number;
  /** 非圆点形状（"!" 斜置的泪滴点），单位为球半径、以原点为中心。 */
  d?: string;
  /** `d` 的旋转，度 */
  rot?: number;
}

export interface ArcSpec {
  id: string;
  seed: ArcSeed;
  t: number;
  opacity: number;
}

export interface ArcRender {
  id: string;
  /** 身体前的一段 */
  front: string;
  /** 身体后的一段（先画，从而被身体遮挡） */
  back: string;
  width: number;
  opacity: number;
  /** 沿轨迹的色相渐变 */
  grad: { x1: number; y1: number; x2: number; y2: number; stops: string[] };
}

/* --------------------------------------------------- 3D 椭圆弧 */

export interface ArcSeed {
  /** 半长轴，单位为球半径 */
  a: number;
  /** 扁率 b/a：实测 <= 0.45，轨道平面都是侧视 */
  k: number;
  /** 长轴在屏幕上的倾角，弧度 */
  tilt: number;
  /** 每秒圈数 */
  speed: number;
  phase: number;
  /** 实际画出的圈占比 */
  sweep: number;
  hue: number;
  hueSpan: number;
  width: number;
  cx: number;
  cy: number;
}

/**
 * 恒定亮度的完整色轮（实测 S 45-62%、L 50-67%），沿轨迹有渐变。
 */
function wheel(hue: number, s = 0.55, l = 0.62): string {
  const h = ((hue % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const rgb =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(rgb[0] ?? 0)}${hex(rgb[1] ?? 0)}${hex(rgb[2] ?? 0)}`;
}

/**
 * 倾斜 3D 圆的正交投影。z < 0 的半段画在身体之前（被身体遮挡），
 * 这个真实的深度分区让环读作轨道而不是平面图画。
 */
export function arcRender(seed: ArcSeed, t: number, scale: number, id: string, opacity = 1): ArcRender {
  const spinAngle = seed.phase + t * seed.speed * TAU;
  const cu = Math.cos(seed.tilt);
  const su = Math.sin(seed.tilt);
  const kz = Math.sqrt(Math.max(0, 1 - seed.k * seed.k));

  const N = 64;
  const span = seed.sweep * TAU;
  let front = "";
  let back = "";
  let prev: boolean | null = null;

  for (let i = 0; i <= N; i++) {
    const th = spinAngle + (i / N) * span;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const x = seed.a * (ct * cu + st * -su * seed.k) + seed.cx;
    const y = seed.a * (ct * su + st * cu * seed.k) + seed.cy;
    const z = seed.a * st * kz;

    const behind = z < 0;
    const sx = r2(x * scale);
    const sy = r2(y * scale);
    const cmd = behind !== prev ? "M" : "L";
    if (behind) back += `${cmd}${sx} ${sy}`;
    else front += `${cmd}${sx} ${sy}`;
    prev = behind;
  }

  const gx = Math.cos(seed.tilt) * seed.a * scale;
  const gy = Math.sin(seed.tilt) * seed.a * scale;
  return {
    id,
    front,
    back,
    width: seed.width * scale,
    opacity,
    grad: {
      x1: r2(seed.cx * scale - gx),
      y1: r2(seed.cy * scale - gy),
      x2: r2(seed.cx * scale + gx),
      y2: r2(seed.cy * scale + gy),
      stops: [wheel(seed.hue), wheel(seed.hue + seed.hueSpan * 0.5), wheel(seed.hue + seed.hueSpan)],
    },
  };
}

/* ------------------------------------------------------------- 轨道环 */

const RING_RNG = createRng(0xa11ce);

/** 6 环：半长轴 1.30-1.40，扁率 <= 0.45，厚 0.055，~3.3 圈/s。 */
export const RINGS: ArcSeed[] = Array.from({ length: 6 }, (_, i) => ({
  a: 1.3 + RING_RNG() * 0.1,
  k: 0.05 + RING_RNG() * 0.4,
  tilt: (i / 6) * Math.PI + RING_RNG() * 0.5,
  speed: 3 + RING_RNG() * 0.7,
  phase: RING_RNG() * TAU,
  sweep: 0.6 + RING_RNG() * 0.25,
  hue: (i * 360) / 6 + RING_RNG() * 30,
  hueSpan: 60 + RING_RNG() * 60,
  width: 0.05 + RING_RNG() * 0.012,
  cx: 0,
  cy: 0.1,
}));

/** 扫过三角形的套叠弧束（play 态），近乎侧视。 */
export const SWOOSH: ArcSeed[] = Array.from({ length: 4 }, (_, i) => ({
  a: 0.78 + i * 0.2,
  k: 0.05 + i * 0.02,
  tilt: -0.62 + i * 0.05,
  speed: 0.3,
  phase: 0.06 * i,
  sweep: 0.4,
  hue: 95 + i * 62,
  hueSpan: 100,
  width: 0.05,
  cx: 0,
  cy: -0.12,
}));

/* ------------------------------------------------------------- 三点 */

/** x 实测：-0.557 / -0.013 / +0.532，y = 0。 */
export const DOT_X = [-0.557, -0.013, 0.532] as const;
export const DOT_R = 0.165;
export const DOT_PEAK = 1.25;

/* ------------------------------------------------------------ 粒子 */

const P_RNG = createRng(0xbeef);

/** 5 粒，每 0.2 s 出一枚，寿命 0.55 s。 */
const PARTICLES = Array.from({ length: 5 }, (_, i) => ({
  birth: i * 0.2,
  angle: P_RNG() * TAU,
  rho: 0.58 + P_RNG() * 0.18,
}));

/** 粒子不直飞：螺旋收向中心（半径 x0.75/帧、角 +100°/s）同时变大，绕到核心后被吞。 */
export function particles(t: number, scale: number): DotRender[] {
  const out: DotRender[] = [];
  for (const p of PARTICLES) {
    const u = t - p.birth;
    if (u < 0 || u > 0.62) continue;
    const rho = p.rho * Math.pow(0.75, u * 10);
    const a = p.angle + (u * 100 * Math.PI) / 180;
    out.push({
      x: Math.cos(a) * rho * scale,
      y: Math.sin(a) * rho * scale,
      r: (0.04 + 0.028 * clamp(u / 0.55)) * scale,
      depth: clamp(1 - rho / 0.8),
      opacity: clamp(u / 0.06) * clamp((0.62 - u) / 0.08),
    });
  }
  return out;
}

/* ------------------------------------------------------------- 彗星 */

/** 点不动、拖尾绕它转。椭圆 a=0.85、b=0.15、长轴 +34°，4 条缎带，~210°/s。 */
const COMET_RNG = createRng(0xc0e7);
export const COMET_RIBBONS: ArcSeed[] = Array.from({ length: 4 }, (_, i) => {
  const d = i - 1.5;
  return {
    a: 0.85 * (1 + d * 0.03),
    k: (0.15 / 0.85) * (1 + d * 0.16),
    tilt: (34 * Math.PI) / 180 + d * 0.035,
    speed: 210 / 360,
    phase: -i * 0.045 + COMET_RNG() * 0.012,
    sweep: 0.34,
    hue: i * 85 + COMET_RNG() * 20,
    hueSpan: 80,
    width: 0.095,
    cx: 0,
    cy: 0,
  };
});

/** 彗星点半径，实测 0.129。 */
export const COMET_DOT = 0.129;

/* --------------------------------------------------- notify 蓝点 */

/** 逐像素实测的蓝。 */
export const NOTIF_BLUE = "#2496e8";
/** 蓝点贴在圆周上，-42° 处。 */
export const NOTIF_ANGLE = -42;
export const NOTIF_DIST = 1.003;
/** 静止半径；pop 峰值高出 14%。 */
export const NOTIF_R = 0.15;
export const NOTIF_POP = 1.14;
/** 蓝点周围的环形豁口（同心圆从身体上减去），边距恒定 0.054 R。 */
export const NOTIF_MARGIN = 0.054;

export { mixHex };
