-- Identify user messages likely dropped during the 2026-04-13 task-container-hang bug
-- window. Criterion: user message in a TaskFlow-managed group with no bot delivery
-- within 10 min via send_message_log.
--
-- Bug commit: fixed in 00c4753 at 2026-04-13T22:21Z (19:21 BRT).
-- 08:00 BRT TF-STANDUP task-container stuck, blocking inbound messages until fix.
--
-- Usage:
--   sqlite3 -column -header /path/to/store/messages.db < scripts/find-dropped-messages.sql
--
-- Window + threshold variables are inlined; adjust for future incidents.

SELECT
  (SELECT folder FROM registered_groups WHERE jid = um.chat_jid) AS folder,
  um.sender_name,
  COUNT(*) AS dropped_msgs,
  MIN(substr(um.timestamp, 12, 5)) AS first_utc,
  MAX(substr(um.timestamp, 12, 5)) AS last_utc,
  SUBSTR(GROUP_CONCAT(SUBSTR(um.content, 1, 50), ' || '), 1, 200) AS sample_content
FROM messages um
WHERE um.timestamp >= '2026-04-13T11:00:00Z'
  AND um.timestamp <= '2026-04-13T22:21:00Z'
  AND um.is_from_me = 0
  AND um.is_bot_message = 0
  AND um.chat_jid IN (SELECT jid FROM registered_groups WHERE taskflow_managed = 1)
  AND NOT EXISTS (
    SELECT 1 FROM send_message_log sml
    WHERE sml.target_chat_jid = um.chat_jid
      AND sml.delivered_at >= um.timestamp
      AND sml.delivered_at <= datetime(um.timestamp, '+10 minutes')
  )
GROUP BY um.chat_jid, um.sender
ORDER BY folder, first_utc;

-- To see individual messages instead of grouped summary:
--   (remove GROUP BY, expand SELECT to include um.timestamp, um.content)
