# AI 开发工作流

Agent 时代，一个人会同时背负很多上下文：多个 repo、多路 Agent、半截对话、一屏未 review 的 diff。omas 的目标不是再做一个 IDE，而是**帮你把上下文拆开、记住该记住的、让主界面重新聚焦在 Terminal 上**。

---

## 设计原则：记忆轻便

### 编辑器的问题

Cursor、VS Code 等编辑器把 **代码、终端、Chat、SCM、文件树** 放在同一套 UI 里——能力全面，但 Agent 时代常见状态是：

- 三个项目各开一个窗口，每个窗口里还有 Agent Chat + 集成终端 + diff
- 临时改个配置也要在「工程级」界面里找文件
- 关掉某个 tab 不确定 Agent 还在不在跑、会话 id 去哪找

**认知负担来自「所有事看起来都同等重要」。**

### omas 的做法

| 原则 | 具体表现 |
|------|----------|
| **Terminal 为主舞台** | 打开 omas，第一眼是会话列表和 xterm，不是编辑器 |
| **一会话一上下文** | 每个 PTY 独立 scrollback、cwd、标题；列表里区分 Agent / 手工命令 |
| **用完即弃的前端标签** | 浏览器标签页只是「视图」；`omas service install` 后 PTY 在后台进程里继续，关标签 ≠ 杀任务 |
| **历史交给机器记** | 自动扫描 Claude / Cursor / Qoder / OpenCode 本地 jsonl，按项目分组，一键 resume |
| **编辑够用就好** | 侧栏 CodeMirror 改 `.env`、yaml、小脚本；复杂重构回 IDE |
| **改动集中 review** | Git 面板看 Agent 改了哪些文件，diff → 轻编辑 → 或 `$EDITOR` 进终端 |

```text
  IDE 窗口（重）                 omas 窗口（轻）
  ┌─ Chat ─────────────┐        ┌─ Terminal ─────────┐
  ├─ Editor ───────────┤        │  Agent 在跑         │
  ├─ Terminal ─────────┤   vs    ├─ 侧栏：小文件       │
  ├─ SCM / Problems ───┤        └─ 侧栏：Git diff    │
  └─ …                 │        关标签 → 后台仍运行
```

---

## 会话分离：不混在一起

### 多会话列表

- 每个任务开 **独立 PTY**：例如「项目 A · Claude Agent」「项目 B · 只看日志」
- 会话在 omas **服务端** 存活；刷新页面、断网重连后 attach 回来，scrollback 仍在（在配置上限内）
- 支持 **弹窗** 打开终端：主屏看 Git diff，副屏看 Agent 输出

### 关标签页，Agent 继续跑

典型流程：

1. 历史页恢复 Claude 会话 → 新标签页里 Agent 开始长跑（测试、代码生成）
2. 你关掉该浏览器标签去做别的事
3. omas 以 **systemd / launchd 用户服务** 运行时，PTY **不会**随标签关闭而退出
4. 稍后重新打开 omas → 会话列表里还在 → 点进去继续看输出

这与「集成在 IDE 里的终端」不同：IDE 关了，内置终端往往一起没；omas 刻意把 **Shell 生命周期** 和 **浏览器视图** 拆开。

> 若直接 `omas serve` 前台跑、并关掉整个 omas 进程，PTY 仍会结束——需要 `omas service install` 或等价的后台部署。

---

## 自动扫描历史，轻松恢复

omas 从本机用户目录 **只读** 扫描会话元数据（不上传云端）：

| 来源 | `source` 标识 | 恢复命令示例 |
|------|---------------|--------------|
| Claude Code | `claude-code` | `claude --resume <id>` |
| Cursor Agent | `cursor-agent` | `cursor --resume <id>` |
| Qoder | `qoder` | `qoder -r <id>` |
| OpenCode | `opencode` | `opencode --session <id>` |

**历史页**（`#/history`）：

- 按 **项目目录** 分组（默认折叠），按最后活动时间排序
- 筛选来源、搜索标题
- 显示 cwd 是否仍存在、Git 分支、消息数
- 点 **恢复** → 新 PTY + 正确 `cwd` + 自动输入 resume 命令

你 **不需要** 记住 session id、jsonl 路径或编码后的目录名——omas 从磁盘扫出来，并在文件系统上贪婪解析真实路径（含 macOS `/var/folders/_xx/...`）。

### ai-safe 沙箱恢复

若主机安装了 **`ai-safe`**（`PATH` 可用），历史页额外提供 **安全恢复**：

```bash
ai-safe claude -- claude --resume <id>
ai-safe cursor -- cursor --resume <id>
```

omas 只检测并生成命令；沙箱策略由 `ai-safe` 本身定义。

---

## 轻量编辑 + Review AI 改动

omas 的侧栏是 **刻意克制** 的：不做 LSP、不做重构、不做多文件 refactor。

### 文件树 — 改小文件

- 跟随 shell **当前 cwd**（macOS 通过 `lsof` 等跟踪 `cd`）
- 点击文件 → CodeMirror 6 网页编辑保存
- 适合：`.env`、`config.yaml`、十几行的脚本、改个端口/开关

**什么时候回 IDE**：跨文件跳转、符号定义、大段手写代码。

### Git 面板 — review Agent 产出

Agent 改完一堆文件后，常见需求是 **「先看一眼再 merge」**：

1. Git 侧栏列出变更文件
2. **差异** 视图看 unified diff
3. 小修正 → **编辑** 视图直接改
4. 大文件 → **在终端编辑**，注入 `$EDITOR "/abs/path"`

这比在 IDE 里逐 tab 打开改动更 **聚焦**：主屏仍是 Terminal（继续跟 Agent 交互），侧栏专门负责 **审改动**。

---

## 与 Cursor / VS Code / Claude Desktop 的分工

| 场景 | 用 IDE / Desktop | 用 omas |
|------|------------------|---------|
| 架构设计、长代码编写、Chat 推理 | ✅ 主战场 | |
| 启动/监视 CLI Agent（Claude Code、cursor agent） | 可以，但占 IDE 工作区 | ✅ Terminal 居中 |
| 同时跑多个 Agent / 多 repo Shell | 多窗口易混 | ✅ 会话列表分离 |
| 关界面后 Agent 继续跑 | 通常不行 | ✅ 后台服务 + detach |
| 恢复昨天 CLI 会话 | IDE Agent 面板 / 手动找 id | ✅ 历史页扫描 |
| Review Agent 改动的 3～5 个文件 | SCM 面板（功能全） | ✅ Git 侧栏（够快） |
| 改一行配置 | 开 IDE | ✅ 侧栏点开即改 |
| iPad / 另一台电脑看终端 | 视方案 | ✅ 浏览器 + 端口转发 |

**推荐组合**：IDE 写代码 + Chat；omas 挂着 Agent 与 Shell；需要 deep dive 时再回 IDE。**不必把所有上下文塞进一个编辑器窗口。**

omas **不** 读取 IDE 内部状态，只读 AI CLI 落盘 jsonl 与 Git 工作区。

---

## 三栏布局

```text
┌──────────┬─────────────────────────┬──────────┐
│ 文件树   │   xterm · 主舞台         │ Git 面板 │
│ 轻编辑   │   多会话 · 断线重连       │ review   │
└──────────┴─────────────────────────┴──────────┘
```

- **中间最大**：Terminal 是默认注意力所在
- **左右可选**：需要改文件或看 diff 时再展开侧栏，不抢主屏

---

## 推荐部署

```bash
omas install --prefix ~/.local/bin
omas init
omas service install    # 关键：Agent 不随浏览器关闭而停
```

可选 `omas serve --cwd ~/Projects` 设定新会话默认目录。对外暴露见 [DEPLOY.md](../DEPLOY.md) 与 [SECURITY.md](../SECURITY.md)。

---

## 限制

| 限制 | 说明 |
|------|------|
| 不是 IDE | 无 LSP、无多文件 refactor、不适合大段手写代码 |
| 单用户 | 一个密码；非多租户 |
| 恢复 = 自动输入命令 | 等价于在 PTY 里打字 resume，非 API 绑定 |
| 前台 omas 退出 | PTY 会结束；长跑 Agent 请用 service |
| 只读扫描历史 | 不修改 Claude/Cursor 数据目录 |

更多见 [MANUAL.md § 限制与已知问题](./MANUAL.md#限制与已知问题)。

---

## API

```http
GET /api/history
GET /api/history?source=claude-code,cursor-agent
POST /api/sessions          # cols, rows, cwd, initialCommand
POST /api/sessions/:id/input
```

详见 [MANUAL.md § HTTP / WebSocket API](./MANUAL.md#http--websocket-api)。
