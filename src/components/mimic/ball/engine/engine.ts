/**
 * 拟态球引擎 · 无时钟采样器。
 *
 * 自 bloub src/bot/engine.ts 移植，按 chat-elf 需求裁剪：
 * 去掉了 bloub 专属的自定义形状（personnalisateur）、表情系统与
 * eyefit 眼距修正表——chat-elf 只用基础轮廓与静止脸，裁剪不影响
 * 其余行为。状态 morph、look 混合、liveliness、眨眼、眼体贴合轮廓、
 * 装饰光栅化全部与 bloub 一致。
 *
 * `sample(t)` 是时间的纯函数：暂停、续播、跳转任意日期都得到同一画面。
 */

import { arcRender, type ArcRender, type DotRender } from "./decor";
import { blinkScale, eyePoses, liveliness } from "./face";
import { clamp, easings, lerp, r2 } from "./math";
import {
  blend,
  capsulePath,
  closedPath,
  radiusAtAngle,
  toPoints,
  type Point,
  type Silhouette,
} from "./shape";
import { STATE_BY_ID, type Pose, type StateDef, type StateId } from "./states";

export interface RenderedEye {
  d: string;
  matrix: string;
  alpha: number;
}

export interface BotFrame {
  bodyPath: string;
  bodyAlpha: number;
  eyes: RenderedEye[];
  dots: DotRender[];
  /** true = 圆点画在身体后面（burst 粒子） */
  dotsBehind: boolean;
  arcs: ArcRender[];
  notif: { x: number; y: number; r: number } | null;
  notch: { x: number; y: number; r: number } | null;
}

/**
 * 外部驱动（鼠标指针）注视目标。
 *
 * `yaw`/`pitch` 是绝对方向，随 `mix` 上升替换状态姿态——混合必须由引擎做
 * （只有它知道当下的姿态），且两轴都取绝对值，否则每次换状态眼睛都会跳。
 * `spin` 是要「走」掉的一整圈（度）：眼在球面上，一圈恰好从球后绕回原位。
 */
export interface Look {
  yaw: number;
  pitch: number;
  mix: number;
  spin: number;
  wander: number;
}

export const NO_LOOK: Look = { yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 1 };

const lerpLook = (a: Look, b: Look, t: number): Look => ({
  yaw: lerp(a.yaw, b.yaw, t),
  pitch: lerp(a.pitch, b.pitch, t),
  mix: lerp(a.mix, b.mix, t),
  spin: lerp(a.spin, b.spin, t),
  wander: lerp(a.wander, b.wander, t),
});

const lerpEye = (a: Pose["eyes"][number], b: Pose["eyes"][number], t: number) => ({
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
  open: lerp(a.open, b.open, t),
  tilt: lerp(a.tilt ?? 0, b.tilt ?? 0, t),
});

/** 两姿态插值。装饰以不透明度交叉，几何不交叉。 */
function blendPose(a: Pose, b: Pose, t: number): Pose {
  const out = 1 - t;
  return {
    sil: blend(a.sil, b.sil, t),
    offX: lerp(a.offX, b.offX, t),
    offY: lerp(a.offY, b.offY, t),
    gaze: {
      yaw: lerp(a.gaze.yaw, b.gaze.yaw, t),
      pitch: lerp(a.gaze.pitch, b.gaze.pitch, t),
      roll: lerp(a.gaze.roll, b.gaze.roll, t),
    },
    split: lerp(a.split, b.split, t),
    eyes: [lerpEye(a.eyes[0], b.eyes[0], t), lerpEye(a.eyes[1], b.eyes[1], t)],
    eyeAlpha: lerp(a.eyeAlpha, b.eyeAlpha, t),
    bodyAlpha: lerp(a.bodyAlpha, b.bodyAlpha, t),
    dots: [
      ...a.dots.map((d) => ({ ...d, opacity: d.opacity * out })),
      ...b.dots.map((d) => ({ ...d, opacity: d.opacity * t })),
    ],
    arcs: [
      ...a.arcs.map((r) => ({ ...r, id: `a${r.id}`, opacity: r.opacity * out })),
      ...b.arcs.map((r) => ({ ...r, id: `b${r.id}`, opacity: r.opacity * t })),
    ],
    notif: t < 0.5 ? a.notif : b.notif,
    dotsBehind: t < 0.5 ? a.dotsBehind : b.dotsBehind,
  };
}

export class BotEngine {
  /** 静止球半径，viewBox 单位。 */
  readonly scale: number;

  private cur: StateId;
  private prev: StateId | null = null;
  /** 冻结的出发姿态：morph 进行中又来一次状态切换时使用（见 setState）。 */
  private departFige: Pose | null = null;
  private tCur = 0;
  private tPrev = 0;
  private blinkAt = -10;
  private pts: Point[] = [];
  private look: Look = NO_LOOK;
  private lookPrev: Look = NO_LOOK;
  private lookAt = -10;
  /** look 的追赶时长；LOOK_MORPH 是默认值。 */
  private lookMorph = BotEngine.LOOK_MORPH;

  /** 注视追赶时长：比身体 morph 短——跟随要「attention」，不要「粘稠」。 */
  static readonly LOOK_MORPH = 0.24;

  constructor(scale = 100, initial: StateId = "idle") {
    this.scale = scale;
    this.cur = initial;
  }

  /**
   * 新注视目标；`null` 回到状态自身姿态。
   * 从当前值出发（而非上一目标），否则每次指针移动眼睛先回退一格，跟随会抖。
   * 非 finite 的目标被拒收：引擎保留最后一个有效目标，一个 NaN 会永远赖着。
   */
  setLook(look: Look | null, now: number, morph = BotEngine.LOOK_MORPH): void {
    if (look && !Number.isFinite(look.yaw + look.pitch + look.mix + look.spin + look.wander)) {
      return;
    }
    this.lookPrev = this.lookAtTime(now);
    this.look = look ?? NO_LOOK;
    this.lookAt = now;
    this.lookMorph = morph;
  }

  private lookAtTime(now: number): Look {
    const k = (now - this.lookAt) / this.lookMorph;
    if (k >= 1) return this.look;
    return lerpLook(this.lookPrev, this.look, easings.easeOutQuint(clamp(k)));
  }

  /** 回到 `id` 且不带历史，像落在这个状态上的新引擎。 */
  reset(id: StateId, now: number): void {
    this.cur = id;
    this.prev = null;
    this.departFige = null;
    this.tCur = now;
    this.tPrev = now;
    this.blinkAt = -10;
  }

  private posed(def: StateDef, t: number): Pose {
    return def.pose(t);
  }

  /** 淡出进行中的起点：冻结姿态，或被离开状态在其自身时间轴上的取值。 */
  private origine(now: number): Pose | null {
    if (this.departFige) return this.departFige;
    if (!this.prev) return null;
    const prevDef = STATE_BY_ID.get(this.prev);
    if (prevDef === undefined) return null;
    return this.posed(prevDef, Math.max(0, now - this.tPrev));
  }

  /** 当下的复合姿态（淡出混合之后、生活层之前）。 */
  private poseComposee(now: number): Pose {
    const def = STATE_BY_ID.get(this.cur);
    if (def === undefined) throw new Error(`unknown state: ${this.cur}`);
    const pose = this.posed(def, Math.max(0, now - this.tCur));
    const since = now - this.tCur;
    if (since >= def.morph) return pose;
    const origine = this.origine(now);
    if (!origine) return pose;
    return blendPose(origine, pose, easings.easeOutQuint(clamp(since / def.morph)));
  }

  /**
   * 状态切换（带日期）。morph 进行中又来切换时，冻结当前复合姿态并从它混合，
   * 连续切换无论多少次都保持连续。
   */
  setState(id: StateId, now: number): void {
    if (id === this.cur) return;
    const curDef = STATE_BY_ID.get(this.cur);
    if (curDef === undefined) return;
    const enPleinFondu = this.prev !== null && now - this.tCur < curDef.morph;
    this.departFige = enPleinFondu ? this.poseComposee(now) : null;
    this.prev = this.cur;
    this.tPrev = this.tCur;
    this.cur = id;
    this.tCur = now;
    // 视频里每次形状切换都被一次眨眼掩护
    if (STATE_BY_ID.get(id)?.blinkIn) this.blinkAt = now;
  }

  sample(now: number): BotFrame {
    const R = this.scale;
    const def = STATE_BY_ID.get(this.cur);
    if (def === undefined) throw new Error(`unknown state: ${this.cur}`);
    let pose = this.posed(def, Math.max(0, now - this.tCur));

    // --- 转场 -------------------------------------------------------------
    const since = now - this.tCur;
    // 被离开的状态永不清除：`since < def.morph` 足以在淡出后忽略它；
    // 遗忘它会让引擎不可重放（淡出窗口内重读旧日期找不回起点）。
    const origine = since < def.morph ? this.origine(now) : null;
    if (origine) {
      // ease-out 指数：视频实测曲线。球体无过冲。比率须夹紧——
      // 读到早于切状态的日期会给出负比率，外推后轮廓飞出三十倍远。
      const ratio = easings.easeOutQuint(clamp(since / def.morph));
      pose = blendPose(origine, pose, ratio);
    }

    // --- 静止生活层 --------------------------------------------------------
    const alive = pose.eyeAlpha > 0.01;
    const look = this.lookAtTime(now);
    const life = liveliness(now, { wander: alive ? look.wander : 0, blink: alive });

    const gaze = {
      // look 的两轴替换（而非叠加）姿态的对应轴；spin 在路径上扣减。
      // 漂移在混合之后追加：它必须在一颗转开的头上存活。
      yaw: lerp(pose.gaze.yaw, look.yaw, look.mix) + life.dYaw - look.spin,
      pitch: lerp(pose.gaze.pitch, look.pitch, look.mix) + life.dPitch,
      // 翻滚不跟随指针：头部倾角是签名，被指针带着转会毁掉它
      roll: pose.gaze.roll + life.dRoll,
    };

    // 状态切换触发的眨眼，叠加在日历之上
    const forced = clamp((now - this.blinkAt) / 0.2);
    const forcedLid = forced < 1 ? Math.abs(forced * 2 - 1) : 1;
    const lid = Math.min(life.lid, forcedLid);

    const offX = pose.offX + life.driftX;
    const offY = pose.offY + life.driftY;

    // --- 身体 ---------------------------------------------------------------
    const sil: Silhouette = {
      ...pose.sil,
      cx: pose.sil.cx + offX,
      cy: pose.sil.cy + offY,
      sy: pose.sil.sy * life.breath,
    };
    const bodyPath = closedPath(toPoints(sil, R, this.pts));

    // --- 眼睛 ---------------------------------------------------------------
    // 眼画在半径 1 的球面上；轮廓非圆时按该方向的真实半径折算，否则溢出轮廓。
    const bodyRadius = (x: number, y: number): number =>
      radiusAtAngle(pose.sil.radii, Math.atan2(y, x) - pose.sil.rot);

    const eyes: RenderedEye[] = [];
    if (pose.eyeAlpha > 0.01) {
      const poses = eyePoses(gaze, R, pose.split);
      for (let i = 0; i < 2; i++) {
        const e = poses[i];
        if (e === undefined || e.depth <= 0.02) continue;
        const cfg = pose.eyes[i];
        if (cfg === undefined) continue;
        const fit = bodyRadius(e.x, e.y);
        // 眼自身倾角：切面标架与平面旋转复合（Basis x Rot），镜像倾角由此可能
        const phi = ((cfg.tilt ?? 0) * Math.PI) / 180;
        const cp = Math.cos(phi);
        const sp = Math.sin(phi);
        const ax = e.a * cp + e.c * sp;
        const ay = e.b * cp + e.d * sp;
        const cx2 = -e.a * sp + e.c * cp;
        const cy2 = -e.b * sp + e.d * cp;
        // 眨眼在其后施加：屏幕竖向压扁，不沿胶囊轴
        const k = blinkScale(Math.min(lid, cfg.open));
        eyes.push({
          d: capsulePath(cfg.w * R, cfg.h * R),
          matrix: `matrix(${r2(ax)},${r2(ay * k)},${r2(cx2)},${r2(cy2 * k)},${r2(e.x * fit + offX * R)},${r2(e.y * fit + offY * R)})`,
          alpha: pose.eyeAlpha * clamp(e.depth / 0.12),
        });
      }
    }

    // --- 装饰 ---------------------------------------------------------------
    const dots = pose.dots
      .filter((p) => p.opacity > 0.01 && p.r > 0.0005)
      .map((p) => ({ ...p, x: (p.x + offX) * R, y: (p.y + offY) * R, r: p.r * R }));

    // 蓝点贴在轮廓上，随形状走
    const nFit = pose.notif ? bodyRadius(pose.notif.x, pose.notif.y) : 1;
    const nx = pose.notif ? (pose.notif.x * nFit + offX) * R : 0;
    const ny = pose.notif ? (pose.notif.y * nFit + offY) * R : 0;
    const notif = pose.notif ? { x: nx, y: ny, r: pose.notif.r * R } : null;
    const notch = pose.notif ? { x: nx, y: ny, r: pose.notif.notch * R } : null;

    return {
      bodyPath,
      bodyAlpha: pose.bodyAlpha,
      eyes,
      dots,
      dotsBehind: pose.dotsBehind,
      // 状态以球半径单位声明弧；尺度归引擎
      arcs: pose.arcs
        .filter((a) => a.opacity > 0.01)
        .map((a) => arcRender(a.seed, a.t, R, a.id, a.opacity)),
      notif,
      notch,
    };
  }
}
