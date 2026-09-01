/**
 * 远端音频播放控制(WebRTC 模式)。
 *
 * 与 WebSocket 模式"逐帧 base64 入队播放"不同:WebRTC 下远端音频经 RTP 轨道
 * 直达浏览器抖动缓冲,由 <audio> 元素连续播放,应用层没有真正的"队列"。
 * 因此打断(barge-in)的实现是:先做 ~120ms 音量淡出(避免硬切爆音,也给
 * 对端 AEC 的残余抑制一个软过渡),再把元素重挂到媒体流的实时沿、丢弃已缓冲
 * 的残余音频——效果等价于清空播放队列。
 *
 * 参考官方 WebRTC 最佳实践(2026-08 核实):
 * https://help.aliyun.com/zh/model-studio/best-practice-webrtc-omni-realtime
 */

import type { ProsodySample } from "./mood";

const FADE_OUT_MS = 120;

/** 韵律分析抽头:周期性采样播放流的能量与基频,供语气启发式使用。 */
export interface ProsodyTap {
  /** 当前帧不可用(如上下文未就绪)时返回 null。 */
  sample(): ProsodySample | null;
  dispose(): void;
}

/**
 * 归一化自相关提基频;搜索 70–400Hz,非周期帧(噪声/静音)返回 null。
 * 纯时域方法,无依赖;每帧约 0.7M 次乘加,150ms 采样一次可忽略。
 */
function detectPitch(buf: Float32Array, sampleRate: number): number | null {
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.008) return null;

  const half = buf.length >> 1;
  const minLag = Math.max(2, Math.floor(sampleRate / 400));
  const maxLag = Math.min(Math.floor(sampleRate / 70), half);
  let bestCorr = 0;
  let bestLag = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let norm0 = 0;
    let norm1 = 0;
    for (let i = 0; i < half; i++) {
      corr += buf[i] * buf[i + lag];
      norm0 += buf[i] * buf[i];
      norm1 += buf[i + lag] * buf[i + lag];
    }
    const norm = corr / Math.sqrt(norm0 * norm1 + 1e-9);
    if (norm > bestCorr) {
      bestCorr = norm;
      bestLag = lag;
    }
  }
  if (bestCorr < 0.6 || bestLag < 0) return null;
  return sampleRate / bestLag;
}

export class RemoteAudioPlayer {
  private element: HTMLAudioElement | null = null;
  private fadeFrame = 0;
  private tapContext: AudioContext | null = null;

  /** 创建隐藏的 <audio> 并绑定远端流(首次 ontrack 时调用)。 */
  attach(stream: MediaStream): void {
    this.ensureElement();
    if (this.element === null) {
      return;
    }
    this.element.volume = 1;
    this.element.srcObject = stream;
    // 自动播放策略:start() 由用户点击触发,已满足手势解锁;此处的 play()
    // 失败仅意味着需要用户与页面再交互一次,不视为会话错误。
    this.element.play().catch(() => {});
  }

  /**
   * 打断:音量快速淡出 → 暂停 → 重挂流以丢弃缓冲中的残余语音。
   * 在 input_audio_buffer.speech_started(用户开始说话)时调用。
   */
  interrupt(): void {
    const el = this.element;
    if (el === null) {
      return;
    }
    cancelAnimationFrame(this.fadeFrame);
    const startVolume = el.volume;
    const startedAt = performance.now();
    const step = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / FADE_OUT_MS);
      el.volume = startVolume * (1 - progress);
      if (progress < 1) {
        this.fadeFrame = requestAnimationFrame(step);
        return;
      }
      this.snapToLiveEdge(el);
    };
    this.fadeFrame = requestAnimationFrame(step);
  }

  /**
   * 思考保持(2026-09-01 thinking 防闪烁闸门):暂停播放但**不**重挂流 ——
   * 抖动缓冲保留,resume() 时从暂停处继续,回复的语音头不会被丢弃。
   * 与 interrupt() 的区别就在于此:interrupt 要丢掉残余(用户打断了,
   * 旧答案作废),hold 要留着(thinking 演示完接着播)。
   */
  hold(): void {
    cancelAnimationFrame(this.fadeFrame);
    this.element?.pause();
  }

  /** 恢复出声(response.created / 新一轮回答开始时调用)。 */
  resume(): void {
    cancelAnimationFrame(this.fadeFrame);
    const el = this.element;
    if (el === null) {
      return;
    }
    el.volume = 1;
    el.play().catch(() => {});
  }

  dispose(): void {
    cancelAnimationFrame(this.fadeFrame);
    if (this.tapContext !== null) {
      void this.tapContext.close().catch(() => {});
      this.tapContext = null;
    }
    if (this.element !== null) {
      this.element.pause();
      this.element.srcObject = null;
      this.element.remove();
      this.element = null;
    }
  }

  /**
   * 在隐藏 <audio> 元素上建立分析抽头(MediaElementSource → AnalyserNode)。
   * 走元素而非 createMediaStreamSource:后者在 Chrome 上对远端 WebRTC 流
   * 历史上存在输出静音的问题,元素抽头是可视化的标准做法。
   * 每个元素只能 source 一次,故每会话调用一次;失败返回 null(分析是尽力而为)。
   */
  enableAnalysis(): ProsodyTap | null {
    const el = this.element;
    if (el === null || this.tapContext !== null || typeof AudioContext === "undefined") {
      return null;
    }
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyser.connect(ctx.destination); // 必须回连,否则元素静音
      this.tapContext = ctx;
      const buffer = new Float32Array(analyser.fftSize);
      return {
        sample(): ProsodySample | null {
          if (ctx.state === "suspended") {
            void ctx.resume().catch(() => {});
          }
          if (ctx.state !== "running") return null;
          analyser.getFloatTimeDomainData(buffer);
          let sum = 0;
          for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
          return { rms: Math.sqrt(sum / buffer.length), pitch: detectPitch(buffer, ctx.sampleRate) };
        },
        dispose() {
          void ctx.close().catch(() => {});
        },
      };
    } catch {
      return null;
    }
  }

  /** 暂停并把元素重新绑定到流的实时沿,丢弃抖动缓冲里的残余帧。 */
  private snapToLiveEdge(el: HTMLAudioElement): void {
    el.pause();
    const stream = el.srcObject;
    el.srcObject = null;
    if (stream instanceof MediaStream) {
      el.srcObject = stream;
    }
    // 此刻已暂停,恢复音量不会立刻出声;下一次 resume() 时从满音量开始。
    el.volume = 1;
  }

  private ensureElement(): void {
    if (this.element !== null || typeof document === "undefined") {
      return;
    }
    const el = document.createElement("audio");
    el.autoplay = true;
    el.setAttribute("playsinline", "");
    el.style.display = "none";
    document.body.appendChild(el);
    this.element = el;
  }
}
