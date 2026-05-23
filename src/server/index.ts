#!/usr/bin/env node
import { Command } from 'commander';
import { createServer } from './server.js';
import { logger } from './logger.js';
import { runInit, runPasswd } from './cli/init.js';
import { runInstall } from './cli/install.js';
import { runServiceInstall, runServiceUninstall } from './cli/service.js';
import {
  VERSION,
  ROOT_SUMMARY,
  ROOT_DESCRIPTION,
  ROOT_HELP_AFTER,
  SERVE_DESCRIPTION,
  INIT_DESCRIPTION,
  PASSWD_DESCRIPTION,
  INSTALL_DESCRIPTION,
  SERVICE_DESCRIPTION,
  SERVICE_INSTALL_DESCRIPTION,
  SERVICE_UNINSTALL_DESCRIPTION,
} from './cli/help-text.js';

const program = new Command();

program
  .name('omas')
  .summary(ROOT_SUMMARY)
  .description(ROOT_DESCRIPTION)
  .version(VERSION, '-V, --version', '显示版本号')
  .helpOption('-?, --help', '显示此帮助')
  .configureHelp({
    sortSubcommands: true,
    sortOptions: true,
    subcommandTerm: (cmd) => `${cmd.name()}${cmd.alias() ? '|' + cmd.alias() : ''}`,
  })
  .showHelpAfterError('（加上 --help 查看用法）')
  .addHelpText('after', `\n${ROOT_HELP_AFTER}\n`);

program
  .command('serve', { isDefault: true })
  .summary('启动 Web 终端服务')
  .description(SERVE_DESCRIPTION)
  .option('-p, --port <port>', '监听端口', '7681')
  .option('-h, --host <host>', '监听地址（公网请用 0.0.0.0 且前置 TLS 代理）', '127.0.0.1')
  .option('--shell <shell>', '新会话默认 Shell（默认 $SHELL → /bin/bash → /bin/sh）')
  .option('--cwd <dir>', '新会话默认工作目录（也可用 OMAS_CWD 或 config.json 的 defaultCwd）')
  .option('--config-dir <dir>', '配置目录（默认 ~/.config/oh-my-agent-shell）')
  .option('--max-sessions <n>', '最大并发会话数', '50')
  .option('--scrollback-bytes <n>', '每会话 scrollback 字节数', '524288')
  .option('--password <pw>', '登录密码（仅内存，ps 可见，适合本地调试）')
  .option('--password-file <path>', '从文件读取密码（仅内存，比 --password 更安全）')
  .addHelpText(
    'after',
    `
示例:
  OMAS_PASSWORD=secret omas serve
  omas serve --port 8080 --cwd ~/projects/my-app
  omas serve --password-file /run/omas/password

默认启动目录: --cwd > OMAS_CWD > config.json defaultCwd > 启动 omas 时的 process.cwd()
`.trim(),
  )
  .action(async (opts) => {
    const { app } = await createServer({
      host: opts.host,
      port: parseInt(opts.port, 10),
      shell: opts.shell,
      cwd: opts.cwd,
      configDir: opts.configDir,
      maxSessions: parseInt(opts.maxSessions, 10),
      scrollbackBytes: parseInt(opts.scrollbackBytes, 10),
      passwordInline: opts.password,
      passwordFile: opts.passwordFile,
    });
    const addr = await app.listen({ host: opts.host, port: parseInt(opts.port, 10) });
    logger.info({ addr }, 'omas listening');
  });

program
  .command('init')
  .summary('初始化登录密码配置文件')
  .description(INIT_DESCRIPTION)
  .option('--config-dir <dir>', '配置目录（默认 ~/.config/oh-my-agent-shell）')
  .option('--force', '覆盖已存在的 config.json')
  .addHelpText('after', '示例: omas init\n        omas init --config-dir /var/lib/omas/config --force')
  .action(async (opts) => {
    await runInit({ configDir: opts.configDir, force: opts.force });
  });

program
  .command('passwd')
  .summary('修改登录密码')
  .description(PASSWD_DESCRIPTION)
  .option('--config-dir <dir>', '配置目录（默认 ~/.config/oh-my-agent-shell）')
  .addHelpText('after', '示例: omas passwd\n        omas passwd --config-dir /var/lib/omas/config')
  .action(async (opts) => {
    await runPasswd({ configDir: opts.configDir });
  });

program
  .command('install')
  .summary('安装二进制到 PATH')
  .description(INSTALL_DESCRIPTION)
  .option('--prefix <dir>', '目标目录（默认可写则 /usr/local/bin，否则 ~/.local/bin）')
  .option('--name <name>', '安装后的命令名', 'omas')
  .option('--alias <name>', '额外创建符号链接别名')
  .option('--no-alias', '不创建别名')
  .option('--force', '覆盖已存在的同名文件')
  .addHelpText(
    'after',
    `
示例:
  ./release/omas install --prefix ~/.local/bin
  sudo ./release/omas install --prefix /usr/local/bin --force

说明: 仅单文件二进制可用（npm run build → release/omas）
`.trim(),
  )
  .action((opts) => {
    runInstall({
      prefix: opts.prefix,
      name: opts.name,
      alias: opts.noAlias ? false : opts.alias,
      force: opts.force,
    });
  });

const service = program
  .command('service')
  .summary('注册 / 卸载后台服务')
  .description(SERVICE_DESCRIPTION)
  .addHelpText(
    'after',
    `
子命令:
  install     写入 systemd unit 或 launchd plist，默认立即启动
  uninstall   停止并删除 unit / plist

平台:
  Linux (用户)  ~/.config/systemd/user/omas.service
  Linux (系统)  /etc/systemd/system/omas.service   需 sudo + --system
  macOS         ~/Library/LaunchAgents/com.omas.plist

完整说明: docs/MANUAL.md#注册系统服务
`.trim(),
  );

service
  .command('install')
  .summary('注册并启动后台服务')
  .description(SERVICE_INSTALL_DESCRIPTION)
  .option('-p, --port <port>', '监听端口', '7681')
  .option('-h, --host <host>', '监听地址', '127.0.0.1')
  .option('--config-dir <dir>', '配置目录（默认 ~/.config/oh-my-agent-shell）')
  .option('--cwd <dir>', '新会话默认工作目录')
  .option('--binary <path>', '要运行的 omas 路径（默认：当前可执行文件）')
  .option('--system', 'Linux 系统级 systemd（需 root；macOS 不支持）')
  .option('--no-start', '只写 unit/plist，不 enable / 不启动')
  .option('--force', '覆盖已有 unit/plist')
  .addHelpText(
    'after',
    `
示例:
  omas init
  omas service install
  omas service install --port 8080 --force
  sudo omas service install --system
  omas service install --no-start --binary /usr/local/bin/omas
`.trim(),
  )
  .action((opts) => {
    if (opts.system && process.platform === 'darwin') {
      console.error('service install: macOS 仅支持用户级 LaunchAgent，不能使用 --system');
      process.exit(1);
    }
    runServiceInstall({
      host: opts.host,
      port: parseInt(opts.port, 10),
      configDir: opts.configDir,
      cwd: opts.cwd,
      binary: opts.binary,
      scope: opts.system ? 'system' : 'user',
      force: opts.force,
      startNow: opts.start !== false,
    });
  });

service
  .command('uninstall')
  .summary('卸载后台服务')
  .description(SERVICE_UNINSTALL_DESCRIPTION)
  .option('--system', '卸载 Linux 系统级服务（需 root）')
  .addHelpText(
    'after',
    `
示例:
  omas service uninstall
  sudo omas service uninstall --system
`.trim(),
  )
  .action((opts) => {
    runServiceUninstall({ scope: opts.system ? 'system' : 'user' });
  });

program.parseAsync().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
