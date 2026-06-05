/**
 * Live runtime-acceptance probe for the transcribe_audio MCP tool (#383).
 *
 * Verifies the make-or-break assumption: a Bun multipart POST to OpenAI's
 * transcription endpoint, sent through the OneCLI gateway with NO auth header,
 * gets the OpenAI credential INJECTED by the gateway (generic secret, host
 * api.openai.com, headerName=Authorization, valueFormat="Bearer {value}").
 *
 * Run inside the gateway-wired runtime so HTTPS_PROXY + the CA env are set:
 *
 *   onecli run --agent <agent-identifier> -- bun scripts/probe-transcription.ts
 *
 * Interpreting the raw status:
 *   200            → full success: gateway injected the key, OpenAI accepted the audio.
 *   400 (bad audio)→ auth SUCCEEDED (key injected); only the synthetic WAV was rejected.
 *                    Still proves the #383 credential path.
 *   401 / 403      → gateway did NOT inject the OpenAI credential (assignment or
 *                    inject-vs-rewrite problem) — the thing #383 depends on.
 */
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

// Minimal valid WAV: 1s of 16 kHz mono 16-bit PCM silence (Whisper accepts this).
function silentWav(seconds = 1, sampleRate = 16000): Uint8Array {
  const numSamples = seconds * sampleRate;
  const dataBytes = numSamples * 2; // 16-bit mono
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true); // PCM fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits/sample
  writeStr(36, 'data');
  dv.setUint32(40, dataBytes, true);
  // samples left as 0 (silence)
  return new Uint8Array(buf);
}

console.error(
  `[probe] HTTPS_PROXY=${process.env.HTTPS_PROXY ? 'set' : 'UNSET'} ` +
    `NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS ? 'set' : 'UNSET'}`,
);

// Mirror transcribe-audio.ts exactly: multipart form, NO Authorization header, proxy via init.proxy.
const form = new FormData();
form.append('file', new Blob([silentWav() as BlobPart]), 'probe.wav');
form.append('model', 'whisper-1');
form.append('response_format', 'text');

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const init: RequestInit & { proxy?: string } = { method: 'POST', body: form, signal: AbortSignal.timeout(30000) };
if (proxy) init.proxy = proxy;

try {
  const res = await fetch(OPENAI_TRANSCRIBE_URL, init);
  const body = (await res.text()).slice(0, 300);
  console.error(`[probe] raw status=${res.status} body=${body}`);
  const authInjected = res.status !== 401 && res.status !== 403;
  console.log(JSON.stringify({ status: res.status, authInjected, body }, null, 2));
  process.exit(authInjected ? 0 : 1);
} catch (e) {
  console.error(`[probe] fetch THREW: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
