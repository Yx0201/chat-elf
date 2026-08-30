"use client";

/**
 * 01 注册 · 孵化（Ardot 设计稿 3:142，纯 UI 演示，无后端）。
 *
 * 桌面左右分栏：左深色舞台放 egg 球（260px，浅体深眼反色），右浅色表单。
 * H5 单列全深底、球 160px 在上、白色输入卡在下。
 *
 * 交互（spec §3.1）：
 * - 提交成功：egg → burst 彩虹 → idle，随后进入性格设置页；
 * - 校验失败：球切 alert（感叹号斜飞），表单抖动提示。
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { BallAnchor, useBall } from "@/components/mimic/ball/ball-context";

export default function RegisterPage() {
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
      setError("邮箱格式不对，或密码不满 8 位。");
      ball.flash("alert", 1600);
      return;
    }

    // 成功：egg → burst 彩虹 → idle → 进入性格设置（设计稿 3.1 流程）
    setError(null);
    setSubmitting(true);
    ball.triggerBurst();
    ball.setBallState("idle");
    errorTimer.current = setTimeout(() => router.push("/mimic/persona"), 1900);
  }

  const shake = error !== null ? "mimic-shake" : "";

  return (
    <div className="mimic-page min-h-dvh bg-[#0A1530] lg:grid lg:grid-cols-2">
      {/* 左舞台（H5 为顶部区域） */}
      <section className="flex flex-col items-center justify-center gap-5 px-6 py-12 lg:min-h-dvh lg:gap-6 lg:py-16">
        <BallAnchor state="egg" variant="light" className="h-40 w-40 lg:h-[260px] lg:w-[260px]" />
        <p className="hidden max-w-[420px] text-center text-sm text-[#A4A097] lg:block">
          egg 态 · 它还没出生，会轻轻摇，目光跟着你的光标。
        </p>
        <p className="hidden max-w-[420px] text-center text-[13px] text-[#787671] lg:block">
          邮箱提交瞬间：egg → burst 彩虹 → idle。失败则切 alert。
        </p>
        <Link
          href="/mimic"
          className="text-[13px] text-[#787671] transition-colors hover:text-[#A4A097]"
        >
          ← 封面
        </Link>
      </section>

      {/* 右表单（H5 深底白卡；桌面白底） */}
      <section className="flex flex-col justify-center gap-5 px-6 pb-10 lg:min-h-dvh lg:bg-white lg:px-24 lg:gap-6">
        <div className={shake}>
          <p className="text-[11px] font-semibold tracking-wide text-[#8B7BF6] lg:text-[#5645D4]">第一步</p>
          <h1 className="mt-2 text-3xl font-semibold text-white lg:mt-0 lg:text-4xl lg:text-[#1A1A1A]">
            把它孵出来。
          </h1>
          <p className="mt-3 text-sm leading-[1.55] text-[#A4A097] lg:max-w-[480px] lg:text-base lg:text-[#5D5B54]">
            不需要头像、不需要昵称。先给它一个邮箱，它就会醒来。
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
              className="h-11 rounded-lg border border-[#C8C4BE] bg-white px-4 text-sm text-[#1A1A1A] placeholder:text-[#A4A097] focus:border-[#5645D4] focus:outline-none lg:h-11"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-[#C9C5BE] lg:text-[#37352E]">密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 8 位"
              autoComplete="new-password"
              className="h-11 rounded-lg border border-[#C8C4BE] bg-white px-4 text-sm text-[#1A1A1A] placeholder:text-[#A4A097] focus:border-[#5645D4] focus:outline-none lg:h-11"
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="h-12 rounded-lg bg-[#5645D4] text-sm font-medium text-white transition-colors hover:bg-[#4536A8] active:bg-[#4536A8] disabled:opacity-70"
          >
            {submitting ? "正在唤醒…" : "唤醒它"}
          </button>

          {error !== null && <p className="text-[13px] text-[#FF8A80]">{error}</p>}
        </form>

        <p className="text-[13px] font-medium text-[#4DA3F5] lg:text-[#0075DE]">已经有账号？登录</p>
      </section>
    </div>
  );
}
