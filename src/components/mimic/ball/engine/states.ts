/**
 * 拟态球引擎 · 状态表。
 *
 * 自 bloub src/bot/states.ts 原样移植：每个状态的姿态参数都是
 * 参考视频的逐帧测量值（位置、时长、缓动全部注释在案），
 * 与 bloub 的动画逐帧一致的基础。不要另起参数。
 */

import {
  COMET_DOT,
  COMET_RIBBONS,
  DOT_PEAK,
  DOT_R,
  DOT_X,
  NOTIF_ANGLE,
  NOTIF_DIST,
  NOTIF_MARGIN,
  NOTIF_POP,
  NOTIF_R,
  RINGS,
  SWOOSH,
  particles,
  type ArcSpec,
  type DotRender,
} from "./decor";
import { EYE_H, EYE_SPLIT, EYE_W, REST_GAZE, type HeadGaze } from "./face";
import { TAU, clamp, easings } from "./math";
import {
  circle,
  hullOfCircles,
  polyPath,
  profileFromPolygon,
  silhouette,
  type Silhouette,
} from "./shape";

export interface EyeCfg {
  /** 局部宽（胶囊短轴），单位为球半径 */
  w: number;
  /** 局部高（长轴） */
  h: number;
  /** 1 = 睁，0 = 闭 */
  open: number;
  /**
   * 胶囊自身倾角，度，正 = 上端向右。在球面切面标架之后施加；
   * 没有它双眼只能同侧倾斜，做不出镜像的怒/悲。
   */
  tilt?: number;
}

export interface Pose {
  /** 身体轮廓，单位为球半径 */
  sil: Silhouette;
  /** 身体与眼睛的整体偏移 */
  offX: number;
  offY: number;
  gaze: HeadGaze;
  /** 双眼在球面上的半间距，度 */
  split: number;
  /** [内侧眼, 外侧眼] */
  eyes: [EyeCfg, EyeCfg];
  /** 眼不透明度：无脸状态用 */
  eyeAlpha: number;
  bodyAlpha: number;
  dots: DotRender[];
  arcs: ArcSpec[];
  notif: { x: number; y: number; r: number; notch: number } | null;
  /** true = 装饰画在身体后面（burst 粒子） */
  dotsBehind: boolean;
}

/** 双眼同尺寸；`tilt` 镜像施加，`open` 传眨眼式半闭(如困倦 0.42)。 */
const pair = (w: number, h: number, tilt = 0, open = 1): [EyeCfg, EyeCfg] => [
  { w, h, tilt, open },
  { w, h, tilt: -tilt, open },
];

function base(over: Partial<Pose> = {}): Pose {
  return {
    sil: circle(1),
    offX: 0,
    offY: 0,
    gaze: { ...REST_GAZE },
    split: EYE_SPLIT,
    eyes: pair(EYE_W, EYE_H),
    eyeAlpha: 1,
    bodyAlpha: 1,
    dots: [],
    arcs: [],
    notif: null,
    dotsBehind: false,
    ...over,
  };
}

/* --------------------------------------------------- 非径向形状 */

/**
 * "!" 竖条：两圆凸包。实测上圆 (0,-0.505) r 0.132、下圆 (0,+0.130) r 0.075，
 * 侧边平直——锥台形（高宽比 1.76）。
 */
const BAR_UPRIGHT_CY = -0.1875;
const BAR_UPRIGHT = profileFromPolygon(hullOfCircles(0, -0.505, 0.132, 0, 0.13, 0.075), 0, BAR_UPRIGHT_CY);

/** "!" 斜条：纯胶囊（恒宽 0.269，长 0.776）。 */
const BAR_ITALIC = profileFromPolygon(hullOfCircles(0, -0.2535, 0.1345, 0, 0.2535, 0.1345), 0, 0);

const barUpright = (pose: Partial<Silhouette> = {}): Silhouette => ({
  radii: [...BAR_UPRIGHT],
  rot: 0,
  cx: 0,
  cy: BAR_UPRIGHT_CY,
  sx: 1,
  sy: 1,
  ...pose,
});

const barItalic = (pose: Partial<Silhouette> = {}): Silhouette => ({
  radii: [...BAR_ITALIC],
  rot: 0,
  cx: 0,
  cy: 0,
  sx: 1,
  sy: 1,
  ...pose,
});

/**
 * "!" 斜置的点不是圆盘：是泪滴——靠条一侧圆头（r 0.118），对侧收尖，
 * 沿字形轴长 0.300，以圆头重为中心。
 */
const TEAR = polyPath(hullOfCircles(0, 0, 0.118, 0, 0.172, 0.012));

/**
 * 三角形不自转：其中心绕原点画 r 0.213 的圆（实测）。
 * 这个偏移让它读作「翻越」而非「原地旋转」。
 */
const TRI_ORBIT = 0.213;

function spinningTriangle(rot: number): Silhouette {
  return silhouette("triangle", {
    rot,
    cx: -TRI_ORBIT * Math.sin(rot),
    cy: TRI_ORBIT * Math.cos(rot),
  });
}

/* ------------------------------------------------------------------ 状态 */

export type StateId =
  | "idle"
  | "thinking"
  | "wink"
  | "wide"
  | "alert"
  | "notify"
  | "exclaim"
  | "sleep"
  | "egg"
  | "hexagon"
  | "play"
  | "orbit"
  | "burst"
  | "comet"
  /** 界面转场，不在目录动画之列 */
  | "swirl"
  /** 说话表情轮换(bloub timide/méfiant/neutre),不在目录动画之列 */
  | "shy"
  | "doubt"
  | "calm";

export interface StateDef {
  id: StateId;
  /** 完整序列播放时的维持时长 */
  duration: number;
  /**
   * 低于该时长时动画在到达前被截断（"!" 不回来、身体保持炸开）。
   * 它读自下方 pose 的常数，不能另选；缺省 = 状态忽略时间或循环。
   */
  minDuration?: number;
  /** 入场 morph 时长 */
  morph: number;
  /** true = 入场被一次眨眼掩护 */
  blinkIn: boolean;
  /**
   * true = 身体是「静止轮廓」，可被自定义形状替换。
   * 自己画形状的状态（"!"、点、蛋、三角……）为 false：那个形状本身就是动画。
   */
  baseBody: boolean;
  /** true = 脸是「静止脸」，可被自定义表情替换（目前仅 idle）。 */
  baseFace: boolean;
  pose(local: number): Pose;
}

/** 从左到右扫过三点的脉冲波。 */
function dotPulse(t: number, index: number): number {
  const p = ((((t - index * 0.5) / 1.5) % 1) + 1) % 1;
  const k = p < 0.5 ? 0.5 - 0.5 * Math.cos(p * TAU) : 0;
  return clamp(k * 2);
}

export const STATES: StateDef[] = [
  {
    id: "idle",
    duration: 2.4,
    morph: 0.45,
    blinkIn: false,
    baseFace: true,
    baseBody: true,
    pose: () => base(),
  },

  {
    id: "thinking",
    duration: 2.6,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: (t) => {
      const mid = dotPulse(t, 1);
      // 侧点从球身侧面钻出：视频里与球融合 1-2 帧后才分离
      const emerge = 0.3 + 0.7 * easings.easeOutCubic(clamp(t / 0.3));
      return base({
        // 球本身变成中间那点：morph 保持连续
        sil: circle(DOT_R * (1 + (DOT_PEAK - 1) * mid), { cx: DOT_X[1] }),
        eyeAlpha: 0,
        dots: [0, 2].map((i) => {
          const k = dotPulse(t, i);
          return {
            x: (DOT_X[i] ?? 0) * emerge,
            y: 0,
            r: DOT_R * (1 + (DOT_PEAK - 1) * k),
            opacity: 0.55 + 0.45 * k,
          };
        }),
      });
    },
  },

  {
    id: "wink",
    duration: 1.6,
    morph: 0.3,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: () =>
      base({
        gaze: { yaw: -5.37, pitch: 4.55, roll: 6.7 },
        split: 16.25,
        // 闭眼不是睁眼压扁：是比睁眼更宽的横杠（0.447 对 0.236）
        eyes: [
          { w: 0.236, h: 0.464, open: 1 },
          { w: 0.447, h: 0.089, open: 1 },
        ],
      }),
  },

  {
    id: "wide",
    duration: 1.8,
    morph: 0.55,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: () =>
      base({
        // 2026-09-01 用户拍板:聆听 = 好奇表情(bloub expressions.ts curieux 原值)。
        // 头的 roll 承担「好奇」,双眼同向 -8° 倾斜、一大一小;
        // 原 wide 睁大眼参数(gaze 6.92/-21.96/11.6 · split 18.43 · 0.356×0.875)作废。
        gaze: { yaw: 16, pitch: -9, roll: -15 },
        split: 16.5,
        eyes: [
          { w: 0.24, h: 0.46, tilt: -8, open: 1 },
          { w: 0.2, h: 0.38, tilt: -8, open: 1 },
        ],
      }),
  },

  {
    // 羞怯(bloub timide 原值):目光垂向左下,小窄眼 —— 说话轮换表情之一
    id: "shy",
    duration: 2,
    morph: 0.35,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: () =>
      base({
        gaze: { yaw: -19, pitch: -14, roll: -7 },
        split: 14,
        eyes: pair(0.17, 0.3),
      }),
  },

  {
    // 怀疑(bloub méfiant 原值):一眼正常、一眼眯成缝 —— 说话轮换表情之二
    id: "doubt",
    duration: 2,
    morph: 0.35,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: () =>
      base({
        gaze: { yaw: 12, pitch: 6, roll: -6 },
        split: 16,
        eyes: [
          { w: 0.21, h: 0.4, open: 1 },
          { w: 0.22, h: 0.15, open: 1 },
        ],
      }),
  },

  {
    // 平静(bloub neutre 的眼;视线烘为 chat 正视)—— 说话轮换表情之三
    id: "calm",
    duration: 2,
    morph: 0.35,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: () =>
      base({
        gaze: { yaw: 0, pitch: 0, roll: 0 },
        split: EYE_SPLIT,
        eyes: pair(EYE_W, EYE_H),
      }),
  },

  {
    id: "alert",
    duration: 2.4,
    // "!" 在 1.6 + 0.4 归位
    minDuration: 2,
    morph: 0.45,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      // 实测行程：-0.087 → +0.732 历时 1.5 s，ease-in-out，微过冲
      const p = clamp(t / 1.5);
      const travel = easings.easeInOutCubic(p) * 0.82 - 0.087;
      const back = t > 1.6 ? clamp((t - 1.6) / 0.4) : 0;
      const x = travel * (1 - back) + 0.1 * back;
      // 2.5 Hz 的次级振动，条与点反相
      const buzz = Math.sin(t * 2.5 * TAU) * 0.005;
      const tilt = (17.7 * Math.PI) / 180;
      return base({
        sil: barItalic({ rot: tilt, cx: x, cy: -0.325 - buzz }),
        eyeAlpha: 0,
        dots: [
          {
            // 点沿字形轴，距条中心 0.580
            x: x - Math.sin(tilt) * 0.58,
            y: -0.325 + Math.cos(tilt) * 0.58 + buzz * 2.8,
            r: 0.118,
            d: TEAR,
            rot: (tilt * 180) / Math.PI,
            opacity: 1,
          },
        ],
      });
    },
  },

  {
    id: "notify",
    duration: 2.2,
    morph: 0.5,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: (t) => {
      // 蓝点 pop：0.3 s 处冲到 +14% 再回稳
      const p = clamp(t / 0.45);
      const pop = 1 + (NOTIF_POP - 1) * Math.sin(p * Math.PI) * (1 - p * 0.35);
      const r = NOTIF_R * (p < 1 ? pop : 1);
      const a = (NOTIF_ANGLE * Math.PI) / 180;
      return base({
        // 视线望向蓝点的反方向
        gaze: { yaw: -21.94, pitch: -5.82, roll: -12.2 },
        split: 18.89,
        eyes: pair(0.505, 0.498),
        notif: {
          x: Math.cos(a) * NOTIF_DIST,
          y: Math.sin(a) * NOTIF_DIST,
          r,
          notch: r + NOTIF_MARGIN,
        },
      });
    },
  },

  {
    id: "exclaim",
    duration: 2,
    morph: 0.45,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: () =>
      base({
        sil: barUpright(),
        eyeAlpha: 0,
        dots: [{ x: -0.012, y: 0.526, r: 0.113, opacity: 1 }],
      }),
  },

  {
    // 困倦(2026-09-01 拍板:bloub somnolent 表情原值)——完整圆球 +
    // 半耷拉的眼皮(open 0.42,与眨眼同一压扁机制),头微偏。
    // 旧的「小点上下弹跳」是删除记忆反馈的语义,与此处"打瞌睡"不符,已弃。
    id: "sleep",
    duration: 2.4,
    morph: 0.5,
    baseFace: false,
    baseBody: true,
    blinkIn: true,
    pose: () =>
      base({
        gaze: { yaw: 6, pitch: -9, roll: -3 },
        split: 16,
        eyes: pair(0.2, 0.42, 0, 0.42),
      }),
  },

  {
    id: "egg",
    duration: 1.8,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: () =>
      base({
        sil: silhouette("egg"),
        gaze: { yaw: 19.97, pitch: 26.01, roll: -17.1 },
        // 眼随身体一起收窄
        split: 11.07,
        eyes: pair(0.164, 0.385),
      }),
  },

  {
    id: "hexagon",
    duration: 1.6,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: () =>
      base({
        sil: silhouette("hexagon"),
        gaze: { yaw: 23.11, pitch: 24.42, roll: -13.3 },
        split: 13.37,
        eyes: pair(0.177, 0.411),
      }),
  },

  {
    id: "play",
    duration: 2,
    morph: 0.5,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: (t) => {
      // 弧束掠过时三角形几乎不动
      const fade = clamp(t / 0.35) * clamp((2.2 - t) / 0.5);
      return base({
        sil: spinningTriangle(0),
        gaze: { yaw: 12, pitch: -8, roll: -6 },
        split: 15,
        eyes: pair(0.18, 0.34),
        // 弧束自右向左扫过三角形
        arcs: SWOOSH.map((s, i) => ({
          id: `sw${i}`,
          seed: { ...s, cx: 0.45 - t * 0.42 },
          t,
          opacity: fade,
        })),
      });
    },
  },

  {
    id: "orbit",
    duration: 3.4,
    // 身体在 1.6 + 0.9 从三角放松回球
    minDuration: 2.5,
    morph: 0.6,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      // 实测旋转：0.35 s 起坡后 1.25 圈/s（逆时针）
      const ramp = easings.easeInOutCubic(clamp(t / 0.35));
      const rot = -TAU * 1.25 * t * ramp;
      const back = easings.easeInOutCubic(clamp((t - 1.6) / 0.9));
      const tri = spinningTriangle(rot);
      const ball = circle(1, { rot });
      const sil: Silhouette = {
        radii: tri.radii.map((r, i) => r + ((ball.radii[i] ?? 1) - r) * back),
        rot,
        cx: tri.cx * (1 - back),
        cy: tri.cy * (1 - back),
        sx: 1,
        sy: 1,
      };
      const fade = clamp(t / 0.8) * clamp((3.6 - t) / 0.9);
      return base({
        sil,
        // 眼绕球飞行，约比轮廓快 3 倍
        gaze: {
          yaw: REST_GAZE.yaw + Math.sin(t * 6.5) * 65 * (1 - back),
          pitch: -4 + back * 32,
          roll: -13,
        },
        eyes: pair(0.18, 0.34 + back * 0.07),
        // 环在 0.8 s 内逐一入场
        arcs: RINGS.map((s, i) => ({
          id: `rg${i}`,
          seed: s,
          t,
          opacity: fade * clamp((t - i * 0.13) / 0.3),
        })),
      });
    },
  },

  {
    /**
     * 设置视图的入场态。唯一不从视频测得的状态（和 --ink 一样是「选」出来的）：
     * 借 orbit 的环的词汇但收短——1 s、半数环、无三角。baseFace 保证
     * 光标跟随立刻生效，baseBody 保证形状以 morph 而非跳变接入。
     */
    id: "swirl",
    duration: 1.3,
    minDuration: 1.3,
    morph: 0.3,
    baseFace: true,
    baseBody: true,
    blinkIn: true,
    pose: (t) =>
      base({
        // orbit 六环里取三环：一半的束足以认出，还少光栅化一半的弧
        arcs: RINGS.slice(0, 3).map((s, i) => ({
          id: `sw${i}`,
          seed: s,
          t,
          // 逐一入场，再在块结束前退场，让回位发生在干净的画面上
          opacity: clamp((t - i * 0.06) / 0.14) * clamp((1.22 - t) / 0.34),
        })),
      }),
  },

  {
    id: "burst",
    duration: 2.6,
    // 身体在 1.7 + 0.7 重组完成
    minDuration: 2.4,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      // 实测塌缩：1.0 → 0.166 历时 0.7 s，ease-out，无回弹
      const collapse = 1 - 0.834 * easings.easeOutQuint(clamp(t / 0.7));
      const regrow = easings.easeOutQuint(clamp((t - 1.7) / 0.7));
      return base({
        sil: circle(collapse + (1 - collapse) * regrow),
        eyeAlpha: clamp((t - 1.85) / 0.4),
        dots: particles(t, 1),
        dotsBehind: true,
      });
    },
  },

  {
    id: "comet",
    duration: 2.4,
    // 点在 1.85 + 0.6 = 2.45 重组：片尾之后 0.05 s，随淡出收尾
    minDuration: 2.4,
    morph: 0.45,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      const collapse = 1 - (1 - COMET_DOT) * easings.easeOutQuint(clamp(t / 0.55));
      const regrow = easings.easeOutQuint(clamp((t - 1.85) / 0.6));
      const fade = clamp((t - 0.15) / 0.25) * clamp((1.95 - t) / 0.3);
      return base({
        // 点向下漂 0.035 再回升（实测 wobble）
        sil: circle(collapse + (1 - collapse) * regrow, {
          cy: Math.sin(clamp(t / 1.7) * Math.PI) * 0.035,
        }),
        eyeAlpha: clamp((t - 2) / 0.35),
        arcs: COMET_RIBBONS.map((s, i) => ({ id: `cm${i}`, seed: s, t, opacity: fade })),
      });
    },
  },
];

export const STATE_BY_ID = new Map(STATES.map((s) => [s.id, s]));
