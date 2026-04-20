import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'

const SERVER_BIN = path.resolve(__dirname, '../dist/taskflow-mcp-server.js')
const TEST_DB = process.env.TASKFLOW_DB_PATH || '/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db'

describe('taskflow-mcp-server', () => {
  let proc: ReturnType<typeof spawn> | null = null

  afterEach(async () => {
    if (proc) {
      await new Promise<void>((res) => { proc!.on('exit', () => res()); proc!.kill() })
      proc = null
    }
  })

  it('emits ready sentinel on stderr after startup', async () => {
    proc = spawn('node', [SERVER_BIN, '--db', TEST_DB])
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
})
