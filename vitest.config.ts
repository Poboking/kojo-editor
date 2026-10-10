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
      '@kojo/plugin-sav-parser': r('./packages/plugins/sav-parser/src/index.ts'),
      '@kojo/plugin-state-replay': r('./packages/plugins/state-replay/src/index.ts'),
      '@kojo/plugin-kojo-sugar': r('./packages/plugins/kojo-sugar/src/index.ts'),
      '@kojo/plugin-ui-convention-report': r('./packages/plugins/ui-convention-report/src/index.ts'),
      '@kojo/plugin-ui-state-replay': r('./packages/plugins/ui-state-replay/src/index.ts'),
      '@kojo/plugin-ui-kojo-navigator': r('./packages/plugins/ui-kojo-navigator/src/index.ts'),
      '@kojo/plugin-ui-archive-browser': r('./packages/plugins/ui-archive-browser/src/index.ts'),
      '@kojo/plugin-ui-snapshot-injector': r('./packages/plugins/ui-snapshot-injector/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
