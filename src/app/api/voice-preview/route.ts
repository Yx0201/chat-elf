import { DashScopeConfigError } from "@/lib/dashscope/config";
import {
  PREVIEWABLE_VOICES,
  synthesizeVoicePreview,
  ttsModelForVoice,
  VoicePreviewError,
} from "@/lib/dashscope/tts-preview";

/**
 * 孵化页音色试听 —— GET /api/voice-preview?voice=<id>。
 *
 * 服务端实时合成一段固定文案(见 tts-preview.ts)并用 mp3 字节流直接响应:
 * 既避免把 TTS 结果地址(24h 有效)暴露给页面,也规避 OSS http 地址在
 * https 页面下被浏览器按混合内容拦截。每次点击都是新合成,不做缓存。
 */

// 编码约定:Route Handler 默认 Node.js runtime,显式声明以防默认值变化。
export const runtime = "nodejs";
// 每次试听都是新合成,不可缓存。
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const voice = searchParams.get("voice");

  if (voice === null || ttsModelForVoice(voice) === null) {
    return Response.json(
      { error: `未知音色;可选: ${PREVIEWABLE_VOICES.join(", ")}` },
      { status: 400 },
    );
  }

  let audioUrl: string;
  try {
    audioUrl = await synthesizeVoicePreview(voice);
  } catch (error) {
    if (error instanceof DashScopeConfigError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (error instanceof VoicePreviewError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    throw error;
  }

  let audio: Response;
  try {
    audio = await fetch(audioUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return Response.json({ error: "获取试听音频失败" }, { status: 502 });
  }
  if (!audio.ok || audio.body === null) {
    return Response.json(
      { error: `获取试听音频失败(上游 ${audio.status})` },
      { status: 502 },
    );
  }

  return new Response(audio.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}