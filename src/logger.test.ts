import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from './logger.js';

describe('logger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('does not throw when logging an object with a circular reference', () => {
    // Baileys passes internal objects (sockets, auth state) to its logger.
    // Those frequently contain circular refs — the logger must not crash
    // on them, since a throw in log() would propagate through Baileys
    // and kill the connection.
    const circular: Record<string, unknown> = { name: 'ws' };
    circular.self = circular;

    expect(() => logger.info({ socket: circular }, 'websocket event')).not.toThrow();

    const out = stdoutChunks.join('');
    expect(out).toContain('websocket event');
    expect(out).toContain('socket');
  });

  it('serializes non-circular objects normally', () => {
    logger.info({ foo: 'bar', n: 42 }, 'hello');
    const out = stdoutChunks.join('');
    expect(out).toContain('hello');
    expect(out).toContain('"bar"');
    expect(out).toContain('42');
  });
});
