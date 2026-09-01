"use client";

/**
 * 登录/注册表单(2026-09-01 用户体系 step1;同日晚间按用户需求改为双模式)。
 *
 * 同页两种模式,文字按钮切换(不另写注册页):
 *   - login:邮箱 + 密码 → authClient.signIn.email → 落点服务端判定后 swirl 转场;
 *   - register:邮箱 + 密码 + 邀请码 → /sign-up/email(服务端 hook 校验邀请码,
 *     autoSignIn 已关闭)→ 成功切回 login 模式(邮箱保留预填),用登录进来。
 *
 * 登录/注册走 Better Auth 的 HTTP 端点(cookie 由 /api/auth 直接下发)。
 * 布局(2026-08-31 拍板,对齐 bloub 设置页的动效语言):
 * - 桌面:左半场超大 idle 球(light 变体)微出血,右半场白色表单遮边,眼睛跟随鼠标;
 * - 提交成功(登录)→ 球播 swirl(~1.5s)后随路由飞到中间;注册成功 → wink 一闪;
 * - H5:单列,idle 球在上、表单在下。
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { BallAnchor, useBall } from "@/components/mimic/ball/ball-context";
import { resolveLandingAction } from "@/lib/auth/actions";
import { authClient } from "@/lib/auth/client";

type Mode = "login" | "register";

/** better-auth 的错误码在不同版本有 SNAKE / camel 两种形态,双保险判断。 */
function isUserExistsError(code: unknown, message: unknown): boolean {
  const c = typeof code === "string" ? code.toLowerCase() : "";
  const m = typeof message === "string" ? message.toLowerCase() : "";
  return c.includes("user_already_exists") || c.includes("useralreadyexists") || m.includes("already exists");
}

export function LoginForm() {
  const router = useRouter();
  const ball = useBall();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 认证失败的表情序列第二段(alert→doubt)的接力 timer,卸载/重触发时清理。 */
  const doubtTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(errorTimer.current);
      clearTimeout(doubtTimer.current);
    },
    [],
  );

  /**
   * 认证失败的球反馈(2026-09-01 用户拍板,同日修正):**直立感叹号**(exclaim,
   * bloub 图标样式的"!")1s → 怀疑(doubt)2s → 回原样。此前误用了 alert(斜置
   * 警示条+泪滴),用户要的是纯感叹号。"怀疑"的语义贴"账号密码不对"——球在
   * 琢磨你是谁;本地格式校验错误不走此序列(那是用户自己没填对,纯 alert 提醒)。
   */
  function flashAuthError(): void {
    clearTimeout(doubtTimer.current);
    ball.flash("exclaim", 1000);
    doubtTimer.current = setTimeout(() => ball.flash("doubt", 2000), 1000);
  }

  function switchMode(next: Mode): void {
    setMode(next);
    setError(null);
    setNotice(null);
    ball.swirl();
  }

  async function handleLogin(trimmed: string): Promise<void> {
    const signIn = await authClient.signIn.email({ email: trimmed, password });
    if (signIn.error !== null) {
      setError("邮箱或密码不对。");
      flashAuthError();
      setSubmitting(false);
      return;
    }

    // 落点由服务端判定:有精灵 → /chat;无 → /hatch(首次登录顺带播种预设)。
    // 登录成功即千鸟纹波:swirl(三环入场 + 眼绕球面一整圈,~1.5s),
    // 动画结束后球随路由飞到中间(孵化页的居中锚点接管)。
    const landing = await resolveLandingAction();
    ball.swirl();
    errorTimer.current = setTimeout(() => router.replace(landing), 1550);
  }

  async function handleRegister(trimmed: string): Promise<void> {
    // 走 $fetch 直调端点:signUp.email 的类型化入参不含自定义字段 inviteCode
    const signUp = await authClient.$fetch("/sign-up/email", {
      method: "POST",
      body: {
        email: trimmed,
        password,
        name: trimmed.split("@")[0] ?? trimmed,
        inviteCode: inviteCode.trim(),
      },
    });

    if (signUp.error !== null) {
      const err = signUp.error as { code?: unknown; message?: unknown };
      if (String(err.code ?? "").includes("INVITE_CODE_INVALID")) {
        setError("邀请码不对。");
      } else if (isUserExistsError(err.code, err.message)) {
        setError("这个邮箱已经注册过了,直接登录就好。");
        setMode("login");
      } else {
        setError("注册没成功,稍后再试。");
      }
      flashAuthError();
      setSubmitting(false);
      return;
    }

    // 注册成功(autoSignIn 已关,未建会话):切回登录模式,邮箱保留预填
    setPassword("");
    setInviteCode("");
    setMode("login");
    setNotice("注册成功。用邮箱和密码登录进来,TA 在等你。");
    ball.flash("wink", 800);
    setSubmitting(false);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const trimmed = email.trim();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    if (!emailOk || password.length < 8) {
      setError("邮箱格式不对,或密码不满 8 位。");
      ball.flash("alert", 1600);
      return;
    }
    if (mode === "register" && inviteCode.trim() === "") {
      setError("内测邀请码不能为空。");
      ball.flash("alert", 1600);
      return;
    }

    setError(null);
    setNotice(null);
    setSubmitting(true);

    if (mode === "login") {
      await handleLogin(trimmed);
    } else {
      await handleRegister(trimmed);
    }
  }

  const shake = error !== null ? "mimic-shake" : "";
  const isRegister = mode === "register";

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
          <p className="text-[11px] font-semibold tracking-wide text-[#8B7BF6] lg:text-[#5645D4]">
            {isRegister ? "第一步 · 注册" : "第一步"}
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-white lg:mt-0 lg:text-4xl lg:text-[#1A1A1A]">
            {isRegister ? "把 TA 领回家。" : "回来见 TA。"}
          </h1>
          <p className="mt-3 text-sm leading-[1.55] text-[#A4A097] lg:max-w-[480px] lg:text-base lg:text-[#5D5B54]">
            {isRegister
              ? "填好邮箱、密码和邀请码。注册成功后回到登录,用邮箱和密码进来。"
              : "不需要昵称、不需要头像。第一次来,注册后 TA 会带你完成孵化。"}
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
              autoComplete={isRegister ? "new-password" : "current-password"}
              className="h-11 rounded-lg border border-[#C8C4BE] bg-white px-4 text-sm text-[#1A1A1A] placeholder:text-[#A4A097] focus:border-[#5645D4] focus:outline-none"
            />
          </label>

          {isRegister ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-[#C9C5BE] lg:text-[#37352E]">
                内测邀请码
              </span>
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="输入邀请码"
                autoComplete="off"
                className="h-11 rounded-lg border border-[#C8C4BE] bg-white px-4 text-sm text-[#1A1A1A] placeholder:text-[#A4A097] focus:border-[#5645D4] focus:outline-none"
              />
            </label>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="h-12 rounded-lg bg-[#5645D4] text-sm font-medium text-white transition-colors hover:bg-[#4536A8] active:bg-[#4536A8] disabled:opacity-70"
          >
            {submitting ? (isRegister ? "正在注册…" : "正在进来…") : isRegister ? "注册" : "登录"}
          </button>

          {error !== null && <p className="text-[13px] text-[#FF8A80]">{error}</p>}
          {notice !== null && <p className="text-[13px] text-[#8B7BF6] lg:text-[#5645D4]">{notice}</p>}
        </form>

        {/* 登录 ⇄ 注册 切换(同页切换模式,不另写注册页) */}
        <button
          type="button"
          onClick={() => switchMode(isRegister ? "login" : "register")}
          className="self-start text-[13px] font-medium text-[#787671] transition-colors hover:text-[#A4A097]"
        >
          {isRegister ? "已有账号?去登录 →" : "第一次来?去注册 →"}
        </button>

        <p className="text-[13px] leading-[1.55] text-[#A4A097]">
          邮箱只用来登录你的账号,没有昵称、没有头像。内测期间注册需要邀请码。
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
