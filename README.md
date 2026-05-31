# omas

**English:** [README.en.md](./README.en.md)

> Agent 时代，上下文太多。**omas 把每个任务拆成独立会话**——终端居中、用完即关标签页，Agent 在后台继续跑；本地 AI 历史自动扫描，随时恢复。

面向 AI 辅助开发的自托管 Web 终端。不是 Agent，不是 IDE 替代品，而是**减轻记忆负担的 Shell 控制台**：主界面是 terminal，侧栏只保留改小文件、review AI 改动刚好够用的能力。单文件二进制，浏览器打开即用。

[![Release](https://img.shields.io/github/v/release/lilymoonight/omas)](https://github.com/lilymoonight/omas/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

```text
┌──────────┬──────────────────────────────┬──────────┐
│ files    │  v ~/work/api    * Cursor    │ git diff │
│ edit env │    # session A  claude       │ review   │
│ click=ok │    # session B  npm test     │ AI edits │
│          │  > ~/work/web   (2)          │ $EDITOR  │
└──────────┴──────────────────────────────┴──────────┘
  轻量编辑      ↑ 多会话终端 · 项目分组 · Cmd/F 搜索 · Agent 状态      过一眼再 merge
```

## 功能一览

### 终端核心

- **多会话管理** — 一会话一任务，列表卡片一眼分清；新建 / 重命名 / 销毁。
- **后台常驻 PTY** — 服务端持有 PTY，关闭浏览器标签只断开视图、刷新即重连，**Agent 不中断**。
- **终端内搜索** — `Cmd/Ctrl+F` 搜索 scrollback，高亮匹配并显示「当前 / 总数」，支持大小写 / 正则；仅普通缓冲区拦截，全屏 TUI（vim、Agent TUI）里 `Ctrl+F` 仍交给应用。
- **拖拽上传** — 文件拖入终端即上传到会话当前目录，大文件自动分片并行、可取消、带实时进度。
- **主题** — 浅色 / 深色 / 跟随系统三态切换，首屏无闪烁，xterm 配色随主题实时切换。
- **流畅渲染** — xterm.js + WebGL，自动识别链接，复制走浏览器原生选区（`Cmd/Ctrl+C`）。

### Agent 工作流

- **AI 历史扫描与恢复** — 自动扫描本机 Claude / Cursor / Qoder / OpenCode 会话历史，按项目分组，一键 `cd` + `--resume`。
- **Agent 标识** — 卡片识别当前前台 Agent（即便经 node / python 包装也能认出），其余显示命令名，空闲 shell 不显示徽标。
- **活跃 / 空闲检测** — 基于 Agent 进程子树的 CPU 采样判定「工作中（绿色脉冲）/ 空闲」，避免 TUI 重绘导致的误判抖动。
- **空闲主动通知** — Agent 从「工作中」转「空闲」时，后台标签页弹系统通知（点击打开该会话），标题与 favicon 显示待处理角标，回到标签即清除。
- **会话按项目分组** — 按实时工作目录聚合，oh-my-zsh 风格彩色路径面包屑，分组可折叠、状态持久化；多 repo / 多 Agent 一眼分清。
- **实时工作目录** — 卡片显示会话实时 cwd（跟随 `cd`）。

### 文件与改动 review

- **文件树 + 轻量编辑** — 侧栏点开小文件用 CodeMirror 直接改存，不必切到 IDE。
- **Git 面板** — 集中 review Agent 改了什么：diff / 轻编辑 / 丢回终端 `$EDITOR` 三选一。

### 分享与托管

- **免密公开静态站点** — 把任意目录挂到 `/p/<slug>/` 对外免密访问，方便把构建产物、报告等以网页分享给别人或自己回看。**发布管理页**在线增删站点、改动持久化且**无需重启即时生效**；缺 `index.html` 时按 Python `http.server` 风格**列出目录文件树**；SPA 模式回退 `index.html`；内置路径越界防护（拒绝 `..` / 绝对路径 / NUL）。

### 部署与运维

- **单文件二进制** — 四架构 Release（linux / darwin × x64 / arm64），无 native 依赖（密码哈希用 Bun 内置 argon2id）。
- **密码与常驻** — `omas init`（argon2id 持久化密码）、`omas service install`（launchd / systemd 后台常驻，关浏览器 Agent 也继续跑）。
- **反代友好** — 自适应反向代理前缀、WebSocket、HTTPS（见 [DEPLOY.md](./DEPLOY.md)）。

## 快速开始

**下载二进制**（推荐）：[Releases](https://github.com/lilymoonight/omas/releases) 取 `omas-*`，或自行构建：

```bash
git clone https://github.com/lilymoonight/omas.git && cd omas
npm install && npm run build    # → release/omas

chmod +x release/omas
./release/omas serve --port 7681
# http://127.0.0.1:7681（默认无密码；生产环境请 omas init）
```

```bash
omas init                       # 持久化登录密码
omas install --prefix ~/.local/bin
omas service install            # 后台常驻 → Agent 关浏览器也能继续跑
```

## 核心理念：记忆要轻便

一个人同时开着 Claude、Cursor、三个 repo、五路 Agent 时，**最难的不是跑命令，而是记住「哪个窗口在干嘛」**。omas 把这些上下文从你脑子里搬到界面上：

```text
  你的大脑                          omas 帮你记住的
  ─────────                        ─────────────────
  「这个项目 Agent 在跑测试」   →    会话列表 + 分组 + scrollback
  「上次 Claude 会话 id 是啥」  →    历史页按项目分组、自动解析 cwd
  「哪个 Agent 跑完了」         →    活跃 / 空闲检测 + 空闲通知
  「改了哪些文件」             →    Git 侧栏 diff
  「改个 yaml 就行」           →    文件树点开保存，不用开 IDE
```

→ 工作流详解：[docs/AI-WORKFLOW.md](./docs/AI-WORKFLOW.md)

## 选型对比

omas **不抢** Cursor / VS Code / Claude Desktop 的活——复杂重构、大项目导航、Chat 推理仍在 IDE 里做。omas 管的是 **「Agent 在跑、Shell 在干、改动要过一眼」** 这段轻量上下文。

### vs. 编辑器 / Agent 客户端

| | Cursor / VS Code | Claude Desktop 等 | ttyd / gotty | **omas** |
|---|------------------|-------------------|--------------|----------|
| 主界面 | 编辑器 + 侧栏 + Chat | Chat | 单终端 | **Terminal 居中** |
| 认知负载 | 高（功能全） | 中（对话为主） | 低（无 AI 上下文） | **低且带 AI 上下文** |
| 多 Agent / 多任务 | 多窗口、多 tab，易混 | 多对话线程 | 需自建 | **会话列表 + 项目分组自动分离** |
| 关前端标签 | 视实现而定 | 对话在云端/本地 | 进程可能被杀 | **后台 PTY 继续**（服务常驻） |
| AI 历史恢复 | 内置 Agent 面板 | 内置 | 无 | **扫描 CLI jsonl，一键 resume** |
| Review AI 改动 | 完整 SCM / Diff | 有限 | 无 | **Git 侧栏 diff + 轻编辑** |
| 改小文件 | 开完整 IDE | 通常不支持 | 无 | **侧栏 CodeMirror 够用** |
| 远程 / iPad | 端口转发 | 视产品 | 可以 | **浏览器 + 单二进制自托管** |

一句话：**IDE 负责想清楚、写大块代码；omas 负责跑着、看着、过改动、随时续上 Agent。**

### vs. CLI + tmux

很多人用 **SSH → tmux → Claude/Cursor CLI** 挂 Agent。tmux 保活很强，但 **「鼠标滚历史」与「复制输出」难兼顾**：开 mouse 模式滚的是 copy-buffer、复制又要进 copy-mode（`Ctrl+b [`），还和 TUI 的鼠标事件打架。omas 把 PTY 输出放进 xterm.js，**滚动与复制交给浏览器**——长跑 Agent 查日志、拷报错、贴 Issue 都更省事。

| | CLI + tmux | **omas** |
|---|------------|----------|
| 会话保活 | ✅ `detach` 后继续 | ✅ 后台服务 + 服务端 PTY |
| 鼠标滚历史 | ⚠️ 需 `mouse on`，滚的是 copy-buffer | ✅ 浏览器原生 scrollback |
| 复制文字 | ⚠️ 多需 copy-mode，与鼠标模式冲突 | ✅ 拖选 + `Cmd/Ctrl+C` |
| 多路 Agent 辨认 | 靠窗口名 / `list-sessions` | ✅ 会话列表 + 分组 + 历史页 resume |
| 改文件 / 看 diff | 另开编辑器或 `split` | ✅ 文件树 + Git 面板 |

omas **不是** tmux 替代品：纯 SSH、要 pane 编排的极简场景，tmux 依然合适。omas 适合 **Agent 工作流 + 经常翻输出/复制 + 偶尔远程看一眼**。

## 文档

| 文档 | 内容 |
|------|------|
| [README.en.md](./README.en.md) | 产品概览（English） |
| [docs/AI-WORKFLOW.md](./docs/AI-WORKFLOW.md) | 记忆轻便、会话分离、与 IDE/tmux 分工、历史恢复 |
| [docs/MANUAL.md](./docs/MANUAL.md) | 命令、配置、API、公开站点、部署、排错 |
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
