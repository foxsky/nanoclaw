#!/usr/bin/env bash
# Smoke test: runs the REAL auditor-script.sh inside the REAL container image
# against tiny fixture DBs. Points OLLAMA_HOST at an unreachable IP so the
# semantic-audit path runs end-to-end but callOllama returns null (ollamaFail).
# Asserts: stderr has counter line, stdout has valid JSON, no crash.

set -euo pipefail
cd "$(dirname "$0")/../../.."

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

mkdir -p "$WORKDIR/store" "$WORKDIR/taskflow" "$WORKDIR/audit"
sqlite3 "$WORKDIR/store/messages.db" < container/agent-runner/test/fixtures/messages.smoke.db.sql
sqlite3 "$WORKDIR/taskflow/taskflow.db" < container/agent-runner/test/fixtures/taskflow.smoke.db.sql

docker run --rm \
  -v "$WORKDIR/store:/workspace/store:ro" \
  -v "$WORKDIR/taskflow:/workspace/taskflow:ro" \
  -v "$WORKDIR/audit:/workspace/audit" \
  -e NANOCLAW_SEMANTIC_AUDIT_MODE=enabled \
  -e OLLAMA_HOST=http://192.0.2.1:1 \
  -e NANOCLAW_SEMANTIC_AUDIT_MODEL=test-model:fake \
  --entrypoint /bin/bash \
  nanoclaw-agent:latest \
  -c 'NODE_PATH=/app/node_modules node -e "
    const fs = require(\"fs\");
    // The auditor heredoc lives in /app/src/auditor-script.sh.
    // Extract the JS between SCRIPT_EOF markers and eval it.
    const script = fs.readFileSync(\"/app/src/auditor-script.sh\", \"utf-8\");
    const start = script.indexOf(\"SCRIPT_EOF\") + \"SCRIPT_EOF\".length + 1;
    const end = script.lastIndexOf(\"SCRIPT_EOF\");
    const js = script.slice(start, end);
    // Write to a temp file and run it (same as the real entrypoint does).
    fs.writeFileSync(\"/tmp/auditor.js\", js);
    require(\"child_process\").execSync(
      \"NODE_PATH=/app/node_modules node /tmp/auditor.js\",
      { stdio: [\"pipe\", process.stdout, process.stderr] }
    );
  "' > "$WORKDIR/auditor.stdout" 2> "$WORKDIR/auditor.stderr" || true

# Assert 1: stderr contains a "Semantic audit" log line
if grep -q 'Semantic audit' "$WORKDIR/auditor.stderr"; then
  echo "PASS: Semantic audit counter line found in stderr"
else
  echo "FAIL: no 'Semantic audit' line in stderr"
  echo "--- stderr ---"
  cat "$WORKDIR/auditor.stderr"
  exit 1
fi

# Assert 2: stdout starts with { (valid JSON wrapper)
if head -c 1 "$WORKDIR/auditor.stdout" | grep -q '{'; then
  echo "PASS: auditor stdout emitted JSON"
else
  echo "FAIL: auditor stdout did not emit JSON"
  echo "--- stdout ---"
  cat "$WORKDIR/auditor.stdout"
  exit 1
fi

# Assert 3: the JSON is parseable and has the expected structure
if node -e "const d = JSON.parse(require('fs').readFileSync('$WORKDIR/auditor.stdout','utf-8')); if (!d.data || !d.data.summary) { process.exit(1); }"; then
  echo "PASS: JSON has expected .data.summary structure"
else
  echo "FAIL: JSON missing .data.summary"
  echo "--- stdout ---"
  cat "$WORKDIR/auditor.stdout"
  exit 1
fi

echo ""
echo "All smoke assertions passed."
echo "--- stderr (counters) ---"
grep 'Semantic audit' "$WORKDIR/auditor.stderr" || true
