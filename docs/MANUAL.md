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
5. [安装到 PATH](#安装到-path)
6. [注册系统服务](#注册系统服务)
7. [Docker](#docker)
8. [HTTP / WebSocket API](#http--websocket-api)
9. [生产部署](#生产部署)
10. [开发与测试](#开发与测试)
11. [限制与已知问题](#限制与已知问题)
12. [故障排查](#故障排查)

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
| `omas passwd` | 交互式修改密码 |
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
```

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
```

已登录的浏览器会话在 cookie 过期前仍有效。

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
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### 环境变量

| 变量 | 作用 |
|------|------|
| `OMAS_PASSWORD` | serve 时使用的一次性密码（内存） |
| `XDG_CONFIG_HOME` | 改变默认配置根目录 |
| `LOG_LEVEL` | `pino` 日志级别（`info`、`debug` 等） |
| `NODE_ENV` | `production` 时使用 JSON 日志 |
| `SHELL` | 新终端会话默认 Shell |

### 会话 Cookie

- 名称：`omas_sid`
- 属性：`HttpOnly`、`SameSite=Lax`、HTTPS 下 `Secure`
- 登录失败限流：每 IP 5 次 / 5 分钟

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
| GET | `/api/sessions` | 列表 |
| POST | `/api/sessions` | 创建 `{ "cols", "rows", "name?" }` |
| PATCH | `/api/sessions/:id` | 重命名 |
| DELETE | `/api/sessions/:id` | 销毁 |

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
