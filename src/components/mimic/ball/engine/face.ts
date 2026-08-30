/**
 * 拟态球引擎 · 眼睛画在球面上，不是平贴在脸上。
 *
 * 自 bloub src/bot/face.ts 移植：每只眼取球面切面标架正交投影，
 * 压缩与倾斜由投影自然产生，这就是体积感的来源。
 * 常数来自逐帧测量的拟合（残差 ~1 px / 半径 190 px），不要手调。
 *
 * ⚠️ chat-elf 唯一改动：REST_GAZE。
 * bloub 实测的静止姿态是 {yaw 28.49, pitch 28.62, roll -13}（转头望向右上的
 * 视频姿态）；chat-elf 用户拍板为「正视镜头、双眼正中对称」，
 * 故 yaw/roll 归零，pitch 取 bloub 光标跟随的注视高度 PITCH = 10（微仰，
 * 显得 attent）。除此之外一切几何与动画参数与 bloub 一致。
 */

import { clamp, createRng, loopNoise } from "./math";

/** 双眼在球面上的半间距，度（总分离 ~31°）。 */
export const EYE_SPLIT = 15.46;
/** 静止眼尺寸，单位为球半径。 */
export const EYE_W = 0.186;
export const EYE_H = 0.412;

/** 静止头部朝向（见文件头说明：chat-elf 改为正视）。 */
export const REST_GAZE: HeadGaze = { yaw: 0, pitch: 10, roll: 0 };

export interface EyePose {
  x: number;
  y: number;
  /** 切面标架 2x2：[a b c d]，同 SVG matrix(a,b,c,d,e,f) */
  a: number;
  b: number;
  c: number;
  d: number;
  /** 法线 z 分量：> 0 = 正面可见 */
  depth: number;
}

export interface HeadGaze {
  /** 偏航，度，正 = 向右看 */
  yaw: number;
  /** 俯仰，度，正 = 向上看 */
  pitch: number;
  /** 翻滚，度，头的倾斜 */
  roll: number;
}

const deg = (d: number): number => (d * Math.PI) / 180;

type Vec3 = [number, number, number];

/** 在两向量的公共平面内旋转。 */
function spin(u: Vec3, v: Vec3, angle: number): [Vec3, Vec3] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
    [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s],
  ];
}

/**
 * 头标架再到双眼标架。屏幕坐标系：x 右、y 下、z 朝观者。
 * 索引 0 为内侧眼，索引 1 为外侧眼。
 */
export function eyePoses(gaze: HeadGaze, scale: number, split = EYE_SPLIT): [EyePose, EyePose] {
  let f: Vec3 = [0, 0, 1];
  let right: Vec3 = [1, 0, 0];
  let down: Vec3 = [0, 1, 0];

  // 偏航：forward 倒向 right
  [f, right] = spin(f, right, deg(gaze.yaw));
  // 俯仰：forward 倒向上（与 down 反向）
  [down, f] = spin(down, f, deg(gaze.pitch));
  // 翻滚：头在自己的平面内倾斜
  [right, down] = spin(right, down, deg(gaze.roll));

  const build = (side: number): EyePose => {
    const [ef, er] = spin(f, right, deg(split * side));
    return {
      x: ef[0] * scale,
      y: ef[1] * scale,
      a: er[0],
      b: er[1],
      c: down[0],
      d: down[1],
      depth: ef[2],
    };
  };

  return [build(-1), build(1)];
}

export interface Liveliness {
  dYaw: number;
  dPitch: number;
  dRoll: number;
  /** 1 = 睁眼，0 = 闭眼（屏幕坐标系的竖向压扁） */
  lid: number;
  driftX: number;
  driftY: number;
  breath: number;
}

const BLINK_RNG = createRng(0x5eed);
/** 预抽定的眨眼日历：确定性与无状态。 */
const BLINKS: number[] = (() => {
  const out: number[] = [];
  let t = 1.4;
  while (t < 900) {
    out.push(t);
    // 两次眨眼间隔 1.9 ~ 4.6 s，偶尔带一个双眨
    t += 1.9 + BLINK_RNG() * 2.7;
    if (BLINK_RNG() < 0.18) {
      out.push(t);
      t += 0.24;
    }
  }
  return out;
})();

/** 实测：10 fps 下 1~2 帧。 */
const BLINK_DUR = 0.18;

function blinkLid(t: number): number {
  for (const start of BLINKS) {
    if (t < start) break;
    const k = (t - start) / BLINK_DUR;
    if (k >= 0 && k <= 1) {
      // 快闭，稍慢睁开
      return k < 0.45 ? 1 - k / 0.45 : (k - 0.45) / 0.55;
    }
  }
  return 1;
}

export interface LivelinessOptions {
  wander?: number;
  blink?: boolean;
  float?: boolean;
}

export function liveliness(t: number, opt: LivelinessOptions = {}): Liveliness {
  const { wander = 1, blink = true, float = true } = opt;
  // 周期互质：漂移永不重样
  return {
    dYaw: (loopNoise(t, 11.3, 0.4) * 5.5 + loopNoise(t, 3.7, 2.1) * 1.6) * wander,
    dPitch: (loopNoise(t, 9.1, 1.3) * 4.2 + loopNoise(t, 4.3, 0.7) * 1.3) * wander,
    dRoll: loopNoise(t, 13.7, 3.2) * 2.2 * wander,
    lid: blink ? blinkLid(t) : 1,
    // 静止时视频几乎不动（中心 ±0.003）：生活的部分全在眼神与眨眼
    driftX: float ? loopNoise(t, 7.9, 1.9) * 0.006 : 0,
    driftY: float ? loopNoise(t, 5.3, 0.3) * 0.007 : 0,
    // 宽度恒定，只有高度极轻微呼吸
    breath: float ? 1 + Math.sin((t / 3.4) * Math.PI * 2) * 0.005 : 1,
  };
}

/**
 * 眨眼是屏幕坐标系绕眼中心的竖向压扁（实测：bbox 宽度不变、高度掉到 ~0.35），
 * 不是沿胶囊斜轴的收窄，所以在切面标架之后合成、只影响 y 输出。
 */
export function blinkScale(lid: number): number {
  return 0.06 + 0.94 * clamp(lid);
}
