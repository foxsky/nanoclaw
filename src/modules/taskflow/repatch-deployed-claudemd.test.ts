import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { repatchDeployedClaudeMd } from './repatch-deployed-claudemd.js';

const STALE =
  '**Engine notifications are delivery instructions, not prose you rewrite.** `notifications` and `parent_notification` come preformatted from the engine. Relay them only when they target a different chat/JID; if the target is null, missing, or the current group, keep the result in your normal reply instead of creating a duplicate `send_message`.';

// Agent free-text memory that DELIBERATELY contains the tokens the FULL patcher's
// blanket renames would rewrite (taskflow_create, target_chat_jid). The safe
// runner must leave these untouched — that's the whole point of the revert+rebuild.
const AGENT_MEMORY =
  '\n\n## CLAUDE.local.md (agent memory)\n' +
  '- History: we used to call `taskflow_create` and pass `target_chat_jid` to send_message.\n' +
  '- Thiago prefers PT-BR; Project X is urgent.\n';

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

describe('repatchDeployedClaudeMd (#404 — safe relay-prose-only re-patch)', () => {
  it('rewrites the stale relay prose AND leaves agent memory (incl. taskflow_*/target_chat_jid tokens) untouched', () => {
    const f = seedBoard('seci-taskflow', `# Board\n\n${STALE}${AGENT_MEMORY}`);
    repatchDeployedClaudeMd(dir, { write: true });
    const after = fs.readFileSync(f, 'utf8');

    // The relay prose IS fixed:
    expect(after).not.toContain('delivery instructions, not prose you rewrite');
    expect(after).toContain('delivered by the host');
    // The agent memory survives VERBATIM — NO blanket renames (the corruption the
    // reverted full-patcher runner risked):
    expect(after).toContain('`taskflow_create`');
    expect(after).toContain('`target_chat_jid`');
    expect(after).toContain('Thiago prefers PT-BR; Project X is urgent.');
  });

  it('is idempotent — a second run changes nothing', () => {
    seedBoard('seci-taskflow', `# Board\n\n${STALE}`);
    repatchDeployedClaudeMd(dir, { write: true });
    expect(repatchDeployedClaudeMd(dir, { write: true }).every((r) => r.changed === false)).toBe(true);
  });

  it('dry-run (write:false) reports what would change without writing', () => {
    const f = seedBoard('seci-taskflow', `# Board\n\n${STALE}`);
    const before = fs.readFileSync(f, 'utf8');
    expect(repatchDeployedClaudeMd(dir, { write: false }).find((r) => r.path === f)?.changed).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe(before);
  });

  it('reports changed:false for a board with no stale prose (already clean)', () => {
    const f = seedBoard('new-taskflow', `# Board\n\n${AGENT_MEMORY}`);
    expect(repatchDeployedClaudeMd(dir, { write: true }).find((r) => r.path === f)?.changed).toBe(false);
  });

  it('skips group folders without a CLAUDE.local.md', () => {
    fs.mkdirSync(path.join(dir, 'no-claude-here'), { recursive: true });
    seedBoard('seci-taskflow', `# Board\n\n${STALE}`);
    expect(repatchDeployedClaudeMd(dir, { write: false }).map((r) => r.path)).toEqual([
      path.join(dir, 'seci-taskflow', 'CLAUDE.local.md'),
    ]);
  });
});
