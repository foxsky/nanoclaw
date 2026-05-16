import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Encodes the tf-mcontrol runtime contract (MCPSubprocessClient): spawn
 * `bun taskflow-server-entry.ts --db <path>`, wait for the literal
 * `MCP server ready` on stderr, then speak MCP JSON-RPC over stdio.
 *
 * The intent (not just behavior): the FastAPI subprocess must get the
 * TaskFlow tool surface ONLY — never the full nanoclaw barrel (a
 * `send_message`/self-mod leak would let the API impersonate the agent).
 */
const ENTRY = join(import.meta.dir, 'taskflow-server-entry.ts');
const AGENT_RUNNER_ROOT = join(import.meta.dir, '..', '..');

function rpc(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  predicate: (acc: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let acc = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const next = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), Math.max(1, remaining)),
        ),
      ]);
      if (next.done) break;
      if (next.value) acc += dec.decode(next.value, { stream: true });
      if (predicate(acc)) return acc;
    }
  } finally {
    reader.releaseLock();
  }
  return acc;
}

describe('taskflow-server-entry (tf-mcontrol runtime contract)', () => {
  it('starts with --db, emits "MCP server ready", registers taskflow tools only (no full barrel)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-entry-'));
    const dbPath = join(dir, 'taskflow.db');
    const proc = Bun.spawn(['bun', ENTRY, '--db', dbPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: AGENT_RUNNER_ROOT,
    });
    try {
      // Gap 1 + 2: emits the exact sentinel tf-mcontrol waits for, after
      // opening the --db path without error.
      const ready = await readUntil(
        proc.stderr,
        (a) => a.includes('MCP server ready'),
        20000,
      );
      expect(ready).toContain('MCP server ready');

      proc.stdin.write(
        rpc({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '0' },
          },
        }),
      );
      await proc.stdin.flush();
      await readUntil(proc.stdout, (a) => a.includes('"id":1'), 10000);

      proc.stdin.write(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      proc.stdin.write(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
      await proc.stdin.flush();

      const out = await readUntil(proc.stdout, (a) => a.includes('"id":2'), 10000);
      const line = out
        .split('\n')
        .find((l) => l.includes('"id":2') && l.includes('tools'));
      expect(line, 'tools/list response not received').toBeTruthy();
      const names: string[] = JSON.parse(line as string).result.tools.map(
        (t: { name: string }) => t.name,
      );

      // Gap 3: taskflow surface present, full-barrel surface absent.
      expect(names).toContain('api_create_simple_task');
      expect(names).not.toContain('send_message');

      // R2.7(b): the WhatsApp-agent-only admin/hierarchy surface is
      // imported transitively (via taskflow-api-mutate) but MUST be
      // allowlisted OUT of the FastAPI subprocess — unlisted...
      expect(names).not.toContain('api_admin');
      expect(names).not.toContain('api_hierarchy');
      expect(names).toContain('api_update_board');
      expect(names).toContain('api_create_board');

      // ...AND uncallable (server.ts resolves tools/call from toolMap
      // directly — the allowlist must gate the call path too).
      proc.stdin.write(
        rpc({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'api_admin', arguments: {} },
        }),
      );
      await proc.stdin.flush();
      const out3 = await readUntil(proc.stdout, (a) => a.includes('"id":3'), 10000);
      const line3 = out3.split('\n').find((l) => l.includes('"id":3'));
      expect(line3, 'tools/call response not received').toBeTruthy();
      const callTxt: string =
        JSON.parse(line3 as string).result?.content?.[0]?.text ?? '';
      expect(callTxt).toContain('Unknown tool');

      // Positive: an ALLOWLISTED tool still EXECUTES through the gate
      // (a gate inversion that blocked allowed names would otherwise
      // pass). api_update_board on a nonexistent board → the handler's
      // structured not_found, NOT "Unknown tool". Also exercises
      // verbatim-ids: the plain (non-`board-`) id must reach the engine
      // unrewritten (handler looks up exactly 'nope-uuid').
      proc.stdin.write(
        rpc({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'api_update_board',
            arguments: { board_id: 'nope-uuid', name: 'X' },
          },
        }),
      );
      await proc.stdin.flush();
      const out4 = await readUntil(proc.stdout, (a) => a.includes('"id":4'), 10000);
      const line4 = out4.split('\n').find((l) => l.includes('"id":4'));
      expect(line4, 'allowlisted tools/call response not received').toBeTruthy();
      const okTxt: string =
        JSON.parse(line4 as string).result?.content?.[0]?.text ?? '';
      // Proves the handler RAN (gate didn't over-block): a structured
      // {success:false,error_code} envelope, not the gate's plain
      // "Unknown tool" text. (The tmp db is schemaless so the exact
      // code is internal_error/not_found — don't over-couple to it.)
      expect(okTxt).not.toContain('Unknown tool');
      const okResp = JSON.parse(okTxt);
      expect(okResp.success).toBe(false);
      expect(typeof okResp.error_code).toBe('string');
    } finally {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);
});
