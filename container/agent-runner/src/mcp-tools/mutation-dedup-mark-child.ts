/**
 * Test fixture — NOT a production entrypoint, NOT a test (`*.test.ts` only).
 *
 * Spawned by mutation-dedup.test.ts's CROSS-PROCESS describe as a genuinely
 * separate `bun` process: it points the outbound DB at the caller-supplied
 * path and calls the REAL markDeterministicMutationEmitted(), then exits.
 * The parent process re-opens the same file and consumes the flag — proving
 * the SQLite-file dedup primitive crosses true OS process boundaries (Codex
 * gate P-Audit-2).
 */
import { initOutboundDb } from '../db/connection.js';
import { markDeterministicMutationEmitted } from './mutation-dedup.js';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: mutation-dedup-mark-child.ts <outbound-db-path>');
  process.exit(1);
}

initOutboundDb(dbPath);
markDeterministicMutationEmitted();
process.exit(0);
