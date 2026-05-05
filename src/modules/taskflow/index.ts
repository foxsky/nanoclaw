import { registerDeliveryAction } from '../../delivery.js';
import { handleProvisionRootBoard } from './provision-root-board.js';

registerDeliveryAction('provision_root_board', handleProvisionRootBoard);
