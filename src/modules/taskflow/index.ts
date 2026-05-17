import { registerDeliveryAction } from '../../delivery.js';
import { handleAddDestination } from './add-destination.js';
import { handleCreateGroup } from './create-group.js';
import { handleProvisionChildBoard } from './provision-child-board.js';
import { handleProvisionRootBoard } from './provision-root-board.js';
import { handleTaskflowNotify } from './taskflow-notify.js';
import { handleTaskflowWebChatInbound } from './taskflow-web-chat-inbound.js';

registerDeliveryAction('provision_root_board', handleProvisionRootBoard);
registerDeliveryAction('provision_child_board', handleProvisionChildBoard);
registerDeliveryAction('create_group', handleCreateGroup);
registerDeliveryAction('add_destination', handleAddDestination);
registerDeliveryAction('taskflow_notify', handleTaskflowNotify);
registerDeliveryAction('taskflow_web_chat_inbound', handleTaskflowWebChatInbound);
