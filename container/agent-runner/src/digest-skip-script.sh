#!/usr/bin/env bash
# Digest skip-if-no-activity script
# On Fridays, checks if any user messages arrived since the weekly review ran.
# If no new activity, outputs wakeAgent:false to skip the redundant digest.
# On other days, always wakes the agent.
set -euo pipefail

cat > /tmp/digest-skip.js << 'SCRIPT_EOF'
const TZ_OFFSET_HOURS = -3; // America/Fortaleza

const now = new Date();
const localHour = now.getUTCHours() + TZ_OFFSET_HOURS;
const adjustedNow = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600000);
const dow = adjustedNow.getDay(); // 0=Sun, 5=Fri

// Only check on Fridays
if (dow !== 5) {
  console.log(JSON.stringify({ wakeAgent: true }));
  process.exit(0);
}

// On Friday: check if any user messages since ~4 hours ago (review window)
const fs = require("fs");
const MESSAGES_DB = "/workspace/project/store/messages.db";

if (!fs.existsSync(MESSAGES_DB)) {
  // Can't check — wake agent to be safe
  console.log(JSON.stringify({ wakeAgent: true }));
  process.exit(0);
}

const Database = require("better-sqlite3");
const msgDb = new Database(MESSAGES_DB, { readonly: true });

// Get this group's chat_jid from the env
const chatJid = process.env.NANOCLAW_CHAT_JID;
if (!chatJid) {
  msgDb.close();
  console.log(JSON.stringify({ wakeAgent: true }));
  process.exit(0);
}

// Check for user messages in the last 4 hours (covers the gap between review and digest)
const fourHoursAgo = new Date(now.getTime() - 4 * 3600000).toISOString();
const row = msgDb.prepare(
  "SELECT COUNT(*) as count FROM messages WHERE chat_jid = ? AND is_bot_message = 0 AND timestamp > ?"
).get(chatJid, fourHoursAgo);

msgDb.close();

if (row.count === 0) {
  // No user activity since review — skip digest
  console.error("[digest-skip] Friday: no user activity in last 4h, skipping digest");
  console.log(JSON.stringify({ wakeAgent: false }));
} else {
  console.log(JSON.stringify({ wakeAgent: true }));
}
SCRIPT_EOF

NODE_PATH=/app/node_modules node /tmp/digest-skip.js
