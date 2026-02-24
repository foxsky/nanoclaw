import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['.claude/skills/**/*.test.ts'],
  },
});
