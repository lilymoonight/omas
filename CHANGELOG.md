# Changelog

本文件记录 omas 的重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.5.2] - 2026-06-02

### 修复

- **macOS 新会话不再回显 `cd '<目录>'`**：旧的 Bun PTY 变通会在 shell 启动后向终端写一行 `cd '<工作目录>'`，被交互式 shell 回显为开头的一行提示。现已确认 Bun 1.3.x 的 `Bun.spawn({ terminal, cwd })` 在 macOS 上会正确应用 `cwd`，故移除该手动 `cd`——新会话直接在目标目录启动，开头不再有多余的 `cd` 行。

## [1.5.1] - 2026-06-02

### 性能优化

- **会话列表进程探测去重**：`foregroundForPids` 现在每次 `ps` 快照只构建一次「pid → 进程 / ppid → 子进程」索引并在所有会话查询间复用，把原先每个会话各自重建全表索引的 `O(会话数 × 进程数)` 降为近似 `O(进程数)`；agent 子树 CPU 采样也复用同一索引。
- **macOS cwd 探测合并为单次 `lsof`**：`GET /api/sessions` 列表轮询不再对每个 shell pid 各起一个 `lsof`，改为对所有缓存未命中的 pid 发起**一次** `lsof -Fpn` 批量解析（Linux 仍走廉价的 `/proc` readlink）——这是 macOS 列表路径此前最重的开销。
- **公开静态站点改为异步 FS**：`/p/<slug>/...` 的目录索引与文件探测由同步 `readdirSync`/`statSync` 改为 `fs/promises` 并并行化每项 `stat`，避免大目录请求阻塞整个事件循环。
- **会话退出清理 cwd 缓存**：会话结束时按 pid 清除 cwd 缓存条目，防止已退出（或被复用）的 pid 长期滞留在缓存中。
- **前端省渲染**：系统负载面板仅在数据真正变化时才赋值（避免每 3 秒无谓重渲染与进度条动画）；命令面板的会话命令列表只在面板打开时构建（不再随后台每 3 秒的会话轮询重建 N 个命令对象）；历史页搜索输入加 150ms 防抖并在单次遍历中计算分组的最新活动时间；运行时配置（沙箱策略 / 默认目录）在页面生命周期内缓存，重复打开新建会话对话框不再重复请求；上传进度更新节流到约 10fps。

## [1.5.0] - 2026-06-01

### 新增

- **会话级沙箱隔离（Linux / macOS）**：用 `omas serve --sandbox-root <dir>` 开启后，新会话默认被沙箱包裹——**整个文件系统只读，唯独该会话选定的工作目录（`cwd`）可写**，`HOME`/`TMPDIR` 指到工作目录下的 `.home`/`.tmp`（持久、可写缓存），默认仍共享主机网络（`--sandbox-no-net` 可断网）。可写目录**必须落在 `sandbox-root` 之内**，因此即便会话请求 `/` 也只会被拒绝，杜绝「全盘可写」。沙箱开关是**逐会话**属性，不影响你自己未沙箱的运维会话。两套后端按平台自动选择：**Linux 用 [bubblewrap](https://github.com/containers/bubblewrap)（`bwrap`，另挂私有 tmpfs `/tmp`）**，**macOS 用 `sandbox-exec`（Seatbelt 策略，拒绝 `/tmp` 与 `/var/folders` 写入以对齐隔离效果，同时放行终端 ioctl 以保证交互式 shell 的方向键与作业控制正常）**。`omas exec` 的一次性命令与会话同等受限。
- **解除沙箱口令（bypass）**：要创建「全盘可写」的非沙箱会话，需校验一个**独立于登录密码**的 bypass 口令。该口令只能用 `omas passwd --bypass` 提前设置（仅存 argon2id 哈希、不接受启动参数，避免被 `ps` 看到），且**必须不同于登录密码**、**绝不下发给 agent**。未设置时，非沙箱会话一律拒绝。校验失败按 IP 限流。
- **网页新建会话对话框**：列表页「新建会话」改为弹窗，工作目录支持**面包屑路径导航 + 点击子目录逐级进入**（顶部面包屑可点任意上级目录、内联列出子目录、点一下即选定；也可手动输入 / 粘贴路径并记忆上次目录；服务端开启沙箱时面包屑不越过 `sandbox-root`），并显示 **🛡 沙箱隔离** 勾选框（默认勾选；取消需填 bypass 口令）。新增只读列目录接口 `/api/dirs` 与运行时信息接口 `/api/runtime` 支撑该对话框。
- **面向 agent 的远程命令 / 文件 CLI**：本地 agent 可把远程主机当算力，复用同一域名 + TLS：
  - `omas exec <url> --cwd <工作区> -- <命令>`：在工作区目录内执行 shell 命令并取回 stdout/stderr 与**退出码**（沙箱开启时命令与会话同等受限）。
  - `omas upload <url> <本地文件> [远程子目录] --cwd <工作区>`：上传文件（>16 MiB 自动分片）。
  - `omas download <url> <远程相对路径> [本地路径] --cwd <工作区>`：下载文件，目录自动打包为 `.tar.gz`，`-` 表示输出到 stdout。
  - 三者均可用 `--cwd` 临时新建会话（用完即销毁，**目录文件持久保留**）或 `-s <会话id>` 复用已有会话——「工作区」即磁盘上的真实目录，`upload → exec → download` 指向同一 `--cwd` 即共享文件。
  - 随仓库附带 Agent Skill（`.cursor/skills/omas-remote-compute/`），教 AI agent 用上述 CLI 把远程主机当算力（含沙箱与 bypass 注意事项）。

## [1.4.0] - 2026-06-01

### 新增

- **文件 / 目录下载**：文件侧栏每一行都有下载按钮——文件按原字节流式下载，目录用系统 `tar` 现打成 `.tar.gz` 流式下载（不引入归档依赖、内存占用恒定）。沿用 cwd 越界防护，文件名通过 `Content-Disposition`（含 `filename*` UTF-8 回退）正确编码。与已有的拖拽上传互为对称。
- **会话只读分享链接**：终端页头部「分享」按钮一键生成只读链接并复制（`#/shared/<token>`）。访问者无需登录即可实时观看终端输出，但**无法输入、无法改变窗口大小**（服务端在只读 WebSocket 上彻底忽略输入 / resize / 标题）。观众端**固定使用会话原始的 cols×rows、不随观众窗口重排**（窗口更窄时横向滚动而非折行，保证排版与拥有者所见一致）。观众中途加入也能拿到**完整 scrollback** 历史向上翻看。token 仅存于内存，服务重启即失效；可在导出菜单中「撤销分享链接」。公开元信息接口只暴露标题与尺寸，绝不泄露会话 id。
- **终端内容导出**：终端页「导出」菜单支持导出**纯文本 `.txt`** 与**彩色 `.html`**（均由服务端从无头镜像导出，**包含完整 scrollback 历史而非仅当前屏**），以及 **asciinema 录制 `.cast`**（点击开始录制后实时采集带时间戳的输出，停止即下载，可用 asciinema 回放）。录制时头部显示 `REC` 指示。
- **命令面板（⌘/Ctrl + K）**：任意页面按 `⌘/Ctrl + K` 打开，模糊搜索并跳转到任一会话，或执行常用动作（新建会话、历史、发布、切换主题、开关通知、退出登录）。列表页头部也新增入口按钮。
- **在指定目录新建会话**：文件侧栏头部可「在当前目录新建会话」，树中每个目录悬停也可「在此目录新建会话」，新会话以该目录为工作目录在新标签页打开。
- **点击终端里的路径打开编辑器**：终端输出中形如 `src/app.ts`、`./x.py:12` 的路径变为可点击链接，点击即用网页编辑器打开（自动去除 `:行:列` 后缀，按会话实时工作目录解析；超出工作目录会提示）。

### 修复

- **HTML 导出乱码且不居中**：导出的 `.html` 此前只是 SerializeAddon 的剪贴板片段（无 `<!doctype>` / `<meta charset>`），中文与制表/边框字符在浏览器里按本地编码解析会乱码。改为包裹成完整 UTF-8 文档，并把终端块在页面中**水平居中**显示。
- **只读分享页不居中**：观众端在窗口比会话更宽时终端靠左、右侧大片留白。改为按会话原始宽度**居中**（用 `margin:auto` 而非 flex 居中，避免窗口更窄时左侧内容被裁出滚动范围）；窗口更窄时仍横向滚动、绝不折行。

## [1.3.0] - 2026-06-01

### 新增

- **公开静态站点托管（免密）**：把任意目录挂到 `/p/<slug>/` 对外免密访问，方便把构建产物、报告等工作结果以网页形式分享给别人或自己回看。`--publish-spa` 对单页应用找不到文件时回退 `index.html`；普通站点目录缺少 `index.html` 时，按 Python `http.server` 风格**列出目录文件树**（目录在前、文件带大小、可点进子目录与返回上级）。内置路径越界防护（拒绝 `..`、绝对路径、NUL），目录自动补 `/` 与 `index.html`，正确的 MIME 与 `no-cache`。可通过三种方式配置：
  - **发布管理页**（`#/publish`，列表页「发布」入口）：在网页里新增 / 删除站点、切换 SPA、复制可分享链接（自动适配反向代理前缀），**改动持久化到 `config.json` 且无需重启即时生效**。
  - **`config.json` 的 `sites` 字段**：手动持久化。
  - **`omas serve --publish <slug>=<目录>`**（可重复）：命令行临时发布，CLI 优先级最高且不可在页面里编辑。
  - 安全：仅在配置可落盘时允许页面保存——**内存模式 / 临时密码（`--password` / `--password-file` / `OMAS_PASSWORD`）下拒绝写盘**，避免把仅内存的密码哈希持久化。公开内容随服务监听地址暴露，对外访问请确保监听地址 / 代理符合预期，勿发布含敏感信息的目录。
- **终端内搜索**：终端区域按 `Cmd/Ctrl+F` 打开搜索栏，高亮 scrollback 中的匹配并显示「当前/总数」，`Enter` / `Shift+Enter` 跳转上下一个，支持区分大小写与正则，`Esc` 关闭；高亮配色随浅/深主题切换。仅在普通缓冲区拦截 `Ctrl+F`——全屏 TUI（vim、cursor-agent/claude TUI 等，处于 alt-screen）仍把 `Ctrl+F` 交给应用本身。
- **Agent 空闲主动通知**：会话列表新增「通知」开关（铃铛按钮）。开启后，当某会话的 agent 从「工作中」转为「空闲」（通常意味着跑完或在等输入）时，在后台标签页弹出系统通知（点击可打开该会话），并在标签标题与 favicon 上显示待处理角标，回到该标签页即清除；同一会话用相同 tag 合并，多标签不会重复打扰。开启通知后会话轮询在标签页隐藏时仍继续，以便后台捕捉状态变化。
- **会话按项目分组**：列表页新增「分组」开关，按会话实时工作目录（`liveCwd`，回退到启动 `cwd`）聚合，分组可折叠、状态持久化；多 repo / 多 agent 时一眼分清。无工作目录的会话归入末尾「其他」组。分组标题采用 oh-my-zsh 风格的彩色路径面包屑（箭头分隔、当前目录高亮），展开分组时卡片不再重复显示工作目录标签。

### 修复

- **重新部署后浏览器仍显示旧界面**：SPA 入口页（`/` 等回退到 `index.html` 的路由）未设缓存头，浏览器会启发式缓存它并持续加载旧的资源包。改为对入口页返回 `Cache-Control: no-cache`，强制每次校验，更新后正常刷新即可见到最新版。
- **分组标题展开时被挤到右侧**：分组箭头的展开状态类名 `open` 与会话卡片可点击区域的全局类 `.open`（`flex: 1`）冲突，导致展开时箭头被撑大、把路径与计数顶到右边并形成竖条状空块。状态类重命名为 `expanded`，展开 / 折叠均正确左对齐。

## [1.2.0] - 2026-05-30

### 新增

- **深色主题**：新增 浅色 / 深色 / 跟随系统 三态切换（列表页与终端页头部按钮），偏好持久化到本地，首屏内联应用主题、无闪烁；终端（xterm）配色随主题实时切换，无需重连。
- **拖拽上传文件**：将文件拖到终端区域即可上传到会话当前所在目录，带实时进度提示。超大文件自动分片、并行高速上传（服务端预分配、定位写入、原子落盘并避免重名），可中途取消。
- **Agent 活跃 / 空闲检测**：会话卡片的 agent 徽标显示「工作中」（绿色脉冲）/「空闲」状态。基于对 agent 进程子树的 CPU 占用采样判定，避免 TUI（如 Cursor）光标闪烁、界面重绘导致的误判抖动。

[1.4.0]: https://github.com/lilymoonight/omas/releases/tag/v1.4.0

[1.3.0]: https://github.com/lilymoonight/omas/releases/tag/v1.3.0

[1.2.0]: https://github.com/lilymoonight/omas/releases/tag/v1.2.0

## [1.1.0] - 2026-05-30

### 新增

- **会话 Agent 标识**：会话列表卡片显示当前前台程序——能识别 Claude / Cursor / Qoder 等 AI agent（即便经 node/python 等包装也能认出），其余程序显示命令名；空闲 shell 不显示徽标。
- **实时工作目录**：卡片显示会话实时 cwd（跟随 `cd`），便于区分从同一默认目录启动的多个 agent。

### 修复

- **密码哈希原生模块缺失**：单文件二进制在设置密码 / 登录时报 `no native build was found for argon2`。改用 Bun 内置 `Bun.password`（argon2id，无需 native addon），Node 环境回退 `argon2` npm 包；PHC 格式互相兼容，二进制不再依赖任何 `.node` 文件。
- **终端视口随机跳到 scrollback 顶部**：运行 TUI（cursor-agent / claude 等）时，resize / 重绘会让“是否贴底”的几何判断误判成“用户上滚”。改为显式跟踪用户滚动意图（滚轮 / 翻页键），只有用户主动上滚才停止贴底，否则始终贴住实时屏。

### 优化

- **服务端压力与运行时体验**：缓存 shell cwd / git status / 系统指标；headless 镜像批量写入并缓存快照；历史扫描以文件大小估算行数；前端按需懒加载、合并 xterm 写入。

### 文档

- **命名说明**：README 明确 **omas** 为 **oh-my-agent-shell** 的缩写（o-m-a-s）。
- **English README**：新增 [README.en.md](./README.en.md)，中英文 README 互相链接。

[1.1.0]: https://github.com/lilymoonight/omas/releases/tag/v1.1.0

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
