import { registerDeliveryAction } from '../../delivery.js';
import { setUnroutedDmResolver } from '../../router.js';
import { registerApprovalHandler } from '../approvals/primitive.js'; // primitive, not the side-effectful barrel
import { handleAddDestination } from './add-destination.js';
import { resolveUnroutedExternalDm } from './external-dm-route.js';
import { handleCreateGroup } from './create-group.js';
import { applyTaskflowGatedAction, handleTaskflowRequestApproval } from './gated-action.js';
import { handleProvisionChildBoard } from './provision-child-board.js';
import { handleProvisionRootBoard } from './provision-root-board.js';
import { handleRenameBoardPerson } from './rename-board-person.js';
import { handleTaskflowDispatchNotifications } from './taskflow-dispatch.js';
import { handleTaskflowNotify } from './taskflow-notify.js';
import { handleTaskflowWebChatInbound } from './taskflow-web-chat-inbound.js';
import { handleTaskflowWebChatReply } from './taskflow-web-chat-reply.js';

registerDeliveryAction('provision_root_board', handleProvisionRootBoard);
registerDeliveryAction('provision_child_board', handleProvisionChildBoard);
registerDeliveryAction('rename_board_person', handleRenameBoardPerson);
registerDeliveryAction('create_group', handleCreateGroup);
registerDeliveryAction('add_destination', handleAddDestination);
registerDeliveryAction('taskflow_notify', handleTaskflowNotify);
registerDeliveryAction('taskflow_dispatch_notifications', handleTaskflowDispatchNotifications);
registerDeliveryAction('taskflow_web_chat_inbound', handleTaskflowWebChatInbound);
registerDeliveryAction('taskflow_web_chat_reply', handleTaskflowWebChatReply);

// #407 admin-approval round-trip: the container parks gated actions here; an approver's click runs them.
registerDeliveryAction('taskflow_request_approval', handleTaskflowRequestApproval);
registerApprovalHandler('taskflow_gated_action', applyTaskflowGatedAction);

// RC5-ext inbound GO-LIVE: route an authenticated external participant's DM into
// the granted board's agent session (confined external turn). This is the ONE
// switch that un-DARKs the whole RC5-ext inbound flow — the host resolver
// authenticates the sender JID and writes a narrowly-scoped external-actor row;
// the container's confined execution path (C4b/C4c/C6) + the engine per-meeting
// grant re-check enforce that an external can ONLY accept their invite / add a
// note to their own meeting and ONLY receive a reply to their own cold-DM. Gated
// host-side to wiring-less WhatsApp cold-DM mgs (mg.is_group === 0); falls through
// to the existing drop for anything without an active grant. See
// 2026-06-13-rc5ext-inbound-design.md.
setUnroutedDmResolver(resolveUnroutedExternalDm);
import './migrations-register.js'; // ADR 0006 contract #3: side-effect import that registers the two fork migrations (user-roles-unique-indexes + main-control) into the core runner before runMigrations() runs.
import './backfill-mcp-json.js';
import './container-contributions.js'; // ADR 0006 contract #2: registers the TaskFlow container contributor (taskflow.db/embeddings mounts + board-id/memory/holiday/embed env).
import './host-sweep-register.js'; // ADR 0006 contract #4: register the TaskFlow due-message gate + per-board-TZ recurrence resolver into the core host-sweep hooks.
import './task-script-sanitizer.js'; // ADR 0006 contract #5: registers the board task-script strip (SEC#11 host leg) into core's sanitizer registry.
