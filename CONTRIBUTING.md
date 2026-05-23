# Contributing

感谢考虑为 omas 贡献代码。本项目聚焦 **AI 辅助开发者的自托管 Shell 控制台**，PR 与此目标越一致，越容易合并。

## 开始前

1. 阅读 [README.md](./README.md) 与 [docs/AI-WORKFLOW.md](./docs/AI-WORKFLOW.md) 了解产品边界
2. 大改动请先开 Issue 讨论，避免与维护方向冲突
3. 安全相关问题请走 [SECURITY.md](./SECURITY.md)，不要公开 Issue

## 开发环境

要求：**Node.js ≥ 22**

```bash
git clone https://github.com/lilymoonight/omas.git && cd omas
npm install

# 终端 1：API + WebSocket
OMAS_PASSWORD=devpass npm run dev:server

# 终端 2：前端（代理 /api 到 :7681）
npm run dev:web
```

```bash
npm test              # 单元 + PTY 集成测试
npm run typecheck     # tsc + svelte-check
```

生产交付物始终是 `npm run build` 产出的 **`release/omas`** 单文件二进制，不是 `tsx` / `node dist/...`。

## 代码约定

- **TypeScript**（服务端）、**Svelte 5**（前端）
- 与现有文件风格一致：小改动、少抽象、注释只解释非显而易见的逻辑
- PTY / 平台相关改动请考虑 **Node 与 Bun** 双后端，以及 **Linux / macOS**
- 用户可见文案优先中文（与现有 UI 一致）

## 测试

- 行为变更请附带或更新 `tests/` 下用例
- PTY 相关可用 `tests/pty.integration.test.ts`；纯逻辑用 `*.unit.test.ts`
- 发版前确保 `npm test` 与 `npm run typecheck` 通过

## 提交与 PR

- 提交信息：简短中文或英文均可，说明 **为什么** 改
- PR 描述：问题背景、方案、如何验证
- 若涉及 UI，请说明截图或操作步骤（无需正式截图也可文字描述）

## 发版（维护者）

维护者发版流程：

1. 在 [CHANGELOG.md](./CHANGELOG.md) 的 `[Unreleased]` 下记录变更，并新增 `## [X.Y.Z] - 日期` 段落
2. Commit → `git tag vX.Y.Z` → `git push origin master && git push origin vX.Y.Z`
3. GitHub Actions 自动测试、四架构构建、从 CHANGELOG 提取 Release 说明

## 方向参考

欢迎的方向：

- AI CLI 新来源的历史扫描与恢复命令
- 文件树 / Git / 终端联动体验
- PTY、UTF-8、远程部署可靠性
- 文档与无障碍

通常 **不会** 合并：

- 把 omas 做成通用 PaaS / 多租户平台
- 内置 AI Agent 或 LLM 调用
- 与核心工作流无关的大功能堆叠

## License

贡献即表示你同意以 [MIT](./LICENSE) 许可发布你的贡献。
