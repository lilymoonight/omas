# omas 完整使用手册

omas（**o**h-**m**y-**a**gent-**s**hell 的缩写）是 **Agent 时代的轻量 Shell 控制台**：Terminal 居中，帮你自动分离多路会话；浏览器标签用完即关，Agent 可在后台继续跑；自动扫描 Claude/Cursor 等历史并一键恢复；侧栏支持改小文件与 review AI 的 Git 改动。

支持断线重连、nginx 子路径与 VSCode 端口转发。单文件二进制、自托管。

**不是** AI Agent，**不是** IDE 替代品——减轻上下文记忆负担，把「跑着、看着、过改动」从编辑器里拆出来。

→ 理念与和 IDE 的对比：[AI-WORKFLOW.md](./AI-WORKFLOW.md)

---

## 目录

0. [AI 开发工作流](./AI-WORKFLOW.md)
1. [快速开始](#快速开始)
2. [构建](#构建)
3. [命令参考](#命令参考)
4. [密码与配置](#密码与配置)
5. [会话沙箱（Linux / macOS）](#会话沙箱linux--macos)
6. [安装到 PATH](#安装到-path)
7. [注册系统服务](#注册系统服务)
8. [Docker](#docker)
9. [HTTP / WebSocket API](#http--websocket-api)
10. [生产部署](#生产部署)
11. [开发与测试](#开发与测试)
12. [限制与已知问题](#限制与已知问题)
13. [故障排查](#故障排查)

---

## 快速开始

```bash
git clone git@github.com:lilymoonight/omas.git && cd omas
npm install
npm run build          # → release/omas

# 方式 A：环境变量密码，立刻试用
chmod +x release/omas
OMAS_PASSWORD=yourpass ./release/omas serve --port 7681

# 方式 B：持久化密码 + 后台服务
./release/omas install --prefix ~/.local/bin
omas init
omas service install
```

浏览器打开：**http://127.0.0.1:7681**

查看命令帮助：

```bash
omas --help
omas serve --help
omas service install --help
```

---

## 构建

### 要求

| 项目 | 说明 |
|------|------|
| 构建机 Node | >= 22 |
| 构建机工具 | `curl`、`unzip`（自动下载 Bun） |
| 产物 | 单文件 `release/omas`，无需目标机预装 Node |

### 命令

```bash
npm install          # 同时生成 web-assets stub，供开发 typecheck
npm run build        # 完整单文件二进制
```

### 交叉编译

```bash
ARCH=linux-x64 npm run build      # 在 macOS 上编译 Linux x64
ARCH=linux-arm64 npm run build
ARCH=darwin-arm64 npm run build   # 默认：当前机器架构
```

产物路径固定为 **`release/omas`**（无架构后缀）。对不同架构重复构建会**覆盖**同一路径。

### 构建产物说明

- 内嵌 Bun 运行时、服务端逻辑、Web 前端资源
- 体积约 60–95 MB（视平台而定）
- `install`、`service` 子命令**仅**在此单文件二进制下可用

---

## 命令参考

### 总览

| 命令 | 说明 |
|------|------|
| `omas` / `omas serve` | 启动服务（**默认命令**） |
| `omas init` | 交互式初始化密码配置文件 |
| `omas passwd` | 交互式修改登录密码 / 设置解除沙箱口令（`--bypass`） |
| `omas exec` | 在远程工作区执行命令并取回输出（给本地 agent 用） |
| `omas upload` | 上传文件到远程工作区 |
| `omas download` | 从远程工作区下载文件 / 目录 |
| `omas connect` | 在本地终端像 ssh 一样连接远程会话 |
| `omas install` | 复制二进制到 PATH |
| `omas service install` | 注册并启动 systemd / launchd 服务 |
| `omas service uninstall` | 卸载服务 |
| `omas --help` | 显示帮助 |
| `omas --version` | 显示版本 |

---

### `omas serve`（默认）

启动 HTTP + WebSocket 服务，提供 Web UI 与终端会话。

```bash
omas serve [选项]
omas [选项]                    # 省略 serve 时等价
```

| 选项 | 短选项 | 默认值 | 说明 |
|------|--------|--------|------|
| `--host <host>` | `-h` | `127.0.0.1` | 监听地址。公网暴露请用 `0.0.0.0`，且**必须**前置 TLS 反向代理 |
| `--port <port>` | `-p` | `7681` | 监听端口 |
| `--shell <path>` | | `$SHELL` → `/bin/bash` → `/bin/sh` | 新会话默认 Shell |
| `--config-dir <dir>` | | `~/.config/oh-my-agent-shell` | 配置目录 |
| `--max-sessions <n>` | | `50` | 最大并发会话数，超出返回 HTTP 429 |
| `--scrollback-bytes <n>` | | `524288`（512 KiB） | 每会话 scrollback 环形缓冲区大小 |
| `--password <pw>` | | — | 登录密码（**仅内存**，`ps` 可见，不落盘） |
| `--password-file <path>` | | — | 从文件读密码（trim 后使用，**仅内存**） |
| `--publish <slug=dir>` | | — | 把目录挂到 `/p/<slug>/` 作**免密公开静态站点**（可重复） |
| `--publish-spa <slug=dir>` | | — | 同上，但未命中文件时回退 `index.html`（适合单页应用，可重复） |
| `--sandbox-root <dir>` | | — | **开启会话沙箱**（Linux 用 bwrap / macOS 用 sandbox-exec）。会话只读整个文件系统，仅其工作目录（须在此目录内）可写。详见[会话沙箱](#会话沙箱linux--macos) |
| `--sandbox-no-net` | | — | 沙箱会话断网（默认共享主机网络） |
| `--sandbox-default-off` | | — | 新会话默认**不**沙箱（仍可逐个开启；解除沙箱需 bypass 口令） |

**示例**

```bash
# 本地开发
OMAS_PASSWORD=devpass omas serve

# 指定配置目录
omas serve --config-dir /var/lib/omas/config --port 7681

# 临时密码文件（比 --password 更安全）
echo 'my-secret' > /run/omas/password
omas serve --password-file /run/omas/password

# 局域网（务必加 nginx + HTTPS）
omas serve --host 0.0.0.0 --port 7681

# 发布静态站点（免密访问，便于分享工作结果）
omas serve --publish report=./dist --publish-spa app=./build
# → http://<host>:<port>/p/report/   和   /p/app/
```

#### 公开静态站点（免密托管）

把构建产物 / 报告 / 任意静态目录挂到 `/p/<slug>/`，**不需要 omas 密码**即可访问，方便把工作结果以网页形式分享给别人或自己回看。

- 路径：每个站点位于 `/p/<slug>/`；`slug` 仅允许字母数字与 `. _ -`，不以符号开头。
- 来源：`--publish` / `--publish-spa`（可重复），或 `config.json` 的 `sites` 数组（CLI 同名 slug 覆盖配置）。
- SPA：`--publish-spa`（或 `sites[].spa: true`）在找不到文件时回退该站点的 `index.html`，适配前端路由。
- 安全：内置路径越界防护（拒绝 `..`、绝对路径、NUL），目录自动补 `/` 并尝试 `index.html`，响应带 `no-cache` 与 `X-Content-Type-Options: nosniff`。
- **暴露范围**：公开站点随服务监听地址一同对外。仅本机用默认 `127.0.0.1`；要让别人访问需 `--host 0.0.0.0` 或反向代理/隧道，此时该目录内容对能访问到端口的人均可见，请勿发布含敏感信息的目录。
- 列表页「公开站点」区可一键复制分享链接（自动适配反向代理前缀）。

---

### `omas init`

交互式创建 `config.json`（**需要 TTY**）。

```bash
omas init [--config-dir <dir>] [--force]
```

| 选项 | 说明 |
|------|------|
| `--config-dir <dir>` | 配置目录，默认同上 |
| `--force` | 覆盖已存在的 config.json |

密码最少 **6** 个字符。文件权限 **0600**。

---

### `omas passwd`

交互式修改已有配置中的密码（**需要 TTY**）。

```bash
omas passwd [--config-dir <dir>]
omas passwd --bypass [--config-dir <dir>]   # 设置“解除沙箱”口令
```

| 选项 | 说明 |
|------|------|
| `--bypass` | 设置 / 更新**解除沙箱口令**（创建非沙箱会话时校验）。该口令必须**不同于登录密码**，只存哈希、不接受启动参数（避免被 `ps` 看到） |

不带 `--bypass` 时修改登录密码；已登录的浏览器会话在 cookie 过期前仍有效。

---

### `omas exec` / `omas upload` / `omas download`（远程算力，给本地 agent 用）

把远程 omas 主机当算力：本地 agent 复用同一域名 + TLS（与网页同一套鉴权），在远程「工作区」里跑命令、推代码、取结果。**工作区就是远程磁盘上的真实目录**（沙箱开启时须在 `sandbox-root` 内）；把所有命令指向同一 `--cwd`（或同一 `-s <会话id>`）即共享文件。

公共选项（三条命令通用）：

| 选项 | 短选项 | 说明 |
|------|--------|------|
| `--session <id>` | `-s` | 复用已有会话作为工作区（默认按 `--cwd` 临时新建、用完即销毁，**目录文件保留**） |
| `--cwd <dir>` | | 临时会话的工作目录（沙箱开启时必须在 `sandbox-root` 内） |
| `--no-sandbox` | | 创建非沙箱会话（全盘可写，需配合 `--bypass`） |
| `--bypass <pw>` | | 解除沙箱口令（也可用环境变量 `OMAS_BYPASS`） |
| `--password <pw>` | | 登录密码（也可用 `OMAS_PASSWORD` 或交互输入） |
| `--insecure` | | 跳过 TLS 证书校验（自签名证书时使用） |

```bash
# 执行命令并取回输出，退出码与远程命令一致（便于脚本判断成败）
omas exec example.com --cwd /srv/agent/job1 -- "make && ./run"
omas exec example.com -s <会话id> -- ls -la
omas exec ... --timeout 600000 -- <命令>        # 自定义超时（毫秒，默认 120000）

# 上传本地文件到工作区（>16 MiB 自动分片）；打印写入后的相对路径
omas upload example.com ./main.py --cwd /srv/agent/job1
omas upload example.com ./data.zip subdir -s <会话id>

# 下载文件 / 目录（目录自动打包为 .tar.gz；用 - 输出到 stdout）
omas download example.com result.txt ./result.txt --cwd /srv/agent/job1
omas download example.com out/ . -s <会话id>

# 典型 agent 循环：同一 --cwd 即同一工作区
omas upload host ./main.py --cwd /srv/agent/job1
omas exec   host --cwd /srv/agent/job1 -- "python3 main.py > out.txt 2>&1"
omas download host out.txt - --cwd /srv/agent/job1
```

> `exec` 是**无状态**的一次性进程（`sh -c <命令>`，不共享交互 shell 的 env/历史），但与会话同等受沙箱约束。需要交互式登录请用 [`omas connect`](#omas-connect像-ssh-的本地终端)。

---

### `omas connect`（像 ssh 的本地终端）

在本地终端里直接登录远程 omas，体验类似 `ssh`，但复用现有 HTTP 鉴权 + WebSocket 终端协议，走域名已有的 TLS 反代即可。

```bash
omas connect example.com                  # 新建会话，交互输入密码
omas connect example.com -s <会话id>      # 附加到已有会话（与网页端共享）
omas connect example.com --list           # 列出会话后退出
omas connect http://127.0.0.1:7681 --password dev
```

`Ctrl-]` 断开（会话保留在后台），在 shell 里 `exit` 才真正结束。

---

### `omas install`

将**当前**单文件二进制复制到 PATH 目录。

```bash
omas install [选项]
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--prefix <dir>` | 可写则 `/usr/local/bin`，否则 `~/.local/bin` | 安装目录 |
| `--name <name>` | `omas` | 目标文件名 |
| `--alias <name>` | — | 可选：创建符号链接别名 |
| `--no-alias` | — | 不创建别名 |
| `--force` | — | 覆盖已存在的同名文件 |

**示例**

```bash
./release/omas install --prefix ~/.local/bin
sudo ./release/omas install --prefix /usr/local/bin --force
```

---

### `omas service install`

注册后台服务并（默认）立即启动。

```bash
omas service install [选项]
```

| 选项 | 短选项 | 默认值 | 说明 |
|------|--------|--------|------|
| `--host <host>` | `-h` | `127.0.0.1` | 服务监听地址 |
| `--port <port>` | `-p` | `7681` | 服务监听端口 |
| `--config-dir <dir>` | | `~/.config/oh-my-agent-shell` | 配置目录 |
| `--binary <path>` | | 当前可执行文件 | 服务要运行的 omas 路径 |
| `--system` | | — | **Linux**：系统级 systemd（需 root）。**macOS 不支持** |
| `--no-start` | | — | 只写 unit/plist，不 enable / 不启动 |
| `--force` | | — | 覆盖已有 unit/plist |

**写入位置**

| 平台 | 范围 | 文件路径 |
|------|------|----------|
| Linux | 用户级（默认） | `~/.config/systemd/user/omas.service` |
| Linux | 系统级（`--system`） | `/etc/systemd/system/omas.service` |
| macOS | 用户级 | `~/Library/LaunchAgents/com.omas.plist` |

**推荐流程**

```bash
omas init                        # 先持久化密码
omas service install             # 注册并启动
omas service install --force     # 修改参数后覆盖
```

**Linux 手动管理**

```bash
systemctl --user status omas
systemctl --user restart omas
journalctl --user -u omas -f
```

**macOS 手动管理**

```bash
launchctl print gui/$UID/com.omas
# 日志目录：$TMPDIR/omas/stdout.log、stderr.log
```

**Linux 系统级**

```bash
sudo omas service install --system
sudo systemctl enable --now omas
sudo systemctl status omas
```

---

### `omas service uninstall`

```bash
omas service uninstall [--system]
```

| 选项 | 说明 |
|------|------|
| `--system` | 卸载 Linux 系统级 unit（需 root） |

停止服务、disable、删除 unit/plist 文件。

---

## 密码与配置

### 密码来源优先级（`serve` 时）

当磁盘上**没有**可用 config，或使用了 `--password` / `--password-file` 时：

1. `--password <pw>`
2. `--password-file <path>`
3. 环境变量 `OMAS_PASSWORD`
4. 交互式 TTY（提示输入，**写入** config.json）
5. 无 TTY 且无上述来源 → 生成随机密码，打印到 stdout（**重启失效**）

`--password`、`--password-file`、`OMAS_PASSWORD` **不会**写入磁盘。

### 配置文件

**路径**：`<config-dir>/config.json`

**默认 config-dir**：

- 显式 `--config-dir`
- 否则 `$XDG_CONFIG_HOME/oh-my-agent-shell`
- 否则 `~/.config/oh-my-agent-shell`

**结构**（自动生成，勿手改 hash）：

```json
{
  "passwordHash": "$argon2id$...",
  "cookieSecret": "...",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "defaultCwd": "/home/me/projects",
  "sites": [
    { "slug": "report", "root": "/home/me/app/dist" },
    { "slug": "app", "root": "/home/me/app/build", "spa": true }
  ],
  "sandbox": { "root": "/srv/agent", "net": true, "default": true },
  "unsandboxedHash": "$argon2id$..."
}
```

> `sites`：免密公开静态站点列表（挂到 `/p/<slug>/`），等价于持久化的 `--publish`。`spa: true` 对应 `--publish-spa`。命令行 `--publish*` 与此处同名 slug 时以命令行为准。
>
> `sandbox`：持久化的会话沙箱设置，等价于 `--sandbox-root` / `--sandbox-no-net` / `--sandbox-default-off`（命令行优先）。`root` 是可写区上限（必填以开启沙箱），`net` 默认 `true`，`default` 表示新会话是否默认沙箱（默认 `true`）。详见[会话沙箱](#会话沙箱linux--macos)。
>
> `unsandboxedHash`：解除沙箱口令的 argon2id 哈希，**只能用 `omas passwd --bypass` 设置**，请勿手填。未设置时禁止创建非沙箱会话。

### 环境变量

| 变量 | 作用 |
|------|------|
| `OMAS_PASSWORD` | serve 时使用的一次性密码（内存）；`connect`/`exec`/`upload`/`download` 的登录密码 |
| `OMAS_BYPASS` | `exec`/`upload`/`download` 创建非沙箱会话时的解除沙箱口令 |
| `XDG_CONFIG_HOME` | 改变默认配置根目录 |
| `LOG_LEVEL` | `pino` 日志级别（`info`、`debug` 等） |
| `NODE_ENV` | `production` 时使用 JSON 日志 |
| `SHELL` | 新终端会话默认 Shell |

### 会话 Cookie

- 名称：`omas_sid`
- 属性：`HttpOnly`、`SameSite=Lax`、HTTPS 下 `Secure`
- 登录失败限流：每 IP 5 次 / 5 分钟

---

## 会话沙箱（Linux / macOS）

> **用途**：把会话（以及里面跑的 agent）限制在一个目录内可写、其余只读，避免 agent 误改 / 误删主机上无关文件。

### 原理

开启后，每个沙箱会话用平台对应的后端包裹 shell，效果一致：

- **整个文件系统只读**，**唯独该会话选定的工作目录 `cwd` 可写**；
- `cwd` **必须落在配置的 `sandbox-root` 之内**——这是「可写天花板」，即使请求 `/` 或 `sandbox-root` 之外的路径也会被拒绝，从根本上杜绝「全盘可写」；
- `HOME`/`TMPDIR` 指到 `cwd/.home`、`cwd/.tmp`（持久、可写，工具的缓存 / 临时文件不写到真实 `$HOME` 或全局 `/tmp`）；
- 默认**共享主机网络**，`--sandbox-no-net` 可断网；
- 沙箱进程随 omas 退出而结束。

两套后端按平台自动选择：

| 平台 | 后端 | 关键差异 |
|------|------|----------|
| **Linux** | [bubblewrap](https://github.com/containers/bubblewrap)（`bwrap`） | `--ro-bind / /` 重建只读根，可写目录 `--bind` 回来；另挂**私有 tmpfs `/tmp`**、新建 `/dev` `/proc`；`--die-with-parent` |
| **macOS** | `sandbox-exec`（Seatbelt） | `(deny default)(allow file-read*)` + 仅放开 `cwd` 与 `/dev` 的写；**拒绝 `/tmp` 与 `/var/folders` 写入**以对齐隔离效果（故把 `TMPDIR` 指到 `cwd/.tmp`）。路径按 `realpath` 规范化（Seatbelt 匹配真实路径，如 `/tmp`→`/private/tmp`） |

沙箱是**逐会话**属性：你自己未沙箱的运维会话不受影响；`exec` 一次性命令与所在会话**同等受限**。

### 前置条件

- **Linux**：内核开启**非特权用户命名空间**（unprivileged userns），且装有 `bwrap`（如 `apt install bubblewrap`）。
- **macOS**：自带 `/usr/bin/sandbox-exec`，无需安装。

> macOS 的 `sandbox-exec` 被 Apple 官方标记为 deprecated（但十余年仍在系统中、Chrome / Bazel / Nix 等仍在用）；如对长期稳定性敏感，生产隔离建议用 Linux + bwrap。

未满足时（如缺 `bwrap` 或在不支持的平台上），带 `--sandbox-root` 启动会**立即报错退出**（fail-fast），不会以为开了沙箱实际没开。

### 启用

```bash
# 1) 设置“解除沙箱”口令（必须不同于登录密码；只存哈希）
omas passwd --bypass

# 2) 开启沙箱，限定可写区在 /srv/agent 之内
omas serve --sandbox-root /srv/agent

# 可选：默认不沙箱 / 断网
omas serve --sandbox-root /srv/agent --sandbox-default-off
omas serve --sandbox-root /srv/agent --sandbox-no-net
```

> 建议把 `--cwd`（新会话默认目录）与 `defaultCwd` 设在 `sandbox-root` 之内，否则默认沙箱会话会因 `cwd` 越界而创建失败。

### 解除沙箱（bypass）

要创建「全盘可写」的非沙箱会话，需校验**独立于登录密码**的 bypass 口令：

- 只能用 `omas passwd --bypass` **提前**设置（仅存 argon2id 哈希、不接受启动参数，避免 `ps` 泄露），且**必须不同于登录密码**；
- 未设置 `unsandboxedHash` 时，**一律禁止**非沙箱会话；
- 校验失败按 IP 限流（5 次 / 5 分钟）；
- **绝不要把 bypass 口令给 agent**——agent 只该用沙箱会话。

网页端「新建会话」弹窗中，沙箱默认勾选；取消勾选会要求填写 bypass 口令。CLI 用 `--no-sandbox --bypass <pw>`（或 `OMAS_BYPASS`）。

### 与 agent 配合

配合 [`omas exec` / `upload` / `download`](#omas-exec--omas-upload--omas-download远程算力给本地-agent-用)：本地 agent 把代码 `upload` 到 `sandbox-root` 下的工作区、`exec` 构建 / 运行、`download` 取回产物，全程被限制在该工作区内可写。

### 限制

- bwrap argv 与 Seatbelt profile 的拼装是纯函数并有单元测试（任意平台可验证）。
- macOS 后端是 syscall 级策略（MAC），模型上不如 bwrap 的命名空间彻底；且 `sandbox-exec` 官方标记 deprecated（短期不会移除）。
- 写工作目录之外（含硬编码 `/tmp` 的程序）会被拒绝——这是预期的隔离行为；让工具走 `TMPDIR` 即可。

---

## 安装到 PATH

```bash
./release/omas install --prefix ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"   # 若尚未在 PATH 中
omas --version
```

---

## 注册系统服务

见 [`omas service install`](#omas-service-install)。

服务模式下请**优先**使用 `omas init` 持久化密码，避免在 plist/unit 中明文写密码。

---

## Docker

```bash
docker build -t omas .
docker volume create omas-config

# 初始化密码（交互）
docker run -it --rm -v omas-config:/config omas init

# 运行
docker run -d --name omas --restart unless-stopped \
  -p 127.0.0.1:7681:7681 \
  -v omas-config:/config \
  omas
```

容器内入口为 `/usr/local/bin/omas`，默认监听 `0.0.0.0:7681`，配置目录 `/config`。

---

## HTTP / WebSocket API

### 健康检查

```http
GET /api/health
```

无需认证，示例响应：

```json
{ "ok": true, "uptime": 123.45, "sessions": 2 }
```

### 认证

```http
POST /api/auth/login
Content-Type: application/json

{ "password": "..." }
```

成功时 `Set-Cookie: omas_sid=...`。

### 会话

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/runtime` | 运行时信息：`{ defaultCwd, sandbox }`（供网页新建会话弹窗使用） |
| GET | `/api/dirs?path=<路径>` | 只读列出子目录（目录补全用；按末段做前缀过滤） |
| GET | `/api/sessions` | 列表 |
| POST | `/api/sessions` | 创建 `{ "cols", "rows", "title?", "cwd?", "shell?", "initialCommand?", "sandbox?", "bypass?" }`。`sandbox` 省略时按服务端策略；`sandbox:false` 需附 `bypass` 口令；沙箱开启时 `cwd` 须在 `sandbox-root` 内 |
| POST | `/api/sessions/:id/exec` | 在会话工作区一次性执行命令 `{ command, timeoutMs? }` → `{ stdout, stderr, exitCode, signal, timedOut }`（沙箱会话内同等受限） |
| PATCH | `/api/sessions/:id` | 重命名 |
| DELETE | `/api/sessions/:id` | 销毁 |
| GET | `/api/sessions/:id/export?format=txt\|html` | 导出完整终端内容（屏幕 + scrollback，由服务端无头镜像序列化） |

### 文件下载

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions/:id/fs/download?path=<相对路径>` | 文件按原字节下载；目录用系统 `tar` 现打成 `.tar.gz` 流式下载。受 cwd 越界防护 |

### 只读分享

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/api/sessions/:id/share` | 需登录 | 生成（或返回已有）只读 token：`{ ok, token }`。分享链接为 `#/shared/<token>` |
| GET | `/api/sessions/:id/share` | 需登录 | 查询当前 token：`{ token }`（无则 `null`） |
| DELETE | `/api/sessions/:id/share` | 需登录 | 撤销 token |
| GET | `/api/shared/:token` | **免密** | 观看页元信息：`{ ok, title, cols, rows }`；不泄露会话 id |
| WS | `/api/shared/:token/attach?since=<seq>` | **token 即凭据** | 只读 WebSocket：只收输出，服务端忽略输入 / resize / 标题。token 仅存内存，重启失效 |

### 公开站点

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/api/sites` | 需登录 | `{ canPersist, sites: [{ slug, url, root, spa, cli }] }`；`cli` 表示由 `--publish` 提供（不可在页面编辑） |
| POST | `/api/sites` | 需登录 | 新增 / 覆盖持久化站点 `{ slug, root, spa? }`；写入 `config.json` 且即时生效。`canPersist=false` 时返回 409 |
| DELETE | `/api/sites/:slug` | 需登录 | 取消发布（仅停服务，不删目录文件）。CLI 站点返回 409 |
| GET | `/p/<slug>/...` | **免密** | 静态站点内容 |

> 网页管理：列表页「发布」按钮进入发布管理页（`#/publish`），可视化新增 / 删除站点、切换 SPA、复制分享链接，改动无需重启即时生效。`canPersist` 为 `false`（内存配置 / 临时密码）时页面只读，需先 `omas init` 或改用 `--publish`。

### 终端 WebSocket

```
WS /api/sessions/:id/attach?since=<seq>
Cookie: omas_sid=...
```

- 二进制帧：PTY 输出
- JSON 文本帧：控制消息（hello、ack、resize 等）
- `since=0`：全量快照；`since>0`：增量 replay

---

## 生产部署

详细说明见 [DEPLOY.md](../DEPLOY.md)。要点：

1. **默认只绑 `127.0.0.1`**，公网必须 nginx / Caddy 等做 TLS 终结
2. **WebSocket** 必须转发 `Upgrade` / `Connection`
3. 设置 `X-Forwarded-Proto` 以便 HTTPS cookie 生效
4. 子路径挂载时 `proxy_pass` 末尾**要有 /** 
5. 示例配置：`scripts/nginx-example.conf`

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header X-Forwarded-Proto $scheme;
proxy_buffering off;
proxy_read_timeout 1h;
```

---

## 开发与测试

源码开发使用 Node + tsx，**生产交付物始终是 `release/omas`**。

```bash
npm install
OMAS_PASSWORD=devpass npm run dev:server   # :7681 API + WS
npm run dev:web                            # :5173 UI，/api 代理到 :7681
```

```bash
npm test
npm run typecheck
node tests/ws.smoke.mjs http://127.0.0.1:7681 yourpassword
node tests/proxy-prefix.smoke.mjs
```

### npm scripts

| 脚本 | 说明 |
|------|------|
| `npm run build` | 构建 `release/omas` |
| `npm run build:web` | 仅构建前端（内部步骤） |
| `npm run build:embed` | 嵌入前端资源到 TS（内部步骤） |
| `npm run dev:server` | tsx 热重载服务端 |
| `npm run dev:web` | Vite 开发服务器 |
| `npm test` | vitest 单元 + PTY 集成测试 |

---

## 限制与已知问题

| 项目 | 说明 |
|------|------|
| 单用户 | 一个密码，所有浏览器标签共享会话存储 |
| 重启丢 Shell | `systemctl restart` 会杀死所有 PTY，设计如此 |
| 非多租户 | 无用户隔离 |
| Bun PTY | 常规输入/输出/Ctrl+C/resize 正常；`fg`/`bg`/`jobs`/Ctrl+Z 可能不可用 |
| 二进制命令 | `install` / `service` 不能通过 `node dist/...` 或 tsx 使用 |

---

## 故障排查

### 终端一直「连接中…」

- 检查反向代理是否转发 WebSocket（见 DEPLOY.md）
- 企业网可能剥离 `Connection: Upgrade`，需 SSH 隧道

### 登录后立刻掉线 / Cookie 无效

- HTTPS 站点需代理设置 `X-Forwarded-Proto: https`

### `service install` 后无法启动

- 是否已 `omas init`（config.json 存在）
- Linux：`systemctl --user status omas` / `journalctl --user -u omas`
- macOS：`launchctl print gui/$UID/com.omas`，查看 `$TMPDIR/omas/*.log`

### `install: this command only works from the single-binary build`

- 需使用 `npm run build` 产出的 `release/omas`，不能用 tsx / node 直接跑源码

### 构建失败：找不到 web-assets

- 运行 `npm run build`（会自动 `build:web` + `build:embed`），不要单独只跑 `tsc`

---

## 许可证

MIT
