/**
 * 当前时间的中文标签(客户端安全,无依赖)。
 *
 * 用途:模型没有任何"今天几号"的概念 —— 语音 session.instructions、
 * 文本线 instructions、联网搜索执行端三处都要注入,否则相对时间
 * (今天/明天/最近)无法换算,天气时效类回答必然混乱(2026-09-06 实锤)。
 *
 * 时区:默认取设备本地;服务端调用必须显式传 "Asia/Shanghai"
 * (生产函数在首尔 UTC+9,与用户 UTC+8 有跨日错位窗口)。
 */

export function currentDateLabel(now: Date = new Date(), timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timeZone ?? undefined,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `现在是${get("year")}年${get("month")}月${get("day")}日 ${get("weekday")} ${get("hour")}:${get("minute")}`;
}

/** 仅日期部分(搜索执行端的检索锚定用)。 */
export function currentDateAnchor(now: Date = new Date(), timeZone?: string): string {
  return currentDateLabel(now, timeZone).replace(/ \d{2}:\d{2}$/, "");
}
