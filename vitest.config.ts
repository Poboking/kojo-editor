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
      '@kojo/plugin-kojo-market': r('./packages/plugins/kojo-market/src/index.ts'),
      '@kojo/plugin-ui-condition-matrix': r('./packages/plugins/ui-condition-matrix/src/index.ts'),
      '@kojo/plugin-ui-convention-report': r('./packages/plugins/ui-convention-report/src/index.ts'),
      '@kojo/plugin-ui-state-replay': r('./packages/plugins/ui-state-replay/src/index.ts'),
      '@kojo/plugin-ui-kojo-navigator': r('./packages/plugins/ui-kojo-navigator/src/index.ts'),
      '@kojo/plugin-ui-archive-browser': r('./packages/plugins/ui-archive-browser/src/index.ts'),
      '@kojo/plugin-ui-snapshot-injector': r('./packages/plugins/ui-snapshot-injector/src/index.ts'),
      '@kojo/plugin-ui-sugar-lift': r('./packages/plugins/ui-sugar-lift/src/index.ts'),
      '@kojo/plugin-ui-sugar-preview': r('./packages/plugins/ui-sugar-preview/src/index.ts'),
      '@kojo/plugin-ui-sugar-editor': r('./packages/plugins/ui-sugar-editor/src/index.ts'),
    },
  },
  test: {
    // tools/tests = 仓库 node 验收工具自己的纯逻辑护栏（产物落点 / 语料盘写入门禁）；
    // 只有 tsconfig include 里的 packages/** 才进 tsc，故这一支不经 root typecheck。
    include: ['packages/**/tests/**/*.test.ts', 'tools/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
