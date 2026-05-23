# omas

**English:** [README.en.md](./README.en.md)

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

## 和 CLI + tmux 比

很多人用 **SSH → tmux → Claude/Cursor CLI** 挂 Agent。tmux 会话保活很强，但在 **「往上滚看日志」和「复制一段输出」** 上很难兼顾——omas 刻意用浏览器 + xterm 绕开这套摩擦。

| | CLI + tmux | **omas** |
|---|------------|----------|
| 会话保活 | ✅ `detach` 后进程继续 | ✅ 后台服务 + 服务端 PTY |
| 鼠标滚轮翻历史 | ⚠️ 需开 `mouse on`，且滚的是 **tmux 复制缓冲**，不是直觉式「终端往上翻」 | ✅ 浏览器原生 scrollback，滚轮直接看历史输出 |
| 复制一段文字 | ⚠️ 常要进 **copy-mode**（`Ctrl+b [`），用 vi 键选区；与滚轮/鼠标模式互相打架 | ✅ **鼠标拖选 + Cmd/Ctrl+C**，与网页一致 |
| mouse on + TUI Agent | ⚠️ 滚轮可能被 tmux 截获，TUI 里点选、拖拽与复制模式更易冲突 | ✅ xterm 与 TUI 共存；复制走浏览器选区，不抢 Agent 的鼠标协议 |
| 多路 Agent 辨认 | 靠窗口名 / `tmux list-sessions` 记 | ✅ 会话列表 + **AI 历史页** 扫描 resume |
| 改文件 / 看 diff | 另开编辑器或 `tmux split` | ✅ 侧栏文件树 + Git 面板 |
| 远程 | SSH 即可 | 浏览器（可配合 SSH 隧道 / 端口转发） |

**tmux 的核心矛盾**：想 **鼠标滚历史**，往往要开 mouse 模式，但 **复制** 仍依赖 copy-mode，和 TUI 应用的鼠标事件、选区逻辑缠在一起；关 mouse 则滚历史也要进 copy-mode，**无法同时「自然滚动」和「自然复制」**。omas 把 PTY 输出放进 xterm.js，滚动与复制交给浏览器——Agent 长跑时查日志、拷报错、贴进 Issue 都更省事。

omas **不是** tmux 替代品：不需要 pane 编排、远程纯 SSH 的极简场景，tmux 依然合适。omas 适合 **Agent 工作流 + 经常要翻输出/复制 + 偶尔远程看一眼**。

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
| [README.en.md](./README.en.md) | 产品概览（English） |
| [docs/AI-WORKFLOW.md](./docs/AI-WORKFLOW.md) | 记忆轻便、会话分离、与 IDE/tmux 分工、历史恢复 |
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
| **omas** | 产品名、CLI 命令与 GitHub 仓库 [`lilymoonight/omas`](https://github.com/lilymoonight/omas)；**`oh-my-agent-shell` 的缩写**（取首字母 **o**h-**m**y-**a**gent-**s**hell） |
| **oh-my-agent-shell** | 完整项目名；npm 包名与默认配置目录（`~/.config/oh-my-agent-shell`）仍用此名 |

## License

[MIT](./LICENSE) © lily
