import { describe, it, expect, vi } from 'vitest';

// Mock baileys downloadMediaMessage
vi.mock('@whiskeysockets/baileys', () => ({
  downloadMediaMessage: vi.fn(),
  normalizeMessageContent: (msg: any) => msg,
}));

describe('media module', () => {
  it('detects image messages', async () => {
    const { isMediaMessage, getMediaType } = await import('../add/src/media.js');
    const imgMsg = { message: { imageMessage: { mimetype: 'image/jpeg' } } };
    expect(isMediaMessage(imgMsg as any)).toBe(true);
    expect(getMediaType(imgMsg as any)).toBe('image');
  });

  it('detects document messages', async () => {
    const { isMediaMessage, getMediaType } = await import('../add/src/media.js');
    const docMsg = { message: { documentMessage: { mimetype: 'application/pdf', fileName: 'itinerary.pdf' } } };
    expect(isMediaMessage(docMsg as any)).toBe(true);
    expect(getMediaType(docMsg as any)).toBe('document');
  });

  it('returns false for text-only messages', async () => {
    const { isMediaMessage } = await import('../add/src/media.js');
    const textMsg = { message: { conversation: 'hello' } };
    expect(isMediaMessage(textMsg as any)).toBe(false);
  });

  it('rejects documents with disallowed MIME types', async () => {
    const { isMediaMessage } = await import('../add/src/media.js');
    const exeMsg = { message: { documentMessage: { mimetype: 'application/x-executable', fileName: 'malware.exe' } } };
    expect(isMediaMessage(exeMsg as any)).toBe(false);
    const zipMsg = { message: { documentMessage: { mimetype: 'application/zip', fileName: 'archive.zip' } } };
    expect(isMediaMessage(zipMsg as any)).toBe(false);
    const unknownMsg = { message: { documentMessage: { mimetype: 'application/octet-stream', fileName: 'data.bin' } } };
    expect(isMediaMessage(unknownMsg as any)).toBe(false);
    // text/plain excluded — prompt injection risk
    const txtMsg = { message: { documentMessage: { mimetype: 'text/plain', fileName: 'notes.txt' } } };
    expect(isMediaMessage(txtMsg as any)).toBe(false);
  });

  it('rejects images with non-bitmap MIME types', async () => {
    const { isMediaMessage } = await import('../add/src/media.js');
    // SVG can contain JavaScript
    const svgMsg = { message: { imageMessage: { mimetype: 'image/svg+xml' } } };
    expect(isMediaMessage(svgMsg as any)).toBe(false);
    // TIFF is oversized and rarely useful
    const tiffMsg = { message: { imageMessage: { mimetype: 'image/tiff' } } };
    expect(isMediaMessage(tiffMsg as any)).toBe(false);
    // Case-insensitive — valid MIME should still work
    const jpegMsg = { message: { imageMessage: { mimetype: 'Image/JPEG' } } };
    expect(isMediaMessage(jpegMsg as any)).toBe(true);
  });

  it('sanitizes path traversal in filenames', async () => {
    const { downloadAndSaveMedia } = await import('../add/src/media.js');
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    (downloadMediaMessage as any).mockResolvedValue(Buffer.from('data'));
    const msg = {
      key: { id: 'msg456' },
      message: { documentMessage: { mimetype: 'application/pdf', fileName: '../../../etc/passwd' } },
    };
    const result = await downloadAndSaveMedia(msg as any, '/tmp/test-media', {} as any);
    expect(result).not.toContain('..');
    expect(result).toMatch(/\/tmp\/test-media\//);
    if (result) { (await import('fs')).unlinkSync(result); }
  });

  it('rejects oversized files via fileLength pre-check', async () => {
    const { downloadAndSaveMedia } = await import('../add/src/media.js');
    const msg = {
      key: { id: 'big1' },
      message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 30 * 1024 * 1024 } },
    };
    const result = await downloadAndSaveMedia(msg as any, '/tmp/test-media', {} as any);
    expect(result).toBeNull();
  });

  it('downloads and saves media to group folder', async () => {
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    const { downloadAndSaveMedia } = await import('../add/src/media.js');
    const fs = await import('fs');

    (downloadMediaMessage as any).mockResolvedValue(Buffer.from('fake-image-data'));

    const msg = {
      key: { id: 'msg123' },
      message: { imageMessage: { mimetype: 'image/jpeg' } },
    };

    const result = await downloadAndSaveMedia(msg as any, '/tmp/test-media', {} as any);

    expect(result).toMatch(/\/tmp\/test-media\/msg123\.jpeg$/);
    expect(fs.existsSync(result!)).toBe(true);

    // Cleanup
    fs.unlinkSync(result!);
  });
});
