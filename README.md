# omas

> Agent 时代，上下文太多。**omas 帮你把每个任务拆成独立会话**——终端居中、用完即关标签页，Agent 在后台继续跑；历史自动扫描，随时轻松恢复。

面向 AI 辅助开发的自托管 Web 终端。不是 Agent，不是 IDE 替代品，而是**减轻记忆负担的 Shell 控制台**：主界面是 terminal，侧栏只保留改小文件、review AI 改动刚好够用的能力。

[![Release](https://img.shields.io/github/v/release/lilymoonight/omas)](https://github.com/lilymoonight/omas/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## 核心想法：记忆要轻便

一个人同时开着 Claude、Cursor、三个 repo、五路 Agent 时，**最难的不是跑命令，而是记住「哪个窗口在干嘛」**。

omas 的做法：

| 痛点 | omas 怎么解 |
|------|-------------|
| 编辑器里 Chat、终端、Diff、文件树全堆在一起 | **主页面就是 Terminal**，视觉焦点单一 |
| 每个任务混在同一窗口 | **一会话一任务**，列表里一眼分清 |
| 关标签 = 丢上下文？ | **PTY 在 omas 后台继续跑**，关浏览器标签只是断开视图，刷新可重连 |
| 临时查改文件也要开 IDE | 侧栏 **点开即改** 小文件（CodeMirror），不必切换应用 |
| Agent 改了一屏 diff 懒得逐文件找 | **Git 面板集中 review**，diff / 轻量编辑 / 终端 `$EDITOR` 三选一 |
| 昨天 Agent 跑哪了、怎么续上 | **自动扫描** Claude / Cursor / Qoder / OpenCode **本地历史**，一键 `--resume` |

```text
  你的大脑                         omas 帮你记住的
  ─────────                       ─────────────────
  「这个项目 Agent 在跑测试」  →    会话列表 + scrollback
  「上次 Claude 会话 id 是啥」 →    历史页按项目分组、自动解析 cwd
  「改了哪些文件」           →    Git 侧栏 diff
  「改个 yaml 就行」         →    文件树点开保存，不用开 IDE
```

## 和编辑器 / Agent 客户端比

omas **不抢** Cursor、VS Code、Claude Desktop 的饭碗——复杂重构、大项目导航、Chat 推理仍在 IDE 里做。omas 管的是 **「Agent 在跑、Shell 在干、改动要过一眼」** 这段轻量上下文。

| | Cursor / VS Code | Claude Desktop 等 | ttyd / gotty | **omas** |
|---|------------------|-------------------|--------------|----------|
| 主界面 | 编辑器 + 侧栏 + Chat | Chat | 单终端 | **Terminal 居中** |
| 认知负载 | 高（功能全） | 中（对话为主） | 低（无 AI 上下文） | **低且带 AI 上下文** |
| 多 Agent / 多任务 | 多窗口、多 tab，易混 | 多对话线程 | 需自建 | **会话列表自动分离** |
| 关前端标签 | 视实现而定 | 对话在云端/本地 | 进程可能被杀 | **后台 PTY 继续**（omas 服务常驻） |
| AI 历史恢复 | 内置 Agent 面板 | 内置 | 无 | **扫描 CLI jsonl，一键 resume** |
| Review AI 改动 | 完整 SCM / Diff | 有限 | 无 | **Git 侧栏 diff + 轻编辑** |
| 改小文件 | 开完整 IDE | 通常不支持 | 无 | **侧栏 CodeMirror 够用** |
| 远程 / iPad | 端口转发 | 视产品 | 可以 | **浏览器 + 单二进制自托管** |

一句话：**IDE 负责想清楚、写大块代码；omas 负责跑着、看着、过改动、随时续上 Agent——且不用把所有上下文都塞进一个编辑器窗口。**

## 典型用法：用完即弃的标签页

```text
┌──────────┬──────────────────────────────┬──────────┐
│ 文件树   │  ■ 会话 A  claude --resume    │ Git diff │
│ 改 .env  │  ■ 会话 B  npm test           │ review   │
│          │  ■ 会话 C  tail -f log        │ AI 改动  │
└──────────┴──────────────────────────────┴──────────┘
     ↑ 轻量编辑              ↑ 主舞台              ↑ 过一眼再 merge
```

1. **历史页恢复** — 自动扫描本机 AI CLI 会话，按项目分组；点恢复 → 新标签页 / 弹窗，自动 `cd` + `--resume`。
2. **一会话一任务** — Agent 长跑占一个会话；你另开空会话查日志，**关掉标签页不杀 Agent**（omas 进程里 PTY 仍在）。
3. **Review 再决定** — Git 面板看 Agent 改了什么；小改动侧栏保存，大的 `$EDITOR` 丢回终端或回 IDE。
4. **用完即走** — 任务结束关掉浏览器标签；上下文留在 omas 会话列表和历史页，**不必占着 IDE 工作区**。

→ 详细说明：[docs/AI-WORKFLOW.md](./docs/AI-WORKFLOW.md)

## 和 ttyd 有什么不同？

ttyd / gotty 是**通用 Web 终端**；omas 在终端之上加了 **Agent 时代的会话管理**：

- 多会话列表、断线重连、scrollback
- Claude / Cursor / Qoder / OpenCode **历史扫描与恢复**
- 文件树 + Git 侧栏（够用即可，不膨胀成 IDE）
- 单文件 `omas` 二进制，四架构 Release

## 快速开始

**下载二进制**（推荐）：[Releases](https://github.com/lilymoonight/omas/releases) 取 `omas-*`，或：

```bash
git clone https://github.com/lilymoonight/omas.git && cd omas
npm install && npm run build    # → release/omas

chmod +x release/omas
./release/omas serve --port 7681
# http://127.0.0.1:7681（默认无密码；生产环境请 omas init）
```

```bash
omas init                       # 持久化密码
omas install --prefix ~/.local/bin
omas service install            # 后台常驻 → Agent 关浏览器也能继续跑
```

## 文档

| 文档 | 内容 |
|------|------|
| [docs/AI-WORKFLOW.md](./docs/AI-WORKFLOW.md) | 记忆轻便、会话分离、与 IDE 分工、历史恢复 |
| [docs/MANUAL.md](./docs/MANUAL.md) | 命令、配置、API、部署、排错 |
| [DEPLOY.md](./DEPLOY.md) | 反向代理、WebSocket、HTTPS |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更 · [0.2.x 开发史](./CHANGELOG.md#开发史v100-之前--原-02x) · [踩坑与经验](./CHANGELOG.md#踩坑与经验) |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 参与开发 |
| [SECURITY.md](./SECURITY.md) | 安全模型与报告漏洞 |

## 开发

```bash
OMAS_PASSWORD=devpass npm run dev:server   # :7681
npm run dev:web                            # :5173
npm test && npm run typecheck
```

## 命名说明

| 名称 | 含义 |
|------|------|
| **omas** | 产品名、CLI 命令与 GitHub 仓库 [`lilymoonight/omas`](https://github.com/lilymoonight/omas) |
| **oh-my-agent-shell** | npm 包名（历史遗留） |

## License

[MIT](./LICENSE) © lily
