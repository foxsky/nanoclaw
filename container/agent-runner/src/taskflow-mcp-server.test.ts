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

  it('responds to initialize with protocol version', async () => {
    proc = spawn('node', [SERVER_BIN, '--db', TEST_DB], { stdio: ['pipe', 'pipe', 'pipe'] })

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
    proc = spawn('node', [SERVER_BIN, '--db', TEST_DB], { stdio: ['pipe', 'pipe', 'pipe'] })
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

})