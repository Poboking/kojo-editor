import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { mainExclude } from './tools/perf-suite.mjs';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
/** 仓库根（本文件所在目录）；分池扫描以它为锚，与 `--config` 的调用目录无关 */
const rootDir = fileURLToPath(new URL('.', import.meta.url));

export const config = defineConfig({
  resolve: {
    extensions: ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
    alias: {
      '@kojo/plugin-api': r('./packages/plugin-api/src/index.ts'),
      '@kojo/kojo-core': r('./packages/kojo-core/src/index.ts'),
      // 语言面库：叶子**必须排在桶之前**（alias 的匹配口径是「等于 find」或
      // 「以 `find + /` 开头」，桶在前会把 `/constants` 也吃掉）。
      '@kojo/kojo-lang/constants': r('./packages/kojo-lang/src/constants.ts'),
      '@kojo/kojo-lang/name-chars': r('./packages/kojo-lang/src/name-chars.ts'),
      '@kojo/kojo-lang/interpolation': r('./packages/kojo-lang/src/interpolation.ts'),
      '@kojo/kojo-lang/declarations': r('./packages/kojo-lang/src/declarations.ts'),
      '@kojo/kojo-lang/sourcemap': r('./packages/kojo-lang/src/sourcemap.ts'),
      '@kojo/kojo-lang/expand-view': r('./packages/kojo-lang/src/expand-view.ts'),
      '@kojo/kojo-lang/symbols': r('./packages/kojo-lang/src/symbols.ts'),
      '@kojo/kojo-lang/definition': r('./packages/kojo-lang/src/definition.ts'),
      '@kojo/kojo-lang/inlay': r('./packages/kojo-lang/src/inlay.ts'),
      '@kojo/kojo-lang/adapter-source': r('./packages/kojo-lang/src/adapter-source.ts'),
      '@kojo/kojo-lang/expand-compile': r('./packages/kojo-lang/src/expand-compile.ts'),
      '@kojo/kojo-lang': r('./packages/kojo-lang/src/index.ts'),
      '@kojo/kojo-conformance': r('./packages/kojo-conformance/src/index.ts'),
      '@kojo/kojo-project-kit': r('./packages/kojo-project-kit/src/index.ts'),
      '@kojo/kernel': r('./packages/kernel/src/index.ts'),
      '@kojo/plugin-erb-parser': r('./packages/plugins/erb-parser/src/index.ts'),
      '@kojo/plugin-eratw-adapter': r('./packages/plugins/eratw-adapter/src/index.ts'),
      '@kojo/plugin-eraakumamaid-adapter': r('./packages/plugins/eraakumamaid-adapter/src/index.ts'),
      '@kojo/plugin-erakoumakan-adapter': r('./packages/plugins/erakoumakan-adapter/src/index.ts'),
      '@kojo/plugin-convention-linter': r('./packages/plugins/convention-linter/src/index.ts'),
      '@kojo/plugin-condition-extractor': r('./packages/plugins/condition-extractor/src/index.ts'),
      '@kojo/plugin-sav-parser': r('./packages/plugins/sav-parser/src/index.ts'),
      '@kojo/plugin-state-replay': r('./packages/plugins/state-replay/src/index.ts'),
      '@kojo/plugin-kojo-sugar': r('./packages/plugins/kojo-sugar/src/index.ts'),
      '@kojo/plugin-kojo-lang': r('./packages/plugins/kojo-lang/src/index.ts'),
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
      '@kojo/plugin-ui-market': r('./packages/plugins/ui-market/src/index.ts'),
    },
  },
  test: {
    // tools/tests = 仓库 node 验收工具自己的纯逻辑护栏（产物落点 / 语料盘写入门禁）；
    // 只有 tsconfig include 里的 packages/** 才进 tsc，故这一支不经 root typecheck。
    include: ['packages/**/tests/**/*.test.ts', 'tools/tests/**/*.test.ts'],
    // 墙钟计时用例**不在本池跑**：并行池里计时用例互相饿死 = CI 随机红（分池判据见 tools/perf-suite.mjs）。
    // vitest 里显式写 exclude 会覆盖默认值，所以默认那三项由 mainExclude() 自己列全。
    exclude: [...mainExclude(rootDir)],
    environment: 'node',
    testTimeout: 20000,
  },
});

/** 计时池（`vitest.perf.config.ts`）直接复用这一个对象，杜绝两份 alias 漂移 */
export default config;
