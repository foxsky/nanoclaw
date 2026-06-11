/**
 * transcribe_audio MCP tool — converts a voice note / audio attachment to text via
 * OpenAI Whisper.
 *
 * v2 delivers inbound audio as a downloadable FILE (the agent sees
 * `[audio: voice.ogg — saved to /workspace/...]`). Claude has no native audio input,
 * so this tool gives it the transcript on demand. The OpenAI call goes through the
 * OneCLI gateway, which injects the OpenAI credential transparently at the proxy
 * boundary — there is no API key in code or env. (Replaces the v1 add-voice-transcription
 * skill, which was wrongly batch-deleted as "covered by native attachments": attachments
 * deliver the file, not the transcription.)
 */
import { basename, resolve } from 'node:path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { err, log, nonEmptyString, ok } from './util.js';

export interface TranscribeOptions {
  model?: string;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => Promise<Uint8Array>;
  proxy?: string;
}

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

async function defaultReadFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

// The only directories the host writes inbound attachments into (mounted under /workspace):
// `inbox/<messageId>/...` (session-manager.ts) and `attachments/...` (whatsapp adapter). Anything
// else — taskflow.db, agent memory, /etc, the session DBs — is off-limits to transcription.
const ALLOWED_ATTACHMENT_PREFIXES = ['/workspace/inbox/', '/workspace/attachments/'];

/** True iff `p` resolves (after collapsing `..`) to a file under a host-written attachment dir. */
export function isAllowedAttachmentPath(p: string): boolean {
  const abs = resolve(p);
  return ALLOWED_ATTACHMENT_PREFIXES.some((prefix) => abs.startsWith(prefix));
}

export async function transcribeAudio(filePath: string, opts: TranscribeOptions = {}): Promise<string> {
  const model = opts.model ?? 'whisper-1';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const readFile = opts.readFile ?? defaultReadFile;

  let bytes: Uint8Array;
  try {
    bytes = await readFile(filePath);
  } catch (e) {
    throw new Error(`cannot read audio file '${filePath}': ${(e as Error).message}`);
  }
  if (bytes.byteLength === 0) throw new Error(`audio file '${filePath}' is empty`);

  const form = new FormData();
  form.append('file', new Blob([bytes as BlobPart]), basename(filePath) || 'voice.ogg');
  form.append('model', model);
  form.append('response_format', 'text'); // API returns the transcript as a plain-text body

  // Route through the OneCLI gateway, which injects the OpenAI credential at the proxy
  // boundary (HTTPS_PROXY is set in the container). Bun's fetch honours the `proxy` option.
  const proxy = opts.proxy ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const init: RequestInit & { proxy?: string } = { method: 'POST', body: form };
  if (proxy) init.proxy = proxy;

  const res = await fetchImpl(OPENAI_TRANSCRIBE_URL, init);
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `OpenAI auth failed (${res.status}) — the OneCLI gateway has no OpenAI credential assigned to this agent. ` +
          `An admin must assign an OpenAI secret (host pattern api.openai.com). ${detail}`.trim(),
      );
    }
    throw new Error(`OpenAI transcription failed (${res.status}): ${detail}`);
  }
  return (await res.text()).trim();
}

export const transcribeAudioTool: McpToolDefinition = {
  tool: {
    name: 'transcribe_audio',
    description:
      "Transcribe a voice note / audio file to text (OpenAI Whisper). Use this whenever an inbound message includes an audio or voice attachment — the message shows its saved path, e.g. '[audio: voice.ogg — saved to /workspace/attachments/voice.ogg]'; pass that path (only host-written attachment paths under /workspace/inbox/ or /workspace/attachments/ are accepted). Returns the transcript text. Auth is handled by the OneCLI gateway (no key needed); if it errors with a credential message, an admin must assign an OpenAI secret to this agent.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: "Absolute path to the audio file as shown in the attachment line, e.g. '/workspace/attachments/voice.ogg' (must be under /workspace/inbox/ or /workspace/attachments/).",
        },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const path = nonEmptyString(args.path);
    if (!path) return err("path is required — pass the audio attachment's saved path (e.g. /workspace/inbox/<id>/voice.ogg)");
    // SECURITY: this tool opens the path and ships the bytes to an external transcription API,
    // re-creating an arbitrary-file-read + exfiltration primitive that the disallowed Read/Bash
    // tools exist to remove. Confine reads to the directories the HOST actually writes inbound
    // attachments into (session-manager `inbox/<msg>/...`, whatsapp adapter `attachments/...`),
    // which the host mounts under /workspace. resolve() collapses any `..`, so a traversal like
    // /workspace/inbox/../taskflow/taskflow.db or an absolute /etc/passwd is rejected before any read.
    if (!isAllowedAttachmentPath(path)) {
      return err(
        `transcription is restricted to delivered attachments under /workspace/inbox/ or /workspace/attachments/ — refusing '${path}'`,
      );
    }
    try {
      const transcript = await transcribeAudio(path);
      if (!transcript) return err(`transcription returned empty text for ${path}`);
      log(`transcribe_audio: ${path} → ${transcript.length}ch`);
      return ok(transcript);
    } catch (e) {
      return err(`transcription failed: ${(e as Error).message}`);
    }
  },
};

registerTools([transcribeAudioTool]);
