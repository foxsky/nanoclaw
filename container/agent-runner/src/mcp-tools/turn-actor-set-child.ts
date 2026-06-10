/**
 * Test fixture — NOT a production entrypoint, NOT a test (`*.test.ts` only).
 *
 * Spawned by turn-actor.test.ts's CROSS-PROCESS describe as a genuinely
 * separate `bun` process: it points the outbound DB at the caller-supplied
 * path and calls the REAL setTurnActor() with the remaining argv as the
 * batch's senders, then exits. The parent process re-opens the same file and
 * reads the actor — proving the session_state actor channel crosses true OS
 * process boundaries (the MCP tools run as a separate subprocess from the
 * poll-loop, so a module global would never propagate).
 */
import { initOutboundDb } from '../db/connection.js';
import { setTurnActor } from './turn-actor.js';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: turn-actor-set-child.ts <outbound-db-path> <sender...>');
  process.exit(1);
}

initOutboundDb(dbPath);
setTurnActor(process.argv.slice(3));
process.exit(0);
