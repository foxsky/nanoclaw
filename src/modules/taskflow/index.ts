import { registerDeliveryAction } from '../../delivery.js';
import { registerApprovalHandler } from '../approvals/primitive.js'; // primitive, not the side-effectful barrel
import { handleAddDestination } from './add-destination.js';
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
