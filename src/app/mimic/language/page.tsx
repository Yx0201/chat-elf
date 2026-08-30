"use client";

/**
 * 06 交互语言（Ardot 设计稿 3:318，说明页）。
 *
 * 「场景 → 球体状态 → 鼠标/转场」映射表 + 三张硬规则卡 + H5 适配备注。
 * 本页无球锚点（球常驻层淡出），纯文档排版。
 */

import Link from "next/link";

const ROWS: Array<{ scene: string; state: string; note: string }> = [
  { scene: "注册未提交", state: "egg", note: "目光跟随光标；身体轻微摇。提交成功 egg→burst 彩虹→idle。失败切 alert。" },
  { scene: "性格设置", state: "hexagon", note: "进入 swirl 转场；拖滑块时头转向该行。保存 swirl 一圈后 morph 回 idle。换人格=开新会话。" },
  { scene: "对话待机 / 聆听", state: "idle / wide", note: "半屏归一化跟随；忽略触摸指针。点击球：burst 彩虹粒子，0.7s 后重组。" },
  { scene: "思考 / 说话", state: "thinking / wink", note: "思考裂成三点脉冲；说话时眨眼回应。打断 barge-in 立刻回 wide。" },
  { scene: "记忆页", state: "notify", note: "蓝点=新记忆。点条目 wink；删除 sleep 再弹回。路由进入 orbit。" },
  { scene: "历史记录", state: "comet", note: "滚动时彗星尾巴相位跟着走；点进会话 orbit 转场回 wide。" },
  { scene: "跨路由", state: "orbit / swirl", note: "球是共享层，不随页面卸载。出页 swirl 1.3s，入页 orbit，再落到目标态。禁止硬切。" },
  { scene: "连接失败", state: "alert", note: "感叹号斜飞入场。点球重试：alert → thinking → wide。" },
];

const RULES = [
  {
    title: "跟随",
    bg: "#FFE8D4",
    titleColor: "#793400",
    body: "yaw ±16° / pitch ±13°。半屏饱和。忽略触摸。pointerleave 回原位。",
  },
  {
    title: "点击彩虹",
    bg: "#FDE0EC",
    titleColor: "#A02E6D",
    body: "burst 粒子用 bloub 12 色盘。0.7s 塌缩，1.7s 重组。冷却 1.2s。",
  },
  {
    title: "路由转场",
    bg: "#DCECFA",
    titleColor: "#0A1530",
    body: "球常驻，页面淡 180ms。眼睛绕球面转一圈再落地，不穿越脸。",
  },
];

export default function LanguagePage() {
  return (
    <div className="mimic-page min-h-dvh bg-white px-4 py-8 lg:px-14 lg:py-14">
      <div className="mx-auto flex w-full max-w-[1328px] flex-col gap-6 lg:gap-7">
        <Link href="/mimic" className="text-[13px] text-[#787671] hover:text-[#A4A097]">
          ← 封面
        </Link>

        <header className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold text-[#1A1A1A] lg:text-4xl">拟态球怎么活在系统里</h1>
          <p className="max-w-[1100px] text-sm leading-[1.55] text-[#5D5B54] lg:text-base">
            球不是装饰，是导航、状态和反馈的同一张脸。交互全部来自 bloub：morph
            用指数缓出、不弹簧过冲；跟随只改 gaze；点击才放彩虹。
          </p>
        </header>

        {/* 映射表（H5 退化为堆叠卡片） */}
        <div className="overflow-hidden rounded-xl border border-[#E5E3DF]">
          <div className="hidden grid-cols-[180px_180px_1fr] gap-4 bg-[#F6F5F4] px-5 py-3 text-xs font-semibold text-[#787671] lg:grid">
            <span>场景</span>
            <span>球体状态</span>
            <span>鼠标 / 转场</span>
          </div>
          {ROWS.map((r, i) => (
            <div
              key={r.scene}
              className={`grid gap-2 px-5 py-4 max-lg:grid-cols-1 lg:grid-cols-[180px_180px_1fr] lg:gap-4 lg:py-4 ${
                i % 2 === 1 ? "bg-[#FAFAF9]" : "bg-white"
              } ${i > 0 ? "max-lg:border-t max-lg:border-[#EDE9E3] lg:border-t lg:border-[#EDE9E3]" : ""}`}
            >
              <span className="text-sm font-medium text-[#1A1A1A]">{r.scene}</span>
              <span className="font-['Inter'] text-sm font-medium text-[#5645D4]">{r.state}</span>
              <span className="text-[13px] leading-[1.5] text-[#5D5B54]">{r.note}</span>
            </div>
          ))}
        </div>

        {/* 硬规则三卡 */}
        <div className="grid gap-4 lg:grid-cols-3">
          {RULES.map((r) => (
            <div key={r.title} className="flex flex-col gap-2 rounded-xl p-6" style={{ backgroundColor: r.bg }}>
              <h2 className="text-lg font-semibold" style={{ color: r.titleColor }}>
                {r.title}
              </h2>
              <p className="text-[13px] leading-[1.5] text-[#37352E]">{r.body}</p>
            </div>
          ))}
        </div>

        {/* H5 适配备注 */}
        <div className="flex flex-col gap-2 rounded-xl bg-[#F9E79F] p-6">
          <h2 className="text-lg font-semibold text-[#1A1A1A]">H5 适配</h2>
          <p className="text-sm leading-[1.55] text-[#37352E]">
            窄屏不是等比缩小。注册改成球在上、表单在下；对话去掉顶栏次入口，记忆/历史从设置抽屉进。球在
            H5 不跟随手指（抬指会冻住目光），只保留点击彩虹。触区一律 44px。
          </p>
        </div>
      </div>
    </div>
  );
}
