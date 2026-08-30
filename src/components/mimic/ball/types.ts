/**
 * 拟态球类型定义。
 *
 * 约束（沿用 ARCHITECTURE 编码约定）：本文件不得 import 任何服务端模块，
 * 它会被客户端组件与（未来的）服务端页面同时引用。
 */

/** 拟态球状态 id —— 与 spec §2 状态表、Ardot 组件页命名一一对应 */
export type BallState =
  | "idle" // 待机
  | "wide" // 聆听
  | "thinking" // 思考（三点脉冲）
  | "wink" // 回应 / 说话
  | "notify" // 新记忆（右上蓝点）
  | "egg" // 注册孵化（蛋形）
  | "sleep" // 休眠（低垂小点）
  | "orbit" // 路由转场（轨道环）
  | "hexagon" // 性格设置态
  | "comet" // 历史穿梭（拖尾）
  | "alert"; // 错误提醒（感叹号）

/**
 * 球的色彩变体。
 * - ink：深色球 + 白眼（浅色页面用）—— 组件页默认形态
 * - light：浅色球 + 深眼（深色舞台用）—— 封面 / 注册左舞台 / 记忆左舞台
 *
 * 设计稿中深色舞台上的球做了反色（浅体深眼），保持「同一张脸」的识别度。
 */
export type BallVariant = "ink" | "light";

/** 球对外暴露的命令式 API（由常驻层转发给球本体） */
export interface BallApi {
  /** 触发点击彩虹：bloub burst 态（0.7s 塌缩 → 粒子螺旋 → 1.4s 重组；冷却约 2.6s） */
  burst(): void;
  /** 界面转场：bloub swirl 态（三环入场 + 眼绕球面整一圈，~1.5s） */
  swirl(): void;
}
