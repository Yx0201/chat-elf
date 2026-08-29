<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md — chat-elf 工程约束

架构与技术决策（技术栈、实时链路、Agentic 层、会话参数、目录结构、数据模型、编码约定、模型约束）已迁移至 [ARCHITECTURE.md](./ARCHITECTURE.md)，开发时一并遵守其中【已确认】条目。

## 工具链约束

- **包管理器只允许使用 pnpm**。禁止用 npm / yarn / bun 执行 install 或 scripts；不产生 package-lock.json / yarn.lock。

## 依赖引入约束

新增任何依赖之前，必须先向用户说明并获得确认：

1. **为什么这个功能需要下载新依赖**——现有依赖或少量自研代码能否覆盖；
2. **技术选型的原因**——为什么选这个包而非同类替代品（成熟度、体积、维护状态、与本仓库既有决策的契合度）。

未经说明直接安装依赖视为违规操作。

## 语言与类型约束

- 代码**全部使用 TypeScript**，不允许提交 JavaScript 源文件。
- **禁止 `any` 类型**（含显式 `any`、类型断言绕过检查的变体）；类型确实未知的结构用 `unknown` 配合类型收窄处理；第三方库缺类型时补 `.d.ts` 声明。

## UI 与 H5 适配约束

所有涉及 UI、布局、样式的代码（布局结构、尺寸、间距、字号、交互目标），设计与实现时必须**同时覆盖桌面与手机 H5 两种形态**，不允许"先按 PC 写完、留到后期统一适配"：

- **H5 适配不等于等比缩小**。同一组内容在窄屏下允许（并鼓励）重排信息架构：显示数量、主次层级、排列方式都可按屏幕调整——例如 PC 端一行显示 5 个 item，H5 端不是把 5 个缩小硬塞，而是可以改为"第一行 2 个重要项 + 第二行 3 个次要项"，也可以只保留 2 个，以合适的效果为准。
- 用 Tailwind 响应式断点（`sm:` / `md:` / `lg:`）实现差异，**mobile-first 写法**：默认样式为手机端，断点以上扩展桌面形态；禁止只写桌面样式。
- 尺寸不硬编码导致窄屏溢出；容器用流式布局（flex/grid）配合 `max-w-*` 约束；可点击元素在手机端的实际触区不小于 40px（力争 44px）。
- 涉及 UI 的改动，提交前需在浏览器设备模拟器（iPhone / Android 主流尺寸）下过一遍 H5 效果；目标是 H5 验收（Vercel 部署后真机）时修改点尽量少。


## specCoding 规则

需求以规格（spec）驱动，规格文件集中放在项目根目录 `specCoding/`：

- **一个待实施版本一个文件夹**，文件名即版本计划名（如 `情感陪伴模块/step1-xxx.md`）。文件头标注状态（草案 / 已确认）与最近更新日期。
- **spec 的产生**：由规划会话调研后起草，与用户多轮讨论完善；未达「已确认（含日期）」状态不得交给实施会话开工。
- **spec 必须自洽可交接**：实施会话可能从零上下文开始，spec 需覆盖：背景与目标、范围（做 / 明确不做）、现状盘点（实施起点）、任务分解（每个任务含涉及文件、实现要点、验收标准）、依赖引入清单、待决策项、环境变量变更。
- **实施会话的职责边界**：开工前按顺序读 AGENTS.md → ARCHITECTURE.md → `Memory/` 最新存档 → 对应 spec；只按 spec 实施并在「实施记录」小节追加进度（日期 / 完成任务 / 备注）；遇到 spec 未覆盖的决策点必须停下询问用户，不得自行扩大范围或改写需求。
- **spec 的收尾**：全部任务完成并验收后，将文件移入 `specCoding/done/` 归档。

## 进度保存规则

每当用户说**保存进度** 或者执行 `git push` 时，立即在项目根目录 `Memory/` 文件夹中保存当前工作进度：

- 文件名为**当天日期**：`YYYY-MM-DD.memory.md`（如 `2026-08-29.memory.md`）；当天文件已存在则**更新**它，不新建。
- 内容基于当前窗口的上下文总结，面向"下一个接手的 Agent"书写，必须覆盖四块：
  1. **项目在做什么**：当前任务/里程碑的背景与目标；
  2. **已完成**：本轮关键改动（涉及文件、功能、技术决策）；
  3. **未完成/下一步**：剩余工作、已知问题、待用户验证的事项；
  4. **环境与命令**：跑起来所需的关键信息（代理、包管理器、环境变量名、易踩的坑）。
- 目的：团队成员换用任意 Agent（ZCode / Claude Code / Codex 等）时，读取 `Memory/` 中最新存档即可同步任务上下文。接手会话的 Agent 应先查看 `Memory/` 最新文件再开工。

## 回答与建议原则

对所有询问与问题：

- **第一性原则**：从基本事实和机制出发推理，先搜集足够的资料再综合回答，而非套用惯性结论。
- **不盲从、不趋附**：用户观点与客观事实或最佳实践冲突时，直接指出分歧并陈述依据，不允许为了迎合而附和。
- **不编造答案**：无法确认的事实地明确说明“未确认”并给出验证途径，禁止用看似合理的推测填补知识空白。
- **文档查询一律求新**：涉及技术文档时，必须检索最新的官方文档或社区公认的最佳实践，不允许仅凭既有经验作答——框架 API、模型能力、端点协议等都可能已随版本变化，结论前须核实。
- **建议客观、有据、可溯源**：给出建议或意见时讲清事实依据（版本、行为、限制等具体信息），注明适用前提，并引用来源链接。
