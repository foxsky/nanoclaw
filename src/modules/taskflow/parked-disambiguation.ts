/**
 * RC5-ext inbound — cross-board disambiguation parking (host side, in-memory).
 *
 * When an external's active meeting grants span MORE THAN ONE board, the host
 * must not route their DM into a guessed board (that would leak one board's
 * inbound to another's agent). Instead it sends a numbered "which board?"
 * prompt back to the external and parks the pending choice here; the external's
 * next reply selects a board and is consumed host-side (never forwarded).
 *
 * In-memory is sufficient and minimal: the host is a single Node process, the
 * state is short-lived (TTL), and losing it on restart only means the external
 * is re-prompted. Keyed to the exact DM messaging_group id. The stored choices
 * are display context only — board selection is re-validated against the
 * external's CURRENT grants at selection time (the resolver re-resolves the DM
 * every turn), so a stale parked entry can never authorize a revoked board.
 */
export interface ParkedChoice {
  boardId: string;
  groupJid: string;
  label: string;
}

interface ParkedEntry {
  externalId: string;
  choices: ParkedChoice[];
  /** Set once the external picks a board; subsequent messages route there
   *  (re-validated against live grants) instead of re-prompting. */
  chosen: ParkedChoice | null;
  expiresAt: number; // epoch ms
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes

const parked = new Map<string, ParkedEntry>();

export function parkDisambiguation(dmMgId: string, externalId: string, choices: ParkedChoice[]): void {
  parked.set(dmMgId, { externalId, choices, chosen: null, expiresAt: Date.now() + TTL_MS });
}

/**
 * Record the external's board selection and refresh the TTL. Keeps the existing
 * externalId/choices. No-op if the entry vanished (expired between turns).
 */
export function bindParkedChoice(dmMgId: string, externalId: string, choice: ParkedChoice): void {
  const entry = parked.get(dmMgId);
  if (!entry || entry.externalId !== externalId) return;
  entry.chosen = choice;
  entry.expiresAt = Date.now() + TTL_MS;
}

/**
 * Return the live parked entry for this DM mg, or null if absent/expired. An
 * expired entry is evicted on read. `externalId` must match — a parked entry is
 * bound to the external it was created for (defense against a re-keyed mg).
 */
export function getParkedDisambiguation(dmMgId: string, externalId: string): ParkedEntry | null {
  const entry = parked.get(dmMgId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    parked.delete(dmMgId);
    return null;
  }
  if (entry.externalId !== externalId) return null;
  return entry;
}

export function clearParkedDisambiguation(dmMgId: string): void {
  parked.delete(dmMgId);
}

/** Test-only: drop all parked state. */
export function _resetParkedDisambiguation(): void {
  parked.clear();
}

/**
 * Parse a board selection from the external's reply. Deterministic (NOT a model
 * call — this is routing): a leading 1-based index into `choices`. Returns the
 * selected choice or null if the reply doesn't name a valid index.
 */
export function parseDisambiguationChoice(text: string, choices: ParkedChoice[]): ParkedChoice | null {
  const m = text.trim().match(/^(\d{1,2})\b/);
  if (!m) return null;
  const idx = parseInt(m[1], 10) - 1;
  if (idx < 0 || idx >= choices.length) return null;
  return choices[idx];
}

/**
 * Build a stable, numbered prompt + the matching ordered choices from an
 * external's per-board grants. Ordered by groupJid so the numbering is stable
 * between the prompt and the selection turn.
 */
export function buildDisambiguationChoices(
  grants: Array<{ boardId: string; groupJid: string; groupFolder: string }>,
): ParkedChoice[] {
  const byBoard = new Map<string, ParkedChoice>();
  for (const g of grants) {
    if (!byBoard.has(g.boardId)) {
      byBoard.set(g.boardId, { boardId: g.boardId, groupJid: g.groupJid, label: g.groupFolder });
    }
  }
  return [...byBoard.values()].sort((a, b) => a.groupJid.localeCompare(b.groupJid));
}

export function renderDisambiguationPrompt(choices: ParkedChoice[]): string {
  const lines = choices.map((c, i) => `${i + 1}. ${c.label}`);
  return `You have meetings on more than one team. Which one is this about? Reply with the number:\n${lines.join('\n')}`;
}
