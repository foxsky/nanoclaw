import Database from 'better-sqlite3';
import path from 'path';
import type DatabaseType from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { wakeContainer } from '../../container-runner.js';
import { getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getAllMessagingGroups, getMessagingGroup } from '../../db/messaging-groups.js';
import { createDestinationIfAbsent } from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import { getDb as getCentralDb } from '../../db/connection.js';
import { hasTable } from '../../db/connection.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { brPhoneMatchVariants, normalizePhone } from '../../phone.js';
import type { Session } from '../../types.js';
import {
  buildChildWelcomeMessage,
  createBoardFilesystem,
  deliverPlainText,
  fixOwnership,
  markWelcomeSent,
  buildReservedFolderSet,
  pickUniqueAgentFolder,
  resolveParticipantJid,
  sanitizeFolder,
  ensureSessionInbound,
  findBoardByFolder,
  scheduleOnboarding,
  scheduleRunners,
  seedBoardCore,
  TASKFLOW_DB_PATH,
  wireV2,
  type BoardConfigRow,
  type BoardRow,
  type BoardRuntimeConfigRow,
} from './provision-shared.js';
import { newTaskId, nonEmptyString, requireFields } from './util.js';

const REQUIRED = ['person_id', 'person_name', 'person_phone', 'person_role'] as const;

interface ParsedInput {
  personId: string;
  personName: string;
  personPhone: string;
  /** Canonicalized once at parse time so all downstream callers see the same form. */
  canonicalPhone: string;
  personRole: string;
  shortCode: string | null;
  groupFolderOverride: string | null;
  groupNameOverride: string | null;
  triggerTurnId: string | null;
}

function parseInput(content: Record<string, unknown>): ParsedInput | null {
  if (!requireFields(content, REQUIRED)) return null;
  const personPhone = nonEmptyString(content.person_phone)!;
  return {
    personId: nonEmptyString(content.person_id)!,
    personName: nonEmptyString(content.person_name)!,
    personPhone,
    canonicalPhone: normalizePhone(personPhone),
    personRole: nonEmptyString(content.person_role)!,
    shortCode: nonEmptyString(content.short_code)?.toUpperCase() ?? null,
    groupFolderOverride: nonEmptyString(content.group_folder),
    groupNameOverride: nonEmptyString(content.group_name),
    triggerTurnId: nonEmptyString(content.trigger_turn_id),
  };
}

interface ParentLookup {
  parentBoard: BoardRow;
  parentConfig: BoardConfigRow;
  parentRuntime: BoardRuntimeConfigRow;
  callerName: string;
  sourceMessagingGroupPlatformId: string | null;
}

/**
 * True ONLY for a better-sqlite3 PRIMARY KEY / UNIQUE violation (the RC4
 * pre-claim race-loser). Deliberately NOT `startsWith('SQLITE_CONSTRAINT')` —
 * that would also swallow FOREIGN KEY / NOT NULL / CHECK failures (e.g. a
 * concurrent parent-board delete raising SQLITE_CONSTRAINT_FOREIGNKEY) as a
 * spurious "already claimed".
 */
function isPrimaryKeyConflict(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function loadParent(tfDb: DatabaseType.Database, session: Session): ParentLookup | null {
  const callerAgent = getAgentGroup(session.agent_group_id);
  if (!callerAgent) {
    log.warn('provision_child_board: caller agent_group not found', { sessionId: session.id });
    return null;
  }
  const parentBoard = findBoardByFolder(tfDb, callerAgent.folder);
  if (!parentBoard) {
    log.warn("provision_child_board: caller's session is not a TaskFlow board", {
      sessionId: session.id,
      folder: callerAgent.folder,
    });
    return null;
  }
  if (parentBoard.hierarchy_level + 1 > parentBoard.max_depth) {
    log.warn('provision_child_board: leaf board cannot create children', {
      boardId: parentBoard.id,
      level: parentBoard.hierarchy_level,
      maxDepth: parentBoard.max_depth,
    });
    return null;
  }
  const parentConfig = tfDb.prepare('SELECT * FROM board_config WHERE board_id = ?').get(parentBoard.id) as
    | BoardConfigRow
    | undefined;
  const parentRuntime = tfDb.prepare('SELECT * FROM board_runtime_config WHERE board_id = ?').get(parentBoard.id) as
    | BoardRuntimeConfigRow
    | undefined;
  if (!parentConfig || !parentRuntime) {
    log.warn('provision_child_board: parent config/runtime missing', { boardId: parentBoard.id });
    return null;
  }
  const sourceMg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : null;
  return {
    parentBoard,
    parentConfig,
    parentRuntime,
    callerName: callerAgent.name,
    sourceMessagingGroupPlatformId: sourceMg?.platform_id ?? null,
  };
}

interface ExistingBoardMatch {
  child_board_id: string;
  person_id: string;
  group_jid: string;
  group_folder: string;
  phone: string;
}

const CROSS_PARENT_LOOKUP_SQL = `
  SELECT cbr.child_board_id, cbr.person_id, b.group_jid, b.group_folder, bp.phone,
         CASE WHEN cbr.person_id = ? THEN 0 ELSE 1 END AS prio
    FROM child_board_registrations cbr
    JOIN boards b ON b.id = cbr.child_board_id
    JOIN board_people bp ON bp.board_id = cbr.child_board_id AND bp.person_id = cbr.person_id
   WHERE bp.phone IS NOT NULL
     AND cbr.parent_board_id != ?
   ORDER BY prio ASC`;

/**
 * Find the same person's board on a DIFFERENT parent. id+phone match wins
 * over phone-only match (handled by ORDER BY prio in the SQL); JS-side
 * filter compares `normalizePhone(stored)` so values get canonicalized
 * regardless of which form was stored historically.
 */
function findExistingBoardElsewhere(
  tfDb: DatabaseType.Database,
  parentBoardId: string,
  personId: string,
  canonicalPhone: string,
): ExistingBoardMatch | null {
  if (canonicalPhone.length < 10) return null;
  const rows = tfDb.prepare(CROSS_PARENT_LOOKUP_SQL).all(personId, parentBoardId) as ExistingBoardMatch[];
  // RC5: match against the BR 9th-digit variant set so a board stored under the
  // 12-digit form is still found when this registration is 13-digit (or vice
  // versa) — otherwise we mint a DUPLICATE board instead of linking the existing
  // one (RC4 regression). The same-person_id row wins unambiguously; a phone-only
  // match that resolves to more than one distinct board is ambiguous → fail
  // closed (don't link the wrong board; fall through to creating a fresh one).
  const variants = new Set(brPhoneMatchVariants(canonicalPhone));
  const matches = rows.filter((c) => variants.has(normalizePhone(c.phone)));
  const byId = matches.find((c) => c.person_id === personId);
  if (byId) return byId;
  const distinctBoards = new Set(matches.map((c) => c.child_board_id));
  if (distinctBoards.size !== 1) return null;
  return matches[0];
}

/**
 * UPDATE the row's PK column from→to, OR DELETE the from-row when the
 * to-row already exists (would PK-collide on UPDATE). Used for unifying
 * person_id across board_people / board_admins when linking to an existing
 * board on a different parent.
 */
function rekeyOrDrop(
  tfDb: DatabaseType.Database,
  table: 'board_people' | 'board_admins',
  boardId: string,
  fromId: string,
  toId: string,
): void {
  const collision = tfDb.prepare(`SELECT 1 FROM ${table} WHERE board_id = ? AND person_id = ?`).get(boardId, toId);
  if (collision) {
    tfDb.prepare(`DELETE FROM ${table} WHERE board_id = ? AND person_id = ?`).run(boardId, fromId);
  } else {
    tfDb.prepare(`UPDATE ${table} SET person_id = ? WHERE board_id = ? AND person_id = ?`).run(toId, boardId, fromId);
  }
}

function linkExistingBoardToParent(
  tfDb: DatabaseType.Database,
  parentBoard: BoardRow,
  parsed: ParsedInput,
  existing: ExistingBoardMatch,
): void {
  tfDb.transaction(() => {
    if (existing.person_id !== parsed.personId) {
      log.info('provision_child_board: unifying person_id to match existing board', {
        from: parsed.personId,
        to: existing.person_id,
      });
      rekeyOrDrop(tfDb, 'board_people', parentBoard.id, parsed.personId, existing.person_id);
      tfDb
        .prepare('UPDATE tasks SET assignee = ? WHERE board_id = ? AND assignee = ?')
        .run(existing.person_id, parentBoard.id, parsed.personId);
      rekeyOrDrop(tfDb, 'board_admins', parentBoard.id, parsed.personId, existing.person_id);
    }

    tfDb
      .prepare(
        `INSERT OR IGNORE INTO child_board_registrations (parent_board_id, person_id, child_board_id)
           VALUES (?, ?, ?)`,
      )
      .run(parentBoard.id, existing.person_id, existing.child_board_id);

    // Skip when target equals parent group; otherwise the parent + child
    // would double-deliver to the same chat.
    if (existing.group_jid && existing.group_jid !== parentBoard.group_jid) {
      tfDb
        .prepare('UPDATE board_people SET notification_group_jid = ? WHERE board_id = ? AND person_id = ?')
        .run(existing.group_jid, parentBoard.id, existing.person_id);
    }

    tfDb
      .prepare(
        `UPDATE tasks SET child_exec_board_id = ?, child_exec_enabled = 1, child_exec_person_id = ?
           WHERE board_id = ? AND assignee = ? AND child_exec_board_id IS NULL`,
      )
      .run(existing.child_board_id, existing.person_id, parentBoard.id, existing.person_id);
  })();

  log.info('provision_child_board: existing board linked', {
    parentBoardId: parentBoard.id,
    childBoardId: existing.child_board_id,
  });
}

function computeChildFolderAndName(parsed: ParsedInput): { folder: string; name: string } | null {
  const baseFolder = parsed.groupFolderOverride || sanitizeFolder(parsed.personId) + '-taskflow';
  if (!parsed.groupFolderOverride) {
    log.warn('provision_child_board: group_folder not provided, falling back to person-based name', {
      personId: parsed.personId,
      fallbackFolder: baseFolder,
    });
  }
  // RC1: dedup against board folders too (migrated boards' drifted
  // group_folder isn't in agent_groups.folder), so a new child can't collide.
  const folder = pickUniqueAgentFolder(baseFolder, buildReservedFolderSet(TASKFLOW_DB_PATH));
  if (!folder) {
    log.warn('provision_child_board: invalid group folder name', { baseFolder });
    return null;
  }

  let name = parsed.groupNameOverride || `${parsed.personName} - TaskFlow`;
  // messaging_groups.name carries the chat's display title; two children
  // sharing one would collide on WhatsApp's group subject.
  const existingNames = new Set(
    getAllMessagingGroups()
      .map((mg) => mg.name)
      .filter((n): n is string => !!n),
  );
  if (existingNames.has(name)) {
    const withSuffix = name.replace(/ - TaskFlow$/, ` (${parsed.personName}) - TaskFlow`);
    name = withSuffix !== name ? withSuffix : `${name} (${parsed.personName})`;
  }
  return { folder, name };
}

function seedChildTaskflow(
  tfDb: DatabaseType.Database,
  parsed: ParsedInput,
  parent: ParentLookup,
  childBoardId: string,
  childFolder: string,
  childGroupJid: string,
  ts: string,
): { linkedTasks: number } {
  const phone = parsed.canonicalPhone || parsed.personPhone;
  const { parentBoard, parentConfig, parentRuntime } = parent;

  let linkedTasks = 0;

  tfDb.transaction(() => {
    seedBoardCore(tfDb, {
      boardId: childBoardId,
      groupJid: childGroupJid,
      folder: childFolder,
      hierarchyLevel: parentBoard.hierarchy_level + 1,
      maxDepth: parentBoard.max_depth,
      parentBoardId: parentBoard.id,
      shortCode: parsed.shortCode,
      ownerPersonId: parsed.personId,
      // Child inherits the parent's WIP + runtime config (crons, language, tz).
      wipLimit: parentConfig.wip_limit,
      runtime: parentRuntime,
      person: { personId: parsed.personId, name: parsed.personName, phone, role: parsed.personRole },
    });

    tfDb
      .prepare('INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, ?, ?)')
      .run(parentBoard.id, parsed.personId, childBoardId);

    tfDb
      .prepare('UPDATE board_people SET notification_group_jid = ? WHERE board_id = ? AND person_id = ?')
      .run(childGroupJid, parentBoard.id, parsed.personId);

    const linked = tfDb
      .prepare(
        `UPDATE tasks
            SET child_exec_enabled = 1,
                child_exec_board_id = ?,
                child_exec_person_id = ?,
                column = CASE WHEN column = 'inbox' THEN 'next_action' ELSE column END,
                updated_at = ?
          WHERE board_id = ? AND assignee = ? AND child_exec_enabled = 0`,
      )
      .run(childBoardId, parsed.personId, ts, parentBoard.id, parsed.personId);
    linkedTasks = linked.changes;

    tfDb
      .prepare(
        'INSERT INTO task_history (board_id, task_id, action, by, at, details, trigger_turn_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        parentBoard.id,
        '',
        'child_board_created',
        parsed.personId,
        ts,
        JSON.stringify({ child_board_id: childBoardId, person_id: parsed.personId, auto_provisioned: true }),
        parsed.triggerTurnId,
      );
  })();

  return { linkedTasks };
}

function buildConfirmationMessage(parsed: ParsedInput, childGroupName: string, childBoardId: string): string {
  return `✅ Quadro de ${parsed.personName} provisionado automaticamente.\n\nGrupo: ${childGroupName}\nQuadro: ${childBoardId}\n\nO quadro estará disponível na próxima interação.`;
}

function buildInviteLinkMessage(
  childGroupName: string,
  personName: string,
  inviteLink: string,
  droppedParticipants: string[] | undefined,
): string {
  const dropped = droppedParticipants?.length
    ? `\n⚠️ Não foi possível adicionar: ${droppedParticipants.map((p) => p.split('@')[0]).join(', ')}`
    : '';
  return `📎 Link de convite para o grupo *${childGroupName}* (${personName}):\n${inviteLink}${dropped}`;
}

/**
 * EX-014 fail-loud: the person is already registered (the container's
 * register_person committed before this host action runs), so a silent provision
 * failure leaves an orphaned person with no board. Surface it to the origin chat
 * instead of just logging — the operator needs to know to re-provision.
 */
async function alertProvisionFailed(
  adapter: Parameters<typeof deliverPlainText>[0],
  originPlatformId: string | null | undefined,
  personName: string,
  reason: string,
): Promise<void> {
  if (!originPlatformId) return;
  try {
    await deliverPlainText(
      adapter,
      originPlatformId,
      `⚠️ *${personName}* foi cadastrado(a), mas o quadro NÃO pôde ser provisionado (${reason}).\n\n` +
        `O cadastro da pessoa está salvo; o quadro precisa ser criado manualmente — tente novamente ou avise o suporte.`,
    );
  } catch (err) {
    log.error('provision_child_board: failed to deliver provision-failure alert', { err });
  }
}

export async function handleProvisionChildBoard(
  content: Record<string, unknown>,
  session: Session,
  _inDb: DatabaseType.Database,
): Promise<void> {
  const parsed = parseInput(content);
  if (!parsed) {
    log.warn('provision_child_board: missing required fields', { sessionId: session.id });
    return;
  }

  const adapter = getChannelAdapter('whatsapp');
  if (!adapter || !adapter.createGroup) {
    log.warn('provision_child_board: WhatsApp adapter missing createGroup capability', { sessionId: session.id });
    return;
  }

  const tfDb = new Database(TASKFLOW_DB_PATH);
  tfDb.pragma('busy_timeout = 5000');
  let childInboundDb: DatabaseType.Database | null = null;
  try {
    const parent = loadParent(tfDb, session);
    if (!parent) {
      // RC3: register_person already committed the person, so an unresolvable
      // parent leaves a registered person with NO board (the EX-014/Sanunciel
      // partial state, previously a silent `return`). Fail loud + alert the
      // request's origin chat — the parent's own group is what failed to resolve,
      // but the session's source chat is still reachable.
      log.error('provision_child_board: parent board unresolvable — person registered but board NOT provisioned', {
        sessionId: session.id,
        personId: parsed.personId,
      });
      const originPlatformId = session.messaging_group_id
        ? getMessagingGroup(session.messaging_group_id)?.platform_id
        : undefined;
      if (originPlatformId) {
        await alertProvisionFailed(
          adapter,
          originPlatformId,
          parsed.personName,
          'não foi possível resolver o quadro pai',
        );
      }
      return;
    }
    const alertFailed = (reason: string) =>
      alertProvisionFailed(adapter, parent.sourceMessagingGroupPlatformId, parsed.personName, reason);

    const alreadyOnThisParent = tfDb
      .prepare('SELECT 1 FROM child_board_registrations WHERE parent_board_id = ? AND person_id = ?')
      .get(parent.parentBoard.id, parsed.personId);
    if (alreadyOnThisParent) {
      log.warn('provision_child_board: child board already registered for this person', {
        parentBoardId: parent.parentBoard.id,
        personId: parsed.personId,
      });
      return;
    }

    const existingElsewhere = findExistingBoardElsewhere(
      tfDb,
      parent.parentBoard.id,
      parsed.personId,
      parsed.canonicalPhone,
    );
    if (existingElsewhere) {
      try {
        linkExistingBoardToParent(tfDb, parent.parentBoard, parsed, existingElsewhere);
        // A12-part-2: register cross-board destinations for the linked
        // child. Multi-parent capable per the symmetric per-folder names —
        // existing child gets ANOTHER 'parent-<folder>' for this parent;
        // this parent gets a new 'source-<folder>' for the existing child.
        const parentMgId = session.messaging_group_id;
        if (parentMgId && hasTable(getCentralDb(), 'agent_destinations')) {
          const existingChildAg = getAgentGroupByFolder(existingElsewhere.group_folder);
          const existingChildMg = existingChildAg
            ? (getCentralDb()
                .prepare('SELECT messaging_group_id FROM messaging_group_agents WHERE agent_group_id = ?')
                .get(existingChildAg.id) as { messaging_group_id: string } | undefined)
            : undefined;
          if (existingChildAg && existingChildMg) {
            const destTs = new Date().toISOString();
            const parentName = `parent-${parent.parentBoard.group_folder}`;
            createDestinationIfAbsent(existingChildAg.id, parentName, 'channel', parentMgId, destTs);
            const sourceName = `source-${existingElsewhere.group_folder}`;
            if (
              createDestinationIfAbsent(
                session.agent_group_id,
                sourceName,
                'channel',
                existingChildMg.messaging_group_id,
                destTs,
              )
            ) {
              writeDestinations(session.agent_group_id, session.id);
            }
          }
        }
      } catch (err) {
        log.error('provision_child_board: failed to link existing board', {
          err,
          parentBoardId: parent.parentBoard.id,
          personId: parsed.personId,
        });
        await alertFailed('falha ao vincular o quadro existente');
      }
      return;
    }

    const folderAndName = computeChildFolderAndName(parsed);
    if (!folderAndName) {
      await alertFailed('não foi possível resolver o nome/sigla da divisão');
      return;
    }
    const { folder, name: childGroupName } = folderAndName;
    const childBoardId = `board-${folder}`;

    // RC4: pre-claim the (parent, person) lock BEFORE the WhatsApp createGroup
    // side-effect. The PK on child_board_provision_claims makes a truly-concurrent
    // cross-session provision of the same person fail HERE (caught just below)
    // instead of after both have already minted a WhatsApp group — closing the
    // orphan-group residual. This is a dedicated lock table (read by nothing
    // else), so child_board_registrations keeps its "a row ⇒ a seeded board"
    // invariant for every other consumer. We release the lock on success and on
    // every failure path.
    try {
      tfDb
        .prepare('INSERT INTO child_board_provision_claims (parent_board_id, person_id, claimed_at) VALUES (?, ?, ?)')
        .run(parent.parentBoard.id, parsed.personId, new Date().toISOString());
    } catch (err) {
      if (isPrimaryKeyConflict(err)) {
        // A concurrent provision already holds the lock for this person.
        // Skip the group side-effect; the winning provision sends the confirmation.
        log.warn('provision_child_board: (parent, person) already claimed by a concurrent provision — skipping', {
          parentBoardId: parent.parentBoard.id,
          personId: parsed.personId,
        });
        return;
      }
      throw err;
    }
    const releaseClaim = () =>
      tfDb
        .prepare('DELETE FROM child_board_provision_claims WHERE parent_board_id = ? AND person_id = ?')
        .run(parent.parentBoard.id, parsed.personId);

    // RC4 double-checked locking: a slow contender could have passed the
    // alreadyOnThisParent SELECT above BEFORE a prior provision seeded, then
    // acquired this lock only AFTER that provision committed its registration and
    // released — and would otherwise mint a second orphan group. Re-check under
    // the lock: if the registration (create- OR cross-parent-link path) now
    // exists, the work is already done.
    const nowRegistered = tfDb
      .prepare('SELECT 1 FROM child_board_registrations WHERE parent_board_id = ? AND person_id = ?')
      .get(parent.parentBoard.id, parsed.personId);
    if (nowRegistered) {
      log.warn('provision_child_board: registration appeared after acquiring the lock — skipping', {
        parentBoardId: parent.parentBoard.id,
        personId: parsed.personId,
      });
      releaseClaim();
      return;
    }

    let createResult: Awaited<ReturnType<NonNullable<typeof adapter.createGroup>>>;
    try {
      // RC5: resolve via WhatsApp's onWhatsApp() round-trip so the BR mobile
      // 9th-digit form matches the server's canonical JID (a string-built JID
      // with the wrong form is silently dropped, leaving the person off the
      // new board). Falls back to the string-built JID when unreachable.
      const participantJid = await resolveParticipantJid(adapter, parsed.personPhone);
      createResult = await adapter.createGroup(childGroupName, [participantJid]);
      log.info('provision_child_board: WhatsApp group created', {
        jid: createResult.jid,
        subject: createResult.subject,
        inviteLink: createResult.inviteLink,
      });
    } catch (err) {
      log.error('provision_child_board: failed to create WhatsApp group', { err, childGroupName });
      releaseClaim(); // RC4: release the lock — no group was created, so a retry isn't blocked.
      await alertFailed('falha ao criar o grupo no WhatsApp');
      return;
    }
    const childGroupJid = createResult.jid;

    if (createResult.inviteLink && parent.sourceMessagingGroupPlatformId) {
      try {
        await deliverPlainText(
          adapter,
          parent.sourceMessagingGroupPlatformId,
          buildInviteLinkMessage(
            childGroupName,
            parsed.personName,
            createResult.inviteLink,
            createResult.droppedParticipants,
          ),
        );
      } catch (err) {
        log.error('provision_child_board: failed to deliver invite link (non-fatal)', { err });
      }
    }

    const ts = new Date().toISOString();
    let linkedTasks = 0;
    try {
      ({ linkedTasks } = seedChildTaskflow(tfDb, parsed, parent, childBoardId, folder, childGroupJid, ts));
      log.info('provision_child_board: taskflow DB seeded', {
        childBoardId,
        parentBoardId: parent.parentBoard.id,
        linkedTasks,
      });
    } catch (err) {
      log.error('provision_child_board: failed to seed taskflow DB', { err, childBoardId });
      releaseClaim(); // RC4: seed transaction rolled back (no board row) → release the lock so a retry can proceed.
      await alertFailed('falha ao gravar os dados do quadro');
      return;
    }
    // RC4: the child_board_registrations row is now durably committed; it is the
    // source of truth for re-submits (alreadyOnThisParent). Release the lock —
    // remaining steps are log-and-continue and must not hold it.
    releaseClaim();

    const childAgentGroupId = newTaskId('ag');
    let childMessagingGroupId: string | null = null;
    try {
      const wired = wireV2({
        agentGroupId: childAgentGroupId,
        agentName: parent.callerName,
        folder,
        groupJid: childGroupJid,
        groupName: childGroupName,
        engageMode: 'pattern',
        engagePattern: '.',
      });
      childMessagingGroupId = wired.messagingGroupId;
      log.info('provision_child_board: v2 wiring complete', { childAgentGroupId, folder, childGroupJid });

      // A12 + A12-part-2: register symbolic destinations for cross-board
      // approval routing, per-parent and per-child. Child uses
      // 'parent-<parent_folder>' (one per linked parent); parent uses
      // 'source-<child_folder>' (one per linked child). Both sides use
      // boards.group_folder (NOT NULL + unique per board) so names never
      // collapse to '-null' and never collide cross-child or cross-parent.
      // Multi-parent children (cross_board_registrations) get one
      // 'parent-<folder>' row per linked parent — same pattern as parent's
      // multiple 'source-<folder>' rows.
      // Guard: skip when the agent-to-agent module isn't installed (same
      // pattern as messaging-groups.ts:213) or session is DM-only.
      // Idempotency + selective projection handled by createDestinationIfAbsent.
      const parentMgId = session.messaging_group_id;
      if (parentMgId && hasTable(getCentralDb(), 'agent_destinations')) {
        const destTs = new Date().toISOString();
        const parentName = `parent-${parent.parentBoard.group_folder}`;
        createDestinationIfAbsent(childAgentGroupId, parentName, 'channel', parentMgId, destTs);
        const sourceName = `source-${folder}`;
        // Propagate to the running parent container's inbound.db (top-of-file
        // invariant in agent-destinations.ts) ONLY when actually inserted — an
        // existing row is already projected.
        if (createDestinationIfAbsent(session.agent_group_id, sourceName, 'channel', childMessagingGroupId, destTs)) {
          writeDestinations(session.agent_group_id, session.id);
        }
      }
    } catch (err) {
      log.error('provision_child_board: failed to wire v2', { err, childAgentGroupId });
      await alertFailed('falha ao conectar o agente do quadro');
      return;
    }

    try {
      initGroupFilesystem({
        id: childAgentGroupId,
        name: parent.callerName,
        folder,
        agent_provider: 'claude',
        created_at: ts,
      });
      createBoardFilesystem({
        groupFolder: folder,
        assistantName: parent.callerName,
        personName: parsed.personName,
        personPhone: parsed.personPhone,
        personId: parsed.personId,
        language: parent.parentRuntime.language,
        timezone: parent.parentRuntime.timezone,
        wipLimit: parent.parentConfig.wip_limit,
        boardId: childBoardId,
        groupName: childGroupName,
        groupContext: `${parsed.personName}'s tasks (private standup channel)`,
        groupJid: childGroupJid,
        boardRole: 'hierarchy',
        hierarchyLevel: parent.parentBoard.hierarchy_level + 1,
        maxDepth: parent.parentBoard.max_depth,
        parentBoardId: parent.parentBoard.id,
        standupCronUtc: parent.parentRuntime.standup_cron_utc,
        digestCronUtc: parent.parentRuntime.digest_cron_utc,
        reviewCronUtc: parent.parentRuntime.review_cron_utc,
        standupCronLocal: parent.parentRuntime.standup_cron_local,
        digestCronLocal: parent.parentRuntime.digest_cron_local,
        reviewCronLocal: parent.parentRuntime.review_cron_local,
        attachmentEnabled: !!parent.parentRuntime.attachment_enabled,
        attachmentReason: parent.parentRuntime.attachment_disabled_reason,
        dstGuardEnabled: !!parent.parentRuntime.dst_sync_enabled,
      });
    } catch (err) {
      log.error('provision_child_board: filesystem step failed (non-fatal)', { err, folder });
    }

    if (childMessagingGroupId) {
      try {
        childInboundDb = ensureSessionInbound(childAgentGroupId, childMessagingGroupId);
      } catch (err) {
        log.error('provision_child_board: failed to open session inbound.db (non-fatal)', { err });
      }
    }

    if (childInboundDb) {
      try {
        scheduleRunners({
          tfDb,
          inboundDb: childInboundDb,
          boardId: childBoardId,
          standupCronLocal: parent.parentRuntime.standup_cron_local,
          digestCronLocal: parent.parentRuntime.digest_cron_local,
          reviewCronLocal: parent.parentRuntime.review_cron_local,
          boardTimezone: parent.parentRuntime.timezone,
        });
      } catch (err) {
        log.error('provision_child_board: failed to schedule runners (non-fatal)', { err });
      }
    }

    fixOwnership(
      path.join(GROUPS_DIR, folder),
      path.join(DATA_DIR, 'v2-sessions', childAgentGroupId),
      path.join(DATA_DIR, 'taskflow'),
    );

    if (parent.sourceMessagingGroupPlatformId) {
      try {
        await deliverPlainText(
          adapter,
          parent.sourceMessagingGroupPlatformId,
          buildConfirmationMessage(parsed, childGroupName, childBoardId),
        );
      } catch (err) {
        log.error('provision_child_board: failed to send confirmation (non-fatal)', { err });
      }
    }

    try {
      await deliverPlainText(adapter, childGroupJid, buildChildWelcomeMessage(childGroupName));
      markWelcomeSent(tfDb, childBoardId);
    } catch (err) {
      log.error('provision_child_board: failed to send welcome (non-fatal)', { err });
    }

    if (childInboundDb) {
      try {
        scheduleOnboarding({
          inboundDb: childInboundDb,
          timezone: parent.parentRuntime.timezone,
        });
      } catch (err) {
        log.error('provision_child_board: failed to schedule onboarding (non-fatal)', { err });
      }
    }

    log.info('provision_child_board: complete', {
      childBoardId,
      childGroupJid,
      folder,
      parentBoardId: parent.parentBoard.id,
      personId: parsed.personId,
    });

    // #402: the parent board may have torn down (idle) while this async
    // provisioning ran. Now that the child board's notification_group_jid is
    // committed, respawn the parent so its first-poll idle-drain (#396 unit 3)
    // delivers any pending_notifications whose JID just resolved — closing the
    // torn-down-idle-parent edge the in-session idle-drain cannot reach. The
    // provision confirmation goes via the adapter (not the parent's session DB),
    // so nothing else wakes the parent. Fire-and-forget; wakeContainer never
    // throws and is a no-op when the parent is already running.
    void wakeContainer(session);
  } finally {
    if (childInboundDb) {
      try {
        childInboundDb.close();
      } catch {}
    }
    tfDb.close();
  }
}
