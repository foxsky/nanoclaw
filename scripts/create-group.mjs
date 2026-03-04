#!/usr/bin/env node
/**
 * One-off script: create a WhatsApp group via Baileys.
 * Usage: node scripts/create-group.mjs "Group Name" "5511999990000@s.whatsapp.net"
 *
 * Must be run while nanoclaw service is stopped (only one WA connection at a time).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import makeWASocket, {
  Browsers,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import pino from 'pino';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(PROJECT_ROOT, 'store', 'auth');

const groupName = process.argv[2];
const participants = process.argv.slice(3);

if (!groupName || participants.length === 0) {
  console.error('Usage: node scripts/create-group.mjs "Group Name" "phone@s.whatsapp.net" ...');
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
      if (connection === 'open') {
        clearTimeout(timeout);
        resolve();
      }
      if (connection === 'close') {
        clearTimeout(timeout);
        const code = lastDisconnect?.error?.output?.statusCode;
        reject(new Error(`Connection closed: ${code}`));
      }
    });
  });

  console.log('Connected. Creating group...');

  const result = await sock.groupCreate(groupName, participants);
  console.log(`\nGroup created successfully!`);
  console.log(`  Name: ${result.subject}`);
  console.log(`  JID:  ${result.id}`);

  await sock.end();
  // Give a moment for cleanup
  await new Promise(r => setTimeout(r, 2000));
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
