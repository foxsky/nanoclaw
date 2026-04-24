# Prod cutover from flat main.py to modular MCP-backed app/main.py

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move both the dev API (`192.168.2.160:8100`) and the prod API (`192.168.2.63:8100`) off the flat single-file `main.py` and onto the modular `app/main.py` backed by the TaskFlow MCP subprocess. The flat files stay on disk as the rollback target. No flat-prod functionality is lost — `app/main.py` is a clean superset of the prod-flat endpoint set.

**Architecture:** The modular API spawns the TypeScript engine (`taskflow-mcp-server.js`) as a stdio subprocess at startup. Mutations route through `call_mcp_mutation` → MCP → `engine.apiXxx` instead of direct SQLite. Reads still go through Python for now (engine-backed reads were Phase 5; not all reads are migrated). Cutover is staged: dev first to shake out config issues, then prod.

**Tech Stack:** FastAPI (uvicorn), Python 3.12, SQLite (`better-sqlite3`), Node 22, TypeScript (agent-runner), MCP SDK stdio transport.

**Repos involved:**
- `/root/tf-mcontrol` on `192.168.2.160` — Python API + dashboard. Modular code in `taskflow-api/app/main.py` and `taskflow-api/app/engine/`.
- `/root/nanoclaw` on `192.168.2.160` — TaskFlow skill source. MCP bundle compiled at `container/agent-runner/dist/taskflow-mcp-server.js`.

**Hosts:**
- Dev: `root@192.168.2.160` — dev API runs as a `nohup uvicorn` from `/root/taskflow-api/main.py` (hardlinked with `tf-mcontrol/taskflow-api/main.py`). Dev DB: `/root/taskflow-api/taskflow-dev.db`.
- Prod: `nanoclaw@192.168.2.63` — accessible via `ssh nanoclaw@192.168.2.63` from `.160`. Prod API runs as systemd unit `taskflow-api.service`, `WorkingDirectory=/home/nanoclaw/taskflow-api`, `ExecStart=run.sh` → `uvicorn main:app --host 0.0.0.0 --port 8100`. Prod DB: `/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`.

**Audit results from before this plan (verified):**
- Endpoint set: `app/main.py` is a strict superset of prod-flat. Adds `/notes` deltas (POST/PATCH/DELETE) and `/actor-resolution` (GET). No regressions.
- Prod DB tables include `board_holidays`, `task_history`, `board_people`, `tasks`, `boards`, `users`, `board_chat`, `archive`, `meeting_external_participants`, `org_invites`, `org_members`, `external_contacts`, `subtask_requests`, etc. Looks complete for the modular code's expectations.
- `TASKFLOW_MCP_SERVER_BIN` is unset on both hosts. The MCP subprocess has never been live anywhere.
- Prod has agent-runner src at `/home/nanoclaw/nanoclaw/container/agent-runner/` but **no `node_modules` and no `dist/`**. Needs `npm install && npm run build` before the subprocess can start.
- Node 22.22.1 is installed on prod.
- Dashboard prod env (`/root/tf-mcontrol/taskflow-dashboard/.env.production`) points at `http://192.168.2.63:8100`. Dashboard prod build does NOT need to change for this cutover (the API url is the same).
- `app/main.py` on prod (`/home/nanoclaw/taskflow-api/app/main.py`) is a stale 3943-line snapshot. Dev's canonical version is 4260 lines. Prod's `app/` will be replaced wholesale before cutover.

---

## Stage 1 — Dev cutover (192.168.2.160)

Goal: switch dev's `:8100` from `main:app` to `app.main:app`, with the MCP subprocess live. Validate dashboard works against the new dev API.

### Task 1.1: Verify the dev MCP bundle exists and starts cleanly in isolation

**Files:** none modified. Just probes.

**Step 1.1.1: Confirm the compiled bundle exists on dev**

Run:
```bash
ssh root@192.168.2.160 "ls -la /root/nanoclaw/container/agent-runner/dist/taskflow-mcp-server.js && head -1 /root/nanoclaw/container/agent-runner/dist/taskflow-mcp-server.js"
```

Expected: file exists; first line begins with TypeScript-compiled JS (likely `import` or `'use strict'`).

If missing: `ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npm run build"` and re-check.

**Step 1.1.2: Start the bundle as a one-shot stdio process and confirm it emits the ready sentinel**

Run:
```bash
ssh root@192.168.2.160 'timeout 3 node /root/nanoclaw/container/agent-runner/dist/taskflow-mcp-server.js --db /root/taskflow-api/taskflow-dev.db 2>&1 || true'
```

Expected output contains: `MCP server ready`. Stdin will be closed by `timeout` after 3s, so an exit code of 124 (timeout) or 0 is fine.

If the line does not appear, capture stderr verbatim and stop. The bundle has a startup error.

**Step 1.1.3: Commit no changes — this is verification only**

No commit.

---

### Task 1.2: Configure dev to launch with the MCP subprocess

**Files:**
- Modify: `/root/taskflow-api/.env` (add `TASKFLOW_MCP_SERVER_BIN`)

**Step 1.2.1: Define the success criterion**

After the change, restarting the dev API and querying `/api/v1/health` should report `subprocess: "healthy"` (the modular code includes the MCP subprocess status in its health endpoint per `main.py:2474`). Currently that field reads `disabled`.

Verify pre-state:
```bash
ssh root@192.168.2.160 "curl -s http://localhost:8100/api/v1/health"
```
Expected: `{"status":"ok"}` (the FLAT main.py's simple health response — no `subprocess` key).

**Step 1.2.2: Append the env var**

Run:
```bash
ssh root@192.168.2.160 "grep -q TASKFLOW_MCP_SERVER_BIN /root/taskflow-api/.env || echo 'TASKFLOW_MCP_SERVER_BIN=/root/nanoclaw/container/agent-runner/dist/taskflow-mcp-server.js' >> /root/taskflow-api/.env"
```

Verify:
```bash
ssh root@192.168.2.160 "grep TASKFLOW_MCP_SERVER_BIN /root/taskflow-api/.env"
```
Expected: prints `TASKFLOW_MCP_SERVER_BIN=/root/nanoclaw/container/agent-runner/dist/taskflow-mcp-server.js`.

**Step 1.2.3: No restart yet** — Stage 1.3 changes the entrypoint and restarts in one step. Don't restart against the flat `main.py` with the new env (no harm, but no value).

No commit. The dev `.env` is not git-tracked (verified earlier — `/root/taskflow-api` has no `.git`).

---

### Task 1.3: Switch dev uvicorn entrypoint from `main:app` to `app.main:app`

**Files:**
- Inspect: dev's running uvicorn command and the script that starts it. From `ps aux`, the running command is `bash -c cd /root/taskflow-api && set -a; source .env; set +a && nohup .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8100 > uvicorn.log 2>&1 & echo pid=0`.
- Modify: probably `/root/taskflow-api/run-dev.sh` or wherever that bash command lives. Find it first.

**Step 1.3.1: Locate the dev start script**

Run:
```bash
ssh root@192.168.2.160 "ls /root/taskflow-api/*.sh 2>/dev/null; ps -o cmd -p \$(pgrep -f 'uvicorn main:app' | head -1) 2>/dev/null"
```

Decision:
- If a `.sh` exists with `uvicorn main:app`: edit it.
- If no `.sh`: the start command is invoked manually (e.g., from a memory note). Run it manually with the new entrypoint.

**Step 1.3.2: Verify the modular package is importable from the dev workdir**

The modular code lives at `/root/tf-mcontrol/taskflow-api/app/main.py`. Dev's workdir is `/root/taskflow-api`. Need `app/main.py` to be importable as `app.main` from `/root/taskflow-api`.

Run:
```bash
ssh root@192.168.2.160 "ls /root/taskflow-api/app/ 2>&1"
```

Expected: directory does not exist OR contains stale files.

**Step 1.3.3: Symlink the canonical app/ into the dev workdir**

Run:
```bash
ssh root@192.168.2.160 "rm -rf /root/taskflow-api/app && ln -s /root/tf-mcontrol/taskflow-api/app /root/taskflow-api/app && ls -la /root/taskflow-api/app"
```

Expected: `app -> /root/tf-mcontrol/taskflow-api/app`.

**Step 1.3.4: Verify the modular app boots without crashing**

Dry-run with the env vars set, expecting it to listen and accept a health probe:
```bash
ssh root@192.168.2.160 "kill \$(pgrep -f 'uvicorn main:app') 2>/dev/null; sleep 2; cd /root/taskflow-api && set -a && source .env && set +a && nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8100 > /tmp/uvicorn-modular.log 2>&1 & disown; sleep 4; curl -s http://localhost:8100/api/v1/health"
```

Expected: response body contains `"status":"ok"` AND `"subprocess":{"status":"healthy"}`.

If subprocess is not healthy: read `/tmp/uvicorn-modular.log`. Likely culprits:
  - `TASKFLOW_MCP_SERVER_BIN` not set in process env (the subprocess only spawns at startup if the var is non-empty).
  - Better-sqlite3 native binding mismatch (would crash node before it emits the ready sentinel).
  - Dev `.venv` missing dependencies that the modular code needs (e.g., `python-jose`, `unidecode`).

**Step 1.3.5: Validate the dashboard against the new dev API**

Run a representative call manually:
```bash
ssh root@192.168.2.160 "curl -s -H 'Authorization: Bearer 59f093d83a5df47af2fb82b49bb66f76ee61f067e495b03c5f15121ea62a9fb7' http://localhost:8100/api/v1/boards | python3 -m json.tool | head -20"
```

Expected: list of boards with the canonical schema (`id`, `org_id`, `name`, …). If 503 with "TaskFlow MCP unavailable", the subprocess didn't start.

Open the dashboard in a browser at `http://192.168.2.160:3001` (Vite dev), log in, open a board, **add a note via the note delta endpoints**. The note should persist (this is the path that has been broken silently on flat-main.py because the dashboard was sending whole-array PATCH that flat-main.py also handled). Verify by re-loading the page.

**Step 1.3.6: Update the dev start script to make the change persistent across reboots**

If a `.sh` script was found in 1.3.1, edit it to replace `main:app` with `app.main:app`.

If the start command lives in a memory note or shell history (no script), document the new command in a file the engineer can re-run after a reboot:

```bash
ssh root@192.168.2.160 "cat > /root/taskflow-api/start-dev.sh <<'EOF'
#!/bin/bash
cd /root/taskflow-api
set -a; source .env; set +a
exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8100
EOF
chmod +x /root/taskflow-api/start-dev.sh"
```

**Step 1.3.7: Commit the script** (only if it lives in a git repo; `/root/taskflow-api` is NOT a git repo, so skip the commit).

No commit.

---

### Task 1.4: Fix any failing dashboard interactions found in 1.3.5

If everything in 1.3.5 worked: skip this task.

If something broke: each failing endpoint is its own bug fix. Run `pytest tests/test_api.py -q -k <relevant_keyword>` against the modular code first; the test suite has 190 cases that already cover most of the surface. Treat any failing test as the failing-test step of TDD.

The most likely class of issue is **endpoints that exist in flat-main.py but not in modular `app/main.py`** that the dashboard happens to use. Audit:

```bash
ssh root@192.168.2.160 "diff <(grep -oE '@app\\.(get|post|patch|delete|put)\\(\"[^\"]+\"' /root/taskflow-api/main.py | sort -u) <(grep -oE '@app\\.(get|post|patch|delete|put)\\(\"[^\"]+\"' /root/tf-mcontrol/taskflow-api/app/main.py | sort -u)"
```

Expected from prior audit: only `>` (additions on the modular side). If there are `<` lines (flat-only), each is a parity gap that must be ported into `app/main.py` before declaring Stage 1 done.

---

## Stage 2 — Prod prep on .63

Goal: Get the MCP subprocess buildable and runnable on prod, without yet flipping the API entrypoint.

### Task 2.1: Sync agent-runner source to prod

**Files:** none in the planning repo. Sync only.

**Step 2.1.1: Sync src + package files**

Run:
```bash
ssh root@192.168.2.160 "rsync -a --delete /root/nanoclaw/container/agent-runner/src/ nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/container/agent-runner/src/ && rsync -a /root/nanoclaw/container/agent-runner/package.json /root/nanoclaw/container/agent-runner/package-lock.json /root/nanoclaw/container/agent-runner/tsconfig.json nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/container/agent-runner/"
```

Verify:
```bash
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'ls /home/nanoclaw/nanoclaw/container/agent-runner/src/taskflow-mcp-server.ts /home/nanoclaw/nanoclaw/container/agent-runner/package.json'"
```

Expected: both paths print.

### Task 2.2: Install npm deps and build the bundle on prod

**Files:** creates `/home/nanoclaw/nanoclaw/container/agent-runner/{node_modules,dist}/`.

**Step 2.2.1: Install**

Run:
```bash
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'cd /home/nanoclaw/nanoclaw/container/agent-runner && npm install 2>&1 | tail -10'"
```

Expected: ends with `added N packages`, no errors. Watch specifically for `better-sqlite3` rebuild — if it fails to compile native bindings for prod's node version, the MCP subprocess will crash at startup. Common issue is missing `python3` or `make` for node-gyp; install via `sudo apt-get install build-essential python3` if needed.

**Step 2.2.2: Build the bundle**

Run:
```bash
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'cd /home/nanoclaw/nanoclaw/container/agent-runner && npm run build 2>&1 | tail -10'"
```

Expected: clean exit, no `tsc` errors.

**Step 2.2.3: Verify the bundle starts in isolation against the prod DB**

Run:
```bash
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'timeout 3 node /home/nanoclaw/nanoclaw/container/agent-runner/dist/taskflow-mcp-server.js --db /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db 2>&1 || true'"
```

Expected output contains `MCP server ready`.

### Task 2.3: Sync the canonical app/main.py + app/engine to prod

**Files:** prod's `/home/nanoclaw/taskflow-api/app/` will be replaced.

**Step 2.3.1: Backup prod's existing app/ snapshot**

Run:
```bash
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'mv /home/nanoclaw/taskflow-api/app /home/nanoclaw/taskflow-api/app.bak.\$(date +%Y%m%d-%H%M%S) 2>/dev/null; ls /home/nanoclaw/taskflow-api/'"
```

**Step 2.3.2: Sync the canonical app/**

Run:
```bash
ssh root@192.168.2.160 "rsync -a --delete /root/tf-mcontrol/taskflow-api/app/ nanoclaw@192.168.2.63:/home/nanoclaw/taskflow-api/app/ --exclude '__pycache__'"
```

Verify:
```bash
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'wc -l /home/nanoclaw/taskflow-api/app/main.py'"
```
Expected: same line count as `/root/tf-mcontrol/taskflow-api/app/main.py` on dev.

**Step 2.3.3: Verify python deps on prod cover the modular code**

Run:
```bash
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'cd /home/nanoclaw/taskflow-api && .venv/bin/python -c \"from app import main; print(\\\"import OK\\\")\" 2>&1'"
```

Expected: `import OK`. If `ImportError` for any module: install via `.venv/bin/pip install <missing>` from the dev `requirements.txt` (`/root/tf-mcontrol/taskflow-api/requirements.txt`).

If the `.venv` is missing modules: `ssh nanoclaw@192.168.2.63 'cd /home/nanoclaw/taskflow-api && .venv/bin/pip install -r /home/nanoclaw/taskflow-api/requirements.txt'`.

### Task 2.4: Schema audit against prod DB

**Files:** none modified. Check only.

**Step 2.4.1: Run the modular code's `ensure_support_tables` against the prod DB in dry-run mode (idempotent)**

Run:
```bash
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'cd /home/nanoclaw/taskflow-api && TASKFLOW_DB_PATH=/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db .venv/bin/python -c \"
import sqlite3
from app import main as m
conn = sqlite3.connect(\\\"/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db\\\")
m.ensure_support_tables(conn)
conn.commit()
print(\\\"schema migration OK\\\")
\"'"
```

Expected: prints `schema migration OK`. The function is `CREATE TABLE IF NOT EXISTS …` plus `ALTER TABLE … ADD COLUMN` only if missing — safe on a populated DB.

If it errors: capture the error and pause. Some migrations (e.g., a `NOT NULL` ALTER without a default) will fail on a populated table. Each one is a discrete fix.

---

## Stage 3 — Prod cutover (.63)

Goal: Switch prod from `main:app` to `app.main:app` with the MCP subprocess live.

### Task 3.1: Define rollback first

**Files:** create `/home/nanoclaw/taskflow-api/run.sh.flat-rollback`.

**Step 3.1.1: Save the current run.sh as a rollback artifact**

Run:
```bash
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'cp /home/nanoclaw/taskflow-api/run.sh /home/nanoclaw/taskflow-api/run.sh.flat-rollback && cat /home/nanoclaw/taskflow-api/run.sh.flat-rollback'"
```

Expected: prints the current flat-main.py launcher. **This file must not be deleted.** Rollback procedure: `cp run.sh.flat-rollback run.sh && systemctl restart taskflow-api`.

**Step 3.1.2: Backup the prod DB**

Run:
```bash
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'cp /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db /tmp/taskflow.prod.cutover-backup.\$(date +%Y%m%d-%H%M%S).db && ls -la /tmp/taskflow.prod.cutover-backup.*'"
```

Expected: backup file ~12kB+ (real prod DB size). Keep this until post-cutover smoke test passes.

### Task 3.2: Update the prod run.sh

**Files:**
- Modify: `/home/nanoclaw/taskflow-api/run.sh`

**Step 3.2.1: Replace `main:app` with `app.main:app` and add `TASKFLOW_MCP_SERVER_BIN`**

Write the new `run.sh` content. The current shape (audited):

```bash
#!/bin/bash
export TASKFLOW_DB_PATH=/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db
export TASKFLOW_CORS_ORIGINS='http://192.168.2.63:3000,http://192.168.2.177:3000'
export TASKFLOW_API_TOKEN=59f093d83a5df47af2fb82b49bb66f76ee61f067e495b03c5f15121ea62a9fb7
cd /home/nanoclaw/taskflow-api
exec .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8100
```

The new shape:

```bash
#!/bin/bash
export TASKFLOW_DB_PATH=/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db
export TASKFLOW_CORS_ORIGINS='http://192.168.2.63:3000,http://192.168.2.177:3000,http://192.168.2.160:3001'
export TASKFLOW_API_TOKEN=59f093d83a5df47af2fb82b49bb66f76ee61f067e495b03c5f15121ea62a9fb7
export TASKFLOW_MCP_SERVER_BIN=/home/nanoclaw/nanoclaw/container/agent-runner/dist/taskflow-mcp-server.js
cd /home/nanoclaw/taskflow-api
exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8100
```

Note: CORS origins also gain `192.168.2.160:3001` to match dev's `.env` (already in prod's `.env` per audit, so harmless if duplicated).

Apply via heredoc (the prod file isn't a git repo from here, edit in place):
```bash
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'cat > /home/nanoclaw/taskflow-api/run.sh <<EOF
#!/bin/bash
export TASKFLOW_DB_PATH=/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db
export TASKFLOW_CORS_ORIGINS=\"http://192.168.2.63:3000,http://192.168.2.177:3000,http://192.168.2.160:3001\"
export TASKFLOW_API_TOKEN=59f093d83a5df47af2fb82b49bb66f76ee61f067e495b03c5f15121ea62a9fb7
export TASKFLOW_MCP_SERVER_BIN=/home/nanoclaw/nanoclaw/container/agent-runner/dist/taskflow-mcp-server.js
cd /home/nanoclaw/taskflow-api
exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8100
EOF
chmod +x /home/nanoclaw/taskflow-api/run.sh && cat /home/nanoclaw/taskflow-api/run.sh'"
```

Verify: prints the new contents.

**Step 3.2.2: Restart the prod systemd unit**

Run:
```bash
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'sudo systemctl restart taskflow-api && sleep 4 && sudo systemctl is-active taskflow-api && curl -s http://localhost:8100/api/v1/health'"
```

Expected: `active`, body contains `"status":"ok"` AND `"subprocess":{"status":"healthy"}`.

If subprocess is not healthy: rollback (Task 3.1.1) and inspect `journalctl -u taskflow-api -n 100`. Likely cause: native binding mismatch from Task 2.2.1.

### Task 3.3: Smoke test prod end-to-end

**Files:** none. Verification only.

**Step 3.3.1: Probe representative endpoints**

```bash
TOKEN=59f093d83a5df47af2fb82b49bb66f76ee61f067e495b03c5f15121ea62a9fb7
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:8100/api/v1/boards | python3 -c \"import sys,json; d=json.load(sys.stdin); print(len(d), \\\"boards\\\"); print(d[0][\\\"id\\\"] if d else \\\"none\\\")\"'"
```

Expected: a board count > 0 and the first board's id printed. If 503: MCP subprocess died after startup.

**Step 3.3.2: Open the prod dashboard in a browser**

URL: `http://192.168.2.63:3000`. Log in. Walk through:
- Open a board with tasks. Verify the kanban renders.
- Click a task. Verify TaskDetailPanel renders with tabs.
- Add a note via the new delta endpoint. Verify it persists.
- Edit and delete the note. Verify each persists.
- Move a task between columns. Verify persists.
- Add a member via PeoplePanel. Verify persists.
- Add a holiday via Settings. Verify persists.

Each interaction that fails is a discrete bug. Most likely: a route present in flat-main.py that prod's dashboard called but isn't in modular `app/main.py` — already audited as zero gaps, but confirm.

**Step 3.3.3: Watch logs for stderr from the MCP subprocess**

Run for 60 seconds:
```bash
ssh root@192.168.2.160 "ssh nanoclaw@192.168.2.63 'sudo journalctl -u taskflow-api -f --since \"1 minute ago\"'"
```

Expected: no repeated `MCP unavailable`, no repeated tracebacks. Some stderr from the subprocess is normal (it redirects all `console.log` to stderr per `taskflow-mcp-server.ts:9`).

### Task 3.4: Document the cutover in CHANGELOG

**Files:**
- Modify: `/root/nanoclaw/CHANGELOG.md`

**Step 3.4.1: Add a `## 2026-04-24 — TaskFlow API: prod cutover to modular MCP-backed app/main.py` entry**

The entry should record:
- What changed: prod and dev now run `app.main:app` with the MCP subprocess (`TASKFLOW_MCP_SERVER_BIN` set on both hosts). Flat `main.py` is preserved on disk as the rollback target.
- Why now: today's note delta endpoint work made the dashboard depend on routes only the modular API has. Bridging the gap is the only way that work reaches users.
- Rollback: `cp run.sh.flat-rollback run.sh && sudo systemctl restart taskflow-api`. DB backup at `/tmp/taskflow.prod.cutover-backup.<timestamp>.db`.

**Step 3.4.2: Commit**

Run:
```bash
ssh root@192.168.2.160 "cd /root/nanoclaw && git add CHANGELOG.md && git commit -m 'docs(changelog): prod cutover to modular MCP-backed API'"
```

---

## Stage 4 — 24-hour soak window

No code changes. Watch:
- `journalctl -u taskflow-api` on prod for unexpected restarts or MCP unavailability.
- Dashboard in real use — any user-reported bugs are immediately rollback candidates.
- DB integrity: `sqlite3 taskflow.db 'PRAGMA integrity_check'`.

After 24h with no rollback: delete the `app.bak.*` snapshots and `/tmp/taskflow.prod.cutover-backup.*.db`.
