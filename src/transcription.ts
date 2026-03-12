import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

interface TranscriptionConfig {
  model: string;
  enabled: boolean;
}

const DEFAULT_CONFIG: TranscriptionConfig = {
  model: 'whisper-1',
  enabled: true,
};

async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set in .env');
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({ apiKey });

    const file = await toFile(audioBuffer, 'voice.ogg', {
      type: 'audio/ogg',
    });

    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: config.model,
      response_format: 'text',
    });

    // When response_format is 'text', the API returns a plain string
    return transcription as unknown as string;
  } catch (err) {
    logger.error({ err }, 'OpenAI transcription failed');
    return null;
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return null;
  }

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      logger.error('Failed to download audio message');
      return null;
    }

    logger.info({ bytes: buffer.length }, 'Downloaded audio message');

    const transcript = await transcribeWithOpenAI(buffer, config);

    if (!transcript) {
      return null;
    }

    return transcript.trim();
  } catch (err) {
    logger.error({ err }, 'Transcription error');
    return null;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
