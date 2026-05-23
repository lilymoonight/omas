# Changelog

本文件记录 omas 的重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

## [1.0.0] - 2026-05-23

首个公开发布。

### 产品

- **omas**：面向 AI 辅助开发的自托管 Web 终端；Terminal 居中，减轻多 Agent / 多项目时的上下文记忆负担。
- **多会话 PTY**：一会话一任务，浏览器标签可关，后台服务下 Shell 继续运行。
- **AI 历史恢复**：扫描本机 Claude Code、Cursor Agent、Qoder、OpenCode 会话，一键 `--resume`。
- **侧栏够用即可**：文件树轻量编辑（CodeMirror）、Git 面板 review AI 改动。

### 交付

- 单文件二进制 `release/omas`，CLI 命令 `omas`；Linux / macOS 四架构 Release。
- `omas init` / `omas service install`（systemd / launchd）；推送 `v*` tag 自动发版，Release 说明来自本文件。

### 技术要点

- PTY 字节级 scrollback，UTF-8 安全截断；macOS Bun PTY cwd 与后台 UTF-8 locale。
- 终端快照 attach 后自动滚到当前屏；nginx 子路径与 VSCode 端口转发支持。

[1.0.0]: https://github.com/lilymoonight/omas/releases/tag/v1.0.0
