/**
 * Fix WhatsApp groups: add missing participants and rename duplicate groups.
 * Stop the service before running: systemctl --user stop nanoclaw
 * Usage: npx tsx src/whatsapp-fix-groups.ts
 */
import fs from 'fs';
import pino from 'pino';
import makeWASocket, {
  Browsers,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const AUTH_DIR = './store/auth';
const logger = pino({ level: 'warn' });

async function fixGroups(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
    version: undefined,
  }));

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (update.connection === 'open') {
      console.log('Connected. Applying fixes...\n');

      try {
        // 1. Add Reginaldo to setd-secti-taskflow group
        const reginaldoJid = '5586999986334@s.whatsapp.net';
        const setdGroup = '120363427128623315@g.us';
        console.log('Adding Reginaldo to SETD-SECTI group...');
        try {
          await sock.groupParticipantsUpdate(setdGroup, [reginaldoJid], 'add');
          console.log('  ✓ Reginaldo added');
        } catch (e: any) {
          console.log(`  ⚠ ${e.message || e}`);
        }

        // 2. Add Caio to ux-setd-secti-taskflow group
        const caioJid = '5586999032890@s.whatsapp.net'; // DB has 86999032890, needs 55 prefix fix
        const uxGroup = '120363425088189365@g.us';
        console.log('Adding Caio to UX-SETD-SECTI group...');
        try {
          await sock.groupParticipantsUpdate(uxGroup, [caioJid], 'add');
          console.log('  ✓ Caio added');
        } catch (e: any) {
          console.log(`  ⚠ ${e.message || e}`);
        }

        // 3. Rename the child group to avoid duplicate name
        console.log(
          'Renaming SETD-SECTI child group to "PO-SETD-SECTI - TaskFlow"...',
        );
        try {
          await sock.groupUpdateSubject(setdGroup, 'PO-SETD-SECTI - TaskFlow');
          console.log('  ✓ Renamed');
        } catch (e: any) {
          console.log(`  ⚠ ${e.message || e}`);
        }

        console.log(
          '\nDone! Restart the service with: systemctl --user restart nanoclaw',
        );
      } catch (err: any) {
        console.error('Error:', err.message);
      }

      setTimeout(() => process.exit(0), 2000);
    }

    if (update.connection === 'close') {
      console.error('Connection closed unexpectedly');
      process.exit(1);
    }
  });
}

fixGroups().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
