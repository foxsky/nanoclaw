import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'

const SERVER_BIN = path.resolve(__dirname, '../dist/taskflow-mcp-server.js')

describe('taskflow-mcp-server', () => {
  let proc: ReturnType<typeof spawn> | null = null
  let tempDir: string | null = null

  const createTestDb = () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'taskflow-mcp-server-test-'))
    const dbPath = path.join(tempDir, 'taskflow-test.db')
    // The Phase 1 server only needs a writable SQLite file. Placeholder tools do not query schema yet.
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

  it('emits ready sentinel on stderr after startup', async () => {
    const testDb = createTestDb()
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
    const testDb = createTestDb()
    proc = spawn('node', [SERVER_BIN, '--db', testDb], { stdio: ['pipe', 'pipe', 'pipe'] })

    // Wait for ready sentinel
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

    // Send initialize request
    const req = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } }
    })
    proc!.stdin!.write(req + '\n')

    // Read response from stdout
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
    const testDb = createTestDb()
    proc = spawn('node', [SERVER_BIN, '--db', testDb], { stdio: ['pipe', 'pipe', 'pipe'] })
    const lines: any[] = []
    const stdout_rl = createInterface({ input: proc!.stdout! })
    stdout_rl.on('line', (l) => { try { lines.push(JSON.parse(l)) } catch {} })

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
        if (!settled) { settled = true; clearTimeout(t); rl.close(); reject(new Error(`exited ${code}`)) }
      })
    })

    const send = (msg: object) => proc!.stdin!.write(JSON.stringify(msg) + '\n')
    const waitForId = (id: number, timeoutMs = 5000) => new Promise<any>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`timeout waiting for id=${id}`)), timeoutMs)
      const check = setInterval(() => {
        const msg = lines.find(m => m.id === id)
        if (msg) { clearInterval(check); clearTimeout(deadline); resolve(msg) }
      }, 50)
    })

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } } })
    await waitForId(1)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const resp = await waitForId(2)

    const toolNames = resp.result.tools.map((t: any) => t.name)
    expect(toolNames).toContain('api_board_activity')
    expect(toolNames).toContain('api_filter_board_tasks')
    expect(toolNames).toContain('api_linked_tasks')
  })

  it('returns the placeholder payload from tools/call', async () => {
    const testDb = createTestDb2()
    tempDir = testDb
    proc = spawn('node', [SERVER_BIN, '--db', testDb], { stdio: ['pipe', 'pipe', 'pipe'] })
    const lines: any[] = []
    const stdoutRl = createInterface({ input: proc!.stdout! })
    stdoutRl.on('line', (line) => {
      try { lines.push(JSON.parse(line)) } catch {}
    })

    await new Promise<void>((resolve, reject) => {
      const rl = createInterface({ input: proc!.stderr! })
      let settled = false
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; rl.close(); reject(new Error('timeout waiting for sentinel')) }
      }, 5000)
      rl.on('line', (line) => {
        if (line.includes('MCP server ready') && !settled) {
          settled = true
          clearTimeout(timeout)
          rl.close()
          resolve()
        }
      })
      proc!.on('exit', (code) => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          rl.close()
          reject(new Error(`process exited with code ${code}`))
        }
      })
    })

    const send = (msg: object) => proc!.stdin!.write(JSON.stringify(msg) + '\n')
    const waitForId = (id: number, timeoutMs = 5000) => new Promise<any>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`timeout waiting for id=${id}`)), timeoutMs)
      const check = setInterval(() => {
        const msg = lines.find((candidate) => candidate.id === id)
        if (msg) {
          clearInterval(check)
          clearTimeout(deadline)
          resolve(msg)
        }
      }, 50)
    })

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } } })
    await waitForId(1)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'api_board_activity', arguments: { board_id: 'board-001', mode: 'changes_today' } } })
    const resp = await waitForId(2)

    const text = resp.result.content[0].text
    const data = JSON.parse(text)
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
    const dbPath = createTestDb2()
    tempDir = dbPath
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
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'api_board_activity', arguments: { board_id: 'b1', mode: 'changes_today' } } })
    const resp = await waitFor(2)

    const text = resp.result.content[0].text
    const data = JSON.parse(text)
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

})

// ── test DB factory ──────────────────────────────────────────────────────────

import Database from 'better-sqlite3'
import { rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

export function createTestDb(): string {
  const path = `${tmpdir()}/taskflow-test-${randomBytes(4).toString('hex')}.db`
  const db = new Database(path)
  db.exec(`
    CREATE TABLE boards (
      id TEXT PRIMARY KEY, short_code TEXT, name TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL,
      title TEXT NOT NULL, "column" TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'simple',
      assignee TEXT, priority TEXT, due_date TEXT, labels TEXT,
      description TEXT, parent_task_id TEXT, scheduled_at TEXT,
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
    INSERT INTO tasks VALUES
      ('t1','b1','Urgent Task','todo','simple','alice','urgente','2099-01-01','["bug"]',NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t2','b1','Overdue Task','todo','simple',NULL,NULL,'2020-01-01',NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t3','b1','Linked Task','todo','simple',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z','child-board-1',NULL,NULL),
      ('t4','b1','Done Task','done','simple',NULL,NULL,'2020-01-01',NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL);
    INSERT INTO task_history (board_id, task_id, action, "by", "at", details)
      VALUES ('b1','t1','create','alice', datetime('now','localtime'), NULL);
  `)
  db.close()
  return path
}

// Alias used inside the taskflow-mcp-server describe block for tests that need a seeded DB
const createTestDb2 = createTestDb

export async function removeTestDb(path: string) {
  await rm(path, { force: true })
}

describe('test DB factory', () => {
  it('creates a usable SQLite file with seed data', async () => {
    const dbPath = createTestDb()
    const db = new Database(dbPath)
    const rows = db.prepare('SELECT id FROM tasks WHERE board_id = ?').all('b1')
    db.close()
    await removeTestDb(dbPath)
    expect(rows).toHaveLength(4)
  })
})
