import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import Database from 'better-sqlite3'

// Redirect all console output to stderr — stdout is the exclusive JSON-RPC channel
console.log = (...args) => process.stderr.write(args.join(' ') + '\n')
console.info = (...args) => process.stderr.write(args.join(' ') + '\n')
console.warn = (...args) => process.stderr.write(args.join(' ') + '\n')
console.error = (...args) => process.stderr.write(args.join(' ') + '\n')

function parseArgs(): { db: string } {
  const idx = process.argv.indexOf('--db')
  if (idx === -1 || !process.argv[idx + 1]) {
    process.stderr.write('Error: --db <path> is required\n')
    process.exit(1)
  }
  return { db: process.argv[idx + 1] }
}

function shutdown(db: Database.Database) {
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

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Emit ready sentinel AFTER transport is connected and listening
  process.stderr.write('MCP server ready\n')

  process.on('SIGTERM', () => shutdown(db))
  process.on('SIGINT', () => shutdown(db))
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`)
  process.exit(1)
})
