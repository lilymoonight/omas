import { describe, it, expect } from 'vitest';
import { renderSystemdUnit, renderLaunchdPlist } from '../src/server/cli/service.js';

describe('service unit files', () => {
  const base = {
    binary: '/usr/local/bin/omas',
    host: '127.0.0.1',
    port: 7681,
    configDir: '/home/alice/.config/oh-my-agent-shell',
  };

  it('renders a user systemd unit', () => {
    const unit = renderSystemdUnit({ ...base, scope: 'user' });
    expect(unit).toContain('ExecStart=/usr/local/bin/omas serve');
    expect(unit).toContain('--config-dir /home/alice/.config/oh-my-agent-shell');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('ReadWritePaths=');
  });

  it('renders a system systemd unit', () => {
    const unit = renderSystemdUnit({ ...base, scope: 'system' });
    expect(unit).toContain('WantedBy=multi-user.target');
    expect(unit).not.toContain('ReadWritePaths=');
  });

  it('renders a launchd plist', () => {
    const plist = renderLaunchdPlist(base);
    expect(plist).toContain('<string>com.omas</string>');
    expect(plist).toContain('<string>/usr/local/bin/omas</string>');
    expect(plist).toContain('<string>serve</string>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>EnvironmentVariables</key>');
    expect(plist).toContain('<key>LANG</key>');
  });
});
