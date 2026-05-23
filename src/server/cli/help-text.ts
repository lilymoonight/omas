/** Shared help copy for `omas --help` and docs/MANUAL.md — keep in sync. */

export const VERSION = '1.0.0';

export const ROOT_SUMMARY = '自托管多会话 Web 终端（单文件二进制）';

export const ROOT_DESCRIPTION = `
omas 是一个在浏览器中使用的多会话 Web 终端管理器。

功能概要：
  • 会话列表：创建、重命名、关闭，查看当前连接数
  • 断线重连：关闭浏览器标签页后，Shell 仍在服务端运行
  • 原生滚动与复制粘贴（xterm.js，无需 tmux 鼠标模式）
  • 支持反向代理子路径、VSCode 端口转发等部署方式
  • 单进程、单密码、无数据库、无外部依赖

产物：npm run build → release/omas（约 60–95 MB，含 Bun 运行时与 Web UI）

文档：仓库内 docs/MANUAL.md（完整说明）
部署：DEPLOY.md（反向代理、HTTPS、WebSocket）
`.trim();

export const ROOT_HELP_AFTER = `
命令概览
  serve [options]           启动 Web 终端服务（默认命令，可省略 serve）
  init [options]            交互式设置登录密码并写入配置文件
  passwd [options]          交互式修改登录密码
  install [options]         将本二进制复制到 PATH 目录
  service install [opts]    注册为 systemd / launchd 后台服务并启动
  service uninstall [opts]  停止并移除后台服务

密码来源（serve 首次启动，优先级从高到低）
  1. --password <pw>              命令行明文（仅内存，ps 可见，适合本地调试）
  2. --password-file <path>       从文件读取（仅内存，不落盘）
  3. OMAS_PASSWORD 环境变量       仅内存，不落盘
  4. 交互式 TTY                   提示输入两次，写入 config.json
  5. 无 TTY 且无上述来源          生成随机密码并打印一次（重启后失效）

配置文件
  默认路径    ~/.config/oh-my-agent-shell/config.json
  权限        0600（仅所有者可读）
  内容        passwordHash（argon2id）、cookieSecret、createdAt
  自定义      --config-dir <dir>  或  XDG_CONFIG_HOME/oh-my-agent-shell

环境变量
  OMAS_PASSWORD       serve 时使用的登录密码（内存，不落盘）
  XDG_CONFIG_HOME     影响默认 config 目录
  LOG_LEVEL           日志级别（默认 info；开发可用 debug）
  NODE_ENV            production 时关闭 pretty 日志
  SHELL               新会话默认 Shell（未指定 --shell 时）

典型工作流
  # 构建
  npm install && npm run build

  # 一次性本地试用
  OMAS_PASSWORD=secret ./release/omas serve --port 7681

  # 长期使用
  ./release/omas install --prefix ~/.local/bin
  omas init
  omas service install
  open http://127.0.0.1:7681

  # 跨平台编译（产物始终为 release/omas，会覆盖同路径旧文件）
  ARCH=linux-arm64 npm run build

HTTP 接口（简要）
  GET  /api/health              健康检查（无需登录）
  POST /api/auth/login          登录
  *    /api/sessions            会话 CRUD
  WS   /api/sessions/:id/attach 终端 WebSocket

平台说明
  • install / service 命令仅适用于单文件二进制（npm run build 产物）
  • macOS：service install 注册 LaunchAgent（~/Library/LaunchAgents/com.omas.plist）
  • Linux：service install 注册 systemd 用户服务（~/.config/systemd/user/omas.service）
  • Linux 系统级：sudo omas service install --system

更多信息
  docs/MANUAL.md    完整使用手册
  DEPLOY.md         生产部署与 nginx 配置
  README.md         项目简介与开发说明
`.trim();

export const SERVE_DESCRIPTION =
  '启动 Web 终端 HTTP/WebSocket 服务。省略子命令时 omas 默认执行 serve。';

export const INIT_DESCRIPTION =
  '交互式设置登录密码，写入 config.json（需 TTY）。服务注册前建议先执行 init。';

export const PASSWD_DESCRIPTION =
  '交互式修改已持久化 config.json 中的登录密码（需 TTY，且 config 已存在）。';

export const INSTALL_DESCRIPTION =
  '将当前单文件二进制复制到 PATH 目录（默认 /usr/local/bin 或 ~/.local/bin）。';

export const SERVICE_DESCRIPTION =
  '将 omas 注册为后台服务：Linux 使用 systemd，macOS 使用 launchd。';

export const SERVICE_INSTALL_DESCRIPTION =
  '生成 unit/plist 文件，默认立即 enable 并启动服务。需已 init 或自行在 unit 中配置密码。';

export const SERVICE_UNINSTALL_DESCRIPTION =
  '停止、disable 并删除 unit/plist 文件。';
