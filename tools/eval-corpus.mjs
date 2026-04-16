#!/usr/bin/env node
// Re-runs the semantic-audit prompt against a labeled corpus for a given model.
// Usage: NANOCLAW_OLLAMA_HOST=http://... node tools/eval-corpus.mjs --model=<name> [--corpus=path]

import fs from 'fs';
import { performance } from 'node:perf_hooks';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const model = args.model || 'qwen3.5:35b-a3b-coding-nvfp4';
const host = process.env.NANOCLAW_OLLAMA_HOST || 'http://192.168.2.13:11434';
const corpus = args.corpus || 'docs/semantic-audit-corpus.ndjson';

if (!fs.existsSync(corpus)) {
  console.error(`Corpus not found: ${corpus}`);
  console.error('Create it by labeling dry-run NDJSON rows. See docs/semantic-audit-calibration.md.');
  process.exit(1);
}

const rows = fs.readFileSync(corpus, 'utf-8').trim().split('\n').map(JSON.parse);
let tp = 0, fp = 0, fn = 0, tn = 0, skipped = 0, totalMs = 0;

for (const row of rows) {
  if (row.operator_label === 'unknown' || !row.operator_label) {
    skipped++;
    continue;
  }
  const t0 = performance.now();
  let parsed = null;
  try {
    const resp = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: row.prompt, stream: false }),
      signal: AbortSignal.timeout(120_000),
    });
    const t1 = performance.now();
    totalMs += (t1 - t0);
    const data = await resp.json();
    const raw = data.response || '';
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    let candidate = fence ? fence[1] : raw;
    const s = candidate.indexOf('{');
    const e = candidate.lastIndexOf('}');
    if (s !== -1 && e > s) {
      try { parsed = JSON.parse(candidate.slice(s, e + 1)); } catch {}
    }
  } catch (err) {
    totalMs += (performance.now() - t0);
    console.error(`  Error on ${row.taskId}: ${err.message}`);
  }

  const predicted = parsed?.intent_matches === false;
  const truth = row.operator_label === 'TP';
  if (predicted && truth) tp++;
  else if (predicted && !truth) fp++;
  else if (!predicted && truth) fn++;
  else tn++;
}

const total = tp + fp + fn + tn;
const precision = tp / (tp + fp) || 0;
const recall = tp / (tp + fn) || 0;
const f1 = 2 * precision * recall / (precision + recall) || 0;
console.log(JSON.stringify({
  model, host,
  total, skipped,
  tp, fp, fn, tn,
  precision: +precision.toFixed(3),
  recall: +recall.toFixed(3),
  f1: +f1.toFixed(3),
  avgLatencyMs: Math.round(totalMs / (total || 1)),
}, null, 2));
