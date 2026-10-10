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
      '@kojo/plugin-ui-convention-report': r('../plugins/ui-convention-report/src/index.ts'),
      '@kojo/plugin-ui-state-replay': r('../plugins/ui-state-replay/src/index.ts'),
      '@kojo/plugin-ui-kojo-navigator': r('../plugins/ui-kojo-navigator/src/index.ts'),
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
    chunkSizeWarningLimit: 4096,
  },
});
