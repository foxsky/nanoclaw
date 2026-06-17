#!/usr/bin/env bash
#
# /add-taskflow installer barrel append-sets — SINGLE SOURCE OF TRUTH.
#
# Sourced by BOTH the installer (`setup/add-taskflow.sh`, which appends these
# side-effect imports into the pristine core barrels) and the completeness
# guardrail (`check-append-completeness.sh`, which proves every copy-set
# registrant is wired by one of these appends). Source-only: array definitions,
# no side effects — never execute this file.
#
# Each barrel ships PRISTINE in core (the imports below live ONLY here, not in
# the checked-in barrels). The installer re-appends them grep-idempotently.
# Mirrors ADR 0006 "Installer barrel-append manifest".

# host modules barrel — 2 imports
MODULES_BARREL="src/modules/index.ts"
MODULES_IMPORTS=(
  "import './send-otp/index.js';"
  "import './taskflow/index.js';"
)
# container chat MCP barrel — 17 imports (taskflow-api-board.js intentionally absent)
MCP_BARREL="container/agent-runner/src/mcp-tools/index.ts"
MCP_IMPORTS=(
  "import './send-otp.js';"
  "import './transcribe-audio.js';"
  "import './provision-root-board.js';"
  "import './provision-child-board.js';"
  "import './create-group.js';"
  "import './add-destination.js';"
  "import './taskflow-api-read.js';"
  "import './taskflow-api-mutate.js';"
  "import './taskflow-api-update.js';"
  "import './taskflow-api-notes.js';"
  "import './rename-board-person.js';"
  "import './taskflow-api-comment.js';"
  "import './memory.js';"
  "import './db/taskflow-db.js';"
  "import './db/web-chat-reply-transform.js';"
  "import './dispatch-extensions.js';"
  "import './emit-hooks.js';"
)
# host migrate-v2 register barrel — 1 import
MIGRATE_BARREL="src/migrate-v2-steps-register.ts"
MIGRATE_IMPORTS=(
  "import './modules/taskflow/migrate-v2-main-control.js';"
)
# container boot-extension barrel (main agent-runner process) — 1 import.
# Wires the board-memory prune + recall addendum into the entry's extension
# registry so index.ts (an upstream file) stays free of the fork memory import.
EXT_BARREL="container/agent-runner/src/extensions-register.ts"
EXT_IMPORTS=(
  "import './memory-boot.js';"
)
