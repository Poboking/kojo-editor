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
      // B3c 车道 2：补全 / 悬停的判据叶子（同样必须排在桶之前）。
      '@kojo/kojo-lang/completion': r('./packages/kojo-lang/src/completion.ts'),
      '@kojo/kojo-lang/completion-snippets': r('./packages/kojo-lang/src/completion-snippets.ts'),
      '@kojo/kojo-lang/hover': r('./packages/kojo-lang/src/hover.ts'),
      '@kojo/kojo-lang/event-sites': r('./packages/kojo-lang/src/event-sites.ts'),
      '@kojo/kojo-lang/adapter-source': r('./packages/kojo-lang/src/adapter-source.ts'),
      '@kojo/kojo-lang/expand-compile': r('./packages/kojo-lang/src/expand-compile.ts'),
      '@kojo/kojo-sdk/semantic-roles': r('./packages/kojo-sdk/src/semantic-roles.ts'),
      '@kojo/kojo-sdk/structure-protocol': r('./packages/kojo-sdk/src/structure-protocol.ts'),
      '@kojo/kojo-sdk/contracts': r('./packages/kojo-sdk/src/contracts.ts'),
      '@kojo/kojo-sdk': r('./packages/kojo-sdk/src/index.ts'),
      '@kojo/kojo-lang/theme-rules': r('./packages/kojo-lang/src/theme-rules.ts'),
      '@kojo/kojo-lang/lexicon': r('./packages/kojo-lang/src/lexicon.ts'),
      '@kojo/kojo-lang/monarch': r('./packages/kojo-lang/src/monarch.ts'),
      '@kojo/kojo-lang/language-config': r('./packages/kojo-lang/src/language-config.ts'),
      '@kojo/kojo-lang/monaco-theme': r('./packages/kojo-lang/src/monaco-theme.ts'),
      '@kojo/kojo-lang': r('./packages/kojo-lang/src/index.ts'),
      // 语言层共用词表（LAU-3b 解耦批）：叶子同样必须排在桶之前。
      '@kojo/kojo-vocab/keywords': r('./packages/kojo-vocab/src/keywords.ts'),
      '@kojo/kojo-vocab/system-functions': r('./packages/kojo-vocab/src/system-functions.ts'),
      '@kojo/kojo-vocab/identifier-chars': r('./packages/kojo-vocab/src/identifier-chars.ts'),
      '@kojo/kojo-vocab/engine-globals': r('./packages/kojo-vocab/src/engine-globals.ts'),
      '@kojo/kojo-vocab/statement-functions': r('./packages/kojo-vocab/src/statement-functions.ts'),
      '@kojo/kojo-vocab/blank-charset': r('./packages/kojo-vocab/src/blank-charset.ts'),
      '@kojo/kojo-vocab/sugar-ident': r('./packages/kojo-vocab/src/sugar-ident.ts'),
      '@kojo/kojo-vocab/types': r('./packages/kojo-vocab/src/types.ts'),
      '@kojo/kojo-vocab/lexer': r('./packages/kojo-vocab/src/lexer.ts'),
      '@kojo/kojo-vocab/formatter': r('./packages/kojo-vocab/src/formatter.ts'),
      '@kojo/kojo-vocab/enter': r('./packages/kojo-vocab/src/enter.ts'),
      '@kojo/kojo-vocab/engine': r('./packages/kojo-vocab/src/engine.ts'),
      '@kojo/kojo-vocab': r('./packages/kojo-vocab/src/index.ts'),
      '@kojo/kojo-conformance': r('./packages/kojo-conformance/src/index.ts'),
      '@kojo/kojo-project-kit': r('./packages/kojo-project-kit/src/index.ts'),
      '@kojo/kernel': r('./packages/kernel/src/index.ts'),
      '@kojo/plugin-erb-parser': r('./packages/plugins/erb-parser/src/index.ts'),
      '@kojo/plugin-eratw-adapter': r('./packages/plugins/eratw-adapter/src/index.ts'),
      // 2.0 面叶子（SDK B5 收尾）：conformance 第二列改走包面，不再按相对路径直捅别人的 src。
      // 叶子排在桶之前——将来若给本包加桶别名，这两行必须留在它上面（B3c 就加了一枚桶）。
      '@kojo/plugin-erafl-adapter/kojo2': r('./packages/plugins/erafl-adapter/src/kojo2/index.ts'),
      // B3c 车道 2：搬进 `packages/kojo-lang/tests` 的补全闸要拿 eraFL 的 adapter 做
      // "同一份文本、两个方言"的对拍（原在 `packages/app/tests` 时靠 app 的 node_modules 解析，
      // 换到 kojo-lang 就没有那枚 workspace 链接了）；与上面 `plugin-eratw-adapter` 同一条路。
      '@kojo/plugin-erafl-adapter': r('./packages/plugins/erafl-adapter/src/index.ts'),
      '@kojo/plugin-eraakumamaid-adapter': r('./packages/plugins/eraakumamaid-adapter/src/index.ts'),
      '@kojo/plugin-erakoumakan-adapter': r('./packages/plugins/erakoumakan-adapter/src/index.ts'),
      '@kojo/plugin-erasqc-adapter': r('./packages/plugins/erasqc-adapter/src/index.ts'),
      '@kojo/plugin-eratohok-adapter': r('./packages/plugins/eratohok-adapter/src/index.ts'),
      '@kojo/plugin-eraav-adapter': r('./packages/plugins/eraav-adapter/src/index.ts'),
      '@kojo/plugin-eratohoreverse-adapter': r('./packages/plugins/eratohoreverse-adapter/src/index.ts'),
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
