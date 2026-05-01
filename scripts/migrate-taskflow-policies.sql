-- Phase 2.5 Task 2.5.4: enable unknown-sender approval on all TaskFlow boards.
--
-- Run AFTER:
--   - migrate-v2.sh has seeded the v2.db (Phase 0 Task 0.2)
--   - migrate-taskflow-users.ts has seeded users/user_roles/agent_group_members
--   - migrate-taskflow-destinations.ts has seeded agent_destinations parent edges
--
-- Combined effect:
--   - messaging_groups.unknown_sender_policy='request_approval' — non-member
--     messages route to admin approval (vs the default 'strict' which silently
--     drops them).
--   - messaging_group_agents.sender_scope='known' — agent only engages with
--     members of the agent_group (combined with engage_pattern='.' from the
--     F1 fork-private patch, this gives "respond to every message from members").
--   - messaging_group_agents.ignored_message_policy='accumulate' — dropped
--     messages land in unregistered_senders for audit + admin replay.
--
-- Idempotent: every UPDATE rewrites the target value, so re-running is a
-- no-op once the rows already match.
--
-- Usage:
--   sqlite3 /path/to/data/v2.db < scripts/migrate-taskflow-policies.sql

BEGIN;

UPDATE messaging_groups
   SET unknown_sender_policy = 'request_approval'
 WHERE channel_type = 'whatsapp';

UPDATE messaging_group_agents
   SET sender_scope            = 'known',
       ignored_message_policy  = 'accumulate'
 WHERE messaging_group_id IN (
   SELECT id FROM messaging_groups WHERE channel_type = 'whatsapp'
 );

COMMIT;

-- Verify
SELECT 'messaging_groups by policy:' AS rpt, unknown_sender_policy AS k, COUNT(*) AS n
  FROM messaging_groups GROUP BY unknown_sender_policy;
SELECT 'mga.sender_scope:', sender_scope, COUNT(*)
  FROM messaging_group_agents GROUP BY sender_scope;
SELECT 'mga.ignored_message_policy:', ignored_message_policy, COUNT(*)
  FROM messaging_group_agents GROUP BY ignored_message_policy;
