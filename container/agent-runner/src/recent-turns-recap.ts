import Database from 'better-sqlite3';
import * as fs from 'node:fs';

interface MessageRow {
  timestamp: string;
  sender_name: string | null;
  sender: string | null;
  is_from_me: number;
  is_bot_message: number;
  content: string;
}

export interface GetRecentVerbatimTurnsOptions {
  messagesDbPath?: string;
  maxAgeMinutes?: number;
  maxTurns?: number;
  maxCharsPerLine?: number;
  /**
   * Exclude messages with timestamp >= this ISO string. Default:
   * `Date.now() - 5_000`, which skips the message currently being
   * processed (it just landed in messages.db).
   */
  excludeFrom?: string;
  locale?: string;
  timezone?: string;
}

/**
 * Read the most recent user/bot messages from messages.db for a chat_jid
 * and render them as a compact verbatim recap. Closes the gap between
 * the latest async-summarized rollup (which can lag rapid-fire turns by
 * minutes) and the message currently being processed.
 *
 * 2026-04-23 SETD case: the bot offered "Deseja que eu crie um?" at
 * 22:30:09; user replied "Sim" 44s later at 22:30:53; the next turn's
 * summary recap ended at 22:27 because Ollama hadn't rolled up the
 * 22:29/22:30 exchange yet, so the bot lost its own offer.
 */
export function getRecentVerbatimTurns(
  chatJid: string,
  options: GetRecentVerbatimTurnsOptions = {},
): string | null {
  const messagesDbPath =
    options.messagesDbPath ?? '/workspace/store/messages.db';
  if (!chatJid || !fs.existsSync(messagesDbPath)) return null;

  const maxAge = options.maxAgeMinutes ?? 15;
  const maxTurns = options.maxTurns ?? 12;
  const maxLineChars = options.maxCharsPerLine ?? 200;
  const excludeFrom =
    options.excludeFrom ?? new Date(Date.now() - 5_000).toISOString();
  const locale = options.locale ?? 'pt-BR';
  const timezone = options.timezone ?? process.env.TZ ?? 'America/Fortaleza';

  const cutoff = new Date(Date.now() - maxAge * 60_000).toISOString();

  const db = new Database(messagesDbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT timestamp, sender_name, sender, is_from_me, is_bot_message, content
         FROM messages
         WHERE chat_jid = ?
           AND timestamp > ?
           AND timestamp < ?
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(chatJid, cutoff, excludeFrom, maxTurns) as MessageRow[];

    if (rows.length === 0) return null;

    rows.reverse();

    const lines = rows.map((row) => {
      const time = new Date(row.timestamp).toLocaleTimeString(locale, {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      // Bot label is gated on is_bot_message=1 specifically. is_from_me=1
      // alone covers any echo from the linked phone — including a human
      // operator typing from a shared bot account — which would mislabel
      // operator messages as "Bot" and confuse the agent.
      const role =
        row.is_bot_message === 1
          ? 'Bot'
          : row.sender_name || row.sender || 'User';
      let content = (row.content || '').replace(/\s+/g, ' ').trim();
      if (content.length > maxLineChars) {
        content = content.slice(0, maxLineChars) + '…';
      }
      return `[${time}] ${role}: ${content}`;
    });

    return `--- Recent turns (last ${maxAge} min) ---\n${lines.join('\n')}\n---`;
  } finally {
    db.close();
  }
}
