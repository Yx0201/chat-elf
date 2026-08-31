# ARCHITECTURE.md — chat-elf 技术架构

本文档记录全部技术选型与架构决策。标注约定：【已确认】为不可更改的技术决策；【规划】为当前设计意向，允许讨论调整。其他工程约束见 [AGENTS.md](./AGENTS.md)。

---

## 技术栈【已确认】

| 决策项 | 结论 |
| --- | --- |
| 包管理器 | **pnpm**（唯一包管理器，不要产生 package-lock.json / yarn.lock） |
| 应用框架 | **Next.js**（App Router + TypeScript，`create-next-app --typescript --app --tailwind` 基线） |
| 持久化 | **PostgreSQL**：本地开发用本机实例，上线切换 Neon（2026-08-29 修订，详见「持久化架构」）；Supabase 降级为将来 Auth 的候选项，暂不引入 |
| 数据库查询层 | **Drizzle ORM**（2026-08-29 选定）。只用于**查询侧类型安全**，迁移保持手写 SQL，故不引入 drizzle-kit、不做 codegen；底层驱动 `pg`。排除 Prisma 的决定性理由：其对 `vector` 列只能声明 `Unsupported()`，语义检索必须回落 `$queryRaw` + `::text` 转换，ORM 查询 API 在核心场景失效而查询引擎/codegen 代价照付 |
| 对话模型 | 双通道（2026-08-28 修订）：默认 **Token Plan** 订阅通道，模型 `qwen-audio-3.0-realtime-plus`（Qwen-Audio-Realtime 系列）；保留 **DashScope** 业务空间通道，模型 `qwen3.5-omni-flash-realtime`。由 `REALTIME_PROVIDER` 环境变量切换（`tokenplan` \| `dashscope`） |
| 运行时语言 | TypeScript strict，前后端同构于 Next.js |
| UI 组件 | **shadcn/ui**（基于 Tailwind CSS；用哪个组件加哪个，不整包引入）。**尚未初始化**：现有组件均手写 Tailwind，引入 shadcn 会连带 `class-variance-authority` / `clsx` / `tailwind-merge` / `lucide-react`，需按依赖约束另行报批 |
| 状态管理 | **zustand**（按需引入）。**尚未引入**：当前人格/音色设置仅 3 个字段、组件树 2 层，用 `useSyncExternalStore` + props 足够；待人格入库、需多处共享人格列表时再评估 |
| 类型/数据校验 | **zod** |
| Agent 框架 | **Vercel AI SDK**（仅服务端文本型 agentic 任务；实时语音链路不使用，见下文） |

分工原则：能用 Next.js 解决的（页面、Route Handler、Server Actions）不用额外服务；只有 Next.js 做不了的能力（持久化、鉴权、文件存储）才落到外部服务。当前持久化为 PostgreSQL（本地 → Neon），数据库访问一律走 Next.js 服务端 —— **读走 Server Component 直取，写走 Server Action，不建 REST 数据路由**（实时信令转发是唯一保留的 Route Handler）。

依赖引入原则【已确认】：需要组件库、状态管理、类型校验时，首选分别是 shadcn/ui、zustand、zod，不得引入同类替代品；且一律按需下载——写到哪个功能才装哪个依赖，不做预装囤积。

## 实时链路架构【已确认】

qwen3.5-omni-flash-realtime 支持 WebSocket / WebRTC / AOQ 三种接入协议，本项目选定 **WebRTC**：

```text
┌─ 浏览器 ────────────────────────────────────────────┐
│  getUserMedia(麦克风)                                │
│  RTCPeerConnection ── RTP 音频 ──▶ 阿里云媒体服务器   │  ← 媒体流直连，不经业务服务器
│        ▲                                            │
│        └── DataChannel("txt") 事件 JSON（双向）       │
└──────────────┬──────────────────────────────────────┘
               │ ① POST(Offer SDP)，②返回 Answer SDP（信令，仅此一步走服务器）
┌─ Next.js ▼ ─────────────────────────────────────────┐
│  Route Handler: POST /api/realtime/session          │
│    附加 Authorization: Bearer ${当前通道的 API_KEY}   │
│    转发至该通道的 WebRTC 信令端点                     │
│  （API Key 只存在于服务端，绝不进前端 bundle）          │
└─────────────────────────────────────────────────────┘
               │ 持久化
┌─ PostgreSQL ▼ ──────────────────────────────────────┐
│  本地 PG 实例开发，上线切 Neon（仅改连接串）            │
│  会话/转写/记忆表 · 访问一律走 Next.js 服务端          │
└─────────────────────────────────────────────────────┘
```

选定理由（排除另外两条路）：

- **浏览器直连 WebSocket ❌**：浏览器 WebSocket 无法设置 `Authorization` 自定义头，直连意味着把 API Key 下发给前端，不可接受。
- **WebSocket 服务端中继 ❌**：Next.js Route Handler 不支持长连接 WebSocket upgrade，自建 Node 中继服务违背"Next.js 为主"的原则。
- **AOQ ❌**：QUIC 直连优化方案，面向非浏览器客户端，Web 场景无需。
- **WebRTC ✅**：官方 WebRTC 信令接口受浏览器跨域策略限制不能直接调用，但只需一次 HTTP SDP 交换（Offer→Answer），由 Next.js Route Handler 转发即可，天然规避两个问题；建立连接后音视频走 UDP/P2P 直连阿里云，延迟最低且不占业务服务器资源。

### 接入通道双轨制（2026-08-28 修订）

信令转发路由（`/api/realtime/session`）按 `REALTIME_PROVIDER` 在两条通道间切换，两条通道的信令协议形态一致（`POST {endpoint}/api/v1/webrtc/realtime?model=xxx`，`Content-Type: application/sdp`，Bearer 鉴权，无临时令牌——依据 [Token 鉴权文档](https://help.aliyun.com/zh/model-studio/realtime-token-authentication)核实）：

| 通道 | 端点 | 模型 | 密钥变量 |
| --- | --- | --- | --- |
| **tokenplan**（默认） | `https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime` | `qwen-audio-3.0-realtime-plus` | `TOKENPLAN_API_KEY` |
| dashscope | `https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1/webrtc/realtime` | `qwen3.5-omni-flash-realtime` | `DASHSCOPE_API_KEY` + `DASHSCOPE_WORKSPACE_ID` |

两通道模型的会话参数差异（`src/lib/realtime/session-defaults.ts` 承载，页面注入客户端 Hook）：

- **qwen-audio-3.0 系列**（tokenplan）：`turn_detection` 仅支持 `server_vad` / `smart_turn` / `null`（无 `semantic_vad`）；无 `idle_timeout_ms`（静默主动找话在该模型不可用）；无独立输入转写配置项（转写默认开启）；默认音色 `longanqian`；上下文上限更低（50 轮音频 / 300 秒）。附加能力（2026-08-29 依据[官方文档](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)核实）：
  - **系统音色共 5 个**（`src/lib/persona/voices.ts`）：`longanqian`（默认）、`longanlingxin`、`longanlingxi`、`longanxiaoxin`、`longanlufeng`。⚠️ 官方**没有** Realtime 专属音色列表页（`/zh/model-studio/qwen-audio-realtime-voice-list` 为 404），代码里的中文特质取自同名 TTS 音色页，而 TTS 文档明确"每个模型仅支持一组特定的音色、不能混用"，故标注为**参考值、未核实**。
  - **支持 Function Calling** —— 会话中实时记忆标记可行，无需依赖通道降级。2026-08-30 已落地，见「Function Calling」。
  - **支持声音复刻音色**：复刻接口 `target_model` 填 `qwen-audio-3.0-realtime-plus`，返回的 `voice_id` 可直接用作 `voice` → **音色克隆可接入实时链路**。
  - 新增可用参数 `max_history_turns`（1-50，默认 20，见「模型已知约束」）。
  - **不支持图片输入**（纯语音模型）——图片解读必须切 dashscope 通道；本项目已决定不做图片能力。
- **qwen3.5-omni 系列**（dashscope）：参数基线见「会话参数基线」。

合规提示：Token Plan 官方 FAQ 载明套餐额度仅限 AI 编程工具与 Agent 类工具使用、禁止用于自定义应用后端的自动化调用；本项目以其团队版"支持实时语音对话模型"的描述为前提接入，实际可用性以官方账单/风控为准。

DashScope WebRTC 信令端点形态（以官方文档为准）：

- `POST https://{WorkspaceId}.{REGION}.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.5-omni-flash-realtime`
- Header：`Content-Type: application/sdp`、`Authorization: Bearer <API_KEY>`
- Body：Offer SDP 文本；响应体：Answer SDP 文本
- 连接建立后服务端先在名为 `txt` 的 DataChannel 上发送 `session.created` 事件

## Agentic 层架构【已确认】

职责边界：**AI SDK 只运行在服务端、只处理文本型任务**；WebRTC 实时语音链路保持自有封装（`use-realtime-session`），不被任何 agent 框架接管。在"AI SDK + PostgreSQL 自建"之外不引入 LangGraph / LangChain 等重编排框架——当前需求是检索→注入→落库的直线管道加少量工具循环，无需状态图引擎；将来若需要复杂多智能体编排，优先评估构建于 AI SDK 之上的 TS 框架（如 Mastra），迁移成本最低。

模型连通：`@ai-sdk/openai-compatible` 指向 DashScope OpenAI 兼容模式，Qwen 文本与 embedding 模型均走此通道；复用 `DASHSCOPE_API_KEY`，同样只在服务端出现。

**兼容端点有两种官方写法（2026-08-29 实测：两者均可用，且对同一输入返回完全一致的向量）**：

| 写法 | 端点 | 说明 |
| --- | --- | --- |
| **A（代码默认）** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 公共云端点，只需 API Key —— 本文件已确认项 |
| B | `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1` | 业务空间端点，官方文档（通用文本向量同步接口 API 详情）给出 |

需要时可用 `DASHSCOPE_COMPATIBLE_BASE_URL` 切到 B。

**模型（2026-08-29 实测可用）**：

| 用途 | 模型 | 核实结论 |
| --- | --- | --- |
| 文本（记忆抽取 / 摘要） | `qwen-plus`（`DASHSCOPE_TEXT_MODEL` 可覆盖） | chat completions 与 `response_format: json_schema` 结构化输出均正常 |
| 文本向量 | `text-embedding-v3`（`DASHSCOPE_EMBEDDING_MODEL` 可覆盖） | 默认维度 **1024**；v3 / v4 / qwen3.7-text-embedding 三者默认维度都是 1024，故取 1024 可在换模型时不改表 |

### 记忆：四层 + 双轨写入（2026-08-30 修订）

| 层 | 载体 | 内容 |
| --- | --- | --- |
| 工作记忆 | `session.update` 的 `instructions` | 人格 + 记忆上下文，当前会话可见 |
| 情景记忆 | `messages` 表 | 逐条转写，按时间检索 |
| 语义记忆（碎片层） | `memories` 表 + pgvector | 长期事实/偏好/事件，向量检索 |
| **画像层** | `user_profile` 表 | LLM 整合出的人物速写 + 结构化字段（step3 T4） |

**碎片层与画像层的分工是刻意设计的**：

- 碎片层 **ADD-only** —— "住北京"与"搬上海"共存，靠时间戳消解，保留时序可追溯（也是用户删错记忆后能靠转写找回的基础）；
- 画像层 **每次整体重写** —— 冲突由 LLM 在重写时消解成"现居上海，此前在北京"。重写只发生在画像层，事实层不动。

检索打分 = `相似度 × 时间衰减 × 情感加权`，情感浓度高的记忆衰减更慢（情感 0.98/天 vs 普通 0.95/天）——没有遗忘机制的记忆系统会像"全知监控"，破坏人感。

**双轨写入**：

1. **会话后批量轨**（2026-08-29 落地）：消息数每跨过 8 的整数倍 + 会话结束时兜底，均用 `after()` 排到响应之后；
2. **会话中实时轨**（2026-08-30 落地，step3 T2）：向 realtime 会话注册 `remember_fact` 工具，模型当场调用 → 客户端写库。协议已核实，见「Function Calling」。

两条轨共用 `upsertMemory()`，去重规则一致（相似度 > 0.9 视为同一件事）—— 否则同一件事会被记两遍。

上下文管理流程：对话页是 Server Component 且 `dynamic = "force-dynamic"`，**每次进入都重新**取画像 + 检索语义记忆 + 取最近 20 条历史，组装成一段 `memoryContext` 传给客户端。注入顺序 **人格 → 工具使用说明 → 画像 → 碎片记忆 → 最近历史**（人格定调，画像最凝练故优先级最高）。这一步是长对话记忆的唯一来源——不能依赖模型会话内的历史保留（见"模型已知约束"）。

画像触发：每结束 3 个会话才重写一次（`PROFILE_REFRESH_EVERY`），不是每会话都做 —— 画像是慢变量，每会话重写成本高且无必要（sleep-time compute 思想：异步、不在语音延迟关键路径上）。计数先落库再整合，整合适败计数不丢、下次再试。

⚠️ serverless 环境下 `after()` 有执行时长上限，长会话抽取可能被截断——上线前需评估是否改为独立后台任务。

后台 agent 任务：走 AI SDK 的 `generateText` / `generateObject` + zod schema，跑在 Server Actions 或 Route Handler 中。**已落地**：记忆抽取（含相似度 > 0.9 判重）、画像整合。**尚未做**：AI 生成会话标题（当前用首条用户消息前 40 字回填）、会话内容总结、低频记忆自动归档。

**DashScope 兼容层的两个实测坑（2026-08-30，写新的 `generateObject` 调用时必须处理）**：

1. `response_format: json_object` 模式下，**提示词里必须出现 "json" 这个词**，否则直接报 400 `InternalError.Algo.InvalidParameter: 'messages' must contain the word 'json' in some form`。
2. **模型会擅自改输出字段名**（实测把画像的 `summary` 输出成 `bio`）。zod 的 `z.object` 对改名是**直接判失败**，会让 `generateObject` 抛 "did not match schema"。对策两道：提示词里给输出结构示例并声明"字段名一字不改"；schema 接住同义字段后 transform。抽取类 schema 的每个字段还应带 `.catch()` —— 整批解析时一条字段不合法会报废整轮。

## 持久化架构【已确认，2026-08-29 修订】

选定路线：**本地 PostgreSQL 开发 → 上线切换 Neon**。依据（2026-08-29 调研核实）：本地 Postgres、Neon、其他托管 Postgres 的协议/SQL/pgvector 语义一致，切换即改 `DATABASE_URL` 与连接配置，不是代码重写；且当前无账号体系，Supabase 的核心价值（Auth + RLS）无从发挥——数据库访问一律走 Next.js 服务端可信通道，RLS 整体不需要，`user_id` 单用户阶段硬编码 `local-user`。Supabase 保留为将来引入账号体系时 Auth 的候选项，与存储层解耦。

- **本地**：用本机已安装的 PostgreSQL 实例即可，**不必起 Docker**。
  ⚠️ **事实更正（2026-08-29 实测）**：本节原写"官方 postgres 镜像与 Homebrew postgres 均不含 vector 扩展，故须用 `pgvector/pgvector` Docker 镜像"。实测本机 Homebrew **PostgreSQL 17.5** 的 `pg_available_extensions` 中已有 **vector 0.8.0**，直接 `CREATE EXTENSION IF NOT EXISTS vector;` 即可。Docker 镜像在干净环境或其它机器上仍是可行方案，但不是必需项。
- **查询层**：Drizzle ORM（`drizzle-orm` + `pg`）。**迁移的真相源是手写 SQL 文件**（`db/migrations/*.sql`，幂等可重复执行）；`src/lib/db/schema.ts` 只是查询侧镜像、不参与 DDL，因此不安装 drizzle-kit。改列结构时先改 SQL 迁移，再同步 TS schema。
- **连接池**：单例挂在 `globalThis` 上（`src/lib/db/client.ts`），避免开发期 HMR 反复建池打满 `max_connections`。
- **上线（Neon）**：运行时查询用 pooled 连接串（`-pooler` 后缀，内置 PgBouncer，规避 serverless 函数实例连接耗尽）；迁移/DDL 走非 pooled 直连串（事务模式池化会破坏 session 级状态）；闲置后 scale-to-zero 首查约一秒冷启动属正常现象，非故障。
- **数据迁移**：本地 → Neon 用 `pg_dump` / restore；开发期数据量小，成本可忽略。
- **环境变量**：`DATABASE_URL`（服务端专用，永不加 `NEXT_PUBLIC_` 前缀）。缺失时应用**降级为无记忆模式**而非报错（`isDatabaseConfigured()` 守卫），页面仍可进行语音对话。

## 会话参数基线【已确认】

通过 DataChannel 发送 `session.update` 配置：

- `modalities`: `["text", "audio"]`
- `turn_detection`: `server_vad` + `idle_timeout_ms: 8000`（2026-08-27 修订：产品定位以闲聊为主，用户静默片刻后模型主动抛话头引导对话更贴合场景；`idle_timeout_ms` 仅 qwen3.5 omni 系列 + server_vad 生效，取值范围 [5000, 30000]。原定的 `semantic_vad` 与其互斥，保留为语义断句需求时的回退项）
- 打断处理（barge-in）：监听 `input_audio_buffer.speech_started` 事件——客户端对本地播放做音量淡出后重挂流（清空残余缓冲）并更新 UI 状态；同时对 in-flight 响应显式发送 `response.cancel`（文档唯一保证的取消手段），确保服务端停止生成旧答案
- 开启输入音频转写（用户语音→文字字幕），输出侧消费 `response.audio_transcript.delta/done` 作为助手字幕
- `session.update` **发两次**（2026-08-30 起）：第一条承载 modalities / voice / instructions / turn_detection 等核心配置，第二条只带 `tools`（Function Calling）。拆开发是为了隔离风险 —— 工具注册若被服务端拒绝，核心配置已生效、对话照常。细节见「Function Calling」。
- `voice` 与 `instructions` 都**只在建连时（第一次 `session.update`）生效**，会话中无法修改。**2026-08-31 UI 大一统（step6）起产品语义升级**：人格与音色在**孵化时一次性定格**（`/hatch`，localStorage `chat-elf:hatched`），此后不提供任何切换入口 —— 对话页设置抽屉只展示锁定说明与 记忆/历史/人格库 入口。数据层的 `switchConversationAction`（换参数=开新会话）保留，供孵化确认这一唯一调用点使用。
- `voice` 取值见「接入通道双轨制」的音色清单。`instructions` 由**人格模板 + 语音播报约束 + 不可覆盖的安全段**拼接（`src/lib/persona/presets.ts`）；安全段含 AI 身份披露与"不扮演心理/医疗专业人士"，人格自定义无法覆盖它 —— 合规要求必须从第一期就埋进架构，不能后补。
- 韵律启发式（`src/lib/realtime/mood.ts`）的基频/能量阈值是按 dashscope 通道的 **Tina** 音色标定的。当前默认通道是 tokenplan（音色 `longanqian`），标定并不适用 → 非 Tina 音色一律**跳过韵律层**，表情退化为 ASR 原生 emotion + 流式文本词典两层（由 `PROSODY_CALIBRATED_VOICE` 门控，见 `use-realtime-session.ts`）。

## Function Calling【已确认，2026-08-30 落地】

用于 step3 的"会话中实时记忆标记"。协议依据官方[客户端事件](https://help.aliyun.com/zh/model-studio/fun-audiochat-client-events)与[服务端事件](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-server-events)文档核实：

| 环节 | 事件 / 结构 |
| --- | --- |
| 注册 | `session.update` → `session.tools: [{ type:"function", function:{ name, description, parameters:{type:"object", properties, required} } }]` |
| 服务端下发 | `response.function_call_arguments.done`，携带 `call_id` / `name` / `arguments`（完整参数 JSON 字符串） |
| 回传结果 | `conversation.item.create` → `item: { type:"function_call_output", call_id, output:"<JSON 字符串>" }` |
| 触发二轮推理 | `response.create` |

约束：`tools` 与 `enable_search` 互斥（本项目不开联网搜索）；server_vad 下手动 `response.create` 需当前无响应在生成。

三个关键实现决策（`use-realtime-session.ts`）：

1. **工具放在第二条 `session.update` 单独注册**。第一条承载 voice / instructions / turn_detection 等核心配置，第二条只带 `tools`。若服务端以"不支持 tools"拒绝，核心配置已生效，对话照常进行 —— 合在一条里发则一次失败全盘皆输。
2. **先回执、再落库**。模型在等 `function_call_output`，不回就不继续说话，用户会听到一段没有尽头的沉默。回执内容固定 `{"ok":true}`，不携带落库结果（模型无法重试，知道了也没用）。
3. **单会话上限 10 次**（`MAX_TOOL_CALLS_PER_SESSION`），超出忽略。

工具定义见 `REMEMBER_FACT_TOOL`（`session-defaults.ts`）：`description` 承担"什么时候该调用"的全部规则（模型看不到我们的代码注释）；"调用后怎么表现"（不要对麦克风说"我记下了"）写进 instructions 的 `REMEMBER_FACT_USAGE_HINT`。

## 环境变量【已确认】

```bash
# .env.local（服务端专用，永不加 NEXT_PUBLIC_ 前缀给模型密钥）
REALTIME_PROVIDER=tokenplan         # 实时语音通道：tokenplan(默认) | dashscope
TOKENPLAN_API_KEY=sk-xxx            # Token Plan 通道密钥
DASHSCOPE_API_KEY=sk-xxx            # 百炼 API Key：dashscope 通道信令 + AI SDK 文本/向量调用共用
DASHSCOPE_WORKSPACE_ID=xxx          # 百炼工作空间 ID，拼入信令域名
DASHSCOPE_REGION=cn-beijing         # 区域，默认 cn-beijing
DATABASE_URL=postgres://…           # 本地 PG / 上线 Neon（服务端专用）。缺失时降级为无记忆模式

# —— 可选覆盖（均有代码内默认值）——
# DASHSCOPE_COMPATIBLE_BASE_URL=           # AI SDK 兼容端点，默认 A 写法见「Agentic 层架构」
# DASHSCOPE_TEXT_MODEL=qwen-plus           # 记忆抽取 / 摘要用文本模型
# DASHSCOPE_EMBEDDING_MODEL=text-embedding-v3  # 文本向量模型；换模型若改 dimensions 需同步改 memories.embedding 列宽

# Supabase：持久化已改为 DATABASE_URL 直连 PostgreSQL，Supabase 降级为将来引入账号体系时
# Auth 的候选项，与存储层解耦。NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 已废弃移除。
```

## 目标目录结构【2026-08-29 已实施 · 2026-08-31 UI 大一统更新】

> 2026-08-31 UI 大一统（step6）后：拟态球界面升为**唯一 UI**（根路由），旧白底版
> 页面与组件（chat-panel / settings-sheet / elf-avatar / 首页历史列表 / 旧 memory 页）全部删除。
> `/mimic/*` 旧预览路由 308 重定向到下述新落点。主路径：`/`（登录）→ `/hatch`（一次性孵化）→ `/chat`。

```text
src/
  app/
    page.tsx                        # 登录页（纯 UI；已孵化→/chat，未孵化→/hatch）
    hatch/page.tsx                  # 孵化页（egg→burst→一次性人格/音色定格，服务端壳注入自建人格）
    chat/page.tsx                   # 对话入口（重定向到最近会话或新建表单）
    chat/[conversationId]/page.tsx  # 对话页（Server Component，组装 memoryContext 注入 MimicChatPanel）
    history/page.tsx                # 历史会话（comet 球 + 列表 + 两步确认删除）
    persona/page.tsx                # 人格库（拟态球化；只管理定义，陪伴人格锁定）
    persona/new/page.tsx            # 新建人格（静态段优先于 [personaId]）
    persona/[personaId]/page.tsx    # 编辑人格（预设/陪伴人格只读 + 另存副本）
    memory/page.tsx                 # 「TA 记得你」记忆可视化页（notify 球 + 画像卡）
    language/page.tsx               # 拟态球交互语言说明页（登录页入口）
    mimic.css                       # 拟态球设计 token 与动画（根布局全局引入，原 /mimic 专用）
    api/
      realtime/session/route.ts     # WebRTC SDP 信令转发（核心，Node runtime）
  components/
    chat/
      message-feedback.tsx          # 👍/👎 埋点（对话面板复用）
    mimic/
      ball/                         # 拟态球：ball-context（常驻层）/ mimic-ball（rAF 驱动器）/ engine（bloub 移植）
      hatch-flow.tsx                # 孵化两阶段流程（egg → 一次性定格）
      mimic-chat-panel.tsx          # 唯一对话面板（球态映射 + 字幕 + 锁定抽屉）
      mimic-history-list.tsx        # 历史列表（orbit 转场 + 删除）
      mimic-memory-list.tsx         # 记忆列表（wink/sleep 交互 + 物理删除）
      mimic-new-conversation-form.tsx
    persona/                        # 人格编辑器、人格列表、页面 header（拟态球化）
  lib/
    ai/provider.ts                  # AI SDK provider（DashScope OpenAI 兼容模式）
    db/
      client.ts                     # pg 连接池 + drizzle 实例（globalThis 单例）
      schema.ts                     # 查询侧 schema（镜像 db/migrations，不参与 DDL）
    dashscope/config.ts             # 模型名、端点拼装、区域配置
    tokenplan/config.ts             # Token Plan 通道配置
    memory/
      actions.ts                    # Server Actions：会话 / 转写 / 抽取 / 画像 / 记忆删除 / 反馈
      conversations.ts              # 会话与消息 CRUD（入参过 UUID 校验）
      context-builder.ts            # 画像 + 语义记忆检索（含遗忘衰减）+ 最近历史组装
      tasks.ts                      # 记忆抽取（generateObject + zod）+ 相似度判重 + upsert
      profile.ts                    # 画像整合（LLM 整体重写）+ 会话计数触发
      store.ts                      # 记忆的列表 / 物理删除（管理页用）
      feedback.ts                   # 👍/👎 埋点读写（幂等：同分撤销、异分改判）
      embedding.ts                  # text-embedding-v3 向量化（失败返回 null，不阻塞链路）
    persona/
      presets.ts                    # 人格预设 + 播报约束 + 不可覆盖安全段
      voices.ts                     # 系统音色清单 + 韵律标定音色常量
      traits.ts                     # 人格矩阵维度定义 + zod schema + 解析
      render.ts                     # 人格 → instructions 渲染器（编辑器/孵化预览同源）
      repository.ts                 # personas 表读写（服务端）
      types.ts                      # 类型与纯常量（**不得 import 服务端模块**，见下）
      resolve.ts                    # localStorage 里的 personaId → 可渲染人格（纯函数）
      settings.ts                   # localStorage 持久化（前缀 chat-elf:）
      use-settings.ts               # useSyncExternalStore 订阅
      hatch-state.ts                # 一次性孵化标记（chat-elf:hatched；账号体系后归 user 层）
    realtime/
      use-realtime-session.ts       # 封装 RTCPeerConnection + DataChannel 状态机
      events.ts                     # Realtime 事件的 discriminated union 类型
      parse-events.ts               # 服务端事件零断言解析
      audio-playback.ts             # 远端音频播放与打断清队
      provider.ts                   # 双通道解析（服务端专用）
      session-defaults.ts           # 两通道差异化的 session.update 参数
      mood.ts                       # 三层语气合成
db/migrations/                      # 建表 SQL（手写、幂等，迁移的真相源）
```

数据模型（迁移文件全部幂等可重复执行）：

- `0001_init.sql`（2026-08-29）
  - `conversations(id uuid pk, user_id text, title text, persona text, voice text, created_at, updated_at)`
  - `messages(id, conversation_id → conversations.id ON DELETE CASCADE, role ∈ {user,assistant,system}, content, created_at)`
  - `memories(id, user_id, content, category ∈ {fact,preference,event,relationship,emotion}, importance real, emotion_score real, embedding vector(1024), source_conversation_id → conversations.id ON DELETE SET NULL, last_confirmed_at, last_accessed_at, archived bool, created_at)`
    - `embedding` 上有 HNSW 余弦索引（`vector_cosine_ops`）用于语义检索；`archived = true` 的记忆不进检索结果但不物理删除。
- `0002_personas.sql`（2026-08-30，step2）
  - `personas(id uuid pk, user_id, name, emoji, tagline, archetype, traits jsonb, voice, backstory, boundaries, is_preset bool, created_at, updated_at)`
    - `archetype` 是模板来源 id（如 `xiaoyou`），用户自建为 `NULL`；`(user_id, archetype)` 上有 partial unique index，使种子可幂等重复插入。
    - `traits` 存 jsonb 而非 6 个固定列：人格维度会随产品演进增减，拆列则每加一维都要改表。解析交给 `parseTraits()`，非法值回落中性。
    - ⚠️ **预设的 traits / backstory 在 SQL 种子与 `src/lib/persona/presets.ts` 里各存一份** —— 后者是"未配置 DATABASE_URL 时的降级数据源"，两处不一致会导致有库/无库两种环境下人格表现不同。改任一侧必须同步另一侧。
  - `conversations.persona_id uuid → personas.id ON DELETE SET NULL`。**原有的 `persona` / `voice` 文本列保留**，它们是会话发生时的展示快照（人格被删后历史列表仍能显示"当时聊的是谁"）。
- `0003_feedback.sql`（2026-08-30，step2）
  - `feedback(id, message_id → messages.id ON DELETE CASCADE, score smallint ∈ {-1,1}, created_at)`，`message_id` 唯一：同分即撤销、异分即改判。只埋点不分析。
- `0004_user_profile.sql`（2026-08-30，step3）
  - `user_profile(user_id pk, summary text, traits jsonb, pending_conversations int, updated_at, refreshed_at)` —— 画像层，见「Agentic 层架构」的双层分工。
- `0005_memory_source.sql`（2026-08-30，step3）
  - `memories.source text ∈ {batch, realtime}`（带 CHECK 约束），区分两条写入轨。

- 需启用 `vector` 扩展（本机 Homebrew PG 17.5 自带 0.8.0，见「持久化架构」的事实更正）。

realtime 会话是易失的，文本转写在每轮响应定稿后异步入库，这是历史留存与跨设备恢复的唯一可靠途径。

## 编码约定【已确认】

- 页面默认 Server Component；凡涉及麦克风、AudioContext、RTCPeerConnection 的代码必须处于 `'use client'` 组件内。
- Route Handler 默认 Node.js runtime；本项目的信令转发不需要 Edge。
- AI SDK 调用只允许出现在服务端代码路径（Route Handlers / Server Actions）；客户端与模型的唯一通道是 realtime hook。
- 所有对外部世界的类型（Realtime 事件、数据库表结构、AI SDK 结构化输出）要有显式 TS 类型，事件用 discriminated union，schema 用 zod。
- 密钥与密钥派生值绝不出现在前端可访问代码路径；新增环境变量必须同步 `.env.example`。
- **禁止在 effect 体内同步调用 `setState`**（`react-hooks/set-state-in-effect`，React Compiler 规则）。需要"外部数据源 → 组件"时用 `useSyncExternalStore`；需要"props 变化时重置局部状态"时用渲染期校正（`if (prop !== prev) setState(prop)`），不要塞进 `useEffect`。在 effect 里改 ref、发请求都是允许的。
- **客户端传入的 id 是不可信输入**：Server Action 收到会话 id 一律先过 UUID 校验再拼查询（`isValidConversationId`）。
- **客户端组件只能从"纯模块"导入值**：`import type` 会被编译期擦除、跨边界安全；**值导入则会把整条依赖链拖进客户端 bundle**。踩过的实况（2026-08-30）：人格编辑器从 `persona/repository.ts` 导入两个长度常量，而 repository 依赖 `db/client` → `pg`，构建直接报 `Module not found: Can't resolve 'util/types'`。修法是把类型与纯常量拆到 `persona/types.ts`，该文件的**唯一约束是不得 import 任何服务端模块**；需要共享值常量时先问它属于哪一侧。
- **增强能力失败必须降级而非抛错**：向量化、记忆检索、转写落库失败时记录日志并返回空结果/ false，绝不能把异常冒泡到语音链路或页面渲染。
- 提交前运行 `pnpm lint` 与 `pnpm build`。

## 模型已知约束【已确认，编码时须处理】

- 单条 realtime 连接有最大时长上限（百量级分钟），到期必须主动重连。
- 上下文超限时模型自动丢弃最早的历史（flash 档约为数十轮音频 / 数百秒语音量级），因此长对话依赖我们落库的文本记录与注入的 instructions，而非会话内存。qwen-audio-3.0 另提供 `max_history_turns`（1-50，默认 20）显式控制模型回看的历史轮数 —— 它与"自动丢弃最早历史"是同一上限的两种表达方式，调大可缓解遗忘但会增加延迟与 token 消耗。
- 断线后不存在"续接同一音频会话"，重连即新建 session；历史以转写文本或摘要注入。
- 具体数值与协议细节以官方文档为准：<https://help.aliyun.com/zh/model-studio/realtime> 与 <https://help.aliyun.com/zh/model-studio/realtime-api-overview>。
