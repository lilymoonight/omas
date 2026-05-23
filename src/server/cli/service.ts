import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfigDir } from '../config.js';
import { resolveUtf8Locale } from '../pty/locale.js';
import { requireSingleBinary } from './shared.js';

const SERVICE_NAME = 'omas';
const LAUNCHD_LABEL = 'com.omas';

export type ServiceScope = 'user' | 'system';

export type ServiceInstallOpts = {
  host?: string;
  port?: number;
  configDir?: string;
  cwd?: string;
  binary?: string;
  scope?: ServiceScope;
  force?: boolean;
  startNow?: boolean;
};

export type ServiceUninstallOpts = {
  scope?: ServiceScope;
};

export type ServiceUnitOpts = {
  binary: string;
  host: string;
  port: number;
  configDir: string;
  cwd?: string;
  scope: ServiceScope;
};

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function run(cmd: string, args: string[]): { ok: boolean; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  const stderr = (r.stderr ?? '').trim();
  if (r.error) return { ok: false, stderr: r.error.message };
  return { ok: r.status === 0, stderr };
}

function platformKind(): 'linux' | 'darwin' {
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'darwin') return 'darwin';
  console.error('service: unsupported platform (Linux systemd or macOS launchd only).');
  process.exit(2);
}

function defaultScope(): ServiceScope {
  return process.getuid?.() === 0 ? 'system' : 'user';
}

function systemdUnitPath(scope: ServiceScope): string {
  if (scope === 'system') return `/etc/systemd/system/${SERVICE_NAME}.service`;
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

function launchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function renderSystemdUnit(opts: ServiceUnitOpts): string {
  const execParts = [
    shellQuote(opts.binary),
    'serve',
    '--host', shellQuote(opts.host),
    '--port', String(opts.port),
    '--config-dir', shellQuote(opts.configDir),
  ];
  if (opts.cwd) execParts.push('--cwd', shellQuote(opts.cwd));
  const exec = execParts.join(' ');

  const wantedBy = opts.scope === 'system' ? 'multi-user.target' : 'default.target';
  const readWrite =
    opts.scope === 'user'
      ? `\nReadWritePaths=${shellQuote(opts.configDir)}`
      : '';

  return `[Unit]
Description=omas — self-hosted web terminal
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Environment=LANG=${shellQuote(resolveUtf8Locale())} LC_CTYPE=${shellQuote(resolveUtf8Locale())}
Restart=on-failure
RestartSec=2${readWrite}

[Install]
WantedBy=${wantedBy}
`;
}

export function renderLaunchdPlist(opts: Omit<ServiceUnitOpts, 'scope'>): string {
  const args = [
    opts.binary,
    'serve',
    '--host', opts.host,
    '--port', String(opts.port),
    '--config-dir', opts.configDir,
  ];
  if (opts.cwd) args.push('--cwd', opts.cwd);
  const argsXml = args.map((a) => `\n      <string>${escapeXml(a)}</string>`).join('');
  const logDir = path.join(os.tmpdir(), 'omas');
  const locale = resolveUtf8Locale();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${argsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LANG</key>
    <string>${escapeXml(locale)}</string>
    <key>LC_CTYPE</key>
    <string>${escapeXml(locale)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, 'stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, 'stderr.log'))}</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function writeFileAtomic(file: string, body: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode });
  fs.renameSync(tmp, file);
}

function ensureConfigHint(configDir: string): void {
  const cfg = path.join(configDir, 'config.json');
  if (fs.existsSync(cfg)) return;
  console.warn(`\n! no config at ${cfg}`);
  console.warn('  run `omas init` first (or set OMAS_PASSWORD in the unit/plist manually).\n');
}

function systemdCtl(scope: ServiceScope, args: string[]): { ok: boolean; stderr: string } {
  const base = scope === 'system' ? ['systemctl'] : ['systemctl', '--user'];
  return run(base[0], [...base.slice(1), ...args]);
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function runServiceInstall(opts: ServiceInstallOpts): void {
  const binary = path.resolve(opts.binary ?? requireSingleBinary('service install'));
  if (!fs.existsSync(binary)) {
    console.error(`service install: binary not found: ${binary}`);
    process.exit(1);
  }

  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 7681;
  const configDir = resolveConfigDir(opts.configDir);
  const scope = opts.scope ?? defaultScope();
  const kind = platformKind();

  ensureConfigHint(configDir);

  if (kind === 'linux') {
    const unitPath = systemdUnitPath(scope);
    if (fs.existsSync(unitPath) && !opts.force) {
      console.error(`service install: ${unitPath} already exists (pass --force to overwrite).`);
      process.exit(1);
    }
    if (scope === 'system' && process.getuid?.() !== 0) {
      console.error('service install: --system requires root (sudo omas service install --system).');
      process.exit(1);
    }

    const body = renderSystemdUnit({ binary, host, port, configDir, cwd: opts.cwd, scope });
    writeFileAtomic(unitPath, body, 0o644);
    console.log(`wrote ${unitPath}`);

    if (opts.startNow !== false) {
      const reload = systemdCtl(scope, ['daemon-reload']);
      if (!reload.ok) {
        console.warn(`could not daemon-reload: ${reload.stderr}`);
        printSystemdManual(scope, 'enable --now');
        return;
      }
      const enable = systemdCtl(scope, ['enable', '--now', SERVICE_NAME]);
      if (!enable.ok) {
        console.warn(`could not enable/start: ${enable.stderr}`);
        printSystemdManual(scope, 'enable --now');
        return;
      }
      console.log(`started ${SERVICE_NAME} (${scope} service)`);
      printSystemdStatus(scope, port);
    } else {
      printSystemdManual(scope, 'enable --now');
    }
    return;
  }

  // macOS launchd
  const plistPath = launchdPlistPath();
  if (fs.existsSync(plistPath) && !opts.force) {
    console.error(`service install: ${plistPath} already exists (pass --force to overwrite).`);
    process.exit(1);
  }

  fs.mkdirSync(path.join(os.tmpdir(), 'omas'), { recursive: true });
  const body = renderLaunchdPlist({ binary, host, port, configDir, cwd: opts.cwd });
  writeFileAtomic(plistPath, body, 0o644);
  console.log(`wrote ${plistPath}`);

  if (opts.startNow !== false) {
    const domain = launchdDomain();
    run('launchctl', ['bootout', domain, plistPath]); // ignore if not loaded
    const boot = run('launchctl', ['bootstrap', domain, plistPath]);
    if (!boot.ok) {
      const legacy = run('launchctl', ['load', '-w', plistPath]);
      if (!legacy.ok) {
        console.warn(`could not load service: ${boot.stderr || legacy.stderr}`);
        printLaunchdManual();
        return;
      }
    }
    run('launchctl', ['kickstart', '-k', `${domain}/${LAUNCHD_LABEL}`]);
    console.log(`started ${LAUNCHD_LABEL} (launchd user agent)`);
    printLaunchdManual(false);
  } else {
    printLaunchdManual();
  }
}

export function runServiceUninstall(opts: ServiceUninstallOpts): void {
  requireSingleBinary('service uninstall');
  const scope = opts.scope ?? defaultScope();
  const kind = platformKind();

  if (kind === 'linux') {
    const unitPath = systemdUnitPath(scope);
    if (scope === 'system' && process.getuid?.() !== 0) {
      console.error('service uninstall: --system requires root (sudo omas service uninstall --system).');
      process.exit(1);
    }
    systemdCtl(scope, ['disable', '--now', SERVICE_NAME]);
    systemdCtl(scope, ['daemon-reload']);
    if (fs.existsSync(unitPath)) {
      fs.unlinkSync(unitPath);
      console.log(`removed ${unitPath}`);
    } else {
      console.log(`no unit file at ${unitPath}`);
    }
    systemdCtl(scope, ['reset-failed', SERVICE_NAME]);
    return;
  }

  const plistPath = launchdPlistPath();
  const domain = launchdDomain();
  run('launchctl', ['bootout', domain, plistPath]);
  run('launchctl', ['unload', '-w', plistPath]);
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
    console.log(`removed ${plistPath}`);
  } else {
    console.log(`no plist at ${plistPath}`);
  }
}

function printSystemdManual(scope: ServiceScope, action: string): void {
  const prefix = scope === 'system' ? 'sudo systemctl' : 'systemctl --user';
  console.log(`\nnext steps:`);
  console.log(`  ${prefix} daemon-reload`);
  console.log(`  ${prefix} ${action} ${SERVICE_NAME}`);
  console.log(`  ${prefix} status ${SERVICE_NAME}`);
}

function printSystemdStatus(scope: ServiceScope, port: number): void {
  const prefix = scope === 'system' ? 'systemctl' : 'systemctl --user';
  console.log(`\n  ${prefix} status ${SERVICE_NAME}`);
  console.log(`  open http://127.0.0.1:${port}`);
}

function printLaunchdManual(showLoad = true): void {
  const plist = launchdPlistPath();
  if (showLoad) {
    console.log(`\nnext steps:`);
    console.log(`  launchctl bootstrap gui/$UID ${shellQuote(plist)}`);
    console.log(`  launchctl kickstart -k gui/$UID/${LAUNCHD_LABEL}`);
  }
  console.log(`  launchctl print gui/$UID/${LAUNCHD_LABEL}`);
  console.log(`  logs: ${path.join(os.tmpdir(), 'omas')}/`);
}
