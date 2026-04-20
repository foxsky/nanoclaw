import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'

const SERVER_BIN = path.resolve(__dirname, '../dist/taskflow-mcp-server.js')
const TEST_DB = process.env.TASKFLOW_DB_PATH || '/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db'

describe('taskflow-mcp-server', () => {
  let proc: ReturnType<typeof spawn> | null = null

  afterEach(() => {
    proc?.kill()
    proc = null
  })

  it('emits ready sentinel on stderr after startup', async () => {
    proc = spawn('node', [SERVER_BIN, '--db', TEST_DB])
    const sentinel = await new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input: proc!.stderr! })
      const timeout = setTimeout(() => reject(new Error('timeout waiting for sentinel')), 5000)
      rl.on('line', (line) => {
        if (line.includes('MCP server ready')) {
          clearTimeout(timeout)
          resolve(line)
        }
      })
      proc!.on('exit', (code) => reject(new Error(`exited with code ${code}`)))
    })
    expect(sentinel).toContain('MCP server ready')
  })
})
