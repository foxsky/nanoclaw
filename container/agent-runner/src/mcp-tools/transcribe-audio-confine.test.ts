import { describe, expect, it } from 'bun:test';

import { isAllowedAttachmentPath, transcribeAudioTool } from './transcribe-audio.js';

// SECURITY regression (audit HIGH): transcribe_audio opens the path and ships bytes to an external
// API — an arbitrary-file-read + exfiltration primitive that the disallowed Read/Bash tools exist
// to remove. It must be confined to the host-written attachment dirs.
describe('transcribe_audio path confinement', () => {
  it('ALLOWS the host-written attachment dirs', () => {
    expect(isAllowedAttachmentPath('/workspace/inbox/abc123/voice.ogg')).toBe(true);
    expect(isAllowedAttachmentPath('/workspace/attachments/note.ogg')).toBe(true);
  });

  it('REJECTS sensitive paths, traversal, and absolute escapes', () => {
    expect(isAllowedAttachmentPath('/workspace/taskflow/taskflow.db')).toBe(false); // all boards!
    expect(isAllowedAttachmentPath('/workspace/agent/CLAUDE.local.md')).toBe(false); // agent memory
    expect(isAllowedAttachmentPath('/workspace/inbound.db')).toBe(false);
    expect(isAllowedAttachmentPath('/etc/passwd')).toBe(false);
    // `..` traversal out of the allowed dir is collapsed by resolve() before the prefix check:
    expect(isAllowedAttachmentPath('/workspace/inbox/../taskflow/taskflow.db')).toBe(false);
    expect(isAllowedAttachmentPath('/workspace/attachments/../../etc/passwd')).toBe(false);
  });

  it('the handler REFUSES a disallowed path without attempting the read/upload', async () => {
    const r = await transcribeAudioTool.handler({ path: '/workspace/taskflow/taskflow.db' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('restricted to delivered attachments'); // err() returns raw "Error: ..." text
  });
});
