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

  // TODO(Task 2): move sentinel to AFTER McpServer.connect(transport) — emitting here
  // is correct for the skeleton but Task 2 must gate it behind the transport being live.
  process.stderr.write('MCP server ready\n')

  // Keep process alive
  process.stdin.resume()
  process.on('SIGTERM', () => shutdown(db))
  process.on('SIGINT', () => shutdown(db))
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}
`)
  process.exit(1)
})
