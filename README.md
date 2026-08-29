# chat-elf

AI 实时语音对话应用。Next.js(App Router + TypeScript)为唯一应用框架;实时语音经
**WebRTC** 接入阿里云百炼——音频直连媒体服务器,SDP 信令由本站 Route Handler 转发,
API Key 只存在于服务端。支持两条接入通道(`REALTIME_PROVIDER` 切换):

- **tokenplan**(默认):百炼 Token Plan 订阅,模型 `qwen-audio-3.0-realtime-plus`;
- **dashscope**:百炼业务空间,模型 `qwen3.5-omni-flash-realtime`。

技术决策与架构见 [ARCHITECTURE.md](./ARCHITECTURE.md);工程约束见 [AGENTS.md](./AGENTS.md)。

## 快速开始

```bash
pnpm install                    # 仅允许使用 pnpm
cp .env.example .env.local      # 填入 TOKENPLAN_API_KEY(默认通道);切回 dashscope 见文件内注释
pnpm dev                        # http://localhost:3000
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发服务器 |
| `pnpm build` | 生产构建(提交前必跑) |
| `pnpm lint` | ESLint 检查(提交前必跑) |

## 当前进度

实时语音链路已完整实现(可直接浏览器实测):

- `src/app/api/realtime/session/route.ts` — WebRTC SDP 信令转发(Node runtime),信令连通性已验证
- `src/lib/dashscope/config.ts` — 服务端配置读取与端点拼装
- `src/lib/realtime/events.ts` + `parse-events.ts` — Realtime 协议全量事件类型与零断言解析(官方文档核实)
- `src/lib/realtime/use-realtime-session.ts` — 会话状态机:麦克风采集、媒体门控(参照官方"session.created 前的音频会被丢弃"约束)、SDP 协商、DataChannel 双通道分发、semantic_vad、字幕流、打断处理
- `src/lib/realtime/audio-playback.ts` — 远端音频播放与打断清队(WebRTC 下为重挂流到实时沿)
- `src/components/chat/chat-panel.tsx` — 对话 UI:状态指示、双向字幕、启停控制

待实现:记忆管道(`src/lib/memory/`,届时引入 zod 与 AI SDK)、Supabase 持久化(暂缓)、120 分钟上限自动重连(依赖落库历史)。
