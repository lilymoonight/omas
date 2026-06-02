# Security Policy

omas 提供**真实 Shell 访问**。部署不当等同于把本机终端暴露到网络上。请在启用前阅读本文。

## 威胁模型

omas 面向 **自托管** 场景，支持单用户或受信任的小团队多用户：

- 单用户模式：一个共享密码保护所有 Web 会话
- 多用户模式（OS 级，可选）：每个账号用应用层 argon2id 密码登录（独立于系统密码），可映射到真实 UNIX 用户；服务以 root 运行时，会话 / Git / 文件操作降权到该 UNIX 用户，由内核文件权限做隔离。普通用户只见自己的会话，管理员可见全部
- 通过 omas 登录的用户可创建 PTY、读写其运行身份权限内的文件系统（含 Git 工作区）
- 历史页只**读取**本机 AI 工具数据目录，不向第三方发送

**仍不适合**：面向公众的多租户 SaaS、互不信任的匿名用户共享同一实例、无 TLS 的公网暴露。多用户隔离依赖 OS 文件权限，**不是**对抗本地提权 / 内核漏洞的强隔离边界——多用户仅适用于**彼此基本可信**的团队成员。

## 默认安全行为

| 项 | 行为 |
|----|------|
| 监听地址 | 默认 `127.0.0.1`（仅本机） |
| 认证 | 可通过 `omas init` / `--password` / `OMAS_PASSWORD` 启用；未配置时本地开发可无密码 |
| Cookie | 登录后会话 cookie；HTTPS 部署时需正确设置 `X-Forwarded-Proto` |
| 暴力破解 | 登录接口带速率限制 |

## 部署建议

1. **永远不要**将无密码的 omas 直接绑定 `0.0.0.0` 暴露公网。
2. 对外访问必须经 **nginx / Caddy** 等做 TLS 终结，并转发 WebSocket。见 [DEPLOY.md](./DEPLOY.md)。
3. 使用强密码；生产环境优先 `omas init` 持久化到配置目录。
4. 通过 SSH 隧道或 VPN 访问往往比公网暴露更安全。
5. 若使用 **ai-safe** 恢复 AI 会话，沙箱策略由 `ai-safe` 本身定义，请单独审查。

## 文件系统与 Git API

已认证用户可通过 API 读写 omas 进程用户权限内的路径（文件树、Git 编辑）。omas **不会** sandbox Shell 命令。不要在 omas 以 root 运行的同时给不可信用户访问。

## 报告漏洞

如果你发现安全问题，请 **不要** 公开 Issue。

请通过 GitHub Security Advisories 私下报告：

https://github.com/lilymoonight/omas/security/advisories/new

或在无法使用该入口时，向仓库 Owner 私信说明复现步骤与影响范围。

我们会在确认后尽快回复，并在修复发布后于 [CHANGELOG.md](./CHANGELOG.md) 中致谢（除非你要求匿名）。

## 依赖

发布二进制内嵌 Bun 运行时与前端静态资源。第三方依赖见 `package.json`；Release 构建在 GitHub Actions 中完成，可从 [Actions](https://github.com/lilymoonight/omas/actions) 审计 workflow。
