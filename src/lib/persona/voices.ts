/**
 * qwen-audio-3.0-realtime 系列的系统音色清单(step1 P2)。
 *
 * 核实结论(2026-08-29,官方文档):
 * - 可选系统音色共 5 个:`longanqian`(模型默认)、`longanlingxin`、
 *   `longanlingxi`、`longanxiaoxin`、`longanlufeng`。
 *   来源:https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides 「音色配置」
 * - **硬约束**:音色仅可在**第一次** `session.update` 中设置,后续 `session.update`
 *   传入 `voice` 将被忽略 —— 因此「切换音色」在 UI 上等于「开新会话」。
 * - 声音复刻音色:将复刻接口的 `target_model` 设为 `qwen-audio-3.0-realtime-plus`,
 *   接口返回的 `voice_id` 可直接填入 `voice`。本清单只收系统音色(step1 范围)。
 *
 * ⚠️ 未核实项:`note` 字段。
 * 官方未发布 Realtime 专属的音色列表页(`/zh/model-studio/qwen-audio-realtime-voice-list`
 * 返回 404),Realtime 文档只给了 5 个 id、没有中文名与特质描述。
 * 下方 note 取自《Qwen-Audio-TTS音色列表》中**同名 voice 参数**的「特质/年龄/性别」,
 * 但 TTS 文档明确写着"每个模型仅支持一组特定的音色,不能将一个模型的音色与另一个
 * 模型混用",故这些描述对 Realtime 属**参考值、未核实**,实际听感以实测为准。
 * `longanqian` 在 TTS 列表中不存在,note 为空。
 */

export interface RealtimeVoice {
  /** session.update.voice 的取值 */
  id: string;
  /** 参考特质描述(来源为 TTS 同名音色,对 Realtime 未核实) */
  note: string;
  /** 参考性别(同上,未核实);null 表示官方文档未给出 */
  gender: "female" | "male" | null;
}

export const REALTIME_VOICES: readonly RealtimeVoice[] = [
  { id: "longanqian", note: "", gender: null },
  { id: "longanlingxin", note: "知心温暖音 · 25 岁 · 女(参考同名 TTS 音色)", gender: "female" },
  { id: "longanlingxi", note: "可爱甜美音 · 25 岁 · 女(参考同名 TTS 音色)", gender: "female" },
  { id: "longanxiaoxin", note: "亲切活泼音 · 22 岁 · 女(参考同名 TTS 音色)", gender: "female" },
  { id: "longanlufeng", note: "明亮开朗音 · 25 岁 · 男(参考同名 TTS 音色)", gender: "male" },
];

/** 模型默认音色(未显式下发 voice 时服务端采用的值)。 */
export const DEFAULT_VOICE = "longanqian";

/**
 * 韵律启发式(mood.ts)的标定音色。
 *
 * mood.ts 的基频/能量阈值是按 dashscope 通道 qwen3.5-omni 的默认音色 **Tina**
 * 标定的。当前默认通道是 tokenplan(qwen-audio-3.0,音色 longanqian),与标定
 * 音色不同 —— 沿用阈值会得到错误的情绪映射。故非标定音色一律跳过韵律层
 * (step1 P2 的降级要求:只用 ASR 原生 emotion + 流式文本词典两层)。
 */
export const PROSODY_CALIBRATED_VOICE = "Tina";

/** 音色 id 是否在本清单内(自定义/复刻音色不在,UI 需允许手动填写)。 */
export function isKnownVoice(id: string): boolean {
  return REALTIME_VOICES.some((v) => v.id === id);
}
