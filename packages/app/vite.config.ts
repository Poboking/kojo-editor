import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@kojo/plugin-api': r('../plugin-api/src/index.ts'),
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
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
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
