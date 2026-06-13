/**
 * migrate-v2 step: sessions
 *
 * For each v1 session folder, create a proper v2 session:
 *   1. Create a sessions row in v2.db (via resolveSession)
 *   2. Initialize the session folder (inbound.db, outbound.db, outbox/)
 *   3. Write session routing so the container knows where to reply
 *   4. Copy v1 .claude/ state into v2's .claude-shared/ directory
 *
 * v1: data/sessions/<folder>/.claude/ (settings, conversation history, skills)
 * v2: data/v2-sessions/<agent_group_id>/.claude-shared/ + session folder
 *
 * v1's agent-runner-src/ is NOT copied — v2 uses a completely different
 * Bun-based agent-runner.
 *
 * Idempotent — reuses existing sessions and does not overwrite copied files,
 * EXCEPT conversation transcripts (the `refresh` copy), which are re-copied when
 * the v1 source has grown so a re-run can't resume a stale/truncated JSONL.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/sessions.ts <v1-path>
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../../src/config.js';
import { initDb, closeDb } from '../../src/db/connection.js';
import { getAllAgentGroups } from '../../src/db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from '../../src/db/messaging-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { resolveSession, writeSessionRouting, outboundDbPath } from '../../src/session-manager.js';

const SKIP_NAMES = new Set(['.DS_Store']);

/**
 * Recursively copy. By default never overwrites existing files. With `refresh`,
 * re-copies an append-only transcript (`*.jsonl`) ONLY when the destination is a
 * byte-for-byte PREFIX of the v1 source — i.e. the source is the same transcript
 * with more appended turns (the stale/truncated-resume case, Codex HIGH). Any
 * other relationship means the two diverged: once v2 is live it appends its own
 * turns, so the source is no longer a prefix even if it happens to be longer.
 * Overwriting then would drop v2-only turns — so keep the live v2 copy + warn.
 */
function copyTree(src: string, dst: string, opts: { refresh?: boolean } = {}): number {
  let written = 0;
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);

    if (entry.isDirectory()) {
      written += copyTree(s, d, opts);
      continue;
    }
    // Skip dangling symlinks (e.g. v1's .claude/debug/latest pointer).
    if (entry.isSymbolicLink() && !fs.existsSync(s)) continue;
    if (fs.existsSync(d)) {
      // Non-overwriting by default; refresh applies only to grown transcripts.
      if (!opts.refresh || !entry.name.endsWith('.jsonl')) continue;
      const srcBuf = fs.readFileSync(s);
      const dstBuf = fs.readFileSync(d);
      const grewFromPrefix = srcBuf.length > dstBuf.length && srcBuf.subarray(0, dstBuf.length).equals(dstBuf);
      if (!grewFromPrefix) {
        if (!srcBuf.equals(dstBuf)) {
          console.warn(`WARN:transcript ${d} diverged from its v1 source — keeping the live v2 copy, not overwriting.`);
        }
        continue;
      }
    }
    fs.copyFileSync(s, d);
    written += 1;
  }
  return written;
}

function main(): void {
  const v1Path = process.argv[2];
  if (!v1Path) {
    console.error('Usage: tsx setup/migrate-v2/sessions.ts <v1-path>');
    process.exit(1);
  }

  const v1SessionsDir = path.join(v1Path, 'data', 'sessions');
  if (!fs.existsSync(v1SessionsDir)) {
    // Non-zero so run_step routes to the skipped branch, not silent "success".
    console.log('SKIPPED:no v1 data/sessions/ directory');
    process.exit(1);
  }

  // Init v2 central DB
  const v2DbPath = path.join(DATA_DIR, 'v2.db');
  if (!fs.existsSync(v2DbPath)) {
    console.error('v2.db not found — run db step first');
    process.exit(1);
  }

  const v2Db = initDb(v2DbPath);
  runMigrations(v2Db);

  const agentGroups = getAllAgentGroups();
  const folderToAg = new Map<string, { id: string; folder: string }>();
  for (const ag of agentGroups) {
    folderToAg.set(ag.folder, ag);
  }

  // Authoritative v1 active session per folder, from v1's `sessions` table
  // (group_folder PRIMARY KEY → session_id). This is the source of truth for
  // which conversation to resume. The JSONL-mtime sort below is unreliable —
  // copyTree (fs.copyFileSync) clobbers mtimes on copy, so a group with many
  // JSONL files would otherwise resume an arbitrary old conversation. Falls
  // back to the mtime sort only when the table has no row (older v1).
  const v1ActiveSession = new Map<string, string>();
  const v1MsgDbPath = path.join(v1Path, 'store', 'messages.db');
  if (fs.existsSync(v1MsgDbPath)) {
    const v1Db = new Database(v1MsgDbPath, { readonly: true, fileMustExist: true });
    try {
      const hasSessions = v1Db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
      if (hasSessions) {
        for (const r of v1Db.prepare('SELECT group_folder, session_id FROM sessions').all() as Array<{
          group_folder: string;
          session_id: string;
        }>) {
          if (r.group_folder && r.session_id) v1ActiveSession.set(r.group_folder, r.session_id);
        }
      }
    } finally {
      v1Db.close();
    }
  }

  let sessionsCreated = 0;
  let sessionsReused = 0;
  let sessionsSkipped = 0;
  let filesCopied = 0;

  for (const entry of fs.readdirSync(v1SessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = entry.name;

    const ag = folderToAg.get(folder);
    if (!ag) {
      sessionsSkipped++;
      continue;
    }

    // Find the messaging groups wired to this agent group
    const messagingGroups = getMessagingGroupsByAgentGroup(ag.id);
    if (messagingGroups.length === 0) {
      sessionsSkipped++;
      continue;
    }

    // Create a session for each messaging group (v1 had one session per
    // folder, v2 has one per agent_group + messaging_group pair)
    for (const mg of messagingGroups) {
      const { session, created } = resolveSession(ag.id, mg.id, null, 'shared');

      if (created) {
        // Write routing so the container knows where to reply
        writeSessionRouting(ag.id, session.id);
        sessionsCreated++;
      } else {
        sessionsReused++;
      }
    }

    // Copy v1 .claude/ state into v2's .claude-shared/ directory
    // This is per-agent-group, shared across all sessions for that group
    const v1ClaudeDir = path.join(v1SessionsDir, folder, '.claude');
    if (fs.existsSync(v1ClaudeDir)) {
      try {
        const v2ClaudeDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared');
        filesCopied += copyTree(v1ClaudeDir, v2ClaudeDir);

        // v1 containers worked in /workspace/group, v2 works in /workspace/agent.
        // Claude Code stores sessions under projects/<hashed-cwd>/. Copy v1's
        // project dir to the v2 agent path so Claude Code finds the conversation
        // history. Source it from v1's REAL project dir — NOT the .claude-shared
        // copy the bulk copyTree above made, which is non-overwriting and goes
        // stale when v1 appends to the active JSONL between runs. `refresh`
        // re-copies grown transcripts so a re-run resumes the full conversation,
        // and a brand-new active session's JSONL is picked up too (not stranded).
        const projectsDir = path.join(v2ClaudeDir, 'projects');
        const v1SourceProjectDir = path.join(v1ClaudeDir, 'projects', '-workspace-group');
        const v2ProjectDir = path.join(projectsDir, '-workspace-agent');
        if (fs.existsSync(v1SourceProjectDir)) {
          filesCopied += copyTree(v1SourceProjectDir, v2ProjectDir, { refresh: true });
        }

        // Write the v1 Claude Code session ID as the continuation in outbound.db
        // so the agent-runner resumes the exact same conversation.
        // The session ID is the JSONL filename (without extension) under the
        // project dir.
        const sourceDir = fs.existsSync(v2ProjectDir) ? v2ProjectDir : v1SourceProjectDir;
        const jsonlFiles = fs.existsSync(sourceDir)
          ? fs.readdirSync(sourceDir).filter((f) => f.endsWith('.jsonl'))
          : [];
        // Authoritative: the v1 sessions table says which session is active. Use
        // it when its JSONL was actually copied. Otherwise fall back to the mtime
        // sort (unreliable — copyTree clobbers mtimes — but the only option for v1
        // installs without a sessions row). Fail loud whenever the table named an
        // active session we can't actually resume.
        const authoritative = v1ActiveSession.get(folder);
        let v1SessionId: string | undefined;
        if (authoritative && jsonlFiles.includes(`${authoritative}.jsonl`)) {
          v1SessionId = authoritative;
        } else if (jsonlFiles.length > 0) {
          if (authoritative) {
            console.error(
              `ERROR:session ${folder}: v1 active session ${authoritative} has no copied JSONL — resuming best-effort by mtime`,
            );
          }
          v1SessionId = jsonlFiles
            .map((f) => ({
              name: f.replace('.jsonl', ''),
              mtime: fs.statSync(path.join(sourceDir, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime)[0].name;
        } else if (authoritative) {
          // The table named an active session but NO JSONL history was copied —
          // nothing to resume; surface it rather than start silently fresh.
          console.error(
            `ERROR:session ${folder}: v1 active session ${authoritative} but no JSONL history copied — continuation not set`,
          );
        }

        if (v1SessionId) {
          // Write into each v2 session's outbound.db for this agent group
          const sessions = getMessagingGroupsByAgentGroup(ag.id);
          for (const mg of sessions) {
            const { session } = resolveSession(ag.id, mg.id, null, 'shared');
            const obPath = outboundDbPath(ag.id, session.id);
            if (fs.existsSync(obPath)) {
              const ob = new Database(obPath);
              ob.prepare(
                "INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES ('continuation:claude', ?, ?)",
              ).run(v1SessionId, new Date().toISOString());
              ob.close();
            }
          }
        }
      } catch (err) {
        // An unreadable/locked session dir must degrade THIS folder only —
        // not hard-fail the whole step and strand every other session.
        console.error(`ERROR:session ${folder}: failed to copy v1 .claude state — ${(err as Error).message}`);
      }
    }
  }

  closeDb();

  console.log(`OK:created=${sessionsCreated},reused=${sessionsReused},skipped=${sessionsSkipped},files=${filesCopied}`);
}

main();
