/**
 * 语气(mood)三层来源与合成规则。
 *
 * 1. 用户情绪镜像:百炼 ASR 增量事件(input_audio_transcription.delta)原生携带
 *    emotion 字段(7 种枚举,流式、无需等说完),聆听/思考期直接映射为共情表情。
 *    —— 协议原生,官方文档已核实(2026-08):
 *      https://help.aliyun.com/zh/model-studio/server-events
 * 2. 音频韵律启发式:远端播放流的基频(F0)+ 能量 → 粗粒度语气(高亢/低沉)。
 *    模型输出侧协议无任何情绪字段(已逐事件核实),韵律是唯一的原生信号。
 * 3. 流式文本词典:response.audio_transcript.delta 与语音同步到达,对累积字幕
 *    按优先级词典匹配语义语气(抱歉/好奇等韵律看不出来的)。
 *
 * 合成:说话期 文本(语义) > 韵律(声学) > neutral;聆听/思考期 用户情绪镜像。
 *
 * ⚠️ 韵律层的适用前提:下方阈值是按 dashscope 通道(qwen3.5-omni)的默认音色
 * **Tina** 标定的。换任何其他音色(含 tokenplan 通道默认的 longanqian)都会失真,
 * 此时必须跳过本层 —— 由 `use-realtime-session` 依 `PROSODY_CALIBRATED_VOICE`
 * 门控采样(step1 P2 的降级要求),退化后只剩 ASR 情绪镜像 + 流式文本词典两层。
 */

export type ElfMood =
  | "neutral"
  | "happy"
  | "excited"
  | "gentle"
  | "sorry"
  | "curious"
  /** 陪伴模式随机轮播扩充:专注 */
  | "focused"
  /** 陪伴模式随机轮播扩充:得意 */
  | "smug"
  /** 陪伴模式随机轮播扩充:羞怯 */
  | "shy";

/** ASR emotion 枚举 → 表情语气(共情映射:用户难过/生气时 elf 表达关切)。 */
const USER_EMOTION_TO_MOOD: Record<string, ElfMood> = {
  neutral: "neutral",
  happy: "happy",
  sad: "sorry",
  angry: "sorry",
  surprised: "curious",
  disgusted: "gentle",
  fearful: "gentle",
};

export function moodFromUserEmotion(emotion: string | null | undefined): ElfMood {
  if (emotion === null || emotion === undefined) return "neutral";
  return USER_EMOTION_TO_MOOD[emotion] ?? "neutral";
}

/** [语气, 优先级(高者胜), 触发词] */
const TEXT_LEXICON: Array<[ElfMood, number, readonly string[]]> = [
  ["sorry", 5, ["抱歉", "对不起", "不好意思", "我错了", "别难过", "原谅"]],
  ["excited", 4, ["太好了", "太棒了", "哇", "哈哈", "超级", "惊喜", "太厉害", "兴奋"]],
  ["curious", 3, ["好奇", "猜猜", "想知道", "为什么呢", "要不要猜"]],
  ["gentle", 2, ["别急", "慢慢来", "抱抱", "陪着你", "放松", "深呼吸", "没事的"]],
  ["happy", 1, ["开心", "高兴", "喜欢", "快乐", "很高兴"]],
];

/** 对累积字幕做语义语气判断;无命中返回 null(交由下层来源决定)。 */
export function textMood(text: string): ElfMood | null {
  if (text.length < 2) return null;
  let best: { mood: ElfMood; priority: number } | null = null;
  for (const [mood, priority, words] of TEXT_LEXICON) {
    for (const word of words) {
      if (text.includes(word) && (best === null || priority > best.priority)) {
        best = { mood, priority };
      }
    }
  }
  return best?.mood ?? null;
}

export interface ProsodySample {
  /** 均方根能量(0~1 量级) */
  rms: number;
  /** 基频 Hz;非周期帧(噪声/静音)为 null */
  pitch: number | null;
}

// 阈值按 Tina 音色闲聊语气的经验值标定,实际听感不符时优先调这里。
const PITCH_EXCITED_HZ = 235;
const PITCH_HAPPY_HZ = 195;
const PITCH_GENTLE_HZ = 150;
const RMS_LOUD = 0.05;
const RMS_SOFT = 0.035;
const MIN_VOICED = 3;

/** 韵律 → 粗粒度语气;样本不足或特征不显著返回 null。 */
export function prosodyToMood(samples: readonly ProsodySample[]): ElfMood | null {
  const voiced = samples.filter((s) => s.pitch !== null && s.rms > 0.015);
  if (voiced.length < MIN_VOICED) return null;

  const pitches = voiced
    .map((s) => s.pitch as number)
    .sort((a, b) => a - b);
  const medianPitch = pitches[Math.floor(pitches.length / 2)];
  const meanRms = voiced.reduce((sum, s) => sum + s.rms, 0) / voiced.length;

  if (medianPitch > PITCH_EXCITED_HZ && meanRms > RMS_LOUD) return "excited";
  if (medianPitch > PITCH_HAPPY_HZ) return "happy";
  if (medianPitch < PITCH_GENTLE_HZ && meanRms < RMS_SOFT) return "gentle";
  return null;
}
