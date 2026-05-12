#!/usr/bin/env tsx
/**
 * Runtime pinning audit for Taskflow v1↔v2 compliance replay.
 *
 * This is intentionally read-only. It records the runner/tooling values that
 * need to be pinned for strict compliance-grade replay.
 */
import fs from 'node:fs';

interface AuditRow {
  key: string;
  value: string;
  source: string;
  compliance_note: string;
}

function readJson(pathname: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(pathname, 'utf8')) as Record<string, unknown>;
}

function findLine(pathname: string, pattern: RegExp): string | null {
  if (!fs.existsSync(pathname)) return null;
  return fs.readFileSync(pathname, 'utf8').split('\n').find((line) => pattern.test(line))?.trim() ?? null;
}

function dependencyVersion(pkgPath: string, name: string): string {
  const pkg = readJson(pkgPath);
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  return deps[name] ?? '<not found>';
}

function countBoardIdExamples(): string {
  const p = 'groups/seci-taskflow/CLAUDE.local.md';
  if (!fs.existsSync(p)) return '<missing>';
  const text = fs.readFileSync(p, 'utf8');
  const matches = text.match(/api_[a-z_]+\(\{\s*board_id:/g);
  return String(matches?.length ?? 0);
}

function main(): void {
  const rows: AuditRow[] = [
    {
      key: '@anthropic-ai/claude-agent-sdk',
      value: dependencyVersion('container/agent-runner/package.json', '@anthropic-ai/claude-agent-sdk'),
      source: 'container/agent-runner/package.json',
      compliance_note: 'Pin exact version in package manifest/lockfile for strict replay.',
    },
    {
      key: 'CLAUDE_CODE_VERSION',
      value: findLine('container/Dockerfile', /ARG CLAUDE_CODE_VERSION=/)?.replace('ARG ', '') ?? '<not found>',
      source: 'container/Dockerfile',
      compliance_note: 'Pinned build arg controls bundled Claude Code CLI.',
    },
    {
      key: 'BUN_VERSION',
      value: findLine('container/Dockerfile', /ARG BUN_VERSION=/)?.replace('ARG ', '') ?? '<not found>',
      source: 'container/Dockerfile',
      compliance_note: 'Container runtime version should remain fixed during replay.',
    },
    {
      key: 'SDK_SETTING_SOURCES',
      value: findLine('container/agent-runner/src/providers/claude.ts', /SDK_SETTING_SOURCES/) ?? '<not found>',
      source: 'container/agent-runner/src/providers/claude.ts',
      compliance_note: 'Should stay empty so project settings cannot reintroduce blocked tools.',
    },
    {
      key: 'SDK_DISALLOWED_TOOLS',
      value: findLine('container/agent-runner/src/providers/claude.ts', /SDK_DISALLOWED_TOOLS/) ?? '<not found>',
      source: 'container/agent-runner/src/providers/claude.ts',
      compliance_note: 'Audit includes sqlite and general workspace tools in disallowed list.',
    },
    {
      key: 'model',
      value: findLine('container/agent-runner/src/providers/claude.ts', /model: this\.model/) ?? '<provider configurable; no hard pin found>',
      source: 'container/agent-runner/src/providers/claude.ts',
      compliance_note: 'Strict replay should set explicit model in container config/defaults.',
    },
    {
      key: 'effort',
      value: findLine('container/agent-runner/src/providers/claude.ts', /effort: this\.effort/) ?? '<provider configurable; no hard pin found>',
      source: 'container/agent-runner/src/providers/claude.ts',
      compliance_note: 'Strict replay should set explicit effort/thinking level.',
    },
    {
      key: 'seci CLAUDE.local.md board_id examples',
      value: countBoardIdExamples(),
      source: 'groups/seci-taskflow/CLAUDE.local.md',
      compliance_note: 'Must be 0 for v2 hidden/injected board_id behavior.',
    },
  ];

  const out = {
    generated_at: new Date().toISOString(),
    rows,
    strict_replay_recommendations: [
      'Pin model and effort in container_config/defaults before compliance replay.',
      'Keep SDK_SETTING_SOURCES empty and sqlite tools disallowed.',
      'Archive the generated CLAUDE.local.md used for each run.',
      'Record container image build args and lockfiles with replay artifacts.',
    ],
  };

  const text = [
    '=== Phase 3 runtime pinning audit ===',
    '',
    ...rows.map((row) => [
      `${row.key}: ${row.value}`,
      `  source: ${row.source}`,
      `  note: ${row.compliance_note}`,
    ].join('\n')),
    '',
    'Strict replay recommendations:',
    ...out.strict_replay_recommendations.map((line) => `- ${line}`),
  ].join('\n');

  fs.writeFileSync('/tmp/phase3-runtime-audit.json', JSON.stringify(out, null, 2));
  fs.writeFileSync('/tmp/phase3-runtime-audit.txt', text);
  console.log(text);
  console.log('\nWrote: /tmp/phase3-runtime-audit.json, /tmp/phase3-runtime-audit.txt');
}

main();

