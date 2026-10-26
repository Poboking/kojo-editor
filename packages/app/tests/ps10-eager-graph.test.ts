import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PS-10 ①②：开机静态依赖图的闸（首屏批的"真瘦身"判据）。
 *
 * 口径与形态照 `boot-sweep-single-source.test.ts` 先例：`readFileSync` 读源码、自己走图，
 * 不起壳、不依赖 `dist`（构建产物不在测试预算里）。走图规则与 Vite 的实际行为对齐：
 * **只跟静态的"有值"依赖**——`import type` 与「整串都是 type 的具象导入」会被擦除，
 * 所以不计入；`.css` 与 `?worker` 不是主线程 JS 图，也不计入。
 *
 * 钉三件事：
 * 1. **教程正文不在开机图里**：`tutorial-content` / `tutorial-reference*` / `tutorial-overlay`
 *    / `tutorial-inline` 一枚都不许出现（PS-10 ① 的交付面；它们只在浮层被打开时动态装载）；
 * 2. **插件拆分成立**：`bootstrap.ts` 的静态插件入口只剩两个，其余 18 个走 `import()`；
 *    开机图里除**已知漏点**外，项目级插件一枚文件都不许出现；
 * 3. 图的大小闸（粗闸：抓"整包被拽回来"这种量级事故，不追 KB 级抖动）。
 *
 * ⚠ 已知漏点（本批无权动，如实记在这里而不是偷偷放宽判据）：
 * `App.tsx → ui/shell-overlays.ts → ui/diff-view.ts → monaco/erb-language.ts →
 *  monaco/theme.ts → monaco/kojo-language.ts → @kojo/plugin-kojo-sugar`
 * ——宿主 monaco 层静态挂着 sugar 的词表与条件抽取的表达式表，这两包（~990 KB 源码）
 * 因此仍留在开机图里。要断这根链得动 `monaco/**` 与 `shell-overlays.ts`（PS-10 归属之外），
 * 已作为后续项上报。
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');
const relOf = (abs: string): string => path.relative(repoRoot, abs).split(path.sep).join('/');

/** 与 `vite.config.ts` 的 alias 表同源（不手抄第二份名单：读它，漂了就叫） */
function aliasMap(): Map<string, string> {
  const src = read('packages/app/vite.config.ts');
  const map = new Map<string, string>();
  for (const m of src.matchAll(/['"](@kojo\/[^'"]+)['"]\s*:\s*r\('([^']+)'\)/g)) {
    map.set(m[1]!, path.resolve(repoRoot, 'packages/app', m[2]!));
  }
  // 市场两包**没有** alias（走 workspace 依赖解析）：补按各包清单的 `name` 认路，
  // 否则图里会凭空少掉两包，判据就成了假绿。
  for (const dir of readdirSync(path.join(repoRoot, 'packages/plugins'))) {
    const manifest = path.join(repoRoot, 'packages/plugins', dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const name = String(JSON.parse(readFileSync(manifest, 'utf8')).name);
    if (name.startsWith('@kojo/plugin-') && !map.has(name))
      map.set(name, path.join(repoRoot, 'packages/plugins', dir, 'src/index.ts'));
  }
  return map;
}

const ALIASES = aliasMap();

/** app 包声明的插件依赖全集（真源＝`packages/app/package.json`，新增插件自动进判据） */
function declaredPluginSpecs(): string[] {
  const deps = JSON.parse(read('packages/app/package.json')).dependencies as Record<string, string>;
  return Object.keys(deps).filter((k) => k.startsWith('@kojo/plugin-') && k !== '@kojo/plugin-api');
}

/** 全部插件包目录名（真源＝磁盘上的 `packages/plugins/*`，新增包自动进判据） */
function allPluginPackages(): string[] {
  return readdirSync(path.join(repoRoot, 'packages/plugins')).filter((n) =>
    statSync(path.join(repoRoot, 'packages/plugins', n)).isDirectory(),
  );
}

function resolveSpec(spec: string, fromFile: string): string | null {
  if (spec.startsWith('@kojo/')) return ALIASES.get(spec) ?? null;
  if (!spec.startsWith('.')) return null; // node_modules（react / tauri / monaco）不在本图判据内
  const base = path.resolve(path.dirname(fromFile), spec.split('?')[0]!);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')])
    if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

const STATIC_IMPORT_RE = /(?:^|\n)\s*import\s+(?!type\b)([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /(?:^|\n)\s*export\s+(?!type\b)(?:\*|\{[\s\S]*?\})\s*from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 具名导入里是否含"有值"绑定（`{ type Foo }` 这种整串都是类型的会被擦除） */
function hasValueBinding(clause: string): boolean {
  return clause
    .split(',')
    .some((part) => part.trim() !== '' && !/^\s*type\b/.test(part.trim()));
}

/** 从入口出发走一遍静态图：返回相对路径 → 源码字节数（`followDynamic` 只给反空匹配自证用） */
function eagerClosure(entryRel: string, opts?: { followDynamic?: boolean }): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (abs: string): void => {
    const rel = relOf(abs);
    if (out.has(rel)) return;
    const src = readFileSync(abs, 'utf8');
    out.set(rel, Buffer.byteLength(src));
    const specs = new Set<string>();
    for (const m of src.matchAll(STATIC_IMPORT_RE)) if (hasValueBinding(m[1]!)) specs.add(m[2]!);
    for (const m of src.matchAll(BARE_IMPORT_RE)) specs.add(m[1]!);
    for (const m of src.matchAll(EXPORT_FROM_RE)) specs.add(m[1]!);
    if (opts?.followDynamic) for (const m of src.matchAll(DYNAMIC_IMPORT_RE)) specs.add(m[1]!);
    for (const s of specs) {
      if (s.includes('?worker') || s.endsWith('.css')) continue;
      const next = resolveSpec(s, abs);
      if (next) visit(next);
    }
  };
  visit(path.resolve(repoRoot, entryRel));
  return out;
}

/** PS-10 ① 的判据面：教程正文与渲染器（懒装载壳 `tutorial-lazy.ts` 不在此列，它必须常驻） */
const TUTORIAL_PROSE_RE = /plugins\/eratw-adapter\/src\/tutorial-(content|overlay|inline|reference)/;

/** 已知漏点（见文件头 ⚠）：仍被宿主 monaco 层静态挂着的两包 */
const KNOWN_LEAK_PACKAGES = new Set(['kojo-sugar', 'condition-extractor']);

/** 欢迎页 / 无项目态真吃得到的两个常驻插件 */
const EAGER_PLUGINS = ['@kojo/plugin-erb-parser', '@kojo/plugin-eratw-adapter'];

describe('PS-10 开机静态依赖图（教程与项目级插件都不许在欢迎页被解析）', () => {
  const graph = eagerClosure('packages/app/src/main.tsx');
  const files = [...graph.keys()];
  const totalKb = Math.round([...graph.values()].reduce((a, b) => a + b, 0) / 1024);

  it('走图工具自己先自证：入口与两个常驻插件确实在图里（否则下面的判据全是空匹配）', () => {
    expect(files.some((f) => f.endsWith('packages/app/src/main.tsx'))).toBe(true);
    expect(files.some((f) => f.startsWith('packages/plugins/erb-parser/'))).toBe(true);
    expect(files.some((f) => f.startsWith('packages/plugins/eratw-adapter/'))).toBe(true);
  });

  it('教程正文与渲染器一枚都不在开机图里（PS-10 ① 的交付面）', () => {
    const leaked = files.filter((f) => TUTORIAL_PROSE_RE.test(f));
    expect(leaked).toEqual([]);
  });

  // 动态闭包 = 整棵懒装载面（几百枚文件逐个读 + 正则走图），并行池 CPU 争用时超过
  // 20s 默认预算（2026-10-25 实测：隔离 3.5s，功能池争用 25s+ 被默认超时杀）。
  // 本用例断言的是**图内容**（教程正文在动态图上），不是耗时——显式给预算不属于
  // 放宽判据，只是不让争用把内容断言染成假红。
  it('反空匹配自证：同一条链只要**允许**跟动态边，正文就必须出现在图里', { timeout: 120_000 }, () => {
    // 上面那条"零命中"完全可能因为路径拼错而恒真——这里用同一份正则、同一个入口，
    // 只把判据换成"静态 + 动态都跟"，命中就必须出现，且命中的正是懒装载的那两坨。
    const withDynamic = [...eagerClosure('packages/app/src/main.tsx', { followDynamic: true }).keys()];
    const reached = withDynamic.filter((f) => TUTORIAL_PROSE_RE.test(f));
    expect(reached.length).toBeGreaterThanOrEqual(6);
    expect(reached.some((f) => f.endsWith('tutorial-content.ts'))).toBe(true);
    expect(reached.some((f) => /tutorial-reference(-\w+)?\.ts/.test(f))).toBe(true);
    expect(reached.some((f) => f.endsWith('tutorial-overlay.ts'))).toBe(true);
  });

  it('懒装载壳确实把正文与渲染器挂在动态边上（静态图没了它们，动态图必须有）', () => {
    const lazy = read('packages/plugins/eratw-adapter/src/tutorial-lazy.ts');
    expect(lazy).toContain(`import('./tutorial-content')`);
    expect(lazy).toContain(`import('./tutorial-overlay')`);
    // 静态值依赖不许回来（`import type` 会被擦除，允许）
    const staticSpecs = [...lazy.matchAll(STATIC_IMPORT_RE)]
      .filter((m) => hasValueBinding(m[1]!))
      .map((m) => m[2]!);
    expect(staticSpecs.filter((s) => /tutorial-(content|overlay|reference|inline)/.test(s))).toEqual([]);
  });

  it('bootstrap.ts 的静态插件入口只剩两个，其余全走动态 import（PS-10 ② 的名单）', () => {
    const src = read('packages/app/src/bootstrap.ts');
    const staticPluginSpecs = [...src.matchAll(STATIC_IMPORT_RE)]
      .filter((m) => hasValueBinding(m[1]!))
      .map((m) => m[2]!)
      .filter((s) => s.startsWith('@kojo/plugin-') && s !== '@kojo/plugin-api');
    expect([...staticPluginSpecs].sort()).toEqual([...EAGER_PLUGINS].sort());

    // 适配器的动态 import 在**清单**里（清单本身也是动态取的，不在开机静态图上）
    const manifestSrc = read('packages/app/src/adapter-manifest.ts');
    const dynamicSpecs = [
      ...[...src.matchAll(/import\(\s*['"](@kojo\/plugin-[^'"]+)['"]\s*\)/g)].map((m) => m[1]!),
      ...[...manifestSrc.matchAll(/import\(\s*['"](@kojo\/plugin-[^'"]+)['"]\s*\)/g)].map((m) => m[1]!),
    ];
    expect(new Set(dynamicSpecs).size).toBe(dynamicSpecs.length); // 不重复
    // 名单覆盖 = app 包声明的全部插件依赖，一枚不多一枚不少（新增插件必须进名单）
    const covered = [...EAGER_PLUGINS, ...dynamicSpecs].sort();
    expect(covered).toEqual([...declaredPluginSpecs()].sort());
    expect(dynamicSpecs.length).toBe(declaredPluginSpecs().length - EAGER_PLUGINS.length);
    // 动态 spec 必须都能按 alias / 包名解析到真文件（拼错的名字在源码里看不出来）
    for (const s of dynamicSpecs) expect(ALIASES.get(s), s).toBeTruthy();
  });

  it('项目级插件在开机图里只剩已知漏点（新拽进来一枚就叫，别悄悄长大）', () => {
    const presentDirs = new Set(
      files.filter((f) => f.startsWith('packages/plugins/')).map((f) => f.split('/')[2]!),
    );
    // 常驻两包 + 文件头 ⚠ 记名的漏点包之外，一枚都不该出现在开机图里
    const allowed = new Set(['erb-parser', 'eratw-adapter', ...KNOWN_LEAK_PACKAGES]);
    expect([...presentDirs].filter((d) => !allowed.has(d))).toEqual([]);
    // 拆分真的生效了：20 个插件包里 ≥15 个整包不在图上（只剩常驻两个 + 两个已知漏点）
    const deferredDirs = allPluginPackages().filter((d) => !allowed.has(d));
    expect(deferredDirs.length).toBeGreaterThanOrEqual(15);
    expect(deferredDirs.filter((d) => presentDirs.has(d))).toEqual([]);
  });

  it('开机图体积闸（粗闸：抓整包回灌，不追 KB 级抖动）', () => {
    // 本机同规则实测：拆分前 270 文件 / 3,783 KB ⇒ 拆分后 191 文件 / 2,840 KB
    // （−79 文件 / −943 KB）。阈值只留 ~7% 余量：一枚项目级插件被静态拽回来（最小的
    // ui-plugin-status 9 KB、最大的 kojo-sugar 901 KB）里除了最小的那种都可能悄悄过关，
    // 所以真判据是上面两条成员断言，这里只是兜底 tripwire。
    //
    // 2026-10-23（右键菜单覆盖面批）：191 → 215 文件，增量**逐一对上**本批新增的 10 个
    // 面模块——context-menu-pages / context-menu-shell / editor-context-actions /
    // preview-menu / palette-menu / plugin-context-menu-bridge / plugin-panel-menu /
    // problem-menu / search-menu / tutorial-context-menu（`git diff --diff-filter=A
    // 0179079f..HEAD -- packages/app/src`）＝ 10 个，与 215−205 精确相等。
    // 右键菜单是**开机即用**的功能，没有懒加载的理由，所以这是功能增长而非整包回灌；
    // 上一行的成员断言（插件包只许两个常驻 + 两个已知漏点）仍然全绿，说明没有回灌。
    // 闸随之 205 → 220（同比例留余量）。
    //
    // ⚠ 同一批收口时 **KB 闸也撞线了**：3,057 > 3,050（超 0.2%）。此前这里写过"这 10 个
    // 模块都很小，撞不到 3,050"——那句判断是错的，合入插件面契约（plugin-api 的
    // context-surface.ts + market 面 + 宿主转发）后就撞上了，如实记在这里。成员断言仍全绿，
    // 所以性质没变（功能增长，不是回灌）。KB 闸 3,050 → 3,100（+1.6% 余量）。
    //
    // 2026-10-23 再记一笔（合入批次十之后的**同尺三树对照**，用与本文件同一套走图规则量的）：
    //   老基座 `5b509736`        190 文件 / 2,707 KB
    //   dev `76673942`（批次十） 193 文件 / 2,786 KB   ← 批次十只 +79 KB
    //   合流树（本批 + 批次十）  219 文件 / 3,139 KB   ← 本批自己 +432 KB / +29 文件
    // **增重是本批的，不是批次十的**。逐块点过：增量是菜单数据面与它真实依赖的东西，
    // 26 个新进图文件的全部重量只有三处成规模——
    //   context-menu-shell 31.8 KB + context-menu-pages 29.7 KB + context-menu-model 17.7 KB
    //   （三个面模块本身，右键菜单开机即用，没有懒加载的理由）
    //   keybindings 22.2 KB（菜单项的快捷键提示要 `keybindingSpecOf`，`context-menu-model:24`）
    //   editor-options 26.1 / editor-display-prefs 21.7 / settings-search 10.3 KB
    //   （`context-menu-pages` 的「恢复默认外观」与「按设置项 id 定位」真实用到）
    // 没有整包回灌：成员断言（插件包只许两个常驻 + 两个已知漏点）仍全绿，且「只在 dev 里」
    // 的文件集**为空**——本批的图是 dev 的超集，没有把别处的东西换进来、也没藏进懒边。
    // 已知可减面（本批不做，已立看板行 PS10-MENU-SPLIT）：把 settings / keybindings 两个面
    // 的按钮搬到各自懒页去注册（约 −58 KB），以及菜单快捷键提示换个不吃整个 keybindings 的接线。
    // 闸随之 3,100 → 3,200（+1.9% 余量）。文件闸 215→220 保持不变：现读数 219，余量只剩 1，
    // 下一枚面模块落地前必须先去拆面，**不要**顺手把这个数也抬了。
    //
    // 2026-10-23 收口 PS10-MENU-SPLIT（同尺，同一套走图规则量的本树）：
    //   本批合流后          219 文件 / 3,139 KB
    //   拆面后（本行所在提交）206 文件 / 2,992 KB   ← −13 文件 / −147 KB
    // 四处减法，全部是"搬到它真正被用到的地方"，没有一处是把功能藏进懒边：
    //   - context-menu-shell 整模块离开（通知面下沉 notification-menu，−23 KB，净 0 文件）
    //   - settings / keybindings 两面随 settings-menu.ts 进 SettingsPanel 的懒 chunk
    //     （−13 文件 / −122 KB：editor-options / editor-display-prefs / settings-search /
    //     layout-pref / glass-pref / format-pref / sealed / *-pref / word-separators 全部出图）
    //   - 菜单快捷键提示改吃纯数据叶子 keybinding-specs（keybindings 22.7 KB 离图，
    //     生效键位由 ShellLayout 挂载时注入，作者改键后菜单提示仍跟着变）
    //   - 大纲折叠是纯视图状态，不新增任何模块
    // 闸随之下调：文件 220 → 210，KB 3,200 → 3,050（约 +1.9% 余量）。这两条是**下限纪律**，
    // 不是"还能再涨 58 KB"的许可：谁要抬，先像上面这样把增量逐块点名。
    //
    // 2026-10-24（批次十一 · 视觉批；对照树 = `origin/dev` 尖端 `08814a40`，同尺 206 文件 /
    // 3,006 KB）：本树 **209 文件 / 3,052 KB**（+46 KB / +3 文件）。增量逐块点名（差集用与本
    // 文件同一套走图规则量出，脚本在组长临时目录、不入仓）：
    //   - 新进图三枚，全是"开机即用"的宿主件：`ui-kit/index.tsx` 18.8 KB（SearchPanel 与
    //     kojo2-cutover-settings 已在用 Kit 原语）、`ui/overlay-chrome.tsx` 7.1 KB（浮层统一
    //     外框，ShellLayout 的注册表直接引）、`ui/overlay-editor-appearance.ts` 3.7 KB（同批的
    //     外观档位桥）。
    //   - 原有文件变重：`WelcomeView` +9.7（欢迎页两态重构）· `icons` +2.5（L10 图标 9 档→4 档
    //     新增的注册名）· `QuickFixPreviewOverlay` +1.3 · `main.tsx` +1.2（新增的三行样式 import
    //     与注释；`.css` 本身不在图内）· `shell-overlays` +1.0 · `FileHistoryOverlay` +0.9 ·
    //     `plugin-api/slots` +0.7 · `kojo2-migrate` +0.5 · `OpsHistoryOverlay` +0.4 ·
    //     `CallHierarchyOverlay` +0.3；**减项** `kojo2-cutover-settings` −2.7（设置行拆组后模板下沉）。
    //   - 本批先自己削掉一枚不该在图里的：ui-kit 桶棒原本 re-export 了 `KitGallery`（内部对照页
    //     6.6 KB / 1 文件），而桶棒住在开机图里 ⇒ 等于把对照页挂上首屏。re-export 已删，对照页
    //     改由测试直引；将来接路由走 `import()`。
    // 没有整包回灌：成员断言（插件包只许两个常驻 + 两个已知漏点）仍全绿，涨的是宿主件与文案。
    // 已知可减面（本批不做，记在这）：`ui-kit/index.tsx` 按件拆文件，让开机侧只为真用到的那几枚
    // 付费（约 −12 KB），与第二波「ui-kit 采纳迁移」并线。
    // 闸随之 3,050 → 3,100（+1.6% 余量）；文件闸 210 不动（现读数 209，余量 1）。
    // 2026-10-24（LS-B0 · 语言服务契约扩 4 kind；rebase 到 dev 后的合尺增量）：+9 KB，**零新文件**。
    // 增量逐块点名（两枚，都在 `@kojo/plugin-api` 上，宿主开机必然 import）：
    //   - `plugin-api/slots` +8.3 KB：`ui.editor.languageService` 新增 4 个判别成员
    //     （completion / hover / formatting / signatureHelp）与 `EditorRangeEdit`，
    //     外加**为什么只加 4 个而不加 6 个**（diagnostics / codeAction 各有专用槽）那段理由。
    //     增量里九成是中文注释——契约层把"为什么"写在成员旁边是本仓的既定形态，
    //     不为过闸把理由搬走（搬走就等于下一个改这张表的人看不到它）。
    //   - `plugin-api/index` +0.4 KB：这 12 个新类型的具名导出。
    // 没有整包回灌：成员断言（插件包只许两个常驻 + 两个已知漏点）仍全绿；文件闸不动。
    // 合尺后闸 3,100 → 3,120（余量约 0.3%）：这是**下限纪律**，
    // 下一枚面模块落地前请先减面（`ui-kit/index.tsx` 按件拆文件约 −12 KB，见上一段），
    // 不要顺手把这个数再抬一格。
    // 2026-10-24（B1 · 建 `@kojo/kojo-lang`；同尺读数 **3,110 KB / 210 文件，与上一批持平**）：
    // 五个模块（constants / sourcemap / expand-view / declarations / symbols 的纯半边，
    // 共约 1.9k 行）搬进包，**开机图一分钱没涨**——旧的 `kojo2-constants.ts`（1.2 KB）换成
    // 包里的 `constants.ts`（1.5 KB），净 +0.3 KB，四舍五入仍是 3,110。
    // 但这一批**差点翻车**，记在这里给下一个人看：第一版只给了桶（`@kojo/kojo-lang`），
    // 读数当场 3,110 → **3,192**（+82 KB，整包 85 KB 全被拖进欢迎页），红的就是下面这条闸。
    // 根因：开机图里有四枚只想要扩展名/语言 id 的文件（`kojo2-cutover` / `kojo2-open` /
    // `kojo2-open-paths` / `CallHierarchyOverlay`），它们 import 桶 ⇒ 桶 re-export 了整包。
    // 修法是给包开子路径导出，开机侧一律引叶子；判据落在本文件末尾那条
    // 「开机图里对语言面库的引用必须是叶子」上——它比读数更早、更准地指出是谁干的。
    // 闸不动（3,120 / 210）。
    // 2026-10-24（erafl 线合流 dev；对照树 = `origin/dev` 尖端 `6a998d9c`，同尺 209 文件 /
    // 3,075 KB）：合流后一度 **210 文件 / 3,135 KB**（+60 KB / +1 文件），增量逐块点名：
    //   - +45.4 KB `plugin-api/game.ts` **新进图**：erafl 线把 `activeGameAdapter` 收成
    //     单源实现（替掉 14 处手写判据）并从 type-only 改成桶的值导出 ⇒ 桶的任何值引用
    //     （`WellKnownServices` 等，开机图里有约十枚）都把 45 KB 的 v1 契约面透传进欢迎页。
    //     **与 B1 的桶教训同形**（值导出决定模块图，type 导出不会）。修法照 B1 的叶子纪律：
    //     函数拆进独立模块 `plugin-api/active-adapter.ts`，桶改指它，14 个消费方 import
    //     路径一字未动（单源性不受影响）；game.ts 重新只剩 type 导出 ⇒ 出图。
    //     读数 3,135 → 3,093（−45 KB，零文件变化）。**闸因此不抬。**
    //   - +10.5 KB `plugin-api/slots.ts`：erafl 线 LS-B0/B2/B3 的语言服务契约扩员
    //     （`ui.editor.languageService` 四判别成员 + `EditorRangeEdit` 等）。
    //   - +3.8 KB `bootstrap.ts`：erafl v1 装载三处 + 入口 A（2.0 adapter 登记簿与
    //     按项目解析的 getter）。
    //   - +1.5 / −1.5 KB：B1 常量搬包（`kojo-lang/constants.ts` 换 `monaco/kojo2-constants.ts`）。
    //   - +1.1 KB `plugin-api/events.ts` / +0.8 KB `index.ts`：`RevealRange` 类型导出与
    //     上述导出面调整（type 面，不进图的只有 barrel 那一段）。
    //   - −2.3 KB `eratw-adapter/plugin.ts`：dev 侧自合流点以来的增长，本线没有（差集减项）。
    // 合流后现读数 **3,093 KB / 210 文件**（闸 3,120 / 210）。
    //   - 视觉批十四 +1 文件 `ui/window-title.ts`（窗口标题的唯一算法，App 开机即用）：
    //     210 → **211 文件**，闸随之上抬 1；KB 面 3,093 → **3,096**（+3：App 里的三处接线），
    //     KB 闸 3,120 不动（余量 24）。
    //   - 多游戏适配批（2026-10-25）：`detect` 证据化 + 多适配器冲突诊断 ⇒ 内核
    //     `kernel/src/project.ts` 的 open() 重写（+1.3 KB）、契约 `plugin-api/project.ts`
    //     新增冲突错误与归一函数（+0.9 KB）；同时把新增**类型**搬进 type-only 叶子
    //     `plugin-api/adapter-contract.ts`（不进图，−1.4 KB）、适配器清单走动态 import
    //     （不进图，−0.4 KB）。净 +3 KB ⇒ 现读数 **3,121 KB / 211 文件**，
    //     KB 闸随之上抬 3,120 → **3,130**（本闸是粗闸：抓整包回灌，不追 KB 级抖动；
    //     文件数闸 211 不动——新文件一个都没进开机图）。
    //   - 首屏性能批（2026-10-25 上游 `8a9fee1c`：浮层 / 确认框 / kojo2 存储族改懒装载）
    //     把 **24 个模块挪出开机图** ⇒ 合流后现读数 **187 文件 / 2,741 KB**。两枚闸随现值
    //     **下调**（211 → 187 文件、3,130 → 2,750 KB）：降闸不必写理由，抬闸才要——
    //     上面那笔 3,120 → 3,130 的归因留档，是因为它解释"为什么曾要抬"，不是留着当现值。
    //   - **ERB 语法缺口批（2026-10-25）**：现读数 **190 文件 / 2,779 KB**，两枚闸随之上抬
    //     （187 → 190 文件、2,750 → 2,790 KB）。增量逐块点名（+3 文件 / +38 KB）：
    //     · +12.1 KB `erb-parser/declarations.ts`（**新进图**）：`#DIM` 族五条硬规则 +
    //       `#FUNCTION` 裸 `RETURN` 体检，由 `structure.ts` 的 `checkStructure` 直接调；
    //     · +5.4 KB `condition-extractor/inline.ts`（**新进图**）：`\@条件?真#假\@` 与
    //       `{…?…#…}` 的内联三元扫描器，由 `extract.ts` 直接调；
    //     · +4.1 KB `plugin-api/erb-code-prefix.ts`（**新进图**）：`;!;` / `;#;` 行首代码前缀
    //       判据（`condition-extractor` 与宿主都要用，而插件之间禁止互相 import ⇒ 只能住契约层）；
    //     · +17 KB 既有文件变重（约 426 行，九成是中文注释）：`structure.ts` +140 行
    //       （预处理条件块配对体检）、`extract.ts` +111（内联谓词归并）、`erb-directives.ts` +94
    //       （Top 59 词表与频次归因）、`scanner.ts` +65（代码前缀 + 前缀宽度的列坐标修正）。
    //     这三枚文件都是**常驻插件的核心逻辑**（`erb-parser` / `condition-extractor` 都在
    //     `bootstrap.ts` 的静态入口名单里），没有可挪的动态边——真要减面只能走上面记着的
    //     `ui-kit/index.tsx` 按件拆分那条（约 −12 KB），与 ERB 面无关。
    //   - **A1 内建实参校验批（2026-10-25）**：现读数 **191 文件 / 2,800 KB**，两枚闸随现值
    //     上抬（190 → 191 文件、2,790 → 2,810 KB）。增量逐块点名（+1 文件 / +21 KB）：
    //     · +17.9 KB `erb-parser/builtins.ts`（**新进图**）：exmeth 静态签名表 170 名
    //       （154 wiki 载明 + 16 分支扩展名）+ 内建实参个数/类型诊断；由 `plugin.ts` 的诊断腿
    //       与宿主补全（`erb-completion-system-functions.ts` / `erb-completion-members.ts`）
    //       静态引用——erb-parser 是 `bootstrap.ts` 两个常驻插件之一，没有可挪的动态边；
    //     · +0.9 KB `erb-parser/arity.ts`：调用点共用扫描器（`ErbCallSite` / `erbCallSitesOf`）
    //       上提，内建诊断与用户函数个数诊断共用一把尺子（不写第二份扫描）；
    //     · +1.2 KB `erb-parser/plugin.ts` / +0.6 KB `index.ts`：诊断腿接线（独立 try/catch，
    //       失败进 `failedRules`）与导出面。
    //   - **ERB 体感批 v2（2026-10-26，本批）**：现读数 **191 文件 / 2,821 KB**，文件数与上一档
    //     逐字相同（**零新常驻模块**，本批纪律），KB 闸随现值 2,810 → **2,830**（+0.3% 余量，粗闸）。
    //     增量全部落在既有常驻文件（源码字节差 ≈ +45 KB，图内 ≈ +21 KB，九成是中文注释与派生
    //     名单）：`monaco/erb-language.ts` +14.2 KB（预处理器三条行首规则 + 内联三元形状构建器
    //     + 族头名单收口成 `ERB_VARIABLE_FAMILY_FORMS` 单源）、`monaco/erb-completion-context.ts`
    //     +8.0 KB（九态门新增 `interp-expr` 与串内插值区判据 `erbInterpRegionAt`）、
    //     `erb-parser/folding.ts` +7.2 KB（预处理块折叠接进 `erbFoldingRanges` ⇒ 上屏）、
    //     `monaco/erb-completion.ts` +4.7 KB（`[` 位候选与行中关键字改派生）、
    //     `plugin-api/erb.ts` +4.4 KB（预处理器标记的契约真源一张表）、`kojo-sugar/index.ts`
    //     +3.8 KB（`ENGINE_VARIABLE_FAMILIES` 收 `MASTERNAME` / `ITEM`）、`monaco/erb-directives.ts`
    //     +3.6 KB（K5 批 11 枚语句词与归因），`erb-parser/structure.ts` −0.3 KB（自带三枚正则
    //     删除、改委托真源）。KB 闸随现值抬到下面那条 expect；文件闸 **191 不动且只剩 0 余量**
    //     ——下一批再往常驻面加文件，必须先减面（`ui-kit/index.tsx` 拆分那条）。
    //   - **语言面缺陷批（2026-10-26，本批）**：增量 +2 KB，全落在既有常驻文件、零新模块
    //     （文件数 191 不动，与上一档逐字相同）：· `bootstrap.ts` +1 KB —— 2.0 登记表核
    //     `facts.id === entry.id` 的对账与可见诊断；· `ui/editor-global-providers.ts` +1 KB
    //     —— 2.0 语言面安装器搬出切流开关块，装配段变长。现值 2,823 KB ≤ 闸 2,830，
    //     **本批不动闸**（余量只剩 7 KB：下一枚进图的东西必须先挪一个模块出去）。
    //   - **A5 被裁支压暗批（2026-10-26，与上两批合流后重钉）**：现读数
    //     **191 文件 / 2,835 KB**，文件闸 191 **不动**（读数一枚没涨），KB 闸
    //     2,830 → **2,840**（合流后读数顶穿上游那档 2,830 五个 KB，粗闸只剩 +0.2% 余量：
    //     下一枚进图的东西必须先挪一个模块出去）。
    //     逐块点名（读数 +10 KB；实量为下面两个字节数，其余改动全在图外）：
    //     · +10.6 KB `erb-parser/structure.ts`：预处理器标记读数（`preprocMarkerAt`，把角色 +
    //       宏名一次读全）与被裁支区间（`collectPreprocDeadRanges`，逐条对 Emuera
    //       `ErbLoader.PPState.AddKeyWord`）。**没有可挪的动态边**：`checkPreprocStructure`
    //       本来就要这份标记解析，函数与被它替代的旧分支判据同住一枚文件，拆出去只会多一条
    //       静态边（`structure.ts` 仍要 import 它）；而 erb-parser 是开机常驻两包之一。
    //       体量九成是中文注释（引擎判据表、语料读数、保守偏差清单）。
    //     · +0.2 KB `erb-parser/index.ts`：导出面（宿主装饰层与单测的入口）。
    //     · 宿主两枚新模块（`monaco/erb-preproc-dim.ts` / `erb-preproc-defines.ts`）**不在开机图**：
    //       它们的唯一消费者 `ui/editor-global-providers.ts` 随 EditorPane 走懒 chunk，
    //       所以这两枚一枚文件、一个字节都没进欢迎页（这正是文件闸不动的原因，不是漏数）。
    //   - **A3 指令名撞车批（2026-10-26，与前两批合流后重钉）**：现读数
    //     **192 文件 / 2,845 KB**，两枚闸随现值上抬（191 → **192** 文件、2,840 → **2,850** KB）。
    //     增量逐块点名（+1 文件 / +10 KB）：
    //     · +7.7 KB `erb-parser/instructions.ts`（**新进图**）：引擎指令名全集 301 条
    //       （Emuera `enum FunctionCode` 305 成员 − `__NULL__` / `SET` / `VARS` / `VARI`）
    //       + `isInstructionName`。由 `declarations.ts` 静态引用（`#DIM` 名不得与指令同名）；
    //       erb-parser 是 `bootstrap.ts` 两个常驻插件之一，**没有可挪的动态边**——真要挪只能是
    //       把判据挪到宿主，但那要带着整张表过 `plugin-api` 契约，反而把口径拆成两份。
    //       体量就是那 301 个名字本身 + 表头出处（为什么不能从 wiki 交替式抄、四个剔掉的名字
    //       各是什么理由）。
    //     · +2.1 KB `erb-parser/declarations.ts`：撞名规则（`reservedNameViolation`，指令与
    //       exmeth 两张表在规则处并集，不重抄任何名字）+ `DimLine.directive`（措辞要分
    //       "变量名 / 宏名"）+ 表头语料读数（8 盘 143,167 行 0 命中）。
    //     · +0.2 KB `erb-parser/index.ts`：导出 `ERB_INSTRUCTION_NAMES` / `isInstructionName`
    //       （宿主与单测取表的入口）。
    //   - **A4 头文件形态批（2026-10-26，本批）**：现读数 **193 文件 / 2,860 KB**，两枚闸随现值
    //     上抬（192 → **193** 文件、2,850 → **2,870** KB）。增量逐块点名（+1 文件 / +15 KB；
    //     图内源码实量合计 +14.1 KB，另 1 KB 是两次四舍五入）：
    //     · +10.4 KB `erb-parser/erh.ts`（**新进图**）：`.ERH` 形态判据（`checkHeaderIssues`）
    //       ——行可见性口径（空行 / 注释 / `;!;` 前缀 / `{}` 行连接）与引擎
    //       `ErhLoader.loadHeaderFile` + `EraStreamReader.ReadEnabledLine` 逐条对齐，
    //       白名单 `#DIM` / `#DIMS` / `#DEFINE`。由 `structure.ts` 静态引用；erb-parser 是
    //       `bootstrap.ts` 两个常驻插件之一，**没有可挪的动态边**——判据必须活在装饰器那次
    //       调用里，挪去宿主就得把引擎口径复制一份。体量九成是中文注释（引擎源码逐字引用、
    //       行可见性三条、少报一侧的说明）。
    //     · +1.3 KB `plugin-api/erb.ts`：`checkStructure?` 的可选 `path` 契约说明 +
    //       `erh-invalid` 进 kind 联合。
    //     · +1.3 KB `erb-parser/structure.ts`：第三趟分派（`isErbDeclarationPath`）与按行去重。
    //     · +0.6 KB `erb-parser/offload.ts`：装饰通道从 `checkControlFlowStructure` 切到全量
    //       入口——声明面两类与头文件形态此前只到服务面，编辑器**一条都看不到**。
    //     · +0.2 KB `plugin-api/diagnostic-copy.ts`：`erb.erh-invalid` 的中文名。
    //     · +0.1 KB `erb-parser/plugin.ts` / `index.ts`：服务面透传 `path` 与导出面。
    // 读数随跑随打（同 `styles-split.equivalence` E 闸的口径）：闸绿时也能从日志拿到现值，
    // 交付回执不必靠人肉复算。
    //   - **语言面缺陷批（2026-10-26，合流后重钉）**：读数见下面那条 console（现读数由闸
    //     当场打印）；本批净增全落在既有常驻文件、零新模块：`ui/editor-global-providers.ts`
    //     （2.0 语言面安装器搬出切流开关块）、`monaco/theme.ts` + `kojo-theme-rules.ts`
    //     （2.0 规则无条件并入三套 v1 主题；`kojo2-theme.ts` 因删自抄色表同时缩水）、
    //     `bootstrap.ts`（2.0 登记表核 `facts.id === entry.id` 的对账与可见诊断）、
    //     `monaco/erb-preproc-dim.ts`（语言判据改扩展名，净增几十字节）。两枚闸随上游现值
    //     走（本批不再抬闸）。
    //   - **编辑器对标批 A–E（2026-10-26，变基到本档之上重钉）**：本档基 193 文件 / 2,860 KB；
    //     A–D 四提交（命令面板桥接内核动作 / 状态栏自动换行与空白符 / 书签 / 双文件比较）落地后
    //     一度 +10 KB（**零新进图文件**，增重全在既有图内文件）——逐块点名（同尺差集）：
    //     · `ui/keybinding-specs.ts` +7.2 KB：A 批 29 条内核动作 + C 批 4 条书签 + B 批 2 条状态栏
    //       开关登进静态表（该表被图内 `context-menu-model.ts` 引来查中文标题）；
    //     · `ui/file-tree-ops.ts` +2.2 KB：D 批「比较已选文件」的出现判据（右键菜单同步必需）；
    //     · `ui/commands.ts` +1.4 KB：A 批桥接的 `buildCommandRegistry` 第三参与和弦展示。
    //     E 提交（回归减面）把这三处压回，两处减法都是「把新逻辑搬到它真正被用到的地方」：
    //     · **35 条命令型键位条目搬去懒供给模块 `ui/keybinding-specs-commands.ts`**：`ui/keybindings.ts`
    //       （实测不在开机图）把静态基础表与它拼成键位页看到的完整表；`effectiveKeybindingOf` 对
    //       合并表查缺省 ⇒ Alt+Z / Alt+F2 族仍生效、命令面板仍搜得到全部内核动作、键位页仍列全；
    //       内核动作的 title / category / 内建键说明改由 `monaco-command-specs` **派生**（第二份手抄收口）。
    //       图内 `keybinding-specs` 17.4 → **11.0 KB**（-6.4）。
    //     · **`ui-kit/index.tsx` 出图（-19.6 KB）**：这张十件桶棒此前被图内唯一消费方
    //       `kojo2-cutover-settings.tsx` 引（它只用 `KitRadio`）⇒ 等于把其余九件整包拖进欢迎页。
    //       把 `KitRadio` 拆成单品叶子 `ui-kit/kit-radio.tsx`（+2.4 KB 进图）、消费方直引叶子，
    //       桶棒整份随之下图（懒面既有 `from '../ui-kit'` 一字未改、导出面不变）。
    //     实测 **193 文件 / 2,852 KB**（本档上游变基后读数，含本批减面；较同树未减面低 13 KB），文件闸 193 不动（现读数 193，顶格 0 余量）；
    //     KB 闸随现值 **2,870 → 2,860**（降闸不写理由）。
    //   - **启动器契约补齐批（2026-10-26，L1b）**：现读数 **194 文件 / 2,860 KB**，文件闸随现值
    //     上抬 **193 → 194**（KB 闸不动：总量没变，只是这一枚文件的字节落进了既有余量）。
    //     增量逐块点名：`packages/kernel/src/launcher.ts` **+1 文件 / ≈+8 KB**——`kernel.launcher`
    //     的零逻辑透传（平台桥 `PlatformBridge.launcher?` 的实现方）。它与 `kernel/src/remote.ts`
    //     同族、同体量：都是「一种能力一个服务键」的内核表面，**不是**插件或视图被顺带拖进首屏；
    //     插件侧（`launcher-core`）与视图侧（`app/src/launcher`）仍然全在动态边上，图里不可见。
    //     想把它挪出图只能改成 `start()` 里的 `import()`——那只是把同一次解析挪到首屏之后几毫秒，
    //     反而让闸看不见真实成本，故不取。
    //   - **A2 `{`…`}` 行连接批（2026-10-26，上游 ERB 线）**：现读数 **194 文件 / 2,867 KB**，
    //     文件数不动、KB **+7**（该批落进首屏的 ERB 装配段；同一棵树上把它摘掉即读回 2,860）。
    //     闸随现值 **2,860 → 2,870**——这是"把上游已落地的红修回绿"，不是顺手放宽：
    //     增量已点名到 A2，且 2,870 正是本档在 A2 之前的上一次闸值。
    //   - **启动器 adapter 启动面批（2026-10-26，eraTW `launch.ts`）**：那一批的读数是
    //     **195 文件 / 2,899 KB**，两枚闸随之上抬（194 → 195 文件、2,870 → 2,900 KB）。
    //     增量点名：`packages/plugins/eratw-adapter/src/launch.ts` **+1 文件 / +28.8 KB**。
    //     它进图的机制是既有的、不是那一批新造的：`eratw-adapter` 是**两个 eager 插件之一**
    //     （`EAGER_PLUGINS`），`plugin.ts` 静态挂 `GameAdapter.launch` ⇒ 整份启动描述符随适配器
    //     一起在开机图里。那一批记下的欠账（把同步字段抽成小常量表、实现留懒边），下一行记它已还。
    //   - **ADAPTER-LAZY 批（2026-10-26，本批）：现读数 194 文件 / 2,879 KB**，两枚闸随现值
    //     **下调**（195 → 194 文件、2,900 → 2,880 KB；降闸不写理由，读数口径照旧）。
    //     减法只有一处（`launch.ts` 整份离图：−1 文件 / −28.8 KB），但要同时断三条边：
    //     · 适配器的同步声明面（`saveLayout` / `contentRoots` / `logRules` / `defaultEncoding`）
    //       搬进**已在图里**的 `eratw-adapter/src/constants.ts`（+6.7 KB、**零新增文件**——这是
    //       本批能回到 194 而不是停在 195 的原因：常量搬进既有 eager 文件，不另开小模块）；
    //     · `plugin.ts` 的 `launch` 对象只留同步字段 + 两个 async 转发，`probe` / `buildProfile`
    //       经 `import('./launch')` 一次装载并缓存（打开启动器才付解析钱）；
    //     · 桶 `eratw-adapter/src/index.ts`（`bootstrap.ts` 静态引它）不再值转出 `./launch`，
    //       只留 `export type`——否则 `launch.ts` 会从这条 re-export 边整份回到图里。
    //     净变化 2,899 → 2,879（−20 KB / −1 文件）；余量 1 KB：下一枚进图的东西仍须先减面。
    // 读数随跑随打（同 `styles-split.equivalence` E 闸的口径）：闸绿时也能从日志拿到现值，
    // 交付回执不必靠人肉复算。
    console.log(`[ps10-eager-graph] 开机图现读数：${files.length} 文件 / ${totalKb} KB（闸：≤194 文件 / ≤2,880 KB）`);
    expect(totalKb).toBeLessThanOrEqual(2_880);
    expect(files.length).toBeLessThanOrEqual(194);
  });

  /**
   * **叶子纪律**（B1 立的，理由见上一条注释里的"差点翻车"）。
   *
   * `@kojo/kojo-lang` 的桶 re-export 了整个语言面（约 85 KB）。开机图里任何一枚文件
   * 引桶，就等于把整包挂上欢迎页。所以：**进首屏的代码只许引叶子**。
   *
   * 为什么单独一条而不并进体积闸：读数只能告诉你"涨了 82 KB"，说不清**是谁**；
   * 这条直接点名文件与 specifier。而且它在涨之前就红——体积闸要等累计够量才响。
   */
  it('开机图里对语言面库的引用必须是叶子（不许引桶：桶 = 整包 85 KB）', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const src = readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const m of src.matchAll(STATIC_IMPORT_RE)) {
        if (!hasValueBinding(m[1]!)) continue;
        if (m[2] === '@kojo/kojo-lang') offenders.push(`${rel} → ${m[2]}`);
      }
      for (const m of src.matchAll(EXPORT_FROM_RE)) {
        if (m[1] === '@kojo/kojo-lang') offenders.push(`${rel} → re-export ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
