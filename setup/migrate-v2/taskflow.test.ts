import { describe, expect, it } from 'vitest';

import { activeV1Unit, parseSystemctlShow, pickInstallPath, unitServesInstall } from './taskflow.js';

// Real `systemctl show nanoclaw --property=ActiveState --property=WorkingDirectory
// --property=ExecStart` output shape (captured from a live unit). ExecStart's value
// itself contains '=' signs, so the parser must split on the FIRST '=' only.
const SHOW_ACTIVE_ROOT = [
  'ExecStart={ path=/bin/node ; argv[]=/bin/node /root/nanoclaw/dist/index.js ; ignore_errors=no ; pid=123 }',
  'WorkingDirectory=/root/nanoclaw',
  'ActiveState=active',
].join('\n');

describe('parseSystemctlShow', () => {
  it('parses each property, keeping ExecStart values that contain "="', () => {
    const props = parseSystemctlShow(SHOW_ACTIVE_ROOT);
    expect(props.ActiveState).toBe('active');
    expect(props.WorkingDirectory).toBe('/root/nanoclaw');
    expect(props.ExecStart).toContain('argv[]=/bin/node /root/nanoclaw/dist/index.js');
  });

  it('returns an empty map for empty output', () => {
    expect(parseSystemctlShow('')).toEqual({});
  });
});

describe('pickInstallPath', () => {
  it('uses WorkingDirectory when set', () => {
    expect(pickInstallPath({ WorkingDirectory: '/home/x/nanoclaw' })).toBe('/home/x/nanoclaw');
  });

  // Spaces must survive verbatim — the old ExecStart-argv fallback truncated them and
  // produced a silent false-negative (allowed the copy while v1 was live).
  it('returns a spaced WorkingDirectory verbatim (no truncation)', () => {
    expect(pickInstallPath({ WorkingDirectory: '/home/my user/nanoclaw' })).toBe('/home/my user/nanoclaw');
  });

  it('returns null when WorkingDirectory is empty — caller refuses (safe default)', () => {
    expect(pickInstallPath({ ExecStart: 'argv[]=/bin/node /root/nanoclaw/dist/index.js' })).toBeNull();
  });

  it('returns null for a "/" WorkingDirectory (systemd default → safe default)', () => {
    expect(pickInstallPath({ WorkingDirectory: '/' })).toBeNull();
  });

  it('returns null when WorkingDirectory is absent', () => {
    expect(pickInstallPath({ ActiveState: 'active' })).toBeNull();
  });
});

describe('unitServesInstall', () => {
  it('matches when the install dir equals v1Path', () => {
    expect(unitServesInstall('/srv/nanoclaw', '/srv/nanoclaw')).toBe(true);
  });

  it('matches when the unit path (ExecStart script) is inside v1Path', () => {
    expect(unitServesInstall('/srv/nanoclaw/dist/index.js', '/srv/nanoclaw')).toBe(true);
  });

  it('does NOT match a different install tree', () => {
    expect(unitServesInstall('/root/nanoclaw', '/tmp/v1-live-20260531')).toBe(false);
  });

  it('matches a spaced install path against itself', () => {
    expect(unitServesInstall('/home/my user/nanoclaw', '/home/my user/nanoclaw')).toBe(true);
  });

  it('treats an unknown (null) install path as serving — the safe default (refuse)', () => {
    expect(unitServesInstall(null, '/anything')).toBe(true);
  });
});

describe('activeV1Unit', () => {
  it('refuses when an active unit serves v1Path (the real-cutover case)', () => {
    const d = activeV1Unit([{ scope: 'system', state: 'active', installPath: '/srv/v1' }], '/srv/v1');
    expect(d.active).toBe(true);
    expect(d.how).toContain('serves /srv/v1');
  });

  // THE FIX: an active `nanoclaw` unit pointing at a DIFFERENT install must not block a
  // migration whose source is a snapshot/copy elsewhere. The old name-only probe refused.
  it('does NOT refuse when the only active unit serves a different install', () => {
    const d = activeV1Unit([{ scope: 'system', state: 'active', installPath: '/root/nanoclaw' }], '/tmp/v1-live');
    expect(d.active).toBe(false);
  });

  it('refuses on an active unit whose install path is unconfirmed (no false negative)', () => {
    const d = activeV1Unit([{ scope: 'system', state: 'active', installPath: null }], '/srv/v1');
    expect(d.active).toBe(true);
    expect(d.how).toContain('unconfirmed');
  });

  it('ignores inactive units', () => {
    const d = activeV1Unit([{ scope: 'user', state: 'inactive', installPath: null }], '/srv/v1');
    expect(d.active).toBe(false);
  });

  it('catches the v1 unit even when another scope serves elsewhere (multi-scope host)', () => {
    const d = activeV1Unit(
      [
        { scope: 'user', state: 'active', installPath: '/home/dev/nanoclaw-v2-checkout' },
        { scope: 'system', state: 'active', installPath: '/srv/v1' },
      ],
      '/srv/v1',
    );
    expect(d.active).toBe(true);
    expect(d.how).toContain('system');
  });

  it('treats transitional states (activating) as dangerous', () => {
    const d = activeV1Unit([{ scope: 'system', state: 'activating', installPath: '/srv/v1' }], '/srv/v1');
    expect(d.active).toBe(true);
  });

  // Regression for the truncation false-negative: a spaced install path that serves
  // v1Path must still refuse (now safe because the path comes from WorkingDirectory).
  it('refuses on a spaced install path that serves v1Path', () => {
    const d = activeV1Unit([{ scope: 'system', state: 'active', installPath: '/home/my user/nanoclaw' }], '/home/my user/nanoclaw');
    expect(d.active).toBe(true);
  });
});
