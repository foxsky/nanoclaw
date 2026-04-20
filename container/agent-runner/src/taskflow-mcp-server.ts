import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import Database from 'better-sqlite3'

// Redirect all console output to stderr — stdout is the exclusive JSON-RPC channel
console.log = (...args) => process.stderr.write(args.join(' ') + '\n')
console.info = (...args) => process.stderr.write(args.join(' ') + '\n')
console.warn = (...args) => process.stderr.write(args.join(' ') + '\n')
console.error = (...args) => process.stderr.write(args.join(' ') + '\n')

function safeParseJsonArray(val: unknown): unknown[] {
  if (!val || typeof val !== 'string') return []
  try { return JSON.parse(val) as unknown[] } catch { return [] }
}

function serializeTask(row: Record<string, unknown>) {
  return {
    id: row['id'],
    board_id: row['board_id'],
    board_code: row['board_code'] ?? null,
    title: row['title'],
    assignee: (row['assignee'] as string | null) ?? null,
    column: (row['column'] as string) || 'inbox',
    priority: (row['priority'] as string | null) ?? null,
    due_date: (row['due_date'] as string | null) ?? null,
    type: (row['type'] as string) || 'simple',
    labels: safeParseJsonArray(row['labels']),
    description: row['description'] ?? null,
    notes: null,
    parent_task_id: row['parent_task_id'] ?? null,
    parent_task_title: row['parent_task_title'] ?? null,
    scheduled_at: row['scheduled_at'] ?? null,
    created_at: row['created_at'],
    updated_at: row['updated_at'],
    child_exec_board_id: row['child_exec_board_id'] ?? null,
    child_exec_person_id: row['child_exec_person_id'] ?? null,
    child_exec_rollup_status: row['child_exec_rollup_status'] ?? null,
  }
}

function serializeActivityRow(row: Record<string, unknown>) {
  const rawDetails = row['details']
  let details: unknown = null
  if (rawDetails !== null && rawDetails !== undefined) {
    try { details = JSON.parse(rawDetails as string) } catch { details = rawDetails }
  }
  return {
    id: row['id'],
    board_id: row['board_id'],
    task_id: row['task_id'],
    action: row['action'],
    by: row['by'],
    at: row['at'],
    details,
  }
}

function parseArgs(): { db: string } {
  const idx = process.argv.indexOf('--db')
  if (idx === -1 || !process.argv[idx + 1]) {
    process.stderr.write('Error: --db <path> is required\n')
    process.exit(1)
  }
  return { db: process.argv[idx + 1] }
}

function registerTools(server: McpServer, db: Database.Database): void {
  server.tool(
    'api_board_activity',
    'Board activity log',
    {
      board_id: z.string(),
      mode: z.enum(['changes_today', 'changes_since']).optional(),
      since: z.string().optional(),
    },
    async (args) => {
      const mode = args.mode ?? 'changes_today'
      if (mode === 'changes_since' && !args.since) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'since is required for changes_since' }) }] }
      }
      let rows: Record<string, unknown>[]
      if (mode === 'changes_since') {
        rows = db.prepare(
          `SELECT id, board_id, task_id, action, "by", "at", details FROM task_history WHERE board_id = ? AND "at" >= ? ORDER BY id DESC`
        ).all(args.board_id, args.since!) as Record<string, unknown>[]
      } else {
        rows = db.prepare(
          `SELECT id, board_id, task_id, action, "by", "at", details FROM task_history WHERE board_id = ? AND date("at") = date('now', 'localtime') ORDER BY id DESC`
        ).all(args.board_id) as Record<string, unknown>[]
      }
      const serialized = rows.map(serializeActivityRow)
      return { content: [{ type: 'text', text: JSON.stringify({ rows: serialized }) }] }
    }
  )

  server.tool(
    'api_filter_board_tasks',
    'Board task filter',
    {
      board_id: z.string(),
      filter: z.string(),
      label: z.string().optional(),
    },
    async (args) => {
      const filterType = args.filter.trim().toLowerCase()
      const validFilters = ['overdue', 'due_today', 'due_this_week', 'urgent', 'high_priority', 'by_label']
      if (!validFilters.includes(filterType)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid filter type' }) }] }
      }
      if (filterType === 'by_label' && (!args.label || args.label.trim() === '')) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'label is required for by_label filter' }) }] }
      }

      const rows = db.prepare(`
        SELECT t.id, t.board_id, b.short_code AS board_code,
               t.title, t.assignee, t."column", t.priority, t.due_date,
               t.type, t.labels, t.description, t.parent_task_id,
               t.scheduled_at, t.created_at, t.updated_at,
               t.child_exec_board_id, t.child_exec_person_id, t.child_exec_rollup_status
        FROM tasks t
        JOIN boards b ON b.id = t.board_id
        WHERE t.board_id = ?
      `).all(args.board_id) as Record<string, unknown>[]

      const serialized = rows.map(serializeTask)

      const todayStr = new Date().toISOString().slice(0, 10)
      const weekEnd = new Date()
      weekEnd.setDate(weekEnd.getDate() + 6)
      const weekEndStr = weekEnd.toISOString().slice(0, 10)

      let filtered: ReturnType<typeof serializeTask>[]
      if (filterType === 'overdue') {
        filtered = serialized.filter(t =>
          t.due_date != null && t.column !== 'done' && t.due_date < todayStr
        )
      } else if (filterType === 'due_today') {
        filtered = serialized.filter(t => t.due_date === todayStr)
      } else if (filterType === 'due_this_week') {
        filtered = serialized.filter(t =>
          t.due_date != null &&
          t.due_date >= todayStr &&
          t.due_date <= weekEndStr
        )
      } else if (filterType === 'urgent') {
        filtered = serialized.filter(t => t.priority === 'urgente')
      } else if (filterType === 'high_priority') {
        filtered = serialized.filter(t => t.priority === 'alta')
      } else {
        // by_label
        const labelQuery = args.label!.trim().toLowerCase()
        filtered = serialized.filter(t =>
          Array.isArray(t.labels) &&
          (t.labels as string[]).some(l => l.toLowerCase() === labelQuery)
        )
      }

      filtered.sort((a, b) => {
        const aN = a.due_date == null
        const bN = b.due_date == null
        if (aN && bN) return 0
        if (aN) return 1
        if (bN) return -1
        return a.due_date! < b.due_date! ? -1 : 1
      })

      return { content: [{ type: 'text', text: JSON.stringify({ rows: filtered }) }] }
    }
  )

  server.tool(
    'api_linked_tasks',
    'Board linked tasks',
    {
      board_id: z.string(),
    },
    async (args) => {
      const rows = db.prepare(`
        SELECT t.id, t.board_id, b.short_code AS board_code,
               t.title, t.assignee, t."column", t.priority, t.due_date,
               t.type, t.labels, t.description, t.parent_task_id,
               (SELECT pt.title FROM tasks pt WHERE pt.id = t.parent_task_id LIMIT 1) AS parent_task_title,
               t.scheduled_at, t.created_at, t.updated_at,
               t.child_exec_board_id, t.child_exec_person_id, t.child_exec_rollup_status
        FROM tasks t
        JOIN boards b ON b.id = t.board_id
        WHERE t.board_id = ? AND t.child_exec_board_id IS NOT NULL
        ORDER BY COALESCE(t.updated_at, t.created_at) DESC, t.id ASC
      `).all(args.board_id) as Record<string, unknown>[]
      return { content: [{ type: 'text', text: JSON.stringify({ rows: rows.map(r => serializeTask(r)) }) }] }
    }
  )
}

async function shutdown(server: McpServer, db: Database.Database): Promise<void> {
  try { await server.close() } catch {}
  db.close()
  process.exit(0)
}

async function main() {
  const { db: dbPath } = parseArgs()

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  const server = new McpServer({
    name: 'taskflow-mcp-server',
    version: '0.1.0',
  })

  registerTools(server, db)

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Emit ready sentinel AFTER transport is connected and listening
  process.stderr.write('MCP server ready\n')

  process.on('SIGTERM', () => void shutdown(server, db))
  process.on('SIGINT',  () => void shutdown(server, db))
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`)
  process.exit(1)
})
