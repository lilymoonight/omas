#!/usr/bin/env node
import { Command } from 'commander';
import { createServer } from './server.js';
import { logger } from './logger.js';
import { runInit, runPasswd } from './cli/init.js';
import { runInstall } from './cli/install.js';
import { runConnect } from './cli/connect.js';
import { runExec, runUpload, runDownload } from './cli/agent.js';
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

/** Commander collector for repeatable `--flag value` options. */
function collectKeyVal(value: string, previous: string[]): string[] {
  return [...previous, value];
}

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
  .option(
    '--publish <slug=dir>',
    '发布目录为免密公开静态站点 /p/<slug>/（可重复）',
    collectKeyVal,
    [] as string[],
  )
  .option(
    '--publish-spa <slug=dir>',
    '同 --publish，但找不到文件时回退 index.html（适合 SPA，可重复）',
    collectKeyVal,
    [] as string[],
  )
  .option(
    '--sandbox-root <dir>',
    '开启沙箱：会话默认只读整个文件系统，仅其工作目录（须在此目录内）可写（Linux 用 bwrap / macOS 用 sandbox-exec）',
  )
  .option('--sandbox-no-net', '沙箱会话断网（默认共享主机网络）')
  .option('--sandbox-default-off', '新会话默认不沙箱（仍可逐个开启；解除需 bypass 口令）')
  .addHelpText(
    'after',
    `
示例:
  OMAS_PASSWORD=secret omas serve
  omas serve --port 8080 --cwd ~/projects/my-app
  omas serve --password-file /run/omas/password
  omas serve --publish report=./dist --publish-spa app=./build
  omas serve --sandbox-root /srv/agent     # 开启沙箱，可写区限制在 /srv/agent 下

公开站点: --publish 的目录挂在 /p/<slug>/，不需要密码即可访问，便于分享工作结果。
默认启动目录: --cwd > OMAS_CWD > config.json defaultCwd > 启动 omas 时的 process.cwd()
沙箱: --sandbox-root 开启后，每个会话只能写自己选定的工作目录（必须在该 root 内），其余只读。
      解除沙箱（全盘可写）需先用 \`omas passwd --bypass\` 设置独立口令。
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
      publish: opts.publish,
      publishSpa: opts.publishSpa,
      sandboxRoot: opts.sandboxRoot,
      sandboxNet: opts.sandboxNoNet ? false : undefined,
      sandboxDefault: opts.sandboxDefaultOff ? false : undefined,
    });
    const addr = await app.listen({ host: opts.host, port: parseInt(opts.port, 10) });
    logger.info({ addr }, 'omas listening');
  });

program
  .command('connect <url>')
  .summary('在本地终端连接远程 omas（像 ssh，不开浏览器）')
  .description(
    [
      '在本地终端里直接登录到运行 omas 的远程主机，体验类似 ssh，但完全复用 omas 现有的',
      'HTTP 鉴权 + WebSocket 终端协议——走域名已有的 TLS 反代即可，无需额外开端口。',
      '',
      '默认新建一个会话；也可 --session 附加到已有会话（与网页端共享、可互相接管）。',
      'Ctrl-] 断开（会话保留在后台），在 shell 里输入 exit 才会真正结束。',
    ].join('\n'),
  )
  .option('-s, --session <id>', '附加到已有会话（默认新建一个）')
  .option('-l, --list', '列出远程会话后退出')
  .option('--shell <shell>', '新会话使用的 Shell')
  .option('--cwd <dir>', '新会话的工作目录')
  .option('--password <pw>', '登录密码（也可用 OMAS_PASSWORD 或交互输入）')
  .option('--insecure', '跳过 TLS 证书校验（自签名证书时使用）')
  .addHelpText(
    'after',
    `
示例:
  omas connect example.com                 # https，交互输入密码
  OMAS_PASSWORD=secret omas connect example.com
  omas connect http://127.0.0.1:7681 --password dev
  omas connect example.com --list          # 列出会话
  omas connect example.com -s <会话id>     # 附加到已有会话
`.trim(),
  )
  .action(async (url, opts) => {
    try {
      await runConnect({
        url,
        session: opts.session,
        list: opts.list,
        shell: opts.shell,
        cwd: opts.cwd,
        password: opts.password,
        insecure: opts.insecure,
      });
    } catch (err) {
      console.error(`connect: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// Shared options for the agent-facing remote commands.
function addRemoteOpts(cmd: Command): Command {
  return cmd
    .option('-s, --session <id>', '复用已有会话作为工作区（默认按 --cwd 临时新建并用完销毁）')
    .option('--cwd <dir>', '工作区目录（临时会话的工作目录；沙箱开启时必须在 sandbox-root 内）')
    .option('--no-sandbox', '创建非沙箱会话（全盘可写，需配合 --bypass 口令）')
    .option('--bypass <pw>', '解除沙箱口令（仅配合 --no-sandbox；也可用 OMAS_BYPASS）')
    .option('--password <pw>', '登录密码（也可用 OMAS_PASSWORD 或交互输入）')
    .option('--insecure', '跳过 TLS 证书校验（自签名证书时使用）');
}

function remoteOptsFrom(url: string, opts: any) {
  return {
    url,
    session: opts.session,
    cwd: opts.cwd,
    // commander maps --no-sandbox to opts.sandbox === false
    noSandbox: opts.sandbox === false,
    bypass: opts.bypass ?? process.env.OMAS_BYPASS,
    password: opts.password,
    insecure: opts.insecure,
  };
}

addRemoteOpts(
  program
    .command('exec <url> [command...]')
    .summary('在远程主机的工作区里执行命令并取回输出（给本地 agent 用）')
    .description(
      [
        '把远程 omas 主机当算力：发送一条 shell 命令，在会话工作区（cwd）内执行并取回',
        'stdout/stderr 与退出码。沙箱开启时命令与会话同等受限（仅工作目录可写）。',
        '',
        '工作区就是磁盘上的真实目录：upload→exec→download 指向同一 --cwd 即可共享文件。',
      ].join('\n'),
    ),
)
  .option('--timeout <ms>', '命令超时毫秒数（默认 120000，最大 3600000）')
  .addHelpText(
    'after',
    `
示例:
  omas exec example.com --cwd /srv/agent/job1 -- "make && ./run"
  omas exec example.com -s <会话id> -- ls -la
  OMAS_PASSWORD=secret omas exec http://127.0.0.1:7681 --cwd /tmp/w -- python3 main.py
退出码与远程命令一致，便于脚本/agent 判断成功失败。
`.trim(),
  )
  .action(async (url, command, opts) => {
    try {
      await runExec({
        ...remoteOptsFrom(url, opts),
        command: (command as string[]).join(' '),
        timeoutMs: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
      });
    } catch (err) {
      console.error(`exec: ${(err as Error).message}`);
      process.exit(1);
    }
  });

addRemoteOpts(
  program
    .command('upload <url> <local> [remoteDir]')
    .summary('上传本地文件到远程工作区（自动分片，支持大文件）')
    .description('把本地文件上传到会话工作区（cwd）下的目录（默认根目录）。打印写入后的相对路径。'),
)
  .addHelpText(
    'after',
    `
示例:
  omas upload example.com ./main.py --cwd /srv/agent/job1
  omas upload example.com ./data.zip subdir -s <会话id>
`.trim(),
  )
  .action(async (url, local, remoteDir, opts) => {
    try {
      await runUpload({ ...remoteOptsFrom(url, opts), local, remoteDir });
    } catch (err) {
      console.error(`upload: ${(err as Error).message}`);
      process.exit(1);
    }
  });

addRemoteOpts(
  program
    .command('download <url> <remote> [local]')
    .summary('从远程工作区下载文件或目录（目录自动打包为 .tar.gz）')
    .description('从会话工作区（cwd）下载文件；remote 为相对路径。目录会以 tar.gz 形式下载。local 用 - 表示输出到 stdout。'),
)
  .addHelpText(
    'after',
    `
示例:
  omas download example.com result.txt ./result.txt --cwd /srv/agent/job1
  omas download example.com out/ . -s <会话id>     # 下载目录为 out.tar.gz
  omas download example.com log.txt - --cwd /tmp/w  # 输出到 stdout
`.trim(),
  )
  .action(async (url, remote, local, opts) => {
    try {
      await runDownload({ ...remoteOptsFrom(url, opts), remote, local });
    } catch (err) {
      console.error(`download: ${(err as Error).message}`);
      process.exit(1);
    }
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
  .option('--bypass', '设置“解除沙箱”口令（创建非沙箱会话时校验，必须区别于登录密码）')
  .addHelpText(
    'after',
    '示例: omas passwd\n        omas passwd --bypass            # 设置解除沙箱口令\n        omas passwd --config-dir /var/lib/omas/config',
  )
  .action(async (opts) => {
    await runPasswd({ configDir: opts.configDir, bypass: opts.bypass });
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
