import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { TaskflowEngine } from './taskflow-engine.js'

// Redirect all console output to stderr — stdout is the exclusive JSON-RPC channel
console.log = (...args) => process.stderr.write(args.join(' ') + '\n')
console.info = (...args) => process.stderr.write(args.join(' ') + '\n')
console.warn = (...args) => process.stderr.write(args.join(' ') + '\n')
console.error = (...args) => process.stderr.write(args.join(' ') + '\n')

type TaskflowPersonActor = {
  actor_type: 'taskflow_person'
  source_auth: 'jwt'
  user_id: string
  board_id: string
  person_id: string
  display_name: string
}

type ApiServiceActor = {
  actor_type: 'api_service'
  source_auth: 'api_token'
  board_id: string
  service_name: string
}

type ResolvedActor = TaskflowPersonActor | ApiServiceActor

export function parseActorArg(raw: unknown): ResolvedActor {
  if (!raw || typeof raw !== 'object') {
    throw new Error('actor: expected object')
  }
  const obj = raw as Record<string, unknown>
  if (obj.actor_type === 'taskflow_person') {
    if (typeof obj.user_id !== 'string' || !obj.user_id) throw new Error('actor.user_id: required string')
    if (typeof obj.board_id !== 'string' || !obj.board_id) throw new Error('actor.board_id: required string')
    if (typeof obj.person_id !== 'string' || !obj.person_id) throw new Error('actor.person_id: required string')
    if (typeof obj.display_name !== 'string' || !obj.display_name) throw new Error('actor.display_name: required string')
    if (obj.source_auth !== 'jwt') throw new Error('actor.source_auth: expected "jwt" for taskflow_person')
    return obj as TaskflowPersonActor
  }
  if (obj.actor_type === 'api_service') {
    if (typeof obj.board_id !== 'string' || !obj.board_id) throw new Error('actor.board_id: required string')
    if (typeof obj.service_name !== 'string' || !obj.service_name) throw new Error('actor.service_name: required string')
    if (obj.source_auth !== 'api_token') throw new Error('actor.source_auth: expected "api_token" for api_service')
    return obj as ApiServiceActor
  }
  throw new Error(`actor.actor_type: unknown value "${String(obj.actor_type)}"`)
}

function contentFromResult(result: { success: boolean; data?: unknown; error?: string }) {
  if (!result.success) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error ?? 'unknown_error' }) }] }
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify({ rows: result.data ?? [] }) }] }
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
      const engine = new TaskflowEngine(db, args.board_id, { readonly: true })
      return contentFromResult(engine.apiBoardActivity({ mode: args.mode, since: args.since }))
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
      const engine = new TaskflowEngine(db, args.board_id, { readonly: true })
      return contentFromResult(engine.apiFilterBoardTasks({ filter: args.filter, label: args.label }))
    }
  )

  server.tool(
    'api_linked_tasks',
    'Board linked tasks',
    {
      board_id: z.string(),
    },
    async (args) => {
      const engine = new TaskflowEngine(db, args.board_id, { readonly: true })
      return contentFromResult(engine.apiLinkedTasks())
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`)
    process.exit(1)
  })
}
