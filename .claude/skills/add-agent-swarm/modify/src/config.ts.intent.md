# Intent: src/config.ts modifications

## What this skill adds
Three new config exports: `SWARM_SSH_TARGET` (SSH connection string), `SWARM_ENABLED` (boolean guard), `SWARM_REPOS` (parsed repo config from JSON env var).

## Key sections

### readEnvFile call
- Added: `'SWARM_SSH_TARGET'` and `'SWARM_REPOS_JSON'` to the key array

### New exports (end of file)
- `SWARM_SSH_TARGET`: string, defaults to empty
- `SWARM_ENABLED`: boolean, true when SWARM_SSH_TARGET is non-empty
- `SWARM_REPOS`: parsed from SWARM_REPOS_JSON env var

## Invariants
- `SWARM_ENABLED` is false when `SWARM_SSH_TARGET` is empty — swarm handlers block execution and return explicit configuration errors.
- `SWARM_REPOS` returns empty object on parse failure — never throws.

## Must-keep sections
- All existing config exports unchanged
- readEnvFile import unchanged
- Path constants unchanged
