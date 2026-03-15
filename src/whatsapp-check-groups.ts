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
      const setdMeta = await sock.groupMetadata('120363427128623315@g.us');
      console.log('SETD group:', setdMeta.subject);
      console.log(
        'Participants:',
        JSON.stringify(
          setdMeta.participants.map((p) => ({ id: p.id, admin: p.admin })),
        ),
      );
      const uxMeta = await sock.groupMetadata('120363425088189365@g.us');
      console.log('UX group:', uxMeta.subject);
      console.log(
        'Participants:',
        JSON.stringify(
          uxMeta.participants.map((p) => ({ id: p.id, admin: p.admin })),
        ),
      );

      // Try adding with LID format
      console.log('\nTrying to add Reginaldo...');
      try {
        const res = await sock.groupParticipantsUpdate(
          '120363427128623315@g.us',
          ['5586999986334@s.whatsapp.net'],
          'add',
        );
        console.log('Result:', JSON.stringify(res));
      } catch (e: any) {
        console.log('Error:', e.message, JSON.stringify(e.data || {}));
      }

      console.log('Trying to add Caio...');
      try {
        const res = await sock.groupParticipantsUpdate(
          '120363425088189365@g.us',
          ['5586999032890@s.whatsapp.net'],
          'add',
        );
        console.log('Result:', JSON.stringify(res));
      } catch (e: any) {
        console.log('Error:', e.message, JSON.stringify(e.data || {}));
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
