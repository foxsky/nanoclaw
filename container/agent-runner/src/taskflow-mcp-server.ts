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
    assignee: row['assignee'] ?? null,
    column: (row['column'] as string) || 'inbox',
    priority: row['priority'] ?? null,
    due_date: row['due_date'] ?? null,
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

function parseArgs(): { db: string } {
  const idx = process.argv.indexOf('--db')
  if (idx === -1 || !process.argv[idx + 1]) {
    process.stderr.write('Error: --db <path> is required\n')
    process.exit(1)
  }
  return { db: process.argv[idx + 1] }
}

function registerTools(server: McpServer, db: Database.Database): void {
  void db // suppress unused-variable warning until tools query the DB in a later phase

  server.tool(
    'api_board_activity',
    'Board activity log',
    {
      board_id: z.string(),
      mode: z.enum(['changes_today', 'changes_since']).optional(),
      since: z.string().optional(),
    },
    async (_args) => {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'not_implemented' }) }] }
    }
  )

  server.tool(
    'api_filter_board_tasks',
    'Board task filter',
    {
      board_id: z.string(),
      filter: z.string(),
    },
    async (_args) => {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'not_implemented' }) }] }
    }
  )

  server.tool(
    'api_linked_tasks',
    'Board linked tasks',
    {
      board_id: z.string(),
    },
    async (_args) => {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'not_implemented' }) }] }
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
