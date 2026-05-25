# Changelog

All notable changes to this project will be documented in this file.

## [1.0.10] - 2026-05-25

### Fixed
- **多附件消息丢失**（#26）：`handleSend()` 之前只发第一个附件，现在 `resolveActionMediaUrls()` 统一从 `attachments[]` / `mediaUrls[]` / 顶层标量（`mediaUrl` / `filePath` / `fileUrl` / `url`）收集去重，循环 `uploadAndSendMedia` 每个独立 try/catch；partial failure 不阻塞其余，返回值新增 `mediaCount` 与可选 `failedMedia`

### Internal
- CI：支持 UI 驱动发版（Releases UI Publish → 自动到 ClawHub）+ auto-bump package.json + 三态 release 处理（none / draft / published）+ 强制前向版本（拒绝降级）+ 严格 stable SemVer（拒绝 prerelease）（#27）

## [1.0.9] - 2026-05-23

### Fixed
- **群聊双 bot 并发 @mention 时回复静默丢失**（octo-adapters#56）：引入 `enqueueInbound` 按 `accountId:group:channel_id` 串行化 inbound message，避免 OpenClaw runtime mid-run injection 导致 deliver callback 接不上
- **accountId 大小写不匹配导致 outbound 丢失**（octo-adapters#55）：`resolveOctoAccount` 新增 case-insensitive fallback，兼容 BotFather mixed-case ID 与 OpenClaw lowercase 标准化的差异
- **persona-clone 群路径 GroupSystemPrompt 未注入**（octo-adapters#65）：在 `triggeredByMentionHumans` 路径下合成 persona hint

### Added
- **mention 三态透传**（octo-adapters#45）：适配 octo-server mention `humans`/`ais` 三态字段，bot 仅响应 `ais=1` 或显式 @，`humans=1`（@所有人）仅触发 persona-clone bot
- **persona-clone @所有人 响应**（octo-adapters#61）：配置 `onBehalfOf` 的 bot 作为授权人代理，响应 @所有人 / @grantor，outbound 携带 `on_behalf_of` 字段
- **persona_prompt 注入 LLM system prompt**（octo-adapters#69）：`before_prompt_build` hook 通过 `sessionAccountMap` composite key 解析 persona 身份，注入 `prependSystemContext`；含 `initPersonaPromptCache` 60s 轮询 + generation guard 防过期

### Changed
- `release-drafter.yml` name-template 加 `v` 前缀，与 tag-template 一致

## [1.0.8] - 2026-05-20

### Changed
- 启用 GitHub Actions 自动发版流程（PR #9 / #10）：推 `v*.*.*` tag 到 `main` 后自动跑 `verify → npm pack → clawhub package publish + GitHub Release`，不再依赖本地 `clawhub` CLI 手工 publish。

### Internal
- 相对 1.0.7 没有运行时 / plugin 代码改动；本版本主要用于验证自动发版链路。

## [1.0.7] - 2026-05-18

### Fixed
- README + `skills/octo-bot-api/SKILL.md`：交互式入口改为裸命令（`openclaw channels add` 不带 `--channel octo`）。之前 `openclaw channels add --channel octo` 会进入非交互模式期待所有 flag，无法 prompt 用户输入 token/url

## [1.0.6] - 2026-05-17

### Fixed
- `registerFull` 内的手动注册路径（`setOctoRuntime` / `api.registerChannel` / `api.on('before_prompt_build')`）增加 `registrationMode` 守卫，仅在 `full` 模式下执行，避免 tool-discovery 路径产生副作用（codex review round 3 MAJOR 2）
- 修正过时注释，准确描述 contract `runtime: {}` / `plugin: {}` 字段的用途（codex review MINOR 1）

## [1.0.5] - 2026-05-17

### Fixed
- 恢复 `setOctoRuntime` + `api.registerChannel` 的手动注册（之前 1.0.4 误删导致 regression），完整解决 SDK loader 与 manual setup 双重写入冲突

## [1.0.4] - 2026-05-16

### Removed
- 移除孤立的 `cli/` 目录与未使用的 `commander` 依赖，缩减 dist 体积

### Changed
- 简化 `registerFull` 注册流程，去除重复的 `registerChannel` / `setRuntime` 调用

## [1.0.3] - 2026-05-16

### Fixed
- 修复 ESM 双实例 runtime init regression：将 `setOctoRuntime` 同时注入 `dist/index.js` 与 `dist/setup-entry.js` 两个 bundled entry，解决首条 inbound 消息触发 `Octo runtime not initialized` 报错

## [1.0.2] - 2026-05-16

### Removed
- runtime 模块移除 `child_process` 依赖，通过 OpenClaw ClawScan install gate
- 删除残留的 plugin self-management slash commands（`/octo_info`, `/octo_add_account`, `/octo_remove_account`）—— OpenClaw 已有 `channels add` / `plugins install` 等标准命令覆盖

## [1.0.1] - 2026-05-16

### Removed
- 删除 npm CLI entry 与 4 条 plugin self-management slash commands（`/octo_install`, `/octo_update`, `/octo_uninstall`, `/octo_doctor`）—— OpenClaw 已有 `plugins install` / `channels add` 等标准命令覆盖

### Changed
- 修正 npm artifact 与 ClawHub 元数据一致性问题；移除过期的 npm-only update check；清理 stale skill 文档（codex review round 2 反馈）
- 重新 publish 到 ClawHub

## [1.0.0] - 2026-05-15

Initial release of the OpenClaw channel plugin for Octo.

### Features

- Full WebSocket-based real-time messaging with Octo
- Multi-account support: run multiple bot accounts per OpenClaw instance
- Group, DM, and Thread (sub-topic) message routing
- GROUP.md and THREAD.md per-channel context injection
- Typing indicator, heartbeat, and read receipt support
- File upload via multipart and STS direct-to-COS
- Mention gating (`requireMention`) and @all ignore (`ignoreMentionAll`)
- Agent tool: `octo_management` for group and thread management
- ClawHub-compliant plugin metadata and setup entry
- CI: type-check + test on Node 22
