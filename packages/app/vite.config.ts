import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * 引导层品牌锁的版本号：内联 `index.html` 等不到 `styles.css` / 模块图，但版本又必须与
 * `package.json` 单一真源一致 ⇒ 构建期（dev + build）把占位符换成包清单现值。
 * 内联层其余内容仍手写；只有这一格走注入，免得版本三处漂移。
 */
const APP_VERSION = (JSON.parse(readFileSync(r('./package.json'), 'utf8')) as { version: string }).version;

function injectAppVersion(): Plugin {
  return {
    name: 'kojo:inject-app-version',
    transformIndexHtml(html) {
      return html.replaceAll('%KOJO_APP_VERSION%', APP_VERSION);
    },
  };
}

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

/**
 * vendor 分桶（2026-10-25 拆包批）：把「首屏必然要、但自己很少变」的依赖从入口块里摘出去，
 * 入口只留宿主自己的 UI 代码。
 *
 * 口径来自一次 `generateBundle` 逐模块体积报表（实测入口块 1,029.9 kB 字符 / 289 模块）：
 *   react-dom 638 KB(28.9%) · 工作区包 839 KB(38.0%) · 宿主自身 656 KB(29.7%)
 * —— 入口块的 2/3 与"改一行 UI"无关。分组按**依赖方向**切，不按大小切：`react` 无内部依赖、
 * 且全部在开机图上；`vendor-kojo-core`（kernel / kojo-lang / plugin-api / kojo-project-kit）
 * 只被插件依赖；插件一枚一块、只依赖前两者（audit B/C 已在源码层禁掉插件互引），
 * 故所有边单向、不可能成环（构建无循环 chunk 警告，实测见提交信息）。
 *
 * 刻意**不**把 monaco 并进来：它本来就由 `monaco/entry.ts` 的动态 `import()` 边界自成一块
 * （4,078 kB），且不在开机图里（ps10-eager-graph 的成员断言钉住）。
 *
 * ⚠ **只搬开机图上那一半**（这一条是量出来的）：manualChunks 是"整包认领"，认了
 * `packages/plugins/eratw-adapter/` 就等于把它连**懒边上**的模块一起拉进一个开机即 preload
 * 的块。不做这个过滤的一版实测首屏 JS **1,150 kB → 1,541 kB**（+34%）——入口块是小了、
 * 首屏反而更慢。所以先自己走一遍从入口出发的静态图（判定器见 `createEagerProbe` 头注里
 * 那两个坑），只对本就在图里的模块认领；懒边上的模块一律交回 rollup 按 `import()` 自然切分。
 *
 * 代价（如实记）：首屏 JS 从 1 个块变成 6 个（入口 + react + kojo-core + 三个常驻插件），
 * 它们全是入口的**静态**依赖 ⇒ Vite 各生成一条 `<link rel=modulepreload>`，与入口并行取。
 * 但**字节不是零成本**：实测 1,150.25 kB → 1,265.39 kB（+115 kB / +10%），且已排除重复
 * （全 bundle 逐模块去重，dup=0）——差额是跨块引用的固有代价（跨块导出的符号名改不掉、
 * 也内联不了）。换句话说：这一批买到的是「入口块 1,150 → 388 kB」与"改宿主 UI 不再让
 * react 那 222 kB 重新哈希"，付出的代价是首屏多背 10% 的代码。
 */
/** rollup 传给 `manualChunks` 的第二参（只声明本文件用到的那几个成员） */
interface ChunkGraphApi {
  getModuleIds(): Iterable<string>;
  getModuleInfo(id: string): {
    isEntry: boolean;
    isIncluded: boolean | null;
    importedIds: readonly string[];
    dynamicallyImportedIds: readonly string[];
  } | null;
}

/**
 * 建一枚「是否在开机图里」的判定器：从入口模块出发，只沿**留得下的静态边**走一遍。
 *
 * 三条都是实测踩出来的，缺一条就会把懒模块拽上首屏（第一版两条都缺，首屏 JS 从
 * 1,150 kB 涨到 1,515 kB）：
 * 1. `importedIds` 是**该模块声明的全部 source**，动态 `import()` 也在里头 —— 必须减去
 *    `dynamicallyImportedIds`，否则等于把 24 条懒边一起跟了（kojo-core 的 `lower/**`
 *    整包从懒块 `service-*.js` 被搬进开机预取的块）；
 * 2. 被**树摇掉**的模块不往下走（`isIncluded === false`）：`@kojo/kojo-core` 的桶就是这种——
 *    它自己的代码一枚都没留下（产物里根本没有 `kojo-core/src/index.ts` 这一块），但它的
 *    re-export 清单仍挂在模块图上，顺着它走会把「只有懒消费者真用到」的 `compile` /
 *    `lower/expand/**` 当成开机依赖；
 * 3. 走不到 ⇒ `false`。宁可少搬（那块留在入口）也不能多搬（把懒模块拽到首屏）。
 *
 * 结果缓存一次：`manualChunks` 每个模块调一次，图走一遍就够。
 */
function createEagerProbe(api: ChunkGraphApi): (id: string) => boolean {
  let eager: Set<string> | null = null;
  return (id) => {
    if (eager === null) {
      eager = new Set<string>();
      const stack: string[] = [];
      for (const m of api.getModuleIds()) if (api.getModuleInfo(m)?.isEntry === true) stack.push(m);
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (eager.has(cur)) continue;
        eager.add(cur);
        const info = api.getModuleInfo(cur);
        if (info === null || !info.isIncluded) continue; // 树摇掉的桶：它的 re-export 不构成开机依赖
        const lazy = new Set(info.dynamicallyImportedIds);
        for (const dep of info.importedIds) if (!lazy.has(dep)) stack.push(dep);
      }
    }
    return eager.has(id);
  };
}

/**
 * 懒边上的**插件族**（2026-10-25 件数批）：三个族，判据只有一条——
 * **它们在 `bootstrap.ts` 的同一个 `Promise.all` 里被一起取**。
 *
 * 为什么合并是"零延迟成本"的（这一条是读 `loadProjectPlugins` 读出来的，不是猜的）：
 * 19 个项目级插件是**同一条 `await Promise.all([...19 个 import()])`** 取回来的，改动前
 * 就是 19 个并行请求、同一时刻发出、同一时刻等齐；并成三块之后仍是同一时刻发出，只是
 * 请求数从 23 降到 3。也就是说：**合并省掉的是请求数，代价为零**——没有"打开 A 面板却
 * 装了 B 面板字节"的问题，因为 B 的字节本来就在同一拍里落地。
 *
 * 为什么是**三**族而不是一族（并成一坨也能量到更少的件数，但那是为了数字好看）：
 * 三族对应三条真实的维护边界——**适配器**（游戏事实）/ **引擎**（游戏无关的解析与转译）/
 * **UI 面**（面板与菜单贡献）。改一个面板不必让 340 kB 的引擎块重新哈希，反之亦然。
 * 分族口径与 `bootstrap.ts` 里的注释分组逐条对齐。
 *
 * 三条硬约束（违反任何一条这批就白做）：
 * 1. **只碰懒边**：由下面的 `isEager` 先分流，开机图上的模块走原路，族表不参与；
 * 2. **不跨装载拍**：`eratw-adapter` 的 `tutorial-*` 是"用户点开教程浮层"才 `import()` 的
 *    另一拍（122 kB 文案），**不在本表里**，仍是自己的块——否则开项目就白背一份教程正文；
 * 3. **不碰 CSS / worker / asset-url**：样式有既定的到达顺序（`styles-project.css` →
 *    `market.css`，见 `App.tsx`），worker 与 `?url` 模块各有自己的装配方式。
 */
const LAZY_PLUGIN_FAMILIES: ReadonlyArray<{ readonly name: string; readonly test: RegExp }> = [
  // 五个项目级适配器（eraTW 是常驻的，不在此列）：`adapter-manifest` 的清单逐条 load()
  {
    name: 'lazy-plugin-adapter',
    test: /\/packages\/plugins\/(?:eraakumamaid|erafl|erakoumakan|erasqc|eratohok)-adapter\//,
  },
  // 游戏无关的引擎侧（含 kojo-sugar 的 parser/lexer 共享块 `service-*`，它只被懒消费者 import）
  {
    name: 'lazy-plugin-engine',
    test:
      /\/packages\/plugins\/(?:condition-extractor|convention-linter|kojo-lang|kojo-market|kojo-sugar|sav-parser|state-replay)\//,
  },
  // 面板 / 菜单 / 状态栏这些呈现面
  { name: 'lazy-plugin-ui', test: /\/packages\/plugins\/ui-[^/]+\// },
];

/**
 * 懒边上的**碎叶子**（2026-10-25 件数批）：一枚模块一枚产物、单块 0.06–1.6 kB、合计 **9.6 kB**
 * 却占了 12 个文件名 / 12 个请求。
 *
 * 为什么可以并：它们全是"偏好 / 小工具"级的共享叶子（`theme-pref` / `code-font` / `modal-stack`
 * 被多个浮层共享，`language-mode-pref` / `tree-sitter-pref` / `semantic-color-pref` 被设置面与
 * 编辑器两侧共享，`kojo-lang` 的三枚是语言面叶子）。Rollup 把"被 ≥2 个动态入口共享的模块"
 * 各切一块，于是产物里出现一串 0.1 kB 的文件——**这不是懒加载粒度，这是切块税**。
 * 并成一枚 `lazy-pin` 之后，任何一枚的加载方多背的字节 = 这张表的总额（9.6 kB，实测产物
 * 11.8 kB，差额是 `editor-options` 这类只被 pin 成员用到的邻居被顺带并了进来）。
 *
 * 白名单而不是"小于 N kB 就并"：`manualChunks` 拿到的是模块 id，看不到渲染后体积，想按体积
 * 判就得先构建一遍。这张表是**量出来**的（`generateBundle` 逐块报表），加减条目都要重量。
 *
 * ⚠ **monaco 侧那七枚碎叶子（`word-separators` / `positions` / `tree-sitter/types` /
 * `tree-sitter/indent` / `kojo-folding` / `kojo-code-action` / `kojo-completion-position`，
 * 合计 4.5 kB）试过、**退回来了**：把它们也放进本表之后，`lazy-pin` 块会被入口块**静态**引用
 * （首屏 6 块 → 8 块、1,051.7 → 1,466.6 kB，`lazy-plugin-engine` 也被一起拽上来）。
 * 逐块报表显示被卷进来的是"整条 `languages` 块 + 整条 `theme` 块 + 入口块里的
 * `kojo2-cutover` / `kojo2-migrate-model`"，而 `isEager` 对这几枚叶子自始至终判"懒"
 * （用 `KOJO_TRACE_EAGER` 逐模块打过），所以这不是判定器的漏点，是 **Rollup 的合并策略**在
 * 手工 chunk 变多时的连带效应——机制没查清之前不硬上。留 7 枚共 4.5 kB 的碎块，比首屏多背
 * 415 kB 划算得多。
 */
const LAZY_PIN_SUFFIXES: readonly string[] = [
  '/packages/app/src/ui/code-font.ts',
  '/packages/app/src/ui/contact.ts',
  '/packages/app/src/ui/index-state-copy.ts',
  '/packages/app/src/ui/language-mode-pref.ts',
  '/packages/app/src/ui/modal-stack.ts',
  '/packages/app/src/ui/reference-tally-store.ts',
  '/packages/app/src/ui/semantic-color-pref.ts',
  '/packages/app/src/ui/theme-pref.ts',
  '/packages/app/src/ui/tree-sitter-pref.ts',
  '/packages/kojo-lang/src/adapter-source.ts',
  '/packages/kojo-lang/src/definition.ts',
  '/packages/kojo-lang/src/expand-compile.ts',
];

function createManualChunks(): (id: string, api: ChunkGraphApi) => string | undefined {
  let isEager: ((id: string) => boolean) | null = null;
  return (id, api) => {
    isEager ??= createEagerProbe(api);
    const p = id.replaceAll('\\', '/');
    if (!isEager(id)) {
      // 懒边：只有**同族合并**，没有跨拍搬运（见上面两张表的头注）。
      if (p.endsWith('.css') || p.includes('?worker') || p.includes('?url')) return undefined;
      // `@tauri-apps/api` 的四枚（core / dpi / event / window）是同一拍：`window.js` 自己
      // **静态**引另外三枚，所以任何一次 window / event 调用都会把四枚一起取回来
      // （实测：四块合计 17.7 kB，合并后打开窗口标题这条路少三个请求）。
      if (p.includes('/node_modules/@tauri-apps/api/')) return 'lazy-vendor-tauri';
      for (const family of LAZY_PLUGIN_FAMILIES) if (family.test.test(p)) return family.name;
      if (LAZY_PIN_SUFFIXES.some((suffix) => p.endsWith(suffix))) return 'lazy-pin';
      return undefined;
    }

    if (p.includes('/node_modules/')) {
      // pnpm 的真实落点一定含 `/node_modules/<pkg>/`（`.pnpm/<pkg>@<ver>/node_modules/<pkg>/`），
      // 尾部那个 `/` 保证 `react` 不会吃掉 `react-dom`、更不会误伤 `react-*` 系第三方包。
      if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(p)) return 'vendor-react';
      return undefined; // 其余第三方（@tauri-apps 等）体量小，跟着使用方走
    }
    // 工作区包：`packages/<dir>/…`。`app` 是宿主自己 ⇒ 不进 vendor（它才是入口块的正主）。
    // 插件路径比别的工作区包多一层目录（`packages/plugins/<name>/…`），得单独认。
    // **开机图里的**插件仍是一枚一块：这里的三个常驻项（erb-parser / eratw-adapter /
    // condition-extractor，见 ps10-eager-graph 的成员断言）都是项目态到来之前就要用的，
    // 各自失效面清楚。（曾经写成"插件一枚一块"当通则，2026-10-25 件数批改了口径：
    // **懒边上的**插件按族合并，理由与量测见上方 `LAZY_PLUGIN_FAMILIES` 头注。
    // 早先那版"并成一坨 1,261 kB"的教训针对的是**把懒边一起并进开机块**，与本批无关。）
    const plugin = /\/packages\/plugins\/([^/]+)\//.exec(p);
    if (plugin) return `plugin-${plugin[1]}`;
    const pkg = /\/packages\/([^/]+)\//.exec(p);
    if (pkg && pkg[1] !== 'app' && pkg[1] !== 'plugins') return 'vendor-kojo-core';
    return undefined;
  };
}

export default defineConfig({
  plugins: [react(), injectAppVersion()],
  resolve: {
    alias: {
      '@kojo/plugin-api': r('../plugin-api/src/index.ts'),
      // 语言面库的叶子**必须排在桶之前**：alias 的匹配口径是
      // 「等于 find」或「以 `find + /` 开头」，桶若在前会把 `/constants` 也吃掉。
      '@kojo/kojo-lang/constants': r('../kojo-lang/src/constants.ts'),
      '@kojo/kojo-lang/name-chars': r('../kojo-lang/src/name-chars.ts'),
      '@kojo/kojo-lang/interpolation': r('../kojo-lang/src/interpolation.ts'),
      '@kojo/kojo-lang/declarations': r('../kojo-lang/src/declarations.ts'),
      '@kojo/kojo-lang/sourcemap': r('../kojo-lang/src/sourcemap.ts'),
      '@kojo/kojo-lang/expand-view': r('../kojo-lang/src/expand-view.ts'),
      '@kojo/kojo-lang/symbols': r('../kojo-lang/src/symbols.ts'),
      '@kojo/kojo-lang/definition': r('../kojo-lang/src/definition.ts'),
      '@kojo/kojo-lang/inlay': r('../kojo-lang/src/inlay.ts'),
      // B3c 车道 2：补全 / 悬停的判据叶子（同样必须排在桶之前）。
      '@kojo/kojo-lang/completion': r('../kojo-lang/src/completion.ts'),
      '@kojo/kojo-lang/completion-snippets': r('../kojo-lang/src/completion-snippets.ts'),
      '@kojo/kojo-lang/hover': r('../kojo-lang/src/hover.ts'),
      '@kojo/kojo-lang/event-sites': r('../kojo-lang/src/event-sites.ts'),
      '@kojo/kojo-lang/adapter-source': r('../kojo-lang/src/adapter-source.ts'),
      '@kojo/kojo-lang/expand-compile': r('../kojo-lang/src/expand-compile.ts'),
      // B3d：签名帮助 / 格式化的判据叶子（同样必须排在桶之前）。
      '@kojo/kojo-lang/signature': r('../kojo-lang/src/signature.ts'),
      '@kojo/kojo-lang/format': r('../kojo-lang/src/format.ts'),
      '@kojo/kojo-lang/references': r('../kojo-lang/src/references.ts'),
      '@kojo/kojo-lang/rename': r('../kojo-lang/src/rename.ts'),
      // B3f：同符号高亮 / 结构化扩选的判据叶子（同样必须排在桶之前）。
      '@kojo/kojo-lang/highlight': r('../kojo-lang/src/highlight.ts'),
      '@kojo/kojo-lang/selection-range': r('../kojo-lang/src/selection-range.ts'),
      // B3g：行上注解的判据叶子（同样必须排在桶之前）。
      '@kojo/kojo-lang/codelens': r('../kojo-lang/src/codelens.ts'),
      // B3h：折叠区间判据的叶子（同样必须排在桶之前）。
      '@kojo/kojo-lang/folding': r('../kojo-lang/src/folding.ts'),
      '@kojo/kojo-sdk/semantic-roles': r('../kojo-sdk/src/semantic-roles.ts'),
      '@kojo/kojo-sdk/structure-protocol': r('../kojo-sdk/src/structure-protocol.ts'),
      '@kojo/kojo-sdk/contracts': r('../kojo-sdk/src/contracts.ts'),
      '@kojo/kojo-sdk': r('../kojo-sdk/src/index.ts'),
      '@kojo/kojo-lang/theme-rules': r('../kojo-lang/src/theme-rules.ts'),
      '@kojo/kojo-lang/lexicon': r('../kojo-lang/src/lexicon.ts'),
      '@kojo/kojo-lang/monarch': r('../kojo-lang/src/monarch.ts'),
      '@kojo/kojo-lang/language-config': r('../kojo-lang/src/language-config.ts'),
      // B3i：缩进 / 回车判据叶子（排在桶之前；宿主 `monaco/kojo2-indent.ts` 只引这一枚）。
      '@kojo/kojo-lang/indent': r('../kojo-lang/src/indent.ts'),
      '@kojo/kojo-lang/monaco-theme': r('../kojo-lang/src/monaco-theme.ts'),
      '@kojo/kojo-lang': r('../kojo-lang/src/index.ts'),
      // 语言层共用词表（LAU-3b 解耦批）：叶子同样必须排在桶之前。
      '@kojo/kojo-vocab/keywords': r('../kojo-vocab/src/keywords.ts'),
      '@kojo/kojo-vocab/system-functions': r('../kojo-vocab/src/system-functions.ts'),
      '@kojo/kojo-vocab/identifier-chars': r('../kojo-vocab/src/identifier-chars.ts'),
      '@kojo/kojo-vocab/engine-globals': r('../kojo-vocab/src/engine-globals.ts'),
      '@kojo/kojo-vocab/statement-functions': r('../kojo-vocab/src/statement-functions.ts'),
      '@kojo/kojo-vocab/blank-charset': r('../kojo-vocab/src/blank-charset.ts'),
      '@kojo/kojo-vocab/sugar-ident': r('../kojo-vocab/src/sugar-ident.ts'),
      '@kojo/kojo-vocab/types': r('../kojo-vocab/src/types.ts'),
      '@kojo/kojo-vocab/lexer': r('../kojo-vocab/src/lexer.ts'),
      '@kojo/kojo-vocab/formatter': r('../kojo-vocab/src/formatter.ts'),
      '@kojo/kojo-vocab/enter': r('../kojo-vocab/src/enter.ts'),
      '@kojo/kojo-vocab/engine': r('../kojo-vocab/src/engine.ts'),
      '@kojo/kojo-vocab': r('../kojo-vocab/src/index.ts'),
      '@kojo/kernel': r('../kernel/src/index.ts'),
      // LAU4-ERB-A：ERB 语言面库（叶子排在桶之前，理由同上）。
      '@kojo/erb-lang/constants': r('../erb-lang/src/constants.ts'),
      '@kojo/erb-lang/highlight': r('../erb-lang/src/highlight.ts'),
      '@kojo/erb-lang/selection-range': r('../erb-lang/src/selection-range.ts'),
      '@kojo/erb-lang': r('../erb-lang/src/index.ts'),
      '@kojo/plugin-erb-parser': r('../plugins/erb-parser/src/index.ts'),
      '@kojo/plugin-eratw-adapter': r('../plugins/eratw-adapter/src/index.ts'),
      '@kojo/plugin-convention-linter': r('../plugins/convention-linter/src/index.ts'),
      '@kojo/plugin-condition-extractor': r('../plugins/condition-extractor/src/index.ts'),
      '@kojo/plugin-sav-parser': r('../plugins/sav-parser/src/index.ts'),
      '@kojo/plugin-state-replay': r('../plugins/state-replay/src/index.ts'),
      '@kojo/plugin-kojo-sugar': r('../plugins/kojo-sugar/src/index.ts'),
      '@kojo/plugin-kojo-lang': r('../plugins/kojo-lang/src/index.ts'),
      // LAU4-ERB-A：ERB 语言面的供方插件（同符号高亮 / 结构化扩选两条腿）。
      '@kojo/plugin-erb-lang': r('../plugins/erb-lang/src/index.ts'),
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
  // dev 预打包（2026-10-25 调试模式批反馈）：`web-tree-sitter` 只在项目态的懒边上被加载，
  // 冷启动的 deps 图里没有它 ⇒ 首次进项目时 vite 才「发现新依赖」并**整页 reload**——
  // 调试会话里表现为「项目开着开着弹回欢迎页、命令注册表回到未登记」（实测）。
  // 显式 include 让它启动即预打包；对 build 无影响（optimizeDeps 只作用于 dev）。
  optimizeDeps: { include: ['web-tree-sitter'] },
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
     * - `manualChunks` 见文件上方 `createManualChunks` —— 2026-10-25 拆包批起才有（此前那句
     *   「刻意不动 manualChunks」的理由是"没预算量"，本批把逐模块体积报表量完了）。
     * - `chunkSizeWarningLimit: 4200`：唯一的超标块是 monaco（4,078 kB，由
     *   `monaco/entry.ts` 的动态 import 自成一块、开文件时才取）。默认 500 kB 的这条
     *   警告因此**永远**在响——天天响的警告等于没有警告，所以把闸抬到刚好盖住它，
     *   让"别的块突然变大"重新变成可见信号。入口块的上界另有硬闸：
     *   `tools/release-gate.mjs` 的 artifact-audit（上限 1,100 kB，本批实测 388 kB）。
     */
    reportCompressedSize: false,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 4200,
    rollupOptions: {
      output: { manualChunks: createManualChunks() },
    },
  },
});
