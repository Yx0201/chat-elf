/**
 * 孵化页「音色试听」的 TTS 合成 —— 服务端专用(密钥绝不进入前端 bundle)。
 *
 * 端点与参数按官方《非实时语音合成(Qwen-Audio-TTS/CosyVoice)HTTP API参考》核实:
 *   POST https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
 *   非流式响应在 output.audio.url 返回 24 小时有效的音频地址。
 *   来源:https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api
 *
 * 「音色 × 模型」映射为 2026-08-31 逐个实测(本地直调上游 API 验证):
 *   - longanqian 只被 plus 接受(TTS 音色列表里没有这个 id,flash 上 400);
 *   - longanxiaoxin 只被 flash 接受(plus 上 400);
 *   - longanlingxi 两个模型都通,按官方音色列表归属用 flash;
 *   - longanlingxin / longanlufeng 按音色列表归属 plus。
 * 注意:试听走 TTS、会话走实时模型,同名音色两者听感仍有差异,
 * 试听只作参考 —— 详见 persona/voices.ts 的未核实标注。
 */

import { resolveDashScopeConfig } from "@/lib/dashscope/config";

/** 试听固定文案(2026-08-31 拍板:每次调用都读同一句,不做逐次差异化)。 */
export const VOICE_PREVIEW_TEXT = "你好啊,我是你的好朋友,之后我们会一起度过愉快的时光";

/** 实时系统音色 → 可合成它的 TTS 模型(实测结果见文件头)。 */
const VOICE_TTS_MODEL: Readonly<Record<string, string>> = {
  longanqian: "qwen-audio-3.0-tts-plus",
  longanlingxin: "qwen-audio-3.0-tts-plus",
  longanlingxi: "qwen-audio-3.0-tts-flash",
  longanxiaoxin: "qwen-audio-3.0-tts-flash",
  longanlufeng: "qwen-audio-3.0-tts-plus",
};

/** 可试听的音色 id(= 孵化页的 5 个系统音色)。 */
export const PREVIEWABLE_VOICES: readonly string[] = Object.keys(VOICE_TTS_MODEL);

export class VoicePreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoicePreviewError";
  }
}

/** 音色对应的 TTS 模型;不在可试听清单时返回 null。 */
export function ttsModelForVoice(voice: string): string | null {
  return VOICE_TTS_MODEL[voice] ?? null;
}

interface TtsResponse {
  output?: {
    audio?: {
      url?: string;
    };
  };
}

/** 下游返回 http:// 的 OSS 地址;页面若部署在 https 上,须升级协议才能播放。 */
function toHttps(url: string): string {
  return url.replace(/^http:/, "https:");
}

/**
 * 合成一段试听音频,返回 24 小时内有效的 https 音频 URL。
 * 配置缺失 / 上游失败 / 响应无音频地址时抛错,由路由层转成 JSON 错误响应。
 */
export async function synthesizeVoicePreview(voice: string): Promise<string> {
  const model = ttsModelForVoice(voice);
  if (model === null) {
    throw new VoicePreviewError(`不存在可试听的音色: ${voice}`);
  }

  const config = resolveDashScopeConfig();
  const endpoint =
    `https://${config.workspaceId}.${config.region}.maas.aliyuncs.com` +
    `/api/v1/services/audio/tts/SpeechSynthesizer`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: {
          text: VOICE_PREVIEW_TEXT,
          voice,
          format: "mp3",
          sample_rate: 24000,
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new VoicePreviewError("连接百炼语音合成端点失败");
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new VoicePreviewError(`语音合成失败(上游 ${res.status}): ${detail}`);
  }

  const body = (await res.json()) as TtsResponse;
  const url = body.output?.audio?.url;
  if (typeof url !== "string" || url === "") {
    throw new VoicePreviewError("语音合成响应缺失音频地址");
  }
  return toHttps(url);
}