/**
 * Debug WhatsApp authentication - verbose logging
 */
import fs from 'fs';
import pino from 'pino';

import makeWASocket, {
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

const AUTH_DIR = './store/auth';

const logger = pino({ level: 'info' });

async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  console.log('Registered:', state.creds.registered);
  console.log('Fetching WA version...');

  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`WA version: ${version.join('.')}, isLatest: ${isLatest}`);

  console.log('Creating socket...');

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    printQRInTerminal: true,
    logger,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    connectTimeoutMs: 60000,
  });

  console.log('Socket created, waiting for events...');

  sock.ev.on('connection.update', (update) => {
    console.log('\n=== CONNECTION UPDATE ===');
    console.log('Connection:', update.connection);
    console.log('Has QR:', !!update.qr);

    if (update.lastDisconnect) {
      const err = update.lastDisconnect.error as any;
      console.log('Disconnect statusCode:', err?.output?.statusCode);
      console.log('Disconnect payload:', JSON.stringify(err?.output?.payload));
      console.log('Disconnect message:', err?.message);
    }

    if (update.connection === 'open') {
      console.log('\n✓ SUCCESS!');
      setTimeout(() => process.exit(0), 2000);
    }

    if (update.connection === 'close') {
      console.log('\n✗ FAILED');
      process.exit(1);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

authenticate().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
