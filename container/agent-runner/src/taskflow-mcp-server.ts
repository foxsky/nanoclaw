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

type DeferredNotificationEvent = {
  kind: 'deferred_notification'
  target_person_id: string
  message: string
}

type DirectMessageEvent = {
  kind: 'direct_message'
  target_chat_jid: string
  message: string
}

type ParentNotificationEvent = {
  kind: 'parent_notification'
  parent_group_jid: string
  message: string
}

export type NotificationEvent =
  | DeferredNotificationEvent
  | DirectMessageEvent
  | ParentNotificationEvent

type RawEngineNotification = {
  target_kind?: 'group' | 'dm'
  target_person_id?: string
  notification_group_jid?: string | null
  target_chat_jid?: string | null
  message?: string
}

type RawParentNotification = {
  parent_group_jid?: string
  message?: string
}

export type ApiMutationResult<T = unknown> = {
  success: true
  data: T
  notification_events: NotificationEvent[]
} | {
  success: false
  error_code: string
  error: string
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label}: required non-empty string`)
  }
  return value
}

function parseNotificationEvent(raw: unknown, label: string): NotificationEvent {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${label}: expected object`)
  }
  const obj = raw as Record<string, unknown>
  if (obj.kind === 'deferred_notification') {
    return {
      kind: 'deferred_notification',
      target_person_id: requireNonEmptyString(obj.target_person_id, `${label}.target_person_id`),
      message: requireNonEmptyString(obj.message, `${label}.message`),
    }
  }
  if (obj.kind === 'direct_message') {
    return {
      kind: 'direct_message',
      target_chat_jid: requireNonEmptyString(obj.target_chat_jid, `${label}.target_chat_jid`),
      message: requireNonEmptyString(obj.message, `${label}.message`),
    }
  }
  if (obj.kind === 'parent_notification') {
    return {
      kind: 'parent_notification',
      parent_group_jid: requireNonEmptyString(obj.parent_group_jid, `${label}.parent_group_jid`),
      message: requireNonEmptyString(obj.message, `${label}.message`),
    }
  }
  throw new Error(`${label}.kind: unknown value "${String(obj.kind)}"`)
}

export function parseNotificationEvents(raw: unknown): NotificationEvent[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) {
    throw new Error('notification_events: expected array')
  }
  return raw.map((item, index) => parseNotificationEvent(item, `notification_events[${index}]`))
}

export function normalizeEngineNotificationEvents(raw: unknown): NotificationEvent[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('mutation_result: expected object')
  }
  const result = raw as Record<string, unknown>
  const normalized: NotificationEvent[] = []
  const notifiedJids = new Set<string>()

  const notifications = result.notifications
  if (notifications != null) {
    if (!Array.isArray(notifications)) {
      throw new Error('mutation_result.notifications: expected array')
    }
    for (let index = 0; index < notifications.length; index++) {
      const item = notifications[index]
      if (!item || typeof item !== 'object') {
        throw new Error(`mutation_result.notifications[${index}]: expected object`)
      }
      const notification = item as RawEngineNotification
      const message = requireNonEmptyString(notification.message, `mutation_result.notifications[${index}].message`)
      if (notification.target_kind === 'dm') {
        const targetChatJid = requireNonEmptyString(
          notification.target_chat_jid,
          `mutation_result.notifications[${index}].target_chat_jid`,
        )
        normalized.push({ kind: 'direct_message', target_chat_jid: targetChatJid, message })
        notifiedJids.add(targetChatJid)
        continue
      }
      if (typeof notification.notification_group_jid === 'string' && notification.notification_group_jid) {
        normalized.push({
          kind: 'direct_message',
          target_chat_jid: notification.notification_group_jid,
          message,
        })
        notifiedJids.add(notification.notification_group_jid)
        continue
      }
      if (typeof notification.target_person_id === 'string' && notification.target_person_id) {
        normalized.push({
          kind: 'deferred_notification',
          target_person_id: notification.target_person_id,
          message,
        })
        continue
      }
      throw new Error(
        `mutation_result.notifications[${index}]: missing routing target`,
      )
    }
  }

  const parentNotification = result.parent_notification
  if (parentNotification != null) {
    if (!parentNotification || typeof parentNotification !== 'object') {
      throw new Error('mutation_result.parent_notification: expected object')
    }
    const parent = parentNotification as RawParentNotification
    const parentGroupJid = requireNonEmptyString(
      parent.parent_group_jid,
      'mutation_result.parent_notification.parent_group_jid',
    )
    const message = requireNonEmptyString(
      parent.message,
      'mutation_result.parent_notification.message',
    )
    if (!notifiedJids.has(parentGroupJid)) {
      normalized.push({
        kind: 'parent_notification',
        parent_group_jid: parentGroupJid,
        message,
      })
    }
  }

  return normalized
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

export function registerTools(server: McpServer, db: Database.Database): void {
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
  server.tool(
    'api_create_simple_task',
    'Create a simple task via the REST API',
    {
      board_id: z.string(),
      title: z.string(),
      sender_name: z.string(),
      assignee: z.string().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      due_date: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    },
    (params) => {
      try {
        const engine = new TaskflowEngine(db, params.board_id)
        const result = engine.create({
          board_id: params.board_id,
          type: 'inbox',
          title: params.title,
          sender_name: params.sender_name,
          assignee: params.assignee,
          priority: params.priority as 'low' | 'normal' | 'high' | 'urgent' | undefined,
          due_date: params.due_date ?? undefined,
        })
        if (!result.success) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: result.error }) }] }
        }
        if (!result.task_id) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'engine returned success without task_id' }) }] }
        }
        const taskId = result.task_id
        const row = db.prepare(
          `SELECT t.*, b.short_code AS board_code FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ?`
        ).get(taskId) as Record<string, unknown>
        const data = engine.serializeApiTask(row)
        const notification_events = (result.notifications ?? [])
          .filter(n => n.target_person_id)
          .map(n => ({ kind: 'deferred_notification', board_id: params.board_id, target_person_id: n.target_person_id!, message: n.message }))
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data, notification_events }) }] }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }] }
      }
    }
  )

  server.tool(
    'api_update_simple_task',
    'Update a simple task via the REST API (field updates, column move, reassign)',
    {
      board_id: z.string(),
      task_id: z.string(),
      sender_name: z.string(),
      sender_is_service: z.boolean().optional(),
      column: z.string().optional(),
      title: z.string().optional(),
      description: z.string().nullable().optional(),
      assignee: z.string().nullable().optional(),
      priority: z.string().optional(),
      due_date: z.string().nullable().optional(),
    },
    (params) => {
      try {
        const engine = new TaskflowEngine(db, params.board_id)

        const existing = db.prepare(
          'SELECT t.*, b.short_code AS board_code FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ? AND t.board_id = ?'
        ).get(params.task_id, params.board_id) as Record<string, unknown> | undefined
        if (!existing) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error_code: 'not_found', error: `Task not found: ${params.task_id}` }) }] }
        }

        const senderPerson = params.sender_is_service
          ? undefined
          : db.prepare(
              'SELECT person_id, role FROM board_people WHERE board_id = ? AND name = ?'
            ).get(params.board_id, params.sender_name) as { person_id: string; role: string } | undefined

        if (!params.sender_is_service) {
          const isGestor = senderPerson?.role === 'Gestor'
          if (!isGestor) {
            const createdBy = existing['created_by'] as string | null
            const assignee = existing['assignee'] as string | null
            const isCreatorOrUnowned = createdBy === null || createdBy === params.sender_name
            const isAssignee = assignee !== null && assignee === params.sender_name
            if (!isCreatorOrUnowned && !isAssignee) {
              return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error_code: 'actor_type_not_allowed', error: 'Not authorized to modify this task' }) }] }
            }
          }
        }

        if ('column' in params && params.column === 'done' && existing['requires_close_approval']) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error_code: 'conflict', error: 'Task requires close approval before moving to done' }) }] }
        }

        let resolvedAssignee: string | null | undefined = undefined
        let newAssigneePersonId: string | null = null
        if ('assignee' in params) {
          if (params.assignee === null) {
            resolvedAssignee = null
          } else {
            const person = db.prepare(
              'SELECT person_id, name FROM board_people WHERE board_id = ? AND (name = ? OR person_id = ?)'
            ).get(params.board_id, params.assignee, params.assignee) as { person_id: string; name: string } | undefined
            if (!person) {
              return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error_code: 'validation_error', error: `Assignee not found: ${params.assignee}` }) }] }
            }
            resolvedAssignee = person.name
            newAssigneePersonId = person.person_id
          }
        }

        const now = new Date().toISOString()
        const setClauses: string[] = ['updated_at = ?']
        const setValues: unknown[] = [now]

        if ('column' in params) { setClauses.push('"column" = ?'); setValues.push(params.column) }
        if ('title' in params) { setClauses.push('title = ?'); setValues.push(params.title) }
        if ('description' in params) { setClauses.push('description = ?'); setValues.push(params.description) }
        if ('assignee' in params) { setClauses.push('assignee = ?'); setValues.push(resolvedAssignee) }
        let resolvedPriority: string | undefined = undefined
        if ('priority' in params) {
          const priorityMap: Record<string, string> = {
            urgent: 'urgente', high: 'alta', normal: 'normal', low: 'baixa',
            urgente: 'urgente', alta: 'alta', baixa: 'baixa',
          }
          resolvedPriority = priorityMap[params.priority!] ?? params.priority
          setClauses.push('priority = ?')
          setValues.push(resolvedPriority)
        }
        if ('due_date' in params) { setClauses.push('due_date = ?'); setValues.push(params.due_date) }

        db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ? AND board_id = ?`)
          .run(...setValues, params.task_id, params.board_id)

        engine.recordHistory(params.task_id, 'updated', params.sender_name)

        const row: Record<string, unknown> = { ...existing, updated_at: now }
        if ('column' in params) row['column'] = params.column
        if ('title' in params) row['title'] = params.title
        if ('description' in params) row['description'] = params.description
        if ('assignee' in params) row['assignee'] = resolvedAssignee
        if ('priority' in params) row['priority'] = resolvedPriority
        if ('due_date' in params) row['due_date'] = params.due_date
        const data = engine.serializeApiTask(row)

        const notification_events: Array<{ kind: string; board_id: string; target_person_id: string; message: string }> = []
        if (newAssigneePersonId) {
          if (!senderPerson || senderPerson.person_id !== newAssigneePersonId) {
            notification_events.push({
              kind: 'deferred_notification',
              board_id: params.board_id,
              target_person_id: newAssigneePersonId,
              message: `${params.sender_name} assigned you: ${(row['title'] as string) ?? params.task_id}`,
            })
          }
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data, notification_events }) }] }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error_code: 'internal_error', error: msg }) }] }
      }
    }
  )

  server.tool(
    'api_delete_simple_task',
    'Delete a simple task via the REST API, enforcing creator/Gestor/service ownership',
    {
      board_id: z.string(),
      task_id: z.string(),
      sender_name: z.string(),
      sender_is_service: z.boolean().optional(),
    },
    (params) => {
      const engine = new TaskflowEngine(db, params.board_id)
      const result = engine.apiDeleteSimpleTask(params)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
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
