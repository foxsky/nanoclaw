import makeWASocket, {
  Browsers,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';

const logger = pino({ level: 'warn' });

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState('./store/auth');
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
      console.log('Connected.\n');

      // Resolve correct JIDs
      const numbers = ['5586999986334', '5586999032890'];
      console.log('Resolving numbers on WhatsApp...');
      const results = await sock.onWhatsApp(...numbers);
      console.log('Results:', JSON.stringify(results, null, 2));

      for (const r of results ?? []) {
        if (!r.exists) {
          console.log(`${r.jid} not found on WhatsApp`);
          continue;
        }
        const jid = r.jid;
        const isReginaldo = jid.includes('999986334');
        const groupJid = isReginaldo
          ? '120363427128623315@g.us'
          : '120363425088189365@g.us';
        const name = isReginaldo ? 'Reginaldo' : 'Caio';

        console.log(`\nAdding ${name} (${jid}) to group ${groupJid}...`);
        try {
          const res = await sock.groupParticipantsUpdate(
            groupJid,
            [jid],
            'add',
          );
          console.log('Result:', JSON.stringify(res));
        } catch (e: any) {
          console.log(
            'Error:',
            e.message,
            JSON.stringify(e.data || e.output || {}),
          );
        }
      }

      setTimeout(() => process.exit(0), 2000);
    }
    if (update.connection === 'close') process.exit(1);
  });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
