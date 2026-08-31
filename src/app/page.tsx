"use client";

/**
 * 首页 · 登录(2026-08-31 UI 大一统后,首页即登录页)。
 *
 * 主路径:登录 → 孵化(一次性设定性格/音色)→ 对话。
 * 登录成功:本地已有孵化记录 → 直进 /chat;首次来访 → /hatch 孵化。
 *
 * 纯 UI 演示:本期不做账号体系(2026-08-30 已拍板),表单只在本地校验,
 * 不发任何请求。
 *
 * 布局(2026-08-31 二次改版,对齐 bloub 设置页的动效语言,用户拍板):
 * - 桌面:左半场是 bloub 设置页的镜像——一只超大的 idle 球(light 变体,
 *   大小与 bloub 的巨球相当)停在左半场、微微偏出画面左缘,被右半场
 *   的白色表单遮住出血边;眼睛全程跟随鼠标。页面本身**不播**千鸟纹波,
 *   swirl 只属于提交时刻。
 * - 提交校验通过 → 球播 swirl(三环入场 + 眼绕球面一整圈,约 1.5s),
 *   动画结束后球随路由飞到中间,进入 /hatch(已孵化则 /chat)。
 * - H5:单列,idle 球在上、表单在下(bloub 在窄屏同样不放大小球)。
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { BallAnchor, useBall } from "@/components/mimic/ball/ball-context";
import { isHatched } from "@/lib/persona/hatch-state";

export default function LoginPage() {
  const router = useRouter();
  const ball = useBall();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(errorTimer.current);
    },
    [],
  );

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    if (!emailOk || password.length < 8) {
      setError("邮箱格式不对,或密码不满 8 位。");
      ball.flash("alert", 1600);
      return;
    }

    // 已孵化 → 直进对话;未孵化 → 去孵化页。
    // 提交即千鸟纹波:swirl(三环入场 + 眼绕球面一整圈,~1.5s),
    // 动画结束后球随路由飞到中间(孵化页的居中锚点接管)。
    setError(null);
    setSubmitting(true);
    ball.swirl();
    errorTimer.current = setTimeout(
      () => router.replace(isHatched() ? "/chat" : "/hatch"),
      1550,
    );
  }

  const shake = error !== null ? "mimic-shake" : "";

  return (
    <div className="mimic-page min-h-dvh bg-[#0A1530] lg:grid lg:grid-cols-2">
      {/* 左半场:巨型 idle 球(bloub 设置页镜像);H5 为顶部常规球。 */}
      <section className="relative flex flex-col items-center gap-5 overflow-hidden px-6 py-12 lg:block lg:min-h-dvh lg:px-0 lg:py-0">
        <BallAnchor
          state="idle"
          variant="light"
          className="h-40 w-40 lg:absolute lg:left-[-10vw] lg:top-[3vh] lg:h-[64vw] lg:w-[64vw]"
        />
        <div className="flex flex-col items-center gap-5 lg:hidden">
          <h1 className="text-center text-[30px] font-semibold leading-tight text-white">
            一个会转头看你的陪伴。
          </h1>
          <p className="max-w-[420px] py-4 text-center text-sm text-[#A4A097]">
            登录后,从孵化到记忆翻阅,整套旅程都围着这颗拟态球转。
          </p>
          <Link
            href="/language"
            className="text-[13px] text-[#787671] transition-colors hover:text-[#A4A097]"
          >
            拟态球怎么活在系统里 →
          </Link>
        </div>
      </section>

      {/* 右表单(H5 深底;桌面白底,盖住球的出血边 —— z 高于球层) */}
      <section className="relative z-50 flex flex-col justify-center gap-5 px-6 pb-10 lg:min-h-dvh lg:bg-white lg:px-24">
        <div className={shake}>
          <p className="text-[11px] font-semibold tracking-wide text-[#8B7BF6] lg:text-[#5645D4]">第一步</p>
          <h1 className="mt-2 text-3xl font-semibold text-white lg:mt-0 lg:text-4xl lg:text-[#1A1A1A]">
            回来见 TA。
          </h1>
          <p className="mt-3 text-sm leading-[1.55] text-[#A4A097] lg:max-w-[480px] lg:text-base lg:text-[#5D5B54]">
            不需要昵称、不需要头像。第一次来,登录后 TA 会带你完成孵化。
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 lg:gap-5" noValidate>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-[#C9C5BE] lg:text-[#37352E]">邮箱</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="h-11 rounded-lg border border-[#C8C4BE] bg-white px-4 text-sm text-[#1A1A1A] placeholder:text-[#A4A097] focus:border-[#5645D4] focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-[#C9C5BE] lg:text-[#37352E]">密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 8 位"
              autoComplete="current-password"
              className="h-11 rounded-lg border border-[#C8C4BE] bg-white px-4 text-sm text-[#1A1A1A] placeholder:text-[#A4A097] focus:border-[#5645D4] focus:outline-none"
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="h-12 rounded-lg bg-[#5645D4] text-sm font-medium text-white transition-colors hover:bg-[#4536A8] active:bg-[#4536A8] disabled:opacity-70"
          >
            {submitting ? "正在进来…" : "登录"}
          </button>

          {error !== null && <p className="text-[13px] text-[#FF8A80]">{error}</p>}
        </form>

        <p className="text-[13px] leading-[1.55] text-[#A4A097]">
          账号仅用于演示流程:校验在本地完成,不会发送任何请求。
        </p>

        <Link
          href="/language"
          className="hidden text-[13px] text-[#787671] transition-colors hover:text-[#A4A097] lg:block"
        >
          拟态球怎么活在系统里 →
        </Link>
      </section>
    </div>
  );
}