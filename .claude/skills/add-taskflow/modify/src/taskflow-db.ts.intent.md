# taskflow-db.ts Modifications

Sync the canonical TASKFLOW_SCHEMA with the live database:

1. Add the `board_groups` table
2. Add these columns to `board_runtime_config`:
   - `welcome_sent INTEGER DEFAULT 0`
   - `standup_target TEXT DEFAULT 'team'`
   - `digest_target TEXT DEFAULT 'team'`
   - `review_target TEXT DEFAULT 'team'`
   - `runner_standup_secondary_task_id TEXT`
   - `runner_digest_secondary_task_id TEXT`
   - `runner_review_secondary_task_id TEXT`
