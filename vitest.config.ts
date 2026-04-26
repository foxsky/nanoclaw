import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', '.claude/skills/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      // Skill add/ and modify/ trees are reference files for re-application
      // on a fork — not runnable in-place (imports target host-repo paths,
      // not relative to the skill dir).
      '.claude/skills/**/add/**/*.test.ts',
      '.claude/skills/**/modify/**/*.test.ts',
    ],
  },
});
