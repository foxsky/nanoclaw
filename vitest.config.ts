import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', '.claude/skills/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '.claude/skills/**/add/src/**/*.test.ts',
      '.claude/skills/**/modify/src/**/*.test.ts',
    ],
  },
});
