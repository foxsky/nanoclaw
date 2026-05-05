import { registerDeliveryAction } from '../../delivery.js';
import { handleProvisionChildBoard } from './provision-child-board.js';
import { handleProvisionRootBoard } from './provision-root-board.js';

registerDeliveryAction('provision_root_board', handleProvisionRootBoard);
registerDeliveryAction('provision_child_board', handleProvisionChildBoard);
