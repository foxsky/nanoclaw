CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, board_role TEXT, hierarchy_level INTEGER, max_depth INTEGER, parent_board_id TEXT, short_code TEXT);
CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT NOT NULL DEFAULT 'America/Fortaleza', language TEXT);
CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, phone TEXT, role TEXT, wip_limit INTEGER, notification_group_jid TEXT, PRIMARY KEY (board_id, person_id));
CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, task_id TEXT, action TEXT, by TEXT, at TEXT, details TEXT);
CREATE TABLE board_holidays (board_id TEXT, holiday_date TEXT, label TEXT, PRIMARY KEY (board_id, holiday_date));

INSERT INTO boards VALUES ('board-smoke', '120363smoketest@g.us', 'smoke', 'standard', 0, 1, NULL, NULL);
INSERT INTO board_runtime_config (board_id, timezone) VALUES ('board-smoke', 'America/Fortaleza');
INSERT INTO board_people VALUES ('board-smoke', 'giovanni', 'Carlos Giovanni', '5588', 'manager', 3, NULL);
INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES
  ('board-smoke', 'M1', 'updated', 'giovanni',
   '2026-04-15T11:01:00.000Z',
   '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}');
