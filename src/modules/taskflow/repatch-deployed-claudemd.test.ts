import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { repatchDeployedClaudeMd } from './repatch-deployed-claudemd.js';

// The exact pre-#398 stale relay prose the migrate-board-claudemd patcher rewrites
// (migrate-board-claudemd.ts:451). A deployed CLAUDE.local.md rendered before the
// fix carries this; re-running the patcher must replace it in place.
const STALE =
  '**Engine notifications are delivery instructions, not prose you rewrite.** `notifications` and `parent_notification` come preformatted from the engine. Relay them only when they target a different chat/JID; if the target is null, missing, or the current group, keep the result in your normal reply instead of creating a duplicate `send_message`.';

const AGENT_MEMORY = '\n\n## CLAUDE.local.md (agent memory)\n- Thiago prefers PT-BR\n- Project X is urgent\n';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repatch-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedBoard(folder: string, body: string): string {
  const g = path.join(dir, folder);
  fs.mkdirSync(g, { recursive: true });
  const f = path.join(g, 'CLAUDE.local.md');
  fs.writeFileSync(f, body);
  return f;
}

describe('repatchDeployedClaudeMd (#404 cutover runner)', () => {
  it('rewrites the stale v1 relay prose in a deployed CLAUDE.local.md and preserves agent memory', () => {
    const f = seedBoard('seci-taskflow', `# Board\n\n${STALE}${AGENT_MEMORY}`);
    const report = repatchDeployedClaudeMd(dir, { write: true });

    const after = fs.readFileSync(f, 'utf8');
    expect(after).not.toContain('delivery instructions, not prose you rewrite');
    // The patcher's #398 replacement text is now present.
    expect(after).toContain('delivered by the host');
    // Agent-appended memory is untouched.
    expect(after).toContain('Thiago prefers PT-BR');
    expect(after).toContain('Project X is urgent');

    const changed = report.find((r) => r.path === f);
    expect(changed?.changed).toBe(true);
  });

  it('is idempotent — a second run over already-patched files changes nothing', () => {
    seedBoard('seci-taskflow', `# Board\n\n${STALE}`);
    repatchDeployedClaudeMd(dir, { write: true });
    const second = repatchDeployedClaudeMd(dir, { write: true });
    expect(second.every((r) => r.changed === false)).toBe(true);
  });

  it('dry-run (write:false) reports what WOULD change without writing', () => {
    const f = seedBoard('seci-taskflow', `# Board\n\n${STALE}`);
    const before = fs.readFileSync(f, 'utf8');
    const report = repatchDeployedClaudeMd(dir, { write: false });
    expect(report.find((r) => r.path === f)?.changed).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe(before); // not written
  });

  it('skips group folders without a CLAUDE.local.md and reports nothing for them', () => {
    fs.mkdirSync(path.join(dir, 'no-claude-here'), { recursive: true });
    seedBoard('seci-taskflow', `# Board\n\n${STALE}`);
    const report = repatchDeployedClaudeMd(dir, { write: false });
    expect(report.map((r) => r.path)).toEqual([path.join(dir, 'seci-taskflow', 'CLAUDE.local.md')]);
  });
});
