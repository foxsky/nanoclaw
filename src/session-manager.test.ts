import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = path.join(os.tmpdir(), 'sm-stage-test-fixed');

// Root the host DATA_DIR at a throwaway temp dir so extractAttachmentFiles' fs writes
// (DATA_DIR/attachments source + DATA_DIR/v2-sessions/.../inbox dest) stay hermetic.
vi.mock('./config.js', async (orig) => ({ ...((await orig()) as object), DATA_DIR: TMP }));

const { extractAttachmentFiles, safeAttachmentSource } = await import('./session-manager.js');

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'attachments'), { recursive: true });
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('safeAttachmentSource (traversal guard)', () => {
  it('resolves a localPath under <data>/attachments', () => {
    expect(safeAttachmentSource(TMP, 'attachments/voice.ogg')).toBe(path.join(TMP, 'attachments', 'voice.ogg'));
  });
  it('rejects a path that escapes the attachments dir', () => {
    expect(safeAttachmentSource(TMP, 'attachments/../../etc/passwd')).toBeNull();
    expect(safeAttachmentSource(TMP, '../secret')).toBeNull();
    expect(safeAttachmentSource(TMP, 'v2-sessions/g/s/inbound.db')).toBeNull();
  });
});

describe('extractAttachmentFiles — native (localPath) attachment staging', () => {
  it('copies a host-downloaded attachment into the session inbox and rewrites localPath', () => {
    fs.writeFileSync(path.join(TMP, 'attachments', 'voice.ogg'), 'OGG-BYTES');
    const content = JSON.stringify({ text: 'voice', attachments: [{ type: 'audio', name: 'voice.ogg', localPath: 'attachments/voice.ogg' }] });

    const out = JSON.parse(extractAttachmentFiles('grp', 'sess', 'msg1', content));

    expect(out.attachments[0].localPath).toBe('inbox/msg1/voice.ogg');
    const staged = path.join(TMP, 'v2-sessions', 'grp', 'sess', 'inbox', 'msg1', 'voice.ogg');
    expect(fs.existsSync(staged)).toBe(true);
    expect(fs.readFileSync(staged, 'utf8')).toBe('OGG-BYTES');
  });

  it('skips (does not copy or rewrite) an attachment whose localPath escapes the attachments dir', () => {
    const content = JSON.stringify({ attachments: [{ type: 'audio', name: 'x', localPath: 'attachments/../../evil' }] });
    const out = JSON.parse(extractAttachmentFiles('grp', 'sess', 'msg2', content));
    expect(out.attachments[0].localPath).toBe('attachments/../../evil'); // untouched
    expect(fs.existsSync(path.join(TMP, 'v2-sessions', 'grp', 'sess', 'inbox', 'msg2'))).toBe(false);
  });

  it('still stages base64 data attachments (unchanged behavior)', () => {
    const content = JSON.stringify({ attachments: [{ name: 'note.txt', data: Buffer.from('hi').toString('base64') }] });
    const out = JSON.parse(extractAttachmentFiles('grp', 'sess', 'msg3', content));
    expect(out.attachments[0].localPath).toBe('inbox/msg3/note.txt');
    expect(out.attachments[0].data).toBeUndefined();
  });
});
