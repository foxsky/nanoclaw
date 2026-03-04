#!/usr/bin/env node
/**
 * One-off script: update a WhatsApp group subject.
 * Usage: node scripts/update-group-subject.mjs "JID@g.us" "New Subject"
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import makeWASocket, {
  Browsers,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(PROJECT_ROOT, 'store', 'auth');

const groupJid = process.argv[2];
const newSubject = process.argv[3];

if (!groupJid || !newSubject) {
  console.error('Usage: node scripts/update-group-subject.mjs "JID@g.us" "New Subject"');
  process.exit(1);
}

const logger = pino({ level: 'warn' });

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestWaWebVersion({}).catch(() => ({ version: [2, 3000, 1015901307] }));

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout (30s)')), 30000);
    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') { clearTimeout(timeout); resolve(); }
      if (connection === 'close') { clearTimeout(timeout); reject(new Error(`Closed: ${lastDisconnect?.error?.output?.statusCode}`)); }
    });
  });

  console.log(`Updating group subject to "${newSubject}"...`);
  await sock.groupUpdateSubject(groupJid, newSubject);
  console.log('Done!');

  await sock.end();
  await new Promise(r => setTimeout(r, 2000));
  process.exit(0);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
