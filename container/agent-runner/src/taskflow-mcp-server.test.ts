import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'
import { parseActorArg } from './taskflow-mcp-server.js'

const SERVER_BIN = path.resolve(__dirname, '../dist/taskflow-mcp-server.js')

describe('taskflow-mcp-server', () => {
  let proc: ReturnType<typeof spawn> | null = null
  let tempDir: string | null = null

  const createEmptyTestDb = () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'taskflow-mcp-server-test-'))
    const dbPath = path.join(tempDir, 'taskflow-test.db')
    writeFileSync(dbPath, '')
    return dbPath
  }

  afterEach(async () => {
    if (proc) {
      if (proc.exitCode === null && proc.signalCode === null) {
        await new Promise<void>((res) => {
          proc!.on('exit', () => res())
          proc!.kill()
        })
      }
      proc = null
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  async function startTestServer(): Promise<{ send: (msg: object) => void; waitFor: (id: number) => Promise<any> }> {
    tempDir = mkdtempSync(path.join(tmpdir(), 'taskflow-mcp-server-test-'))
    const dbPath = createTestDbSeeded(tempDir)
    proc = spawn('node', [SERVER_BIN, '--db', dbPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    const lines: any[] = []
    createInterface({ input: proc.stdout! }).on('line', l => { try { lines.push(JSON.parse(l)) } catch {} })

    await new Promise<void>((resolve, reject) => {
      const rl = createInterface({ input: proc!.stderr! })
      let settled = false
      const t = setTimeout(() => { if (!settled) { settled = true; rl.close(); reject(new Error('timeout')) } }, 5000)
      rl.on('line', l => { if (l.includes('MCP server ready') && !settled) { settled = true; clearTimeout(t); rl.close(); resolve() } })
    })

    const send = (msg: object) => proc!.stdin!.write(JSON.stringify(msg) + '\n')
    const waitFor = (id: number) => new Promise<any>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`timeout id=${id}`)), 5000)
      const iv = setInterval(() => {
        const m = lines.find(x => x.id === id)
        if (m) { clearInterval(iv); clearTimeout(deadline); resolve(m) }
      }, 50)
    })

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } } })
    await waitFor(1)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    return { send, waitFor }
  }

  it('emits ready sentinel on stderr after startup', async () => {
    const testDb = createEmptyTestDb()
    proc = spawn('node', [SERVER_BIN, '--db', testDb])
    const sentinel = await new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input: proc!.stderr! })
      const timeout = setTimeout(() => {
        rl.close()
        reject(new Error('timeout waiting for sentinel'))
      }, 5000)
      let settled = false
      rl.on('line', (line) => {
        if (line.includes('MCP server ready') && !settled) {
          settled = true
          clearTimeout(timeout)
          rl.close()
          resolve(line)
        }
      })
      proc!.on('exit', (code) => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          rl.close()
          reject(new Error(`exited with code ${code}`))
        }
      })
    })
    expect(sentinel).toContain('MCP server ready')
  })

  it('responds to initialize with protocol version', async () => {
    const testDb = createEmptyTestDb()
    proc = spawn('node', [SERVER_BIN, '--db', testDb], { stdio: ['pipe', 'pipe', 'pipe'] })

    await new Promise<void>((resolve, reject) => {
      const rl = createInterface({ input: proc!.stderr! })
      let settled = false
      const t = setTimeout(() => {
        if (!settled) { settled = true; rl.close(); reject(new Error('timeout waiting for sentinel')) }
      }, 5000)
      rl.on('line', (l) => {
        if (l.includes('MCP server ready') && !settled) {
          settled = true; clearTimeout(t); rl.close(); resolve()
        }
      })
      proc!.on('exit', (code) => {
        if (!settled) { settled = true; clearTimeout(t); reject(new Error(`exited with code ${code}`)) }
      })
    })

    const req = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } }
    })
    proc!.stdin!.write(req + '\n')

    const response = await new Promise<any>((resolve, reject) => {
      const rl = createInterface({ input: proc!.stdout! })
      let settled = false
      const t = setTimeout(() => {
        if (!settled) { settled = true; rl.close(); reject(new Error('timeout waiting for initialize response')) }
      }, 5000)
      rl.on('line', (line) => {
        if (settled) return
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1) { settled = true; clearTimeout(t); rl.close(); resolve(msg) }
        } catch {}
      })
      proc!.on('exit', (code) => {
        if (!settled) { settled = true; clearTimeout(t); rl.close(); reject(new Error(`process exited with code ${code}`)) }
      })
    })

    expect(response.id).toBe(1)
    expect(response.result.protocolVersion).toBe('2024-11-05')
    expect(response.result.serverInfo.name).toBe('taskflow-mcp-server')
    expect(response.result.capabilities).toBeDefined()
  })

  it('returns adapter tools in tools/list after handshake', async () => {
    const { send, waitFor } = await startTestServer()
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const resp = await waitFor(2)
    const toolNames = resp.result.tools.map((t: any) => t.name)
    expect(toolNames).toContain('api_board_activity')
    expect(toolNames).toContain('api_filter_board_tasks')
    expect(toolNames).toContain('api_linked_tasks')
  })

  it('returns JSON content from tools/call', async () => {
    const { send, waitFor } = await startTestServer()
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'api_board_activity', arguments: { board_id: 'board-001', mode: 'changes_today' } } })
    const resp = await waitFor(2)
    const data = JSON.parse(resp.result.content[0].text)
    expect(Array.isArray(data.rows)).toBe(true)
  })

  it('exits non-zero when --db is missing', async () => {
    proc = spawn('node', [SERVER_BIN], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exitCode = await new Promise<number | null>((resolve) => {
      proc!.on('exit', (code) => resolve(code))
    })
    expect(exitCode).not.toBe(0)
  })

  it('api_board_activity returns history rows for changes_today', async () => {
    const { send, waitFor } = await startTestServer()
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'api_board_activity', arguments: { board_id: 'b1', mode: 'changes_today' } } })
    const resp = await waitFor(2)
    const data = JSON.parse(resp.result.content[0].text)
    expect(Array.isArray(data.rows)).toBe(true)
    expect(data.rows.length).toBeGreaterThanOrEqual(1)
    const row = data.rows[0]
    expect(row).toHaveProperty('id')
    expect(row).toHaveProperty('board_id', 'b1')
    expect(row).toHaveProperty('task_id')
    expect(row).toHaveProperty('action')
    expect(row).toHaveProperty('by')
    expect(row).toHaveProperty('at')
    expect(row).toHaveProperty('details')
  })

  it('api_board_activity returns history rows for changes_since', async () => {
    const { send, waitFor } = await startTestServer()
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'api_board_activity', arguments: { board_id: 'b1', mode: 'changes_since', since: '2021-01-01T00:00:00Z' } } })
    const resp = await waitFor(2)
    const data = JSON.parse(resp.result.content[0].text)
    expect(Array.isArray(data.rows)).toBe(true)
    expect(data.rows).toHaveLength(1)
    expect(data.rows[0].action).toBe('create')
    expect(data.rows[0].details).toEqual({ source: 'seed' })
  })

  it('api_filter_board_tasks returns urgent tasks', async () => {
    const { send, waitFor } = await startTestServer()
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'api_filter_board_tasks', arguments: { board_id: 'b1', filter: 'urgent' } } })
    const resp = await waitFor(2)
    const data = JSON.parse(resp.result.content[0].text)
    expect(Array.isArray(data.rows)).toBe(true)
    expect(data.rows.length).toBe(1)
    expect(data.rows[0].id).toBe('t1')
    expect(data.rows[0].priority).toBe('urgente')
    expect(data.rows[0].board_code).toBe('TF')
    expect(Array.isArray(data.rows[0].labels)).toBe(true)
    expect(Array.isArray(data.rows[0].notes)).toBe(true)
    expect(data.rows[0].notes).toHaveLength(1)
  })

  it('api_filter_board_tasks supports due, label, and high-priority filters', async () => {
    const { send, waitFor } = await startTestServer()
    const callTool = async (id: number, filter: string, extraArgs: Record<string, unknown> = {}) => {
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'api_filter_board_tasks', arguments: { board_id: 'b1', filter, ...extraArgs } } })
      const resp = await waitFor(id)
      return JSON.parse(resp.result.content[0].text)
    }

    const overdue = await callTool(2, 'overdue')
    expect(overdue.rows.map((row: any) => row.id)).toEqual(['t2'])

    const dueToday = await callTool(3, 'due_today')
    expect(dueToday.rows.map((row: any) => row.id)).toEqual(['t5'])

    const dueThisWeek = await callTool(4, 'due_this_week')
    expect(dueThisWeek.rows.map((row: any) => row.id)).toEqual(['t5', 't6'])

    const highPriority = await callTool(5, 'high_priority')
    expect(highPriority.rows.map((row: any) => row.id)).toEqual(['t7'])

    const byLabel = await callTool(6, 'by_label', { label: 'backend' })
    expect(byLabel.rows.map((row: any) => row.id)).toEqual(['t6'])
  })

  it('api_linked_tasks returns only tasks with child_exec_board_id', async () => {
    const { send, waitFor } = await startTestServer()
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'api_linked_tasks', arguments: { board_id: 'b1' } } })
    const resp = await waitFor(2)
    const data = JSON.parse(resp.result.content[0].text)
    expect(Array.isArray(data.rows)).toBe(true)
    expect(data.rows.length).toBe(1)
    expect(data.rows[0].id).toBe('t3')
    expect(data.rows[0].child_exec_board_id).toBe('child-board-1')
    expect(data.rows[0].parent_task_title).toBeNull()
  })

})

// ── test DB factory ──────────────────────────────────────────────────────────

import Database from 'better-sqlite3'
import { rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

function _seedDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE boards (
      id TEXT PRIMARY KEY, short_code TEXT, name TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL,
      title TEXT NOT NULL, "column" TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'simple',
      assignee TEXT, priority TEXT, due_date TEXT, labels TEXT,
      description TEXT, notes TEXT, parent_task_id TEXT, scheduled_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      child_exec_board_id TEXT, child_exec_person_id TEXT,
      child_exec_rollup_status TEXT
    );
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id TEXT NOT NULL, task_id TEXT NOT NULL,
      action TEXT NOT NULL, "by" TEXT,
      "at" TEXT NOT NULL, details TEXT
    );
    INSERT INTO boards VALUES ('b1', 'TF', 'Test Board', '2024-01-01T00:00:00Z');
    INSERT INTO tasks (
      id, board_id, title, "column", type, assignee, priority, due_date, labels,
      description, notes, parent_task_id, scheduled_at, created_at, updated_at,
      child_exec_board_id, child_exec_person_id, child_exec_rollup_status
    ) VALUES
      ('t1','b1','Urgent Task','todo','simple','alice','urgente','2099-01-01','["bug"]',NULL,'[{"id":"n1","author":"alice","content":"seed note","created_at":"2024-01-01T00:00:00Z"}]',NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t2','b1','Overdue Task','todo','simple',NULL,NULL,'2020-01-01',NULL,NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t3','b1','Linked Task','todo','simple',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z','child-board-1',NULL,NULL),
      ('t4','b1','Done Task','done','simple',NULL,NULL,'2020-01-01',NULL,NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t5','b1','Due Today Task','todo','simple',NULL,NULL,date('now','localtime'),'[]',NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t6','b1','Due This Week Task','todo','simple',NULL,NULL,date('now','localtime','+3 days'),'["backend"]',NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t7','b1','High Priority Task','todo','simple',NULL,'alta','2099-02-01','[]',NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL);
    INSERT INTO task_history (board_id, task_id, action, "by", "at", details)
      VALUES
        ('b1','t2','update','alice', '2020-01-01T00:00:00Z', '{"source":"old"}'),
        ('b1','t1','create','alice', datetime('now','localtime'), '{"source":"seed"}');
  `)
}

export function createTestDb(): string {
  const filePath = `${tmpdir()}/taskflow-test-${randomBytes(4).toString('hex')}.db`
  const db = new Database(filePath)
  _seedDb(db)
  db.close()
  return filePath
}

function createTestDbSeeded(dir: string): string {
  const dbPath = path.join(dir, 'taskflow-test.db')
  const db = new Database(dbPath)
  _seedDb(db)
  db.close()
  return dbPath
}

export async function removeTestDb(filePath: string) {
  await rm(filePath, { force: true })
}

describe('test DB factory', () => {
  it('creates a usable SQLite file with seed data', async () => {
    const dbPath = createTestDb()
    const db = new Database(dbPath)
    const rows = db.prepare('SELECT id FROM tasks WHERE board_id = ?').all('b1')
    db.close()
    await removeTestDb(dbPath)
    expect(rows).toHaveLength(7)
  })
})

describe('parseActorArg', () => {
  it('accepts a valid taskflow_person actor', () => {
    const actor = parseActorArg({
      actor_type: 'taskflow_person',
      source_auth: 'jwt',
      user_id: 'u1',
      board_id: 'b1',
      person_id: 'alice',
      display_name: 'Alice',
    })
    expect(actor.actor_type).toBe('taskflow_person')
    if (actor.actor_type === 'taskflow_person') {
      expect(actor.person_id).toBe('alice')
      expect(actor.display_name).toBe('Alice')
    }
  })

  it('accepts a valid api_service actor', () => {
    const actor = parseActorArg({
      actor_type: 'api_service',
      source_auth: 'api_token',
      board_id: 'b1',
      service_name: 'taskflow-api',
    })
    expect(actor.actor_type).toBe('api_service')
    if (actor.actor_type === 'api_service') {
      expect(actor.service_name).toBe('taskflow-api')
    }
  })

  it('rejects null', () => {
    expect(() => parseActorArg(null)).toThrow('actor: expected object')
  })

  it('rejects unknown actor_type', () => {
    expect(() => parseActorArg({ actor_type: 'unknown' })).toThrow('actor.actor_type: unknown value')
  })

  it('rejects taskflow_person with missing person_id', () => {
    expect(() => parseActorArg({
      actor_type: 'taskflow_person',
      source_auth: 'jwt',
      user_id: 'u1',
      board_id: 'b1',
      display_name: 'Alice',
    })).toThrow('actor.person_id: required string')
  })

  it('rejects api_service with wrong source_auth', () => {
    expect(() => parseActorArg({
      actor_type: 'api_service',
      source_auth: 'jwt',
      board_id: 'b1',
      service_name: 'taskflow-api',
    })).toThrow('actor.source_auth: expected "api_token"')
  })
})

import { normalizeEngineNotificationEvents, parseNotificationEvents } from './taskflow-mcp-server.js'

describe('parseNotificationEvents', () => {
  it('accepts a valid deferred_notification', () => {
    const result = parseNotificationEvents([
      { kind: 'deferred_notification', target_person_id: 'alice', message: 'Hello' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('deferred_notification')
    if (result[0].kind === 'deferred_notification') {
      expect(result[0].target_person_id).toBe('alice')
      expect(result[0].message).toBe('Hello')
    }
  })

  it('accepts a valid direct_message', () => {
    const result = parseNotificationEvents([
      { kind: 'direct_message', target_chat_jid: 'jid@s.whatsapp.net', message: 'Hi there' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('direct_message')
    if (result[0].kind === 'direct_message') {
      expect(result[0].target_chat_jid).toBe('jid@s.whatsapp.net')
      expect(result[0].message).toBe('Hi there')
    }
  })

  it('accepts a valid parent_notification', () => {
    const result = parseNotificationEvents([
      { kind: 'parent_notification', parent_group_jid: 'group@g.us', message: 'Update' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('parent_notification')
    if (result[0].kind === 'parent_notification') {
      expect(result[0].parent_group_jid).toBe('group@g.us')
      expect(result[0].message).toBe('Update')
    }
  })

  it('rejects items with unknown kind', () => {
    expect(() => parseNotificationEvents([
      { kind: 'unknown_kind', message: 'Should fail' },
    ])).toThrow(/unknown value/)
  })

  it('returns empty array for nullish input and rejects malformed non-array input', () => {
    expect(parseNotificationEvents(null)).toEqual([])
    expect(parseNotificationEvents(undefined)).toEqual([])
    expect(() => parseNotificationEvents('a string')).toThrow(/expected array/)
    expect(() => parseNotificationEvents(42)).toThrow(/expected array/)
  })

  it('rejects empty message string', () => {
    expect(() => parseNotificationEvents([
      { kind: 'deferred_notification', target_person_id: 'alice', message: '' },
    ])).toThrow(/message/)
    expect(() => parseNotificationEvents([
      { kind: 'direct_message', target_chat_jid: 'jid@s.whatsapp.net', message: '' },
    ])).toThrow(/message/)
    expect(() => parseNotificationEvents([
      { kind: 'parent_notification', parent_group_jid: 'group@g.us', message: '' },
    ])).toThrow(/message/)
  })

  it('rejects deferred_notification missing required field target_person_id', () => {
    expect(() => parseNotificationEvents([
      { kind: 'deferred_notification', message: 'No person' },
    ])).toThrow(/target_person_id/)
  })
})

describe('normalizeEngineNotificationEvents', () => {
  it('normalizes group-routed, deferred, and parent notifications', () => {
    const result = normalizeEngineNotificationEvents({
      notifications: [
        { notification_group_jid: 'group-1@g.us', target_person_id: 'alice', message: 'group update' },
        { target_person_id: 'bob', message: 'deferred update' },
      ],
      parent_notification: { parent_group_jid: 'parent@g.us', message: 'parent update' },
    })

    expect(result).toEqual([
      { kind: 'direct_message', target_chat_jid: 'group-1@g.us', message: 'group update' },
      { kind: 'deferred_notification', target_person_id: 'bob', message: 'deferred update' },
      { kind: 'parent_notification', parent_group_jid: 'parent@g.us', message: 'parent update' },
    ])
  })

  it('preserves same-call parent dedup behavior', () => {
    const result = normalizeEngineNotificationEvents({
      notifications: [
        { notification_group_jid: 'parent@g.us', target_person_id: 'alice', message: 'already delivered' },
      ],
      parent_notification: { parent_group_jid: 'parent@g.us', message: 'duplicate parent update' },
    })

    expect(result).toEqual([
      { kind: 'direct_message', target_chat_jid: 'parent@g.us', message: 'already delivered' },
    ])
  })

  it('rejects malformed engine notification entries', () => {
    expect(() => normalizeEngineNotificationEvents({
      notifications: [{ message: 'missing route' }],
    })).toThrow(/missing routing target/)
  })
})

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from './taskflow-mcp-server.js'
import { TaskflowEngine } from './taskflow-engine.js'

// Helper: create a fully-initialized in-memory DB via the engine
function createEngineDb(boardId: string): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE boards (
      id TEXT PRIMARY KEY, short_code TEXT, name TEXT NOT NULL DEFAULT '',
      board_role TEXT NOT NULL DEFAULT 'hierarchy',
      group_folder TEXT NOT NULL DEFAULT '',
      group_jid TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE board_people (
      board_id TEXT NOT NULL, person_id TEXT NOT NULL, name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY (board_id, person_id)
    );
    CREATE TABLE board_id_counters (
      board_id TEXT NOT NULL, prefix TEXT NOT NULL,
      next_number INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (board_id, prefix)
    );
    CREATE TABLE tasks (
      id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'simple',
      title TEXT NOT NULL,
      assignee TEXT,
      next_action TEXT,
      waiting_for TEXT,
      column TEXT DEFAULT 'inbox',
      priority TEXT,
      due_date TEXT,
      description TEXT,
      labels TEXT DEFAULT '[]',
      blocked_by TEXT DEFAULT '[]',
      reminders TEXT DEFAULT '[]',
      next_note_id INTEGER DEFAULT 1,
      notes TEXT DEFAULT '[]',
      _last_mutation TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      child_exec_enabled INTEGER DEFAULT 0,
      child_exec_board_id TEXT,
      child_exec_person_id TEXT,
      child_exec_rollup_status TEXT,
      child_exec_last_rollup_at TEXT,
      child_exec_last_rollup_summary TEXT,
      linked_parent_board_id TEXT,
      linked_parent_task_id TEXT,
      subtasks TEXT,
      recurrence TEXT,
      current_cycle TEXT,
      parent_task_id TEXT,
      max_cycles INTEGER,
      recurrence_end_date TEXT,
      recurrence_anchor TEXT,
      participants TEXT,
      scheduled_at TEXT,
      requires_close_approval INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      PRIMARY KEY (board_id, id)
    );
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id TEXT NOT NULL, task_id TEXT NOT NULL,
      action TEXT NOT NULL, "by" TEXT,
      "at" TEXT NOT NULL, details TEXT, trigger_turn_id TEXT
    );
    INSERT INTO boards (id, short_code, name) VALUES ('${boardId}', 'TF', 'Test Board');
    INSERT INTO board_people (board_id, person_id, name, role) VALUES ('${boardId}', 'alice', 'alice', 'manager');
    INSERT INTO board_id_counters (board_id, prefix, next_number) VALUES ('${boardId}', 'T', 1);
    CREATE TABLE IF NOT EXISTS child_board_registrations (parent_board_id TEXT, person_id TEXT NOT NULL, child_board_id TEXT, PRIMARY KEY (parent_board_id, person_id));
  `.replace(/\${boardId}/g, boardId))
  new TaskflowEngine(db, boardId) // run schema migrations
  return db
}

describe('api_create_simple_task', () => {
  it('registerTools registers api_create_simple_task', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, short_code TEXT, name TEXT NOT NULL DEFAULT '', board_role TEXT NOT NULL DEFAULT 'hierarchy', group_folder TEXT NOT NULL DEFAULT '', group_jid TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS board_people (board_id TEXT NOT NULL, person_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active', PRIMARY KEY (board_id, person_id));
    `)
    const toolNames: string[] = []
    const mockServer = {
      tool: (name: string, ...rest: unknown[]) => { toolNames.push(name) },
    } as unknown as McpServer
    registerTools(mockServer, db)
    expect(toolNames).toContain('api_create_simple_task')
  })

  it('api_create_simple_task returns success with full task data including created_by', async () => {
    const boardId = 'b1'
    const db = createEngineDb(boardId)
    const toolHandlers = new Map<string, (params: any) => Promise<any>>()
    const mockServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: (params: any) => Promise<any>) => {
        toolHandlers.set(name, handler)
      },
    } as unknown as McpServer
    registerTools(mockServer, db)

    const handler = toolHandlers.get('api_create_simple_task')!
    expect(handler).toBeDefined()

    const response = await handler({
      board_id: boardId,
      title: 'Test Task from MCP',
      sender_name: 'alice',
      priority: 'normal',
    })

    const result = JSON.parse(response.content[0].text)
    expect(result.success).toBe(true)
    expect(result.data).toBeDefined()
    expect(result.data.title).toBe('Test Task from MCP')
    expect(result.data.board_id).toBe(boardId)
    expect(result.data.board_code).toBe('TF')
    expect(result.data.created_by).toBe('alice')
    expect(result.data.column).toBe('inbox')
    expect(typeof result.data.id).toBe('string')
    expect(Array.isArray(result.notification_events)).toBe(true)
  })

  it('api_create_simple_task propagates engine error as JSON (not thrown)', async () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, short_code TEXT, name TEXT NOT NULL DEFAULT '', board_role TEXT NOT NULL DEFAULT 'hierarchy', group_folder TEXT NOT NULL DEFAULT '', group_jid TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS board_people (board_id TEXT NOT NULL, person_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active', PRIMARY KEY (board_id, person_id));
      INSERT INTO boards (id, short_code, name) VALUES ('b-err', 'XX', 'Error Board');
    `)
    const toolHandlers = new Map<string, (params: any) => Promise<any>>()
    const mockServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: (params: any) => Promise<any>) => {
        toolHandlers.set(name, handler)
      },
    } as unknown as McpServer
    registerTools(mockServer, db)

    const handler = toolHandlers.get('api_create_simple_task')!

    const response = await handler({
      board_id: 'b-err',
      title: 'Should fail',
      sender_name: 'unknownperson',
      assignee: 'nonexistent-assignee',
    })

    const result = JSON.parse(response.content[0].text)
    expect(response.content[0].type).toBe('text')
    expect(typeof result).toBe('object')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })
})