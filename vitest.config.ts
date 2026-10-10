import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    extensions: ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
    alias: {
      '@kojo/plugin-api': r('./packages/plugin-api/src/index.ts'),
      '@kojo/kernel': r('./packages/kernel/src/index.ts'),
      '@kojo/plugin-erb-parser': r('./packages/plugins/erb-parser/src/index.ts'),
      '@kojo/plugin-eratw-adapter': r('./packages/plugins/eratw-adapter/src/index.ts'),
      '@kojo/plugin-convention-linter': r('./packages/plugins/convention-linter/src/index.ts'),
      '@kojo/plugin-condition-extractor': r('./packages/plugins/condition-extractor/src/index.ts'),
      '@kojo/plugin-ui-convention-report': r('./packages/plugins/ui-convention-report/src/index.ts'),
      '@kojo/plugin-ui-kojo-navigator': r('./packages/plugins/ui-kojo-navigator/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
