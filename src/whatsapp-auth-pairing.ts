/**
 * WhatsApp Authentication with Pairing Code
 *
 * Uses pairing code instead of QR - works better from VPS/servers
 *
 * Usage: npx tsx src/whatsapp-auth-pairing.ts
 */
import fs from 'fs';
import readline from 'readline';
import pino from 'pino';

import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

const AUTH_DIR = './store/auth';

const logger = pino({
  level: 'warn',
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.registered) {
    console.log('✓ Already authenticated with WhatsApp');
    console.log(
      '  To re-authenticate, delete the store/auth folder and run again.',
    );
    rl.close();
    process.exit(0);
  }

  console.log('Starting WhatsApp authentication with pairing code...\n');

  // Get phone number from command line argument or prompt
  let phoneNumber: string;
  if (process.argv[2]) {
    phoneNumber = process.argv[2];
    console.log(`Using phone number from argument: ${phoneNumber}`);
  } else {
    phoneNumber = await question(
      'Enter your phone number (with country code, e.g., 14155551234): ',
    );
  }
  const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');

  if (!cleanNumber || cleanNumber.length < 10) {
    console.error('✗ Invalid phone number');
    rl.close();
    process.exit(1);
  }

  console.log(`\nUsing phone number: +${cleanNumber}`);
  console.log('Fetching latest WhatsApp version...');

  const { version } = await fetchLatestBaileysVersion();
  console.log(`Using WA version: ${version.join('.')}\n`);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    printQRInTerminal: false,
    logger,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    connectTimeoutMs: 60000,
  });

  let pairingCodeRequested = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Request pairing code once the socket is ready (first QR event)
    if (qr && !pairingCodeRequested) {
      pairingCodeRequested = true;
      console.log('Socket connected, requesting pairing code...\n');
      try {
        const code = await sock.requestPairingCode(cleanNumber);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`✓ Your pairing code: ${code}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        console.log('On your phone:');
        console.log('  1. Open WhatsApp');
        console.log('  2. Tap Settings → Linked Devices → Link a Device');
        console.log('  3. Tap "Link with phone number instead"');
        console.log(`  4. Enter the code: ${code}\n`);
        console.log('Waiting for authentication...\n');
      } catch (err: any) {
        console.error('Failed to get pairing code:', err.message);
        rl.close();
        process.exit(1);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;

      console.log('\nConnection closed. Status code:', statusCode);

      if (statusCode === DisconnectReason.loggedOut) {
        console.log('✗ Logged out. Delete store/auth and try again.');
      } else if (statusCode === 515) {
        console.log('✗ Error 515: Still blocked. Try these alternatives:');
        console.log('  1. Wait 15-30 minutes before retrying');
        console.log('  2. Use a VPN (residential IP preferred)');
        console.log('  3. Authenticate via SSH tunnel from your local machine');
        console.log('  4. Use mobile hotspot tethered to the server');
      } else {
        console.log('✗ Connection failed. Please try again.');
      }

      rl.close();
      process.exit(1);
    }

    if (connection === 'open') {
      console.log('✓ Successfully authenticated with WhatsApp!');
      console.log('  Credentials saved to store/auth/');
      console.log('  You can now start the NanoClaw service.\n');

      setTimeout(() => {
        rl.close();
        process.exit(0);
      }, 1000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  rl.close();
  process.exit(1);
});
