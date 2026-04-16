CREATE TABLE messages (
  id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT,
  content TEXT, timestamp TEXT,
  is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0,
  PRIMARY KEY (id, chat_jid)
);
CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, trigger_pattern TEXT, added_at TEXT, taskflow_managed INTEGER);
CREATE TABLE send_message_log (id INTEGER PRIMARY KEY AUTOINCREMENT, source_group_folder TEXT, target_chat_jid TEXT, delivered_at TEXT);
CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, group_folder TEXT, created_at TEXT);

INSERT INTO registered_groups VALUES ('120363smoketest@g.us', 'SMOKE', 'smoke', '@Case', '2026-04-15T00:00:00Z', 1);
INSERT INTO messages VALUES ('m1', '120363smoketest@g.us', '5588@s.whatsapp.net', 'Carlos Giovanni',
  'alterar M1 para quinta-feira 11h', '2026-04-15T11:00:00.000Z', 0, 0);
