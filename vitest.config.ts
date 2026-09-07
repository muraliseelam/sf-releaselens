import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // `main.ts` and `service-worker.ts` are chrome wiring with no logic of
      // their own; everything they call is covered here.
      include: [
        'src/core/**',
        'src/data/**',
        'src/background/router.ts',
        'src/background/messages.ts',
        'src/ui/**',
      ],
      exclude: ['src/ui/main.ts', 'src/ui/handlers.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
