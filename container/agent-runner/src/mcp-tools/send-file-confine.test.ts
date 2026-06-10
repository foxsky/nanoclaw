import { describe, expect, it } from 'bun:test';

import { isAllowedBoardSendFilePath, safeOutboxFilename } from './core.js';

// SEC#11 BLOCKER (whole-epic Codex xhigh): send_file copies a caller-supplied path into the
// outbox and delivers it to chat — an arbitrary-file-read + exfiltration primitive that the
// disallowed Read/Bash tools exist to remove. The #410 broadcast gate only inspects the
// DESTINATION, so a SAME-conversation send of /workspace/taskflow/taskflow.db (the cross-board
// DB, mounted RW) was never held. On a TaskFlow board, confine the SOURCE path to the dirs a
// board agent may legitimately send from: its own workspace + the host-written attachment dirs.
describe('send_file board path confinement', () => {
  it('ALLOWS the board agent workspace and host-written attachment dirs', () => {
    expect(isAllowedBoardSendFilePath('/workspace/agent/report.pdf')).toBe(true);
    expect(isAllowedBoardSendFilePath('/workspace/agent/charts/q2.png')).toBe(true);
    expect(isAllowedBoardSendFilePath('/workspace/inbox/abc123/photo.jpg')).toBe(true);
    expect(isAllowedBoardSendFilePath('/workspace/attachments/file.csv')).toBe(true);
  });

  it('REJECTS the cross-board DB, session DBs, agent memory, and absolute escapes', () => {
    expect(isAllowedBoardSendFilePath('/workspace/taskflow/taskflow.db')).toBe(false); // ALL boards!
    expect(isAllowedBoardSendFilePath('/workspace/inbound.db')).toBe(false);
    expect(isAllowedBoardSendFilePath('/workspace/outbound.db')).toBe(false);
    expect(isAllowedBoardSendFilePath('/workspace/global/secrets')).toBe(false);
    expect(isAllowedBoardSendFilePath('/workspace/agent/CLAUDE.local.md')).toBe(true); // memory IS in workspace — sendable
    expect(isAllowedBoardSendFilePath('/etc/passwd')).toBe(false);
    expect(isAllowedBoardSendFilePath('/app/dist/index.js')).toBe(false);
  });

  it('collapses `..` traversal before the prefix check', () => {
    expect(isAllowedBoardSendFilePath('/workspace/agent/../taskflow/taskflow.db')).toBe(false);
    expect(isAllowedBoardSendFilePath('/workspace/inbox/../../etc/passwd')).toBe(false);
    expect(isAllowedBoardSendFilePath('/workspace/agent/sub/../ok.txt')).toBe(true);
  });
});

// SEC#11 BLOCKER (Codex re-review): the outbox DISPLAY filename was also a write primitive —
// copyFileSync(src, join(outboxDir, filename)) with filename="../../taskflow/taskflow.db" would
// overwrite the shared cross-board DB. safeOutboxFilename forces a single basename segment.
describe('safeOutboxFilename', () => {
  it('keeps a plain display filename', () => {
    expect(safeOutboxFilename('report.pdf', '/workspace/agent/report.pdf')).toBe('report.pdf');
  });

  it('strips path components so the copy cannot escape the outbox dir', () => {
    expect(safeOutboxFilename('../../taskflow/taskflow.db', '/workspace/agent/x.png')).toBe('taskflow.db');
    expect(safeOutboxFilename('a/b/c.txt', '/workspace/agent/x.png')).toBe('c.txt');
    expect(safeOutboxFilename('/etc/passwd', '/workspace/agent/x.png')).toBe('passwd');
  });

  it('falls back to the source basename for degenerate names', () => {
    expect(safeOutboxFilename('..', '/workspace/agent/src.png')).toBe('src.png');
    expect(safeOutboxFilename('.', '/workspace/agent/src.png')).toBe('src.png');
    expect(safeOutboxFilename('', '/workspace/agent/src.png')).toBe('src.png');
    expect(safeOutboxFilename(undefined, '/workspace/agent/src.png')).toBe('src.png');
  });
});
