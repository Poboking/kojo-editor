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

  it('反空匹配自证：同一条链只要**允许**跟动态边，正文就必须出现在图里', () => {
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

    const dynamicSpecs = [...src.matchAll(/import\(\s*['"](@kojo\/plugin-[^'"]+)['"]\s*\)/g)].map((m) => m[1]!);
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
    expect(totalKb).toBeLessThanOrEqual(3_200);
    expect(files.length).toBeLessThanOrEqual(220);
  });
});
