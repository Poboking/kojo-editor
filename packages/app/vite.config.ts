import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * 把 `web-tree-sitter` 里两条 **node 专用** 的动态 import 就地换成抛错的 promise。
 *
 * 为什么必须换（一句话：不换就构建不过）：那两条 `await import("fs/promises")` /
 * `await import("module")` 各自躲在 `ENVIRONMENT_IS_NODE` 判据后面，浏览器与 worker
 * 里永不执行；但 Rollup 只看语法——动态 import ⇒ 产物要多一枚 chunk，而 worker 的
 * `format` 默认值 `iife` 明确不接受 code-splitting：
 * `Invalid value "iife" for option "worker.format" - UMD and IIFE output formats are not
 * supported for code-splitting builds`（实测：`pnpm --filter @kojo/app build` 当场失败）。
 *
 * 试过并**否掉**的两条路：
 * - 把 `fs/promises` / `module` 走 `resolve.alias` 钉到桩模块：alias 生效了，但动态
 *   import 本身还在 ⇒ Rollup 仍切出 `node-only-stub-*.js` 单独 chunk，iife 照旧拒；
 * - `worker: { format: 'es' }`：能过，但那会把**既有**的 Monaco `editor.worker` 与本仓的
 *   `compute-worker` 一起改成模块 worker。一条默认关的实验特性不该动别人的加载方式。
 *
 * 换掉的表达式保留 `await` 语义：真在浏览器里走到这一步就是当场抛（要看见的 bug），
 * 而不是静默拿到 undefined。正则每调用一次现造（带 `g` 的标志位不能跨文件复用）。
 */
function stubNodeOnlyDynamicImports(): Plugin {
  return {
    name: 'kojo:stub-node-only-dynamic-imports',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').includes('web-tree-sitter')) return null;
      const pattern = /import\(\s*["'](?:node:)?(?:fs\/promises|module)["']\s*\)/g;
      if (!pattern.test(code)) return null;
      return {
        code: code.replace(
          pattern,
          'Promise.reject(new Error("node 内置模块在浏览器 / worker 里不可用"))',
        ),
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@kojo/plugin-api': r('../plugin-api/src/index.ts'),
      // 语言面库的叶子**必须排在桶之前**：alias 的匹配口径是
      // 「等于 find」或「以 `find + /` 开头」，桶若在前会把 `/constants` 也吃掉。
      '@kojo/kojo-lang/constants': r('../kojo-lang/src/constants.ts'),
      '@kojo/kojo-lang/name-chars': r('../kojo-lang/src/name-chars.ts'),
      '@kojo/kojo-lang/declarations': r('../kojo-lang/src/declarations.ts'),
      '@kojo/kojo-lang/sourcemap': r('../kojo-lang/src/sourcemap.ts'),
      '@kojo/kojo-lang/expand-view': r('../kojo-lang/src/expand-view.ts'),
      '@kojo/kojo-lang/symbols': r('../kojo-lang/src/symbols.ts'),
      '@kojo/kojo-lang': r('../kojo-lang/src/index.ts'),
      '@kojo/kernel': r('../kernel/src/index.ts'),
      '@kojo/plugin-erb-parser': r('../plugins/erb-parser/src/index.ts'),
      '@kojo/plugin-eratw-adapter': r('../plugins/eratw-adapter/src/index.ts'),
      '@kojo/plugin-convention-linter': r('../plugins/convention-linter/src/index.ts'),
      '@kojo/plugin-condition-extractor': r('../plugins/condition-extractor/src/index.ts'),
      '@kojo/plugin-sav-parser': r('../plugins/sav-parser/src/index.ts'),
      '@kojo/plugin-state-replay': r('../plugins/state-replay/src/index.ts'),
      '@kojo/plugin-kojo-sugar': r('../plugins/kojo-sugar/src/index.ts'),
      '@kojo/plugin-ui-convention-report': r('../plugins/ui-convention-report/src/index.ts'),
      '@kojo/plugin-ui-state-replay': r('../plugins/ui-state-replay/src/index.ts'),
      '@kojo/plugin-ui-kojo-navigator': r('../plugins/ui-kojo-navigator/src/index.ts'),
      '@kojo/plugin-ui-archive-browser': r('../plugins/ui-archive-browser/src/index.ts'),
      '@kojo/plugin-ui-snapshot-injector': r('../plugins/ui-snapshot-injector/src/index.ts'),
      '@kojo/plugin-ui-sugar-lift': r('../plugins/ui-sugar-lift/src/index.ts'),
      '@kojo/plugin-ui-sugar-preview': r('../plugins/ui-sugar-preview/src/index.ts'),
      '@kojo/plugin-ui-sugar-editor': r('../plugins/ui-sugar-editor/src/index.ts'),
      '@kojo/plugin-ui-status': r('../plugins/ui-plugin-status/src/index.ts'),
    },
  },
  worker: {
    /**
     * worker 的构建**不吃根 `plugins`**：Vite 只把 `worker.plugins()` 返回的那批装进 worker
     * 环境（实测挂在根上时那两条动态 import 原样留下、照样切 chunk），故这枚桩插件挂在这里。
     * 形态用文档推荐的**函数**——直接传数组会触发
     * `worker.plugins is now a function that returns an array of plugins` 警告。
     * `format` 保持默认 iife ⇒ 既有 `editor.worker` / `compute-worker` 的加载方式一字不动。
     */
    plugins: () => [stubNodeOnlyDynamicImports()],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // `.kojo-debug/`＝Web 调试模式（2026-10-24 调试模式批）的沙盒 / appData / 截图落点，
    // 编辑器一开项目就在里面持续写会话与自动保存账本——不忽略的话每次写盘都会触发
    // HMR 整页刷新（实测：项目被弹回欢迎页、调试面事件环被清空），把调试会话拆碎。
    watch: { ignored: ['**/src-tauri/**', '**/.kojo-debug/**'] },
  },
  build: {
    target: 'es2022',
    /**
     * PS-10 ④（两条都是"量过才写"，不是猜）：
     * - `reportCompressedSize: false`：产物 ~5.5 MB 全在本地 `tauri://` 协议上跑，
     *   gzip 报表既不进体积也不进加载，纯烧构建循环的时间。
     * - `modulePreload.polyfill: false`：polyfill 是给不支持 `<link rel=modulepreload>`
     *   的浏览器补的探测垫片，而本壳的唯一运行时是 WebView2（Chromium evergreen，
     *   原生支持）⇒ 入口里那段运行时检测与额外 chunk 是白拿。关掉后 `index.html`
     *   少一枚 preload 标签、入口块少一截垫片（实测见交付读数）。
     * 刻意**不动** `manualChunks`：懒分割已经由动态 `import()` 边界决定，插件块
     * 由 Rollup 按 18 个动态入口自然切分；再叠一层手工分桶需要先量首屏与开项目
     * 两段的往返数，本批没有这个预算。
     */
    reportCompressedSize: false,
    modulePreload: { polyfill: false },
  },
});
