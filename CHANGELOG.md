# Changelog

本文件记录 omas 的重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 文档

- **命名说明**：README 明确 **omas** 为 **oh-my-agent-shell** 的缩写（o-m-a-s）。
- **English README**：新增 [README.en.md](./README.en.md)，中英文 README 互相链接。

## [1.0.1] - 2026-05-23

### 修复

- **TUI 视口乱跳 / 乱换行**：attach 快照不再回放 scrollback；`hello` 到达前禁止向服务端发 resize（避免 mount 时 fit 改 PTY 列数与快照不一致）；快照写入后再 fit 并同步；等待 `document.fonts.ready` 后再校正列宽。

### 优化

- **工程质量**：CI 增加 `typecheck`；修复 `sessions` input、`service` systemd 等 TS 错误。
- **终端布局**：抽取 `term-layout.ts` 共享常量；窄屏（≤768px）侧栏改为 drawer，终端全宽。
- **前端体积**：CodeMirror 语言包按需加载；History 路由懒加载；Vite 拆分 codemirror/xterm chunk。
- **历史扫描**：服务端 30s TTL 内存缓存；手动刷新带 `?refresh=1` bypass。
- **测试**：attach 阶段、term-size、history cache、PTY serializeSnapshot 回归用例。

### 文档

- **对比说明**：README / `docs/AI-WORKFLOW.md` 补充与 **CLI + tmux**（滚动 vs 复制）、IDE 的分工对比。

[1.0.1]: https://github.com/lilymoonight/omas/releases/tag/v1.0.1

## [1.0.0] - 2026-05-23

首个 **Git 公开初版**（仓库历史自本 tag 起为单 commit 快照；功能由下方 [0.2.x 开发史](#开发史v100-之前--原-02x) 迭代而来）。

### 产品

- **omas**：面向 AI 辅助开发的自托管 Web 终端；Terminal 居中，减轻多 Agent / 多项目时的上下文记忆负担。
- **多会话 PTY**、**AI 历史恢复**（Claude / Cursor / Qoder / OpenCode）、**侧栏轻量编辑 + Git review**。

### 交付

- 单文件 `release/omas`；`omas init` / `omas service install`；推送 `v*` tag 自动四架构 Release，说明来自本文件。

→ 完整预发布变更与踩坑：[开发史（0.2.x）](#开发史v100-之前--原-02x) · [踩坑与经验](#踩坑与经验)

[1.0.0]: https://github.com/lilymoonight/omas/releases/tag/v1.0.0

---

## 开发史（v1.0.0 之前 · 原 0.2.x）

> **说明**：v1.0.0 对 Git 历史做了重写（仅保留当前快照为初 commit），**不再能从 git log 逐条追溯**以下版本；本节保留原 CHANGELOG 全文，便于查阅迭代过程与修复背景。

## [0.2.6] - 2026-05-23

### 变更

- **命令与二进制统一为 `omas`**（原 `osma` 为笔误）：CLI、`release/omas`、systemd/launchd（`com.omas`）服务名、Release 产物 `omas-*` 均已对齐。

### 修复

- **终端快照恢复**：全量 attach 后自动滚到当前屏，修复 Cursor 等 TUI 重连时跳到久远 scrollback 的问题。
- **发版说明**：GitHub Release 正文从 `CHANGELOG.md` 对应版本段落提取，不再只用自动 commit 摘要。

### 安全

- 移除误提交的 `.claude/settings.local.json` 并忽略 `.claude/`；测试路径改用通用占位符。

### 文档

- **开源定位**：README / `docs/AI-WORKFLOW.md` 以 Agent 时代「记忆轻便、Terminal 居中、会话分离」为核心，补充与 IDE 对比及贡献/安全文档。

## [0.2.5] - 2026-05-23

### 新增

- **Shell 语法高亮**：CodeMirror 编辑器支持 `.sh`/`.bash`/`.zsh` 及 `.bashrc`、`.zshrc` 等常见 shell 配置文件。
- **终端尺寸估算**：新建会话时根据浏览器视口估算 cols/rows（替代固定 80×24），连接前即向 PTY 同步尺寸，TUI 应用首屏列宽更合理。

### 修复

- **UTF-8 locale**：后台服务（launchd/systemd）PTY 默认启用 UTF-8 locale，修复 `ls` 等命令将中文文件名显示为问号；xterm 补充 CJK 字体回退。
- **滚动缓冲 UTF-8**：PTY 数据以原始字节存储与回放，ring buffer 在截断与 `since()` 切片时对齐 UTF-8 边界，避免中文等多字节字符乱码。
- **macOS Bun PTY cwd**：修复 `Bun.spawn({ terminal })` 在 macOS 上忽略 `cwd` 导致会话不在指定目录启动的问题。
- **历史路径解码**：改进 Claude/Cursor 编码路径解析，支持 macOS `/var/folders/_xx/...` 等带 `_` 前缀的临时目录；历史页 cwd 优先选用仍存在的路径。

## [0.2.4] - 2026-05-23

### 新增

- **CodeMirror 编辑器**：文件树与 Git 面板的网页编辑由 textarea 升级为 CodeMirror 6，支持行号、Tab 缩进及按扩展名语法高亮（JS/TS、JSON、Markdown、Python、CSS、HTML、YAML、Rust、Go、SQL、XML 等）。

### 变更

- **发版流程**：推送 `v*` tag 后 GitHub Actions 全自动测试、构建四架构、从 `CHANGELOG.md` 提取对应版本说明创建 Release 并上传 Assets。

## [0.2.3] - 2026-05-23

### 变更

- **GitHub Actions**：构建 workflow 改为推送 `v*` tag 全自动发版（此前曾仅在 Release published 时触发）。
- **历史页分组折叠**：项目目录默认折叠，点击展开查看会话列表。

### 修复

- **CI 交叉编译**：`scripts/build.sh` 区分 host / target，bootstrap 始终下载当前机器架构的 Bun；交叉产物在 CI 上跳过 smoke test。
- **历史会话目录（macOS）**：修复 Cursor/Claude 编码路径解码，将 `oh-my-agent-shell` 误解析为 `oh/my/agent/shell`；改为按文件系统贪婪匹配真实路径。

## [0.2.2] - 2026-05-22

### 变更

- **侧栏轮询防跳动**：文件树、Git 面板、会话列表在数据未变时不重绘；后台刷新使用静默模式，隐藏标签页时暂停轮询。
- **历史会话刷新策略**：浏览历史页时不再定时轮询；仅在打开页面、手动刷新、或关闭/销毁终端标签时更新（弹窗终端通过 `BroadcastChannel` 同步到主窗口）。
- **历史页滚动保留**：列表更新时保持滚动位置，分组排序更稳定。

## [0.2.1] - 2026-05-22

### 新增

- **默认启动目录**：`omas serve --cwd`、`OMAS_CWD`、`config.json` 的 `defaultCwd`；`omas service install` 同样支持 `--cwd`。
- **GitHub Actions 构建**：四架构产物上传 Release Assets。

### 未实现 / 放弃

- **文件树「在终端 cd」**：曾尝试在左侧文件树为文件夹添加跳转按钮，向 PTY 注入 `cd "/path"`。已放弃，原因如下：
  - **无法从外部改 shell 的 cwd**：PTY 子进程的工作目录与 omas 进程隔离，Unix 没有通用 API 能安全地替运行中的 shell 改目录，只能往终端里「打字」发命令。
  - **空闲检测不可靠**：猜提示符文本（`$`、`➜` 等）随主题、oh-my-zsh、ANSI 转义而失效；OSC 133 Shell Integration 虽更准，但需在 shell 里注入 hook，体验不优美，且无法覆盖 fish 等场景。
  - **交互语义混乱**：文件树主要用于浏览与网页编辑；旁路注入 `cd` 与用户正在 vim/less 中的会话容易冲突。
  - **现有替代**：在终端里正常 `cd`，或通过 Git 面板的「在终端编辑」打开文件；文件树仍跟随 shell 当前目录（macOS 经 `lsof` 跟踪 cwd）展示内容。

## [0.2.0] - 2026-05-22

### 新增

- **单文件二进制交付**：`npm run build` 产出 `release/omas`，内嵌 Web 静态资源，无需 Node 运行时。
- **CLI 子命令**：`serve`（默认）、`init`、`install`、`service install/uninstall`；中文帮助。
- **systemd / launchd 服务**：`omas service install` 一键注册用户级后台服务。
- **左侧文件浏览器**、**Git 网页编辑**、**文件系统 / 会话输入 API**、[`docs/MANUAL.md`](./docs/MANUAL.md)。

### 变更

- **默认开放模式**：未配置密码时无需登录（仍可通过 `omas init` / `--password` / `OMAS_PASSWORD` 启用认证）。
- **构建脚本统一**为 `scripts/build.sh`；**三栏布局**文件树 | 终端 | Git。

### 修复

- **macOS PTY**：`backend-bun-darwin.ts`（`Bun.spawn` + `terminal.resize`），修复 zsh 卡住、`ls` 列宽错乱。
- **Bun 二进制崩溃**：`node-pty` 改为动态加载，避免编译产物启动即崩溃。
- **Linux PTY**：修正 Darwin 误用分支、termios、`O_NOCTTY`、`POSIX_SPAWN_SETSID` 等常量。
- **Git 编辑**：使用仓库绝对路径并在当前会话打开，避免在错误 cwd 下创建空文件。

### 移除

- Node 全局安装 / `npm start` 生产路径、`build:server` 等旧分发方式。

---

## 踩坑与经验

开发过程中积累的技术教训（与上节版本记录互补；运维排错另见 [MANUAL.md § 故障排查](./docs/MANUAL.md#故障排查)）。

### PTY 与 TUI（Claude Code / Cursor Agent）

| 坑 | 教训 |
|----|------|
| 断线后重放原始 PTY 字节 | TUI 的 clear-screen 等转义会**再执行一遍**，屏幕被清空。→ 用 **headless xterm 镜像** + `SerializeAddon` 做 attach 快照。 |
| 快照含 2000 行 scrollback | 写入浏览器 xterm 后视口停在 scrollback **顶部**，Cursor 像跳到很久以前。→ attach 后 **`scrollToBottom()`**。 |
| 固定 80×24 建会话 | Agent/TUI 首屏列宽错乱。→ 按视口 **估算 cols/rows**，连接前 `fit` 同步。 |
| Bun `spawn({ terminal })` 在 macOS 忽略 `cwd` | 历史页恢复的会话不在项目目录。→ PTY 起来后 **延迟 `cd`** 注入。 |
| launchd/systemd 无 `LANG` | `ls` 中文文件名变 `?`。→ PTY env 默认 **UTF-8 locale** + xterm CJK 字体回退。 |

### 数据与路径

| 坑 | 教训 |
|----|------|
| PTY 用 string 存输出 | 中文 scrollback 截断出 ``。→ 全链路 **Buffer 字节** + ring `since()` 按 UTF-8 边界切片。 |
| Claude 路径 `Users-…-oh-my-agent-shell` |  naive `-→/` 解码成 `oh/my/agent/shell`。→ **贪婪目录 walk**，最长匹配 `oh-my-agent-shell`。 |
| macOS `/var/folders/_xx/…` | 编码目录带 `_` 前缀。→ `segmentCandidates` 补 `_` 变体。 |

### 构建、发版与仓库

| 坑 | 教训 |
|----|------|
| CI 交叉编译拉错架构 Bun | bootstrap 必须按 **host** 下载，compile 按 **target**。 |
| `osma` / `omas` 混用 | 服务 plist 仍指向 `com.osma`、`release/osma`。→ 统一 **`omas`** 后需 **`service install --force`** 重装。 |
| Release 只有 commit 摘要 | 用户看不到 CHANGELOG。→ tag 发版时 **`extract-changelog.mjs`** 写入 Release body。 |
| 误提交 `.claude/settings.local.json` | 本地 Claude 权限配置不应进 git。→ **`.gitignore` 忽略 `.claude/`**。 |
| 测试写死 `/Users/…/` | 泄漏本机用户名。→ 用 **`mkdtemp` + 占位名**（如 `alice`）。 |
| tmux 滚历史 vs 复制 | copy-mode 与 `mouse on` 难兼顾，Agent 日志难拷。→ omas 用 **xterm scrollback + 浏览器选区复制**（见 README）。 |

### 明确不做的事

- **文件树一键 cd 到 PTY**：见 [0.2.1 放弃说明](#021---2026-05-22)。
- **把 omas 做成 IDE / 多租户 SaaS**：见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

[0.2.6]: https://github.com/lilymoonight/omas/commit/d788da8
[0.2.5]: https://github.com/lilymoonight/omas/commit/f5a277e
[0.2.4]: https://github.com/lilymoonight/omas/commit/d4c149b
[0.2.3]: https://github.com/lilymoonight/omas/commit/71280e7
[0.2.2]: https://github.com/lilymoonight/omas/commit/a14b5b2
[0.2.1]: https://github.com/lilymoonight/omas/commit/7c1375e
[0.2.0]: https://github.com/lilymoonight/omas/commit/1739092
