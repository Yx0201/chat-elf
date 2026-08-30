/**
 * 拟态球引擎 · 数学基元。
 *
 * 自 bloub 仓库 src/bot/math.ts 原样移植（2026-08-30 对齐）：
 * 缓动、周期噪声、确定性 PRNG 与短视频测得的 morph 曲线保持一致，
 * 这是「与 bloub 动画一致」的根基，不要另行调参。
 */

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export type Easing = (t: number) => number;

/**
 * 视频实测：状态切换是指数缓出，球体无过冲。
 * 唯二的弹簧效果（notify 蓝点 pop、睁眼）写在各自状态里。
 */
export const easings = {
  easeOutCubic: (t: number): number => 1 - (1 - t) ** 3,
  easeInOutCubic: (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  easeOutQuint: (t: number): number => 1 - (1 - t) ** 5,
} satisfies Record<string, Easing>;

/** 一维周期噪声：在 `period` 内无缝循环，用于注视漂移。 */
export function loopNoise(t: number, period: number, seed = 0): number {
  const p = (t / period) * TAU;
  return (
    0.55 * Math.sin(p + seed) +
    0.3 * Math.sin(2 * p + seed * 1.7 + 1.1) +
    0.15 * Math.sin(3 * p + seed * 2.3 + 2.4)
  );
}

/** 确定性 PRNG（mulberry32）：同一序列，可重放。 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 短舍入：60 fps 下生成的 path 字符串重量减半。 */
export const r2 = (v: number): number => Math.round(v * 100) / 100;

/** 十六进制颜色插值（burst 粒子的纵深雾化用）。 */
export function mixHex(from: string, to: string, t: number): string {
  const p = (h: string): [number, number, number] => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const a = p(from);
  const b = p(to);
  const ch = (i: number): string =>
    Math.round(lerp(a[i] ?? 0, b[i] ?? 0, t))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}
