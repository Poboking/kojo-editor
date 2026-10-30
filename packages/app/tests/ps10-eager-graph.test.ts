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
 * ⚠ 已知漏点（如实记在这里而不是偷偷放宽判据）：
 * **`condition-extractor`** 仍被宿主 monaco 层静态挂着表达式表，因此留在开机图里。
 * `kojo-sugar` 那条链（`shell-overlays → diff-view → erb-language → theme → kojo-language
 * → @kojo/plugin-kojo-sugar`）已由 LAU-3b 解耦批断掉：共用词表搬进 `packages/kojo-vocab`，
 * 宿主与 ERB / kojo2 改引新包，v1 转译包不再进开机静态图（下方有专门断言）。
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

/**
 * 已知漏点的**插件目录名**（相对 `packages/plugins/`）。
 *
 * - `condition-extractor`：宿主 monaco 层仍静态挂着它的表达式表（`erb-language → …` 链）。
 * - `kojo-sugar` **已出列**（LAU-3b 解耦批，2026-10-27）：共用词表 / 词法 / 格式化搬到
 *   `packages/kojo-vocab`（非插件包），宿主与 ERB / kojo2 改引新包之后，v1 转译包的
 *   ~900 KB 链不再被开机静态图拽进来。下面有一条专门断言它**不许回来**。
 */
const KNOWN_LEAK_PACKAGES = new Set(['condition-extractor']);

/** 欢迎页 / 无项目态真吃得到的两个常驻插件 */
const EAGER_PLUGINS = ['@kojo/plugin-erb-parser', '@kojo/plugin-eratw-adapter'];

describe('PS-10 开机静态依赖图（教程与项目级插件都不许在欢迎页被解析）', () => {
  const graph = eagerClosure('packages/app/src/main.tsx');
  const files = [...graph.keys()];
  const totalBytes = [...graph.values()].reduce((a, b) => a + b, 0);
  const totalKb = Math.round(totalBytes / 1024);

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
    // 拆分真的生效了：29 个插件包里 ≥15 个整包不在图上（只剩常驻两个 + 已知漏点）
    const deferredDirs = allPluginPackages().filter((d) => !allowed.has(d));
    expect(deferredDirs.length).toBeGreaterThanOrEqual(15);
    expect(deferredDirs.filter((d) => presentDirs.has(d))).toEqual([]);
    // LAU-3b 解耦批的交付判据：v1 转译包整体不在开机图里（词表已搬去 kojo-vocab）
    expect(presentDirs.has('kojo-sugar')).toBe(false);
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
    //   - **LAU-3b 收尾批（2026-10-27，`.kojo1` 交接工具 + 封存档首开说明）**：现读数 **194 文件 / 2,907 KB**；
    //     KB 闸随现值 **2,900 → 2,910**（口径仍是"读数进十"）。**零新增模块**，增量全在图内既有文件：
    //     · `ui/App.tsx` **+3.2 KB**——改名命令、懒加载对话框挂载、列举与落地收尾接线（对话框本体在动态边）；
    //     · `ui/kojo2-cutover.ts` **+1.3 KB**——`.kojo1` 的 `extension-kojo1` 路由与常量说明；
    //     · `ui/kojo2-cutover-settings.tsx` **+1.2 KB**——设置页入口与文案；
    //     · `monaco/languages.ts` **+0.3 KB**——descriptor 两枚扩展名并认；
    //     另 **+0.4 KB** 是变基合流（dev IC 批 + 本分支 LAU-3）后的既有余量：合流树改前已是
    //     **194 / 2,901 KB**，比上一闸多 1 KB。`legacy-sealed-notice`（EditorPane 边）与
    //     `kojo1-rename*`（动态边）都不进本图；减面候选照旧是 `ui-kit/index.tsx` 按件拆分。
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
    //   - **体感批（2026-10-26，本组 D 车道：身份带 + 底栏 dock）**：现读数 **194 文件 / 2,883 KB**；
    //     文件闸不动（194，顶格零余量），KB 闸随现值 **2,880 → 2,890**（口径仍是"读数进十"，
    //     与本档 2,852→2,860、2,879→2,880 同一条）。增量按**同一张 194 枚图逐枚对字节复算**
    //     （合并 origin/dev e8c04578 后 dev→HEAD 只差 2,533 B + 一枚新文件），只有两处、都点名：
    //     · `ui/identity-band.ts` **+3,264 B / +1 文件**——身份带插槽（`useSyncExternalStore` +
    //       ref 登记的 75 行小模块）。它进图不是被顺带拖进来的：`WindowChrome` 在真壳的**欢迎页**
    //       就要登记插槽，而"浏览器 dev 下标题栏不存在 ⇒ 工具条必须回原位渲染"这条脱钩判据只能住
    //       在这个模块里。内联进 `WindowChrome.tsx` 只是换个文件记账（字节照付），还会让懒面侧
    //       （`ShellLayout`）从一个组件模块里取 store——故不取。
    //     · `ui/WindowChrome.tsx` **+2,533 B**——身份带 portal 落点 + `bandTitleOf`（同一行里项目名
    //       只报一遍）+ 同步拖动发起器预载（`startDragging` 必须在 mousedown 调用栈里发出，晚一拍
    //       就丢手势）。
    //     ⚠ 上一行"下一枚进图先减面"的承诺**本批没兑现**，理由摆在这里：两处增量都是功能体，
    //     能减的只有注释，而这两段注释正是"调试宿与真壳必须长同一张脸"这条口径的本身——删它
    //     等于删判据。减面路线仍欠着，下一批进图者先还（候选：`tokens.css` 档位表说明与
    //     `styles-project.css` 状态栏段有重叠，可并成一处；本批不动，免得把理由拆到两处之外）。
    //   - **IC 契约批（2026-10-27，补全线的类型面）**：现读数 **194 文件 / 2,886 KB**
    //     （同一棵树改前实测 **2,885** ⇒ 本批 **+1 KB / +0 文件**；对照数是临时把三枚文件
    //     退回 dev `1b3af305` 复跑量出来的，不是估的）。零新进图模块是**设计出来的**，不是运气：
    //     新契约 `plugin-api/inline-completion.ts` 是**纯类型叶子**，桶里只给 `export type`，
    //     `slots.ts` 引它用的是 `import type` ⇒ 走图规则（本文件头第 11 行那条）把它整枚擦掉，
    //     与 B1 / erafl 两条"值导出决定模块图"的教训同形；这条纪律本身由
    //     `packages/plugin-api/tests/inline-completion.test.ts` 的「零值导出」闸钉住（注释里
    //     出现 `export const` 字样不算违纪，所以那条闸扫的是**剥掉注释后的正文**）。
    //     +1 KB 的落点只有两处，都是已在册文件里的中文说明：`plugin-api/slots` 的
    //     `'completion.source'` 条目（为什么不带 `ui.` 前缀 + 为什么不塞 `languageService`）
    //     与 `plugin-api/index` 的 IC 追加区块头。**闸不抬**（2,890 不动），
    //     上面那笔"下一批先减面"的欠账**没还也没新增**——本批没往常驻面加一枚模块。
    //     ⚠ 但落地时读数再 +1 KB ⇒ **194 文件 / 2,888 KB，余量只剩 2 KB**。那 1 KB 不是本批的：
    //     合流上游 synthwave84 欢迎页批 `e226e0bf` 给常驻件 `ui/WelcomeView.tsx` 加了 7 行。
    //     欠账现在更紧，减面候选照旧是 `ui-kit/index.tsx` 按件拆分（约 −12 KB）——别再往下传。
    //   - **LAU-3 框架批（2026-10-27，语言面统一）**：现读数 **194 文件 / 2,893 KB**；
    //   - **LAU-3 框架批（2026-10-27，语言面统一）**：现读数 **194 文件 / 2,895 KB**
    //     （并入六档主题批后 +2 KB：`monaco/theme.ts` 的三张新规则表同源改动常驻在图里）；
    //     文件闸不动（194，顶格），KB 闸随现值 **2,890 → 2,900**（口径仍是"读数进十"）。
    //     增量逐枚点名（**全是判据注释，零新增功能体**）：
    //     · `ui/kojo2-cutover.ts` **+4.5 KB**——计划 v2 迁移（v1 的 `v1-only` 抬档 +
    //       `liftedFromV1Baseline` + `kojo2StageAllowsLegacy`）的规则与取舍：`App` 开机就要挂
    //       切流控制器，这一枚本来就在图里；
    //     · `ui/kojo2-flag.ts` **+1.9 KB**——kojo1 封存门的唯一读点与解析顺序；
    //     · `ui/kojo2-cutover-settings.tsx` **+3.0 KB**——三档作者面文案纠正 + kojo1 开合读数 +
    //       迁移回执（档位控制本来就随 `installKojo2CutoverStageEffects` 常驻）；
    //     · `ui/sugar-view.ts` **+1.1 KB**——预览可用门第三道轴（kojo1 封存）的判据说明。
    //     **本批另有一处真减面**：可用性门原本由 `App.tsx` import 注册表来装（实测 **195 文件 /
    //     2,913 KB**，越闸），改成"缺省谓词住在注册表里"之后整张 descriptor 表回到懒边——
    //     文件数读回 194、字节 −15.8 KB。再想减只剩删上面四条注释，那是删判据，故不取。
    //   - **LAU-3b 解耦批（2026-10-27，kojo1 插件封存 + 词表搬家）**：现读数 **194 文件 / 2,896 KB**
    //     （+1 KB / +1 文件：`ui/legacy-plugin-gate.ts`——装配根要按切流阶段决定装不装 kojo1
    //     插件族，这一枚判据必须常驻，但门的真源仍**动态取**，不把切流控制器拖进开机图）。
    //     `@kojo/plugin-kojo-sugar` 整包**已出图**：共用词表 / 词法 / 格式化搬到
    //     `packages/kojo-vocab`（非插件包），宿主与 ERB / kojo2 改引新包之后，v1 转译的
    //     ~900 KB 链不再被开机静态 import 拽进来。成员断言随之从"两个已知漏点"收紧为
    //     "只剩 condition-extractor"，并新增一条 kojo-sugar 不许回来的断言。
    //   - **LAU-3b 收尾批（2026-10-27，`.kojo1` 交接工具 + 封存档首开说明）**：现读数 **194 文件 / 2,907 KB**；
    //     KB 闸随现值 **2,900 → 2,910**（口径仍是"读数进十"）。**零新增模块**，增量全在图内既有文件：
    //     · `ui/App.tsx` **+3.2 KB**——改名命令、懒加载对话框挂载、列举与落地收尾接线（对话框本体在动态边）；
    //     · `ui/kojo2-cutover.ts` **+1.3 KB**——`.kojo1` 的 `extension-kojo1` 路由与常量说明；
    //     · `ui/kojo2-cutover-settings.tsx` **+1.2 KB**——设置页入口与文案；
    //     · `monaco/languages.ts` **+0.3 KB**——descriptor 两枚扩展名并认；
    //     另 **+0.4 KB** 是变基合流（dev IC 批 + 本分支 LAU-3）后的既有余量：合流树改前已是
    //     **194 / 2,901 KB**，比上一闸多 1 KB。`legacy-sealed-notice`（EditorPane 边）与
    //     `kojo1-rename*`（动态边）都不进本图；减面候选照旧是 `ui-kit/index.tsx` 按件拆分。
    //   - **UI 反馈批（2026-10-27，教程展开 / 间距 / 浮出按钮去重 / 档位降档 / 口上 XML 缺省收起）**：
    //     现读数 **194 文件 / 2,907 KB，与上一档逐字相同**，两枚闸不动（194 / 2,910）。
    //     **本批零进图**不是漏量：新模块 `ui/panel-visibility.ts` 只被 `ShellLayout` 与
    //     `SettingsPanel` 引，而这两个都挂在 `ProjectView` 的动态边之下
    //     （`ui/App.tsx:188` 的 `import('./ProjectView')`）——欢迎页那条链根本走不到它。
    //     判据是同一棵树上改前/改后各跑一次本闸，两次读数一枚不差（194 / 2,907 与 194 / 2,907）。
    //   - **1027 三批合流（标签跨组 / WS-01+02 止血 / WS-03 工作区收窄；变基到 UI 反馈批之后）**：
    //     现读数见下方随跑打点；KB 闸随现值 **2,910 → 2,940**（口径仍是"读数进十"）。
    //     **零新增模块**：`view-state-store`（约 22.5 KB）本来会被 `App.tsx` 的改名收尾静态
    //     拽进图，已改成动态 import（改名是低频动作，同 `editor-model-pool-instance` 的懒边）。
    //     增量逐块点名（`Buffer.byteLength` 对 6a3fcea5 基线）：`ui/tabs-ops.ts` +7.5 KB
    //     （跨组拖拽载荷 / 落点 / 固定区钳位 / 菜单项）、`kernel/workspace.ts` +4.1 KB
    //     （projectDirs / 撤销 / 收窄注释）、`ui/App.tsx` +2.7 KB（跨组移动 + 重名收尾）、
    //     `ui/editor-groups.ts` +2.6 KB、`ui/recent-files.ts` +2.0 KB、`ui/disk-reconcile.ts`
    //     +2.0 KB、`plugin-api/workspace.ts` +1.9 KB、`plugin-api/platform.ts` +1.7 KB、
    //     `plugin-api/io.ts` +1.0 KB、`kernel/io.ts` +1.0 KB、`plugin-api/erb.ts` +0.9 KB、
    //     `ui/workspace-roots.ts` +0.9 KB、`erb-parser/plugin.ts` +0.8 KB、
    //     `bridge/tauri-bridge.ts` +0.7 KB、`use-project-session.ts` +0.2 KB、
    //     `project-scan-schedule.ts` +0.2 KB、adapter 向导 +0.03 KB（合计 ≈32.7 KB；
    //     差值 2.7 KB 是旧基线四舍五入，UI 反馈批本身零进图）。
    //   - **WS-04/05 工作区单源 + 索引增量批（2026-10-27）**：现读数 **198 文件 / 2,977 KB**；
    //     两枚闸随现值抬 **194 → 198 文件 / 2,940 → 2,980 KB**（口径仍是"读数进十"）。
    //     **四枚真新增模块**（`Buffer.byteLength` 合计 ≈25.9 KB），且每一枚都在开机链上
    //     （不是偷懒的静态边界）：
    //     · `ui/workspace-folders.ts` 11.7 KB——五条消费者（树 / Ctrl+P / 检索 / 监视 / 扫描）
    //       的唯一根模型；`use-project-session` 开机装监视时就要拿 `watchRootsOf`，必须常驻；
    //     · `ui/use-workspace-folders.ts` 2.8 KB——同一模型的 React 变化信号；
    //     · `ui/erb-index-sync.ts` 6.9 KB——盘上增删改名的增量接线（`App.tsx` 删除/改名收尾直接调）；
    //     · `plugins/erb-parser/src/incremental.ts` 4.5 KB——增量解析本体（`plugin.ts` 实现 `applyFileChanges`）。
    //     图内既有文件净增 ≈15 KB：`erb-parser/plugin.ts`（`applyFileChanges` 接线与回退判据）、
    //     `ui/FileTree.tsx`（根组 / 徽标 / 新建后增量通知）、`ui/ProjectView.tsx`、
    //     `plugin-api/erb.ts`（`applyFileChanges` 契约）、`ui/project-scan-schedule.ts` /
    //     `ui/kojo-source-scan.ts` / `ui/App.tsx` / `ui/use-project-session.ts` 合计 <2 KB。
    //     **减面口径**：四枚都是"开机就要读"的判据，没有可挪到懒边的消费面；真正的减面候选
    //     照旧是 `ui-kit/index.tsx` 按件拆分。
    //   - **WS-06/07/08 批（会话布局恢复完整 / 项目切换入口 / 附加根生命周期）**：
    //     读数见下方随跑打点（改前 194 / 2,937，落地时 194 / 2,967）；KB 闸随现值
    //     **2,940 → 2,970**（口径仍是"读数进十"），**文件闸不动（194，顶格零余量）**。
    //     两条新判据（分屏比例 / 恢复前置校验）原本各开一枚文件，落地时量到 196 文件 ⇒
    //     按本闸纪律改成**并入既有常驻模块**再进图，文件数读回 194：
    //     · `ui/editor-groups.ts` +7.5 KB——分屏比例那一节（`SPLIT_MIN_RATIO` / sanitize /
    //       align / 像素换算）与布局签名 `groupsLayoutSignature`。比例本来就是组态的一部分；
    //     · `ui/session-store.ts` +10.9 KB——恢复判据（`planSessionRestore` 纯函数 +
    //       `probeExistingPaths` 有界并发探针）与 `splitSizes` / `extraRoots` 两个 additive 字段；
    //       它读写的正是同一份会话记录的形状；
    //     · `ui/App.tsx` +5.7 KB——分屏比例状态 / 组数对齐 / 附加根移除 / 新 props 接线；
    //     · `ui/use-project-session.ts` +4.1 KB——恢复改为探盘后装回、附加根按记录恢复、
    //       flush 依赖扩到布局签名 / 比例 / 附加根；
    //     · `ui/workspace-roots.ts` +1.1 KB——`planRemoveExtraRoot`；
    //     · 零进图：`ui/project-open-menu.ts`（被 `ShellLayout` 引，在项目态懒边之下），
    //       以及 `ProjectView` / `FileTree` 的改动全部在 `import('./ProjectView')` 之后。
    //   - **B/C 合流（2026-10-27）**：两批在同两条消费者线上重叠（`App` / `FileTree` /
    //     `ProjectView` / `use-project-session`），读数按**合流后的树**重测：
    //     **198 文件 / 3,006 KB**；KB 闸 **2,980 → 3,010**（口径仍是"读数进十"），文件闸 198 不动。
    //     B 的四枚新模块与 C 的两处并入互不相干（文件数不变）；KB 按"单批增量相加"是
    //     B +40 / C +30，合流树实测 3,006（比 2,937+70 少 1 KB：两批在 `App.tsx` /
    //     `FileTree.tsx` 同一段落的改写有重叠，按实际读数进闸）。
    //   - **变基到 dev `c000a24b`（击键/光标/长列表热路径批）之后**：读数 **198 文件 / 3,010 KB**
    //     （dev 那批 `commands.ts` 键位索引 +4 KB，全部在图内既有文件）；KB 闸随之 **3,010 → 3,020**
    //     ——读数恰好压在 3,010 上等于零余量，留一档给下一枚 KB 级改动（口径不变，仍是读数进十）。
    //   - **LAU-1 / D2 合流（2026-10-27，再变基到 `3ff2ed63` 之后）**：读数 **198 文件 / 3,017 KB**
    //     （文件数不变，余量 3 KB），两枚闸不动（198 / 3,020）。⚠ **B3c 复核（2026-10-28）改对**：
    //     原台账把净 +7 KB 归给「`monaco/kojo2-event-sites.ts`（悬停 / 引用 / lint 三处共用的事件
    //     挂点扫描）入图」——**实测它从未在图里**：三枚消费方（`kojo2-hover.ts` / `kojo2-references.ts`
    //     / `kojo2-dialect-lint.ts`）全挂在 `kojo2-providers → editor-global-providers` 链上，该链
    //     自首屏批把 monaco 装配挪出欢迎页静态图后一枚都不在图上（现图内 monaco 仅 `reveal-position.ts`
    //     与 `tree-sitter/fallback.ts` 两枚；搬家后进图的 kojo2 语言面文件仍只有 `kojo-lang/src/
    //     constants.ts` 一枚 1,493 B）。该笔 +7 KB 的逐笔归属已不可从现树复原，此段按现值只留历史
    //     记账性质。反向抵消 D2b 把 `erb-language.ts` 的族头串摘成从 `@kojo/kojo-vocab/engine`
    //     派生。**下一枚进图模块仍须先挪一枚。**
    //   - **LAU-6 注入（2026-10-27）**：读数 **198 文件 / 3,018 KB**，两枚闸不动（198 / 3,020）。
    //     `tree-sitter/injection.ts` 的子解析器走共享块（`injection-*.js`，不在图上），
    //     入图的只有 `kojo2-semantic.ts` 那几条合并规则的 +1 KB。余量 2 KB。
    //   - **前端性能批（2026-10-27，自写回声抑制 / 进度条合成属性）**：读数 **198 文件 / 3,018 KB**
    //     ——与上一档逐字相同（+2 KB 源码在"读数进十"的口径下没抬档），两枚闸不动（198 / 3,020）。
    //     增量全在图内既有文件：`ui/external-change.ts` 约 +0.6 KB
    //     （自写回声判据 `isSelfWriteEcho` + `SELF_WRITE_WINDOW_MS`，注释压到最简——
    //     判据的完整说明住在 `external-change.test.ts` 的同名 describe，那里不进图）、
    //     `ui/EditorPane.tsx` 约 +0.4 KB（`selfWriteAtRef` 时刻表 + `file.changed` 腿上的一处放行）。
    //     **零新增模块**；其余改动全在 CSS（`kojo2` / `search-panel` / `shell-band` /
    //     `update-dialog` / `styles-project`）与插件侧行内样式，一枚都不进本图。
    //   - **LAU-2 角色表（2026-10-27，变基到含前端性能批的 dev 之后）**：读数 **199 文件 / 3,037 KB**
    //     （3,036 + 上游那批的 +1 KB），两枚闸随之
    //     **198 → 199 / 3,020 → 3,040**（口径仍是"读数进十"）。这**是一枚新进图模块**：
    //     `monaco/semantic-roles.ts` 18,508 B——角色表被主题/三份 Monarch/捕获侧共同静态引用，
    //     进图是本批的**代价而非副作用**（换来的是 M3 旧 token 名 254 → 64 行、只落别名表一处）。
    //     净 +18 KB ≈ 该模块原始字节（其余文件因角色名替换反向缩了）。按本节纪律，
    //     **下一枚进图模块仍须先挪一枚出去**——欠账挂在这里。
    //   - **LAU-5 结构 worker 池（2026-10-27）**：读数 **199 文件 / 3,037 KB 不动**，两枚闸不动。
    //     `monaco/tree-sitter/structure-pool.ts` 与 `structure.worker.ts` 都只在懒装配链上
    //     （`client.ts` / `injection.ts` 由语言描述符的 `structure.load()` 动态取），**不进开机图**；
    //     `editor-global-providers.ts` 里那条 `closeStructurePool` 也在懒块里。⇒ 欠账仍是一枚。
    //   - **批次 E（WS-10 检索真相面 + WS-14 编辑器组 + WS-16 命令面板覆盖面，变基到含
    //     LAU-5 的 dev 之后）**：KB 闸随之 **3,040 → 3,070**，文件闸 **199 不动**
    //     （本批**零新进图模块**）。逐笔（全部长在**图内既有文件**里）：
    //     · `ui/search-store.ts` 的按项目检索条件（`bindSearchPrefs` / 防抖落盘 / 限额驱逐）
    //       与 `ui/search-query.ts` 的派生默认面 + 排除模式解析——`ShellLayout` 值引前者；
    //     · `ui/editor-groups.ts` 三枚纯函数（排列序聚焦 / 环形切换 / 键盘调份额）；
    //     · `ui/App.tsx` 的三枚组命令回调与随之加上的 import。
    //     刻意**不落进图**的两处：`ui/command-mru.ts`（只被懒面 `Palette.tsx` 值引）与
    //     `keybinding-specs-commands.ts` 新增的 13 条（懒半表）——文件闸按本节纪律顶格，
    //     新增模块一律走懒边，这是硬约束不是偏好。
    //     基线 `3ff2ed63` 上单独测得 +28 KB（3,010 → 3,038）；**变基并入 dev 的性能批 +
    //     LAU-2 / LAU-5 之后本树实测读数 = 199 文件 / 3,062 KB**，3,070 即该读数进十（同一口径）。
    //   - **SDK B4（2026-10-28）**：读数 **199 文件 / 3,064 KB**，两枚闸都不动（上限 3,070 未抬，
    //     本批既不落进图模块也不删进图模块）。**零新进图模块**：角色表从
    //     `monaco/semantic-roles.ts`（LAU-2 那枚 18,508 B）整体搬进
    //     `packages/kojo-lang/src/semantic-roles.ts`（19,304 B）——出图一枚、入图同一枚，净涨的
    //     +0.8 KB 全是搬家时补的"为什么住 SDK"那段注（架构 §7.2「角色表住 SDK 不住 app」）；
    //     同批把 `ui/shell-overlays.ts` 那条注释里的旧住址 `monaco/kojo-theme-rules.ts` 改成包路径
    //     （+1 B，图内文件的注释照样算钱）。本批新增的四枚包内模块（词表 / Monarch / 语言配置 /
    //     主题声明）只在**插件懒链**上：`bootstrap.ts` 引 `@kojo/plugin-kojo-lang` 是动态边，
    //     宿主落点与 `theme.ts` 都不进本图。⇒ 欠账照旧：下一枚进图模块仍须先挪一枚出去。
    //   - **WS-13 2a 车（资源管理器剪贴板家族，变基到含 SDK B4 的 dev 之后）**：读数
    //     **199 文件 / 3,070 KB**——恰好压在 dev 那档（3,064）+ 本批 6 KB 上，**零新进图模块**
    //     （文件数不动就是直接证据）。涨的逐枚按 git 现算：`ui/file-tree-ops.ts` +4,699 B
    //     （四个菜单项 + 两枚能力位）、`ui/disk-reconcile.ts` +984 B（`dirtyNamesIn` 脏投影——
    //     与既有 `fileOpGuardMessage` 共用同一条匹配判据，不留第二份"脏"定义）、
    //     `ui/keybinding-specs.ts` +142 B（序表进「资源管理器」分类）= +5,825 B ≈ 该读数差；
    //     三枚都**没新增 import**（新增 import 才会拽新文件进图）。本批三枚新模块
    //     `file-clipboard` / `file-ops-plan` / `file-ops-exec`，连同改大的 `FileTree`（+19 KB）
    //     与 `ProjectView`，全在 `import('./ProjectView')` 的懒边之下，一枚不进图。
    //     闸 **3,070 → 3,080**：读数正好压在 3,070 上等于零余量，按 `c000a24b` 那次的口径
    //     留一档给下一枚 KB 级改动（仍是读数进十）。⇒ 欠账照旧：下一枚进图模块须先挪一枚出去。

    //   - **真另存为批（2026-10-28，WS 欠账 E）**：读数 **199 文件 / 3,080 KB**——**零新进图模块**
    //     （文件数不动就是直接证据）。进图六枚、净 **+9,597 B ≈ 10 KB**（`totalKb` 是全图字节
    //     一次 round，故 9.4 KB 的增量落在 +10 这一档），逐枚按 git 现算：`ui/App.tsx` +5,742 B
    //     （`saveAs()` 编排与成功回调里的逐处迁移）、`kernel/src/io.ts` +1,070 B（`pickSavePath`
    //     透传层）、`ui/editor-groups.ts` +966 B（`migrateGroupPathsAfterSaveAs` 纯函数）、
    //     `plugin-api/src/io.ts` +774 B 与 `platform.ts` +665 B（additive 契约面：`pickSavePath?`
    //     可选方法 + "为什么这不是第四条域外通道"那段裁决注）、`bridge/tauri-bridge.ts` +380 B。
    //     六枚都**没新增 import**（新增 import 才会拽新文件进图）。刻意全在懒边之下、一枚不进图：
    //     新模块 `ui/file-save-as.ts`（13,509 B，App 里动态 `import()`）、`EditorPane.tsx` +6,402 B
    //     （`readBuffer`/`transferBuffer`/`snapshots`——实测本就不在图内）、`editor-model-pool.ts`
    //     +2,128 B 与 `editor-model-pool-instance.ts` +963 B、`ProjectView.tsx` +853 B、
    //     `keybinding-specs-commands.ts` +687 B（命令登记特意落**懒半**，不落 eager 那半）、
    //     以及调试面三枚（`dialog-policy` / `install-debug` / `web-host-transport`）。
    //     闸 **3,080 → 3,090**：读数又压在顶格上等于零余量，同上口径再留一档。
    //     ⇒ 欠账照旧：下一枚进图模块仍须先挪一枚出去；另存为这条链若还想把这 10 KB 还回去，
    //     办法是把 `App.tsx` 里的 `saveAs()` 编排整体挪进 `file-save-as.ts` 的懒面（未做，
    //     因为迁移回调要持 `App` 的七张账，挪走就等于把状态所有权外移）。
    //   - **B3c 补全/悬停搬家（2026-10-28，本批）**：读数 **199 文件 / 3,087 KB**（逐文件原始字节
    //     实测：上一笔真另存为批的 3,080 档 + 6,526 B ⇒ 进位到 3,087），**两枚闸都不动**
    //     （≤199 / ≤3,090；3,090 是上一笔抬的，本批一字未抬，余量 3 KB）。
    //     搬家本体对图是**零改动**——宿主删的四枚判据 `monaco/kojo2-{completion,completion-snippets,
    //     hover,event-sites}.ts`、改瘦的 `kojo2-providers.ts`、blank 四枚的 re-export
    //     （`kojo-completion-position.ts`）与新入包的四枚叶子全在懒边（见上方 LAU-1/D2 复核段），
    //     图内文件集**一枚未增未减**（199 就是直接证据）。本批图差逐笔按 git 现算：
    //     · `plugin-api/src/slots.ts` **+6,503 B**——契约 additive：`SlotServiceKind` 两枚新槽
    //       （completion / hover）、`EditorCompletionItemKind` 六档图标契约、悬停 `format` / `range`
    //       字段与逐档语义注（slots 是常驻契约面，开机页就值引它）；
    //     · `plugin-api/src/index.ts` **+23 B**——导出面随动一行。
    //     余量 3 KB。⇒ 欠账照旧：下一枚进图模块须先挪一枚出去。
    //   - **B3d 签名/格式化搬家（2026-10-28，本批）**：读数 **199 文件 / 3,089 KB**，
    //     **两枚闸都不动**（≤199 / ≤3,090）。**零新进图模块、零出图**：宿主删的
    //     `kojo2-enter.ts` 与改瘦的 `kojo2-signature.ts` / `kojo2-format.ts`、`register-dialects.ts`
    //     全在 `editor-global-providers → monaco 装配` 这条**懒边**之下——本树实测四处一枚
    //     都不在图上（逐文件扫描：图内 kojo2 语言面文件只有 `kojo-lang/src/constants.ts`）。
    //     ⚠ 任务书原以为"删 `kojo2-enter.ts` ⇒ 199 → 198、把文件闸从顶格变成留一档"：
    //     **实测该文件从未在图里**（只有测试 import 它），所以读数与闸都没动，本批**不抬不降**。
    //     KB 那一档的增量（3,087 → 3,089）全是图内既有文件：契约面 `plugin-api/src/slots.ts`
    //     的 `lineRange` 与桶里那行 `EditorFormattingLineRange`，加上变基并入的上游写域出路批。
    //     ⇒ 欠账照旧：下一枚进图模块须先挪一枚出去（余量 1 KB / 零文件余量）。
    //   - **B3e 引用/改名搬家（2026-10-29，本批）**：读数 **199 文件 / 3,088 KB**——**零新进图
    //     模块**，增量 **+941 B** 全在契约面（`slots.ts` +919：`EditorProjectFile` 与四处请求/
    //     结果字段及注；`index.ts` +21：导出面一行）。变基到当前 dev（`26950491`）后 dev 本体
    //     实测 **3,087 KB**，本批落地 **3,088 KB** ⇒ KB 闸维持 **3,090**（余量 2 KB）；
    //     文件闸不动（199）。
    //   - **B3f 同符号高亮/扩选搬家（2026-10-29，本批）**：读数 **199 文件 / 3,090 KB**——
    //     **零新进图模块**（两枚判据叶子只在插件侧；宿主两文件在懒边之下）。车道的初读是
    //     **3,089 KB / +646 B**，但那笔读数靠**删掉 `EditorLanguageServiceContribution` 的
    //     三态 / 多源口径头注（约 2.6 KB）**换来，且腿层仍写着"与头注逐字一致"⇒ 验收修正
    //     **恢复该头注的紧凑版（+1,179 B）**，读数 **3,089 → 3,090 KB**，**余量 0**。
    //     两枚闸维持 **≤199 / ≤3,090**：零新进图模块，本批**不抬闸**；但下一枚进图模块
    //     **必须先挪一枚出去**（欠账从"余 2 KB"变成"零余量"）。
    //   - **性能线整条并入（2026-10-29，17 条提交）**：读数 **199 文件 / 3,132 KB**——
    //     **零新进图模块**（199 就是直接证据）；净 **+42,167 B ≈ 41 KB** 全落在图内既有文件里，
    //     逐枚按「本树 vs `origin/dev` 同路径原始字节」实测：`erb-parser/src/references.ts` +11,661
    //     （语义着色按窗口取数——R3 的供方腿）、`eratw-adapter/src/family-index.ts` +4,077（家族名
    //     预解析）、`erb-parser/src/plugin.ts` +3,891、`plugin-api/src/slots.ts` +3,120（行窗口
    //     契约 + 语义请求 `range`）、`plugin-api/src/paths.ts` +2,873（归一化记忆 + 路径预折叠
    //     探针）、`erb-parser/src/semantic-tokens.ts` +2,276、`app/src/bridge/invoke.ts` +2,231、
    //     `kernel/src/io.ts` +2,141、`condition-extractor/src/offload.ts` +1,843、
    //     `app/src/ui/project-diagnostics.ts` +1,395、`kernel/src/storage.ts` +1,297、
    //     `plugin-api/src/platform.ts` +941、`erb-parser/src/offload.ts` +683、
    //     `erb-parser/src/undefined-name.ts` +587，其余 185 枚合计 ≈ +3.6 KB。
    //     闸 **3,090 → 3,140**：这 17 条（P0-2 冷开 / P0-3 检索与大文件 / 折叠拆闸 / A 批 / B 批）
    //     此前只在本地分支上跑，**首次并进主干**，字节差是一次到账，不是单批膨胀。
    //     ⇒ 欠账照旧：下一枚进图模块仍须先挪一枚出去（文件闸仍是顶格 199，零文件余量）。
    //   - **内存批 MEM-1/MEM-2（2026-10-29，本批）**：读数 **199 文件 / 3,141 KB**——
    //     **零新进图模块**（199 未动）；净 **+7,706 B** 全落在图内既有四个文件，逐枚实测：
    //     `kernel/src/io.ts` +3,730（文本缓存的空闲整表释放 + 观测出口）、
    //     `erb-parser/src/scanner.ts` +3,603（`detachString` 助手与出口留存闸）、
    //     `kernel/src/kernel.ts` +331（`project.closed` → 释放一行）、
    //     `erb-parser/src/references.ts` +42（两处 `detachString` 调用与一行 import）。
    //     ⇒ 闸 **3,140 → 3,145**（余量 4 KB）。抬这一档的理由：这批加的是**能力**不是注释堆——
    //     它把整库正文的隐式留存（约 −145 MB）与文本缓存的常驻（约 −218 MB）从堆上摘掉，
    //     代码本身必须留在图里；文件数一分未涨，说明没有偷偷多拽模块进来。
    //     欠账照旧：下一枚进图模块仍须先挪一枚出去（文件闸顶格 199）。
    //   - **内存批 MEM-4（2026-10-29，本批）**：读数 **199 文件 / 3,149 KB**——同样**零新进图
    //     模块**（199 未动）；净 **+8,355 B** 全落在图内既有三个文件，逐枚实测：
    //     `erb-parser/src/snapshot.ts` +5,267（解码期的同内容字符串去重表 + 结构普查
    //     `snapshotStats`）、`erb-parser/src/plugin.ts` +1,866（`retainedSnapshot` 镜像与
    //     两个量测出口）、`plugin-api/src/erb.ts` +1,222（两条 additive 可选调试方法）。
    //     ⇒ 闸 **3,145 → 3,150**（余量 1 KB）。抬这一档的理由与上一批同构：加的是**能力**，
    //     而且直接换到堆上——去重表把 772,329 个重复字符串实例（31.3 MB）压到 16.3 MB，
    //     热载稳态 **297.3 → 271.8 MB**。量测出口本身也是能力：没有它，这一批的靶子是
    //     "索引总量 − byName" 推出来的（推错了 145 MB），详见 PITFALLS 259。
    //     欠账照旧：下一枚进图模块仍须先挪一枚出去（文件闸顶格 199）。
    //   - **内存批 MEM-5（2026-10-29，本批）**：读数 **199 文件 / 3,160 KB**——同样**零新进图
    //     模块**（199 未动）；净 **+11,362 B** 只落在图内一枚文件：
    //     `condition-extractor/src/snapshot.ts` +11,362（列式依赖表：15 个 TypedArray + 4 个
    //     字符串池的建表/物化两段，加上 v6 读数注）。同批 `tests/snapshot.test.ts` +1,803 是
    //     测试文件，不进开机图。
    //     ⇒ 闸 **3,150 → 3,162**（余量 2 KB）。抬这一档的理由与前两批同构：加的是**能力**，
    //     而且直接换到堆上——把 21.2 万条依赖的元组（79 万个 JSArray + 57 万份可去重字符串）
    //     压成一张 11.4 MB 的列式表，热载稳态 **272.4 → 203.1 MB（−69.3 / −25.4%）**，
    //     其中本插件 105.8 → 36.5 MB。文件数一分未涨。
    //     欠账照旧：下一枚进图模块仍须先挪一枚出去（文件闸顶格 199）。
    //   - **B3j 一键迁移 code action 判据搬家（2026-10-30，本批）**：读数 **199 文件 / 3,162 KB
    //     不动**——**零新进图模块**（判据叶子 `@kojo/kojo-lang/code-actions` 只在插件供方侧，
    //     宿主那枚安装器仍在 `editor-global-providers → monaco 装配` 的懒边之下）。宿主删掉的
    //     判据与新增的槽查询都在懒边内 ⇒ 两枚闸维持 **≤199 / ≤3,162**，**不抬不降**。
    //   - **内存批 MEM-6（2026-10-30，本批）**：读数 **199 文件 / 3,175 KB**——同样**零新进图
    //     模块**（199 未动）；净 **+12,885 B** 全落在图内既有三枚文件，逐枚实测：
    //     `erb-parser/src/snapshot.ts` +12,288（候选记号集的哈希化：`hashToken` + 一套
    //     base64 编解码 + v11→v12 的免费迁移 + 版本表准入位）、
    //     `erb-parser/src/plugin.ts` +524（名录对称差的哈希集算一次、逐文件复用）、
    //     `plugin-api/src/erb.ts` +73（`candidateChars` → `candidateHashes` 的统计位）。
    //     ⇒ 闸 **3,162 → 3,178**（余量 3 KB）。抬这一档的理由与前几批同构：加的是**能力**，
    //     而且直接换到堆上——每文件 16,968,188 字符的候选串（两字节 ⇒ **32.0 MB**，消融实测）
    //     压成 1,703,214 枚 32 位哈希（**6.5 MB**），热载稳态 **202.9 → 171.7 MB（−31.2 / −15.4%）**。
    //     文件数一分未涨。
    //     欠账照旧：下一枚进图模块仍须先挪一枚出去（文件闸顶格 199）。
    //   - **ERB-VOCAB 架构债批（2026-10-30，本批）**：读数 **199 文件 / 3,175 KB**
    //     （3,250,825 B）——两枚闸**不抬**（≤199 / ≤3,178）。控制流配对表从插件
    //     `erb-parser/src/scanner.ts` 上提到非插件库包 `@kojo/erb-vocab`（库 `@kojo/erb-lang`
    //     不再 import 插件包），新叶子 `erb-vocab/src/control-flow.ts` 进图、`scanner.ts` 减重；
    //     文件数一分未涨的原因：按台账"下一枚进图模块须先挪一枚出去"的口径腾了一枚——
    //     `erb-parser/src/did-you-mean.ts`（102 行纯函数、唯一调用方是 `undefined-name.ts`）
    //     并入 `undefined-name.ts`，判据与用例一字未改。
    //   - **B5b 第一步（2026-10-30，本批）**：读数 **199 文件 / 3,175 KB 不动**——删的两枚
    //     （`monaco/kojo2-symbols.ts` 164 行、`monaco/kojo2-inlay.ts` 155 行）都只在**懒边**
    //     （`editor-global-providers → monaco 装配`）之下，从不在开机图里；全图字节数与上一档
    //     逐字相同就是直接证据。两枚闸维持 **≤199 / ≤3,178**，**不抬不降**。
    // 读数随跑随打（同 `styles-split.equivalence` E 闸的口径）：闸绿时也能从日志拿到现值，
    // 交付回执不必靠人肉复算。

    console.log(
      `[ps10-eager-graph] 开机图现读数：${files.length} 文件 / ${totalKb} KB · ${totalBytes} B（闸：≤199 文件 / ≤3,178 KB）`,
    );
    expect(totalKb).toBeLessThanOrEqual(3_178);
    expect(files.length).toBeLessThanOrEqual(199);
  });

  /**
   * **叶子纪律**（B1 立的，理由见上一条注释里的"差点翻车"）。
   *
   * `@kojo/kojo-lang` 的桶 re-export 了整个语言面（约 85 KB）。开机图里任何一枚文件
   * 引桶，就等于把整包挂上欢迎页。所以：**进首屏的代码只许引叶子**。
   *
   * 为什么单独一条而不并进体积闸：读数只能告诉你"涨了 82 KB"，说不清**是谁**；
   * 这条直接点名文件与 specifier。而且它在涨之前就红——体积闸要等累计够量才响。
   *
   * SDK B5a：同样的形状多了一枚 `@kojo/kojo-sdk`——它的桶把**契约面 + 结构协议 + 角色表**
   * 一起 re-export（还会经 `structure-protocol` 值引 core 的桶）。判据与 `kojo-lang` 逐字
   * 相同（"不许引桶、只许引叶子"），只是取证点从一枚包变成两枚：这不是放宽，是新包进图时
   * 必须回答的同一个问题。
   */
  it('开机图里对语言面库的引用必须是叶子（不许引桶：桶 = 整包 85 KB）', () => {
    const barrels = new Set(['@kojo/kojo-lang', '@kojo/kojo-sdk']);
    const offenders: string[] = [];
    for (const rel of files) {
      const src = readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const m of src.matchAll(STATIC_IMPORT_RE)) {
        if (!hasValueBinding(m[1]!)) continue;
        if (barrels.has(m[2]!)) offenders.push(`${rel} → ${m[2]}`);
      }
      for (const m of src.matchAll(EXPORT_FROM_RE)) {
        if (barrels.has(m[1]!)) offenders.push(`${rel} → re-export ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
