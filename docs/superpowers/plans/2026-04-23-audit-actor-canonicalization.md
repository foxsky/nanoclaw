# Audit Actor Match (Read-Side Only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the ~98% `taskMutationFound: false` rate in Kipp's daily audit by fixing the actor-compare step on the read side only — no schema change, no write-path change, no engine risk.

**Architecture:** A single, inline, NFD-normalized actor resolver in the auditor heredoc. The resolver takes a string (either a display name, a `person_id`, or a phone-number-style sender) and an array of `boardIds`; returns a canonical `person_id` if `board_people` can reach it, else `null`. The matcher normalizes BOTH `mutation.by` and `msg.sender_name` through the resolver and compares. Unresolved actors fall through to a fixed `normalizeForCompare` path (same behavior as today). No `.ts` extraction, no `require`, no ESM/CJS coupling.

**Tech Stack:** Inline JS inside a bash heredoc (`auditor-script.sh`), `better-sqlite3`, plus one standalone ESM diagnostic script that runs outside the container. No vitest — the diagnostic script IS the test loop (measure before, apply, measure after, assert uplift).

**Load-bearing rule — MEASURE BEFORE BUILDING.** Task 1 is a gate. If the diagnostic shows the resolver lifts the pairable-write count by less than 50 % on live data, stop. The shape-mismatch hypothesis is wrong and we need a different theory.

---

## File Structure

- **Create:** `scripts/audit-actor-match-diagnostic.mjs` — standalone Node ESM. Opens `store/messages.db` + `data/taskflow/taskflow.db` (paths configurable via env), iterates a recent window, counts `sameActor`-matching mutations under (a) current logic and (b) proposed resolver. Emits a side-by-side report. Read-only.
- **Modify:** `container/agent-runner/src/auditor-script.sh` — patch the heredoc only. Add an inline resolver, replace the match block at L789-802 preserving the fall-through-to-task-ref-filter semantics, and log first-name-heuristic hits.
- **No changes to:** `taskflow-engine.ts`, any existing test file, any schema, any migration, any IPC plugin. Zero engine blast radius.

---

## Task 1 (GATE) — Diagnostic script: measure the uplift before shipping anything

**Files:**
- Create: `/root/nanoclaw/scripts/audit-actor-match-diagnostic.mjs`

**Why a gate:** Three prior skeptical reviews flagged that the 98 %→80 % uplift claim is unverified. Confounders (phone-number senders, diacritics, already-mixed `task_history.by` shape) mean the resolver could move the needle only 10 % instead of 80 %. Stop if it does.

- [ ] **Step 1: Write the diagnostic script**

```javascript
#!/usr/bin/env node
// Read-only diagnostic. Counts write-ish user messages in the given window
// and measures how many have a sameActor-matching task_history mutation in
// window under (a) the current auditor logic and (b) the proposed resolver.
//
// CRITICAL: WRITE_KEYWORDS / TERSE_PATTERN / isWriteRequest below are kept
// in sync with auditor-script.sh:87-113,251-254. If you change the live
// detection, update this script too — otherwise the diagnostic measures a
// different denominator than the live auditor.

import Database from 'better-sqlite3';

const MESSAGES_DB = process.env.MESSAGES_DB || '/root/nanoclaw/store/messages.db';
const TASKFLOW_DB = process.env.TASKFLOW_DB || '/root/nanoclaw/data/taskflow/taskflow.db';
const DAYS = Number(process.env.DAYS || 7);
const WINDOW_MS = 10 * 60 * 1000;

const nfd = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

// MIRRORS auditor-script.sh:87-96
const WRITE_KEYWORDS = [
  'concluir', 'concluída', 'concluido', 'finalizar', 'finalizado',
  'criar', 'adicionar', 'atribuir', 'aprovar', 'aprovada', 'aprovado',
  'descartar', 'cancelar', 'mover', 'adiar', 'renomear', 'alterar',
  'remover', 'em andamento', 'para aguardando', 'para revisão',
  'processar inbox', 'para inbox', 'nota', 'anotar', 'lembrar',
  'lembrete', 'prazo', 'próximo passo', 'próxima ação', 'descrição',
  'começando', 'comecando', 'aguardando', 'retomada', 'devolver',
  'done', 'feita', 'feito', 'pronta',
];
// MIRRORS auditor-script.sh:113
const TERSE_PATTERN = /^(?:(?:[A-Z]{2,}-)?(?:T|P|M|R)\S+|SEC-\S+)\s*(conclu|feita|feito|pronta|ok|aprovad|✅)/i;
// MIRRORS auditor-script.sh:251-254
function isWriteRequest(text) {
  const lower = String(text || '').toLowerCase();
  return WRITE_KEYWORDS.some((kw) => lower.includes(kw)) || TERSE_PATTERN.test(text);
}

function makeResolver(tfDb) {
  const exactName = tfDb.prepare(
    `SELECT person_id, name FROM board_people WHERE board_id = ?`,
  );
  // We load per-board people once and match in JS so we can NFD-normalize
  // (SQLite LOWER() is ASCII-only — diacritics leak through).
  const cache = new Map();
  let heuristicHits = 0;
  const resolve = (raw, boardIds) => {
    if (!raw) return null;
    const key = nfd(raw);
    if (!key) return null;
    for (const boardId of boardIds) {
      let people = cache.get(boardId);
      if (!people) {
        people = exactName.all(boardId);
        cache.set(boardId, people);
      }
      const exact = people.find((p) => nfd(p.name) === key || nfd(p.person_id) === key);
      if (exact) return exact.person_id;
      const first = key.split(/\s+/)[0];
      if (first) {
        const firstMatches = people.filter(
          (p) => nfd(p.name).split(/\s+/)[0] === first,
        );
        if (firstMatches.length === 1) {
          heuristicHits += 1;
          return firstMatches[0].person_id;
        }
      }
    }
    return null;
  };
  return { resolve, heuristicHits: () => heuristicHits };
}

function main() {
  const msgDb = new Database(MESSAGES_DB, { readonly: true });
  const tfDb = new Database(TASKFLOW_DB, { readonly: true });

  // ISO cutoff string — messages.timestamp and task_history.at are both
  // TEXT/ISO-Z, lexicographic comparison matches chronological order.
  const cutoffIso = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();

  // MIRRORS auditor-script.sh:481-498. Only TaskFlow-managed groups, then
  // resolve their boards by group_folder. Scanning `boards` directly would
  // include unmanaged rows like board-sec-taskflow.
  const groups = msgDb
    .prepare(
      `SELECT jid, name, folder FROM registered_groups WHERE taskflow_managed = 1`,
    )
    .all();
  const boardStmt = tfDb.prepare(
    `SELECT id, parent_board_id FROM boards WHERE group_folder = ?`,
  );

  const { resolve, heuristicHits } = makeResolver(tfDb);

  let totalWrites = 0;
  let writesWithAnyMutation = 0;
  let matchOld = 0;
  let matchNew = 0;

  for (const group of groups) {
    const board = boardStmt.get(group.folder);
    if (!board) continue;
    const boardIds = [board.id, board.parent_board_id].filter(Boolean);
    const placeholders = boardIds.map(() => '?').join(',');

    const msgs = msgDb
      .prepare(
        `SELECT id, chat_jid, timestamp, content, sender, sender_name
         FROM messages
         WHERE chat_jid = ?
           AND is_from_me = 0
           AND is_bot_message = 0
           AND content IS NOT NULL
           AND content <> ''
           AND timestamp >= ?`,
      )
      .all(group.jid, cutoffIso);

    const mutStmt = tfDb.prepare(
      `SELECT board_id, task_id, "by", at FROM task_history
       WHERE board_id IN (${placeholders}) AND at >= ? AND at <= ?`,
    );

    for (const m of msgs) {
      const content = m.content || '';
      if (!isWriteRequest(content)) continue;
      totalWrites += 1;

      // m.timestamp is ISO TEXT (e.g. "2026-04-22T18:30:12.000Z").
      // Convert to ms for window math, then back to ISO for the SQL filter
      // (task_history.at is also ISO TEXT, lexicographically comparable).
      const startMs = new Date(m.timestamp).getTime();
      if (!Number.isFinite(startMs)) continue;
      const endIso = new Date(startMs + WINDOW_MS).toISOString();
      const mutations = mutStmt.all(...boardIds, m.timestamp, endIso);
      if (mutations.length === 0) continue;
      writesWithAnyMutation += 1;

      const rawSender = m.sender_name || m.sender || '';
      const oldSenderKey = nfd(rawSender);
      const newSenderPid = resolve(rawSender, boardIds);
      const newSenderKey = newSenderPid ?? oldSenderKey;

      const hasOld = mutations.some((mut) => {
        if (!oldSenderKey || !mut.by) return false;
        return nfd(mut.by) === oldSenderKey;
      });
      const hasNew = mutations.some((mut) => {
        if (!newSenderKey || !mut.by) return false;
        const mutPid = resolve(mut.by, [mut.board_id, ...boardIds]);
        const mutKey = mutPid ?? nfd(mut.by);
        return mutKey === newSenderKey;
      });

      if (hasOld) matchOld += 1;
      if (hasNew) matchNew += 1;
    }
  }

  const pctOld = totalWrites ? ((matchOld / totalWrites) * 100).toFixed(1) : '0.0';
  const pctNew = totalWrites ? ((matchNew / totalWrites) * 100).toFixed(1) : '0.0';
  const uplift = matchNew - matchOld;
  const upliftPct = totalWrites ? ((uplift / totalWrites) * 100).toFixed(1) : '0.0';

  console.log(JSON.stringify({
    days: DAYS,
    totalWrites,
    writesWithAnyMutation,
    matchOld,
    matchNew,
    pctOld: `${pctOld}%`,
    pctNew: `${pctNew}%`,
    uplift,
    upliftPct: `${upliftPct}%`,
    firstNameHeuristicHits: heuristicHits(),
  }, null, 2));
}

main();
```

- [ ] **Step 2: Run it against local prod data (read-only)**

```bash
cd /root/nanoclaw
node scripts/audit-actor-match-diagnostic.mjs
```

If the DB paths are wrong for this install, override:
```bash
MESSAGES_DB=/path/to/messages.db TASKFLOW_DB=/path/to/taskflow.db DAYS=7 \
  node scripts/audit-actor-match-diagnostic.mjs
```

Expected shape:
```json
{
  "days": 7,
  "totalWrites": 140,
  "matchOld": 3,
  "matchNew": 115,
  "upliftPct": "80.0%",
  ...
}
```

- [ ] **Step 3: Decision gate**

The honest denominator is `writesWithAnyMutation` — the resolver cannot lift writes that have no mutation in window (those have nothing to pair with regardless). Use the pairable sub-population:

```
pairableUpliftPct = (matchNew - matchOld) / writesWithAnyMutation * 100
```

- **≥ 50 %:** hypothesis confirmed. Proceed to Task 2.
- **< 50 %:** STOP. Shape-mismatch is not the dominant cause. Report numbers and wait for direction.

Also look at `firstNameHeuristicHits`. If this is a large fraction of `matchNew`, the uplift is heuristic-driven and we need to decide whether to keep or drop the fallback before shipping.

Also assert `matchNew >= matchOld` — the v2.1 plan dropped the strict-superset theoretical claim, but empirically the resolver should never regress a pairing the raw compare accepted. If `matchNew < matchOld` on any board, investigate before shipping.

**Measured on prod snapshot (2026-04-23, 7-day window, 28 groups, scp'd from `nanoclaw@192.168.2.63`):**

```json
{
  "totalWrites": 178,
  "writesWithAnyMutation": 164,
  "matchOld": 36,
  "matchNew": 158,
  "pctOld_pairable": "22.0%",
  "pctNew_pairable": "96.3%",
  "pairableUpliftPct": "74.4%",
  "firstNameHeuristicHits": 3,
  "regressionBoards": 0
}
```

Per-board highlights: `asse-seci-taskflow` 1→57, `seci-taskflow` 1→32, `sec-secti` 0→13, `thiago-taskflow` 0→7. No board regressed. Gate passes by a wide margin.

Eliminated competing root causes during this verification:
- `task_history.at` format: uniformly `ISO-T-Z` on prod (325/325 in last 7 days). The mixed-format bug is a local-DB artifact only.
- Stale deploy: `md5sum` of `auditor-script.sh` matches across local and prod.
- `trigger_turn_id` rollout: resolver works regardless of column presence.
- Cross-board scope: resolver already passes `[mutation.board_id, ...boardIds]`; verified no orphaned mutations.

- [ ] **Step 4: Commit the diagnostic (whether or not we proceed)**

```bash
git add scripts/audit-actor-match-diagnostic.mjs
git commit -m "diag(audit): actor-match uplift measurement script"
```

The script is useful after shipping too, for monitoring drift.

---

## Task 2 — Inline resolver + fixed match block in the auditor heredoc

**Only run this task if Task 1's gate passed.**

**Files:**
- Modify: `container/agent-runner/src/auditor-script.sh` — two edits inside the heredoc.

- [ ] **Step 1: Add the inline resolver near `personNameByIdStmt`**

Locate `personNameByIdStmt` at `auditor-script.sh:662-664`. Immediately after line 664 (still inside the heredoc), insert:

```javascript
// --- Actor resolver: NFD-normalized name/person_id → canonical person_id. ---
// Symmetric with taskflow-engine.ts:resolvePerson but uses NFD (not LOWER())
// to handle diacritics correctly. Loads per-board people once, matches in JS.
const _boardPeopleStmt = tfDb.prepare(
  `SELECT person_id, name FROM board_people WHERE board_id = ?`
);
const _boardPeopleCache = new Map();
let _firstNameHeuristicHits = 0;
function _nfd(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}
function resolveActorToPersonId(rawName, boardIds) {
  if (!rawName) return null;
  const key = _nfd(rawName);
  if (!key) return null;
  for (const boardId of boardIds) {
    if (!boardId) continue;
    let people = _boardPeopleCache.get(boardId);
    if (!people) {
      people = _boardPeopleStmt.all(boardId);
      _boardPeopleCache.set(boardId, people);
    }
    const exact = people.find(
      (p) => _nfd(p.name) === key || _nfd(p.person_id) === key,
    );
    if (exact) return exact.person_id;
    const first = key.split(/\s+/)[0];
    if (first) {
      const firstMatches = people.filter(
        (p) => _nfd(p.name).split(/\s+/)[0] === first,
      );
      if (firstMatches.length === 1) {
        _firstNameHeuristicHits += 1;
        return firstMatches[0].person_id;
      }
    }
  }
  return null;
}
```

Notes on the design (not comments in code — rationale for the reviewer):
- NFD stripping is required because SQLite's `LOWER()` is ASCII-only; `Álvaro` vs `alvaro` leaks through otherwise (Agent C's diacritic finding).
- The resolver accepts `boardIds` as an array so cross-board mutations (parent-only people acting on child boards, shipped 2026-04-12) resolve correctly (Agent B's cross-board finding).
- The first-name fallback only fires when exactly one match exists on the board — matches the engine's `resolvePerson` L1348-1351 semantics and avoids the silent two-Carlos collision.
- `_firstNameHeuristicHits` is read at the end of the audit run for observability.

- [ ] **Step 2: Replace the match block at L789-802**

Before-state (auditor-script.sh:788-802):
```javascript
if (isWrite) {
  const mutations = taskHistoryStmt.all(...boardIds, msg.timestamp, tenMinLater);
  const actorKey = normalizeForCompare(msg.sender_name || msg.sender || '');
  const matchingMutations = mutations.filter((mutation) => {
    const sameActor = !actorKey || !mutation.by
      ? true
      : normalizeForCompare(mutation.by) === actorKey;
    if (!sameActor) return false;
    if (messageTaskRefs.size === 0) return true;
    return buildTaskIdAliases(
      mutation.task_id,
      mutation.board_id,
      boardShortCodes,
    ).some((alias) => messageTaskRefs.has(alias));
  });
```

Replace with:
```javascript
if (isWrite) {
  const mutations = taskHistoryStmt.all(...boardIds, msg.timestamp, tenMinLater);
  const rawSender = msg.sender_name || msg.sender || '';
  const senderPersonId = resolveActorToPersonId(rawSender, boardIds);
  // When resolver hits, the resolved person_id is the canonical key. When it
  // misses (phone-number sender, external contact, unregistered), fall back
  // to the existing NFD-normalized string. NOTE: this is NOT a strict
  // superset of today's logic — if a display name resolves to different
  // person_ids on different boards due to precedence, today's raw-name
  // compare can pair a row that the resolver rejects. Not observed in
  // current data, but document the regression possibility.
  const senderKey = senderPersonId ?? normalizeForCompare(rawSender);
  const matchingMutations = mutations.filter((mutation) => {
    let sameActor;
    if (!senderKey || !mutation.by) {
      // Matches today's semantics: when one side is unknown, don't gate on
      // actor — let the task-ref filter decide. DO NOT short-circuit return.
      sameActor = true;
    } else {
      const mutPersonId = resolveActorToPersonId(
        mutation.by,
        [mutation.board_id, ...boardIds],
      );
      const mutationKey = mutPersonId ?? normalizeForCompare(mutation.by);
      sameActor = mutationKey === senderKey;
    }
    if (!sameActor) return false;
    if (messageTaskRefs.size === 0) return true;
    return buildTaskIdAliases(
      mutation.task_id,
      mutation.board_id,
      boardShortCodes,
    ).some((alias) => messageTaskRefs.has(alias));
  });
```

Design notes:
- The empty-side branch sets `sameActor = true` and lets control fall through to the task-ref check, exactly like the original. This fixes the literal-`return true` bug the second review caught.
- The mutation side passes `[mutation.board_id, ...boardIds]` so we try the mutation's own board first, then fall back to the auditor's board scope. This covers cross-board subtask mutations.
- `normalizeForCompare` is the existing function (NFD+lower+trim at `auditor-script.sh:225-231`). `_nfd` in the resolver does the same thing; we just reuse `normalizeForCompare` for the fallback to keep the codepath consistent.
- **Caveat:** this is not a strict superset of today's logic. If the same display name resolves to different `person_id`s on different boards due to precedence ordering, the resolver can reject a pair that today's raw-string compare accepts. Not observed in current `board_people` (no collisions), but the diagnostic in Task 1 should report `matchNew < matchOld` as a flag if it ever happens.

- [ ] **Step 3: Emit heuristic-hit count in the JSON output**

Find where the auditor prints its final JSON result (search for `console.log(JSON.stringify(` near the bottom of the heredoc). Add one field to the output object:

```javascript
actor_first_name_heuristic_hits: _firstNameHeuristicHits,
```

This gives us weekly visibility into whether the heuristic is carrying too much weight.

- [ ] **Step 4: Build the container-runner TypeScript (no changes there, but confirm clean)**

```bash
cd /root/nanoclaw/container/agent-runner
npm run build
```

Expected: build succeeds. (We didn't change any `.ts` files — this is just a sanity check.)

- [ ] **Step 5: Shellcheck/syntax-check the heredoc**

```bash
cd /root/nanoclaw
bash -n container/agent-runner/src/auditor-script.sh
```

Expected: exit 0. The heredoc body isn't evaluated by bash — only the surrounding bash script — so this only catches bash-level syntax errors, not JS errors inside the heredoc. That's what Task 3 is for.

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/auditor-script.sh
git commit -m "fix(audit): NFD-normalized actor resolver on read side (fixes ~98% false-mismatch)"
```

---

## Task 3 — Post-change dry-run + before/after delta

**Files:**
- No new files. Runs the diagnostic from Task 1 plus a heredoc extraction.

- [ ] **Step 1: Re-run the diagnostic to confirm the gate still holds**

```bash
cd /root/nanoclaw
node scripts/audit-actor-match-diagnostic.mjs > /tmp/diag-after-task2.json
cat /tmp/diag-after-task2.json
```

The diagnostic itself doesn't depend on `auditor-script.sh`, so the numbers should be identical to Task 1 Step 2. This is a sanity check that no environmental drift has happened between Task 1 and Task 3.

- [ ] **Step 2: Extract the heredoc and run it against live data**

This proves the live auditor JS (not just our isolated re-implementation) pairs correctly.

```bash
cd /root/nanoclaw
# Extract the heredoc body to /tmp/auditor-extracted.js
awk '/^cat > \/tmp\/auditor.js << .SCRIPT_EOF./{flag=1; next} /^SCRIPT_EOF$/{flag=0} flag' \
  container/agent-runner/src/auditor-script.sh > /tmp/auditor-extracted.js

# Check first line looks like JS
head -3 /tmp/auditor-extracted.js
```

Expected: the first line is `const Database = require("better-sqlite3");`.

- [ ] **Step 3: Run the extracted heredoc against local data**

The heredoc hard-codes `/workspace/...` paths. Override by wrapping. We must also set `NODE_PATH` so `require('better-sqlite3')` resolves — the live wrapper at `auditor-script.sh:1133` sets `NODE_PATH=/app/node_modules`; the local equivalent is the container-runner's `node_modules`.

```bash
cd /root/nanoclaw
cat > /tmp/auditor-harness.cjs <<'EOF'
process.env.NANOCLAW_AUDIT_PERIOD_DAYS_BACK = '7';
// Swap the hardcoded paths for local ones.
const fs = require('fs');
const src = fs.readFileSync('/tmp/auditor-extracted.js', 'utf8')
  .replace('/workspace/store/messages.db', '/root/nanoclaw/store/messages.db')
  .replace('/workspace/taskflow/taskflow.db', '/root/nanoclaw/data/taskflow/taskflow.db');
eval(src);
EOF

# Resolve the local better-sqlite3 path. Live wrapper uses /app/node_modules
# (the container's path). Locally it's wherever the container-runner installs.
NODE_PATH=/root/nanoclaw/container/agent-runner/node_modules \
  node /tmp/auditor-harness.cjs 2>&1 | tail -200 > /tmp/auditor-live-output.txt
tail -5 /tmp/auditor-live-output.txt
```

If `require('better-sqlite3')` still fails, the container-runner's `node_modules` may not exist on the host. Run `cd container/agent-runner && npm install` first, or skip Task 3 Step 3 entirely and rely on Task 3 Step 1 (the diagnostic) plus Task 3 Step 4 (post-deploy log inspection).

Expected: JSON output on the last line. It will include `actor_first_name_heuristic_hits` as a new field.

- [ ] **Step 4: Extract `taskMutationFound` pairing counts from the live output**

```bash
grep -oE '"taskMutationFound":(true|false)' /tmp/auditor-live-output.txt | sort | uniq -c
```

Expected: the `true` count is substantially higher than the pre-fix audit's ~2 %. Compare against the last pre-fix audit output in your logs or DB.

- [ ] **Step 5: If the uplift vindicates the diagnostic, stop here and wait for deploy approval**

Per the user's standing rule, no deploy without authorization. This plan ends at green dry-run.

Summarize the delta for the user:
- `matchOld` / `matchNew` / `upliftPct` from the diagnostic
- `taskMutationFound: true` count from the live heredoc extract
- `actor_first_name_heuristic_hits` (is the heuristic load-bearing or incidental?)

Wait for explicit deploy approval before any `systemctl restart nanoclaw` or remote sync.

---

## Out of scope (explicitly deferred)

- **Any change to `recordHistory` or `task_history` shape.** Three skeptical reviews showed this blast radius is too large for the problem at hand (3 bypass sites, 7+ test assertions, a migration JOIN at `taskflow-engine.ts:947` that assumes display names, `apiFilterBoardHistory` rendering, digest prose quality). Read-side only is strictly safer and just as correct for the audit.
- **Fix 2 (engine-side `taskflow_update` guard for T10 magnetism).** Separate concern, separate plan.
- **Fix 3 (multi-message burst handling).** Needs one week of `pollIpcDuringQuery` instrumentation first.
- **Semantic-audit actor parity.** `semantic-audit.ts` has its own actor-compare; it may or may not need the same treatment. Measure separately once this ships.
- **Any deploy.** Plan ends at green local dry-run.

---

## Self-review

- **Spec coverage:** Addresses every issue the three agents flagged that survived the rewrite: ESM-vs-CJS (no `require` at all now), cross-board scope (both sides try all boardIds), diacritics (NFD throughout), first-name ambiguity (single-match only + logged), match-block logic bug (`sameActor = true` now falls through to task-ref filter as in the original), blast radius (zero engine changes). Also addresses the Codex follow-up findings: diagnostic now uses live `WRITE_KEYWORDS` + `TERSE_PATTERN`, ISO-string timestamp handling, `registered_groups WHERE taskflow_managed = 1` board scope, and `NODE_PATH` set in the Task 3 harness.
- **Placeholder scan:** None. All code blocks are concrete. The only flexible value is the DB paths, controlled by env.
- **Type/signature consistency:** `resolveActorToPersonId(rawName, boardIds) → person_id | null` is used identically in the diagnostic and the heredoc.
- **Risk ledger:**
  - Heredoc bash-file edit is textual. If a future edit breaks the `SCRIPT_EOF` marker, the whole auditor silently becomes bash noise. Mitigation: `bash -n` in Task 2 Step 5, and the Task 3 heredoc extraction would fail loudly.
  - `_boardPeopleCache` lives for the life of the heredoc process (one audit run). OK — `board_people` doesn't change mid-run.
  - If `board_people` is empty for a board (misconfigured), resolver returns null for everyone and we fall through to `normalizeForCompare` — identical to today's behavior for that board. No regression.
- **Gate discipline:** Task 1 cannot be skipped. If it says no, the rest of the plan is dead.
