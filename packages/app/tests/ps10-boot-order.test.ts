import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectAdapters } from '../src/adapter-manifest';

/**
 * PS-10 ②③ 的两条**次序契约**闸（源码级，形态照 `boot-sweep-single-source.test.ts`）。
 *
 * 为什么用源码级而不是渲染级：这两条判据的本体就是"谁先谁后"，而起真壳要桌面预算
 * （同 identifier 只能一个实例，PITFALLS 70），跑 React 又要把 20 个插件全拖进测试图。
 * 源码级读序足以钉住它们，且改错一个字就红。
 *
 * 1. **注册早于开项目**：`ensureProjectPlugins` 必须排在 `kernel.project.open()` 前面——
 *    项目级插件挂在 `project.opened` 那一拍（级联 / 快照 / 各自的 compute 任务表），
 *    晚一拍就是漏接事件＝产品行为变化，而这正是本批唯一被允许"不变"的东西。
 * 2. **可点标记早于任何预取**：`boot.welcomeInteractive` 必须先于 `loadProjectView()` /
 *    `prefetchProjectPlugins()` 出现——boot-probe 断言②以该标记为界切"可点前的网络请求"，
 *    标记之前飞出去的 Monaco 请求会直接把硬断言打成红。
 *
 * 外加两条名单闸：注册顺序逐字冻结（PITFALLS 105 的教训＝次序与展开时机同轴），
 * 以及两个水位订阅不许留在开机那一趟（插件没在场时 `tryGet` 是 undefined，订不上）。
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');
const appSrc = read('packages/app/src/ui/App.tsx');
// REF-FRONT-PERF：openProject 整体搬进 use-project-session.ts。判据不搬家就失效——
// 这里把「注册 / 撤预取 / open 的相对次序」追到新文件，App 侧改钉「确实委托给该 hook」。
const sessionSrc = read('packages/app/src/ui/use-project-session.ts');
const bootstrapSrc = read('packages/app/src/bootstrap.ts');

/** 第 n 次出现的位置（找不到就抛，免得 -1 参与比较变成假绿） */
function nthIndex(src: string, needle: string, n = 1): number {
  let i = -1;
  for (let k = 0; k < n; k++) {
    i = src.indexOf(needle, i + 1);
    if (i < 0) throw new Error(`找不到第 ${n} 处「${needle}」`);
  }
  return i;
}

describe('PS-10 次序契约（注册早于开项目 / 标记早于预取）', () => {
  it('openProject：先注册项目级插件，再 open()，且开项目入口先撤预取防', () => {
    const cancel = nthIndex(sessionSrc, 'cancelPrefetchRef.current?.()');
    const ensure = nthIndex(sessionSrc, 'await ensureProjectPlugins(kernel)');
    const open = nthIndex(sessionSrc, 'await kernel.project.open(dir)');
    expect(cancel).toBeLessThan(ensure);
    expect(ensure).toBeLessThan(open);
    // 只有项目生命周期 hook 会注册项目级插件（别的入口不许另起一套时机）
    expect(sessionSrc.match(/await ensureProjectPlugins\(kernel\)/g)?.length).toBe(1);
    expect(appSrc.match(/await ensureProjectPlugins\(kernel\)/g)).toBeNull();
    // App 那一趟 bootstrap 进口里必须有开机预取，且**绝不能**有项目级注册（那条进口在 hook 里）。
    // ⚠ 判据形态改过（LAU-1a，2026-10-25）：原样是一条整串字面量
    //   `import { bootstrapKernel, prefetchProjectPlugins } from '../bootstrap';`，
    //   而 LAU-1a 把"2.0 事实按项目取"的端口也收在组合根 ⇒ App 的进口名表合法地变长、
    //   并被 Prettier 折成多行。整串比对会把**设计内的加名字**判成违规，故改成对进口形状取证：
    //   ① 只此一枚来自 '../bootstrap' 的进口（不许另起第二处）；② 内含这两个开机必需的名字；
    //   ③ 内含 `ensureProjectPlugins`  ⇒ 红（那正是这条用例的本体）。
    const appBootstrapImports = [...appSrc.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/bootstrap'/g)]
      .map((m) => m[1]!)
      .map((names) => names.split(',').map((n) => n.trim()).filter((n) => n !== ''));
    expect(appBootstrapImports.length, 'App 只能有一枚来自 ../bootstrap 的进口').toBe(1);
    const appBootstrapNames = appBootstrapImports[0] ?? [];
    expect(appBootstrapNames).toContain('bootstrapKernel');
    expect(appBootstrapNames).toContain('prefetchProjectPlugins');
    expect(
      appBootstrapNames.filter((n) => n === 'ensureProjectPlugins'),
      '项目级注册的进口必须留在 use-project-session，不许进 App',
    ).toEqual([]);
    expect(sessionSrc).toContain("import { ensureProjectPlugins } from '../bootstrap';");
    // App 确实委托给 hook（而不是偷偷留了第二份 openProject）
    expect(appSrc).toContain('useProjectSession({');
    expect(appSrc).not.toContain('await kernel.project.open(dir)');
    expect(appSrc).not.toContain('cancelPrefetchRef.current?.()');
  });

  it('欢迎页：boot.welcomeInteractive 早于任何编辑器图预取', () => {
    const mark = nthIndex(appSrc, "perf.bootMark('boot.welcomeInteractive'");
    expect(mark).toBeLessThan(nthIndex(appSrc, 'void loadProjectView()'));
    expect(mark).toBeLessThan(nthIndex(appSrc, 'void prefetchProjectPlugins()'));
  });

  it('预取只认意图：无点击不预取；反空匹配自证由探针模拟一次 pointerdown', () => {
    expect(appSrc).toContain(`const WELCOME_OPEN_INTENT_SELECTOR = '.welcome-recent, .welcome-resume'`);
    // 2026-10-25 性能批：无人兜底预取已删（真壳实测它在欢迎页可点后顶出 54ms / 106ms 长任务）
    expect(appSrc).not.toMatch(/PREFETCH_FALLBACK_MS/);
    expect(appSrc).not.toContain('fallbackTimer');
    expect(appSrc).not.toContain('requestIdleCallback(fire');
    // 意图触发面确实挂在 pointerdown 上（不是只留了个常量）
    expect(appSrc).toContain("window.addEventListener('pointerdown', onPointer, true)");
    expect(appSrc).toContain('target.closest(WELCOME_OPEN_INTENT_SELECTOR)');
    // 取证侧：boot-probe 必须自己派发合成 pointerdown（否则「可点后见得到 monaco」无法自证），
    // 且意图选择器从 smoke-lib 的类名单源拼出来（welcome-recent-selector 守卫禁止手抄类名）
    const probeSrc = read('tools/boot-probe.mjs');
    expect(probeSrc).toContain("new PointerEvent('pointerdown'");
    expect(probeSrc).toContain("import { WELCOME_RECENT_CLASSES, resumeOpenRowSel } from './smoke-lib.mjs'");
    expect(probeSrc).toContain('WELCOME_INTENT_SELECTOR = `.${WELCOME_RECENT_CLASSES.section}, ${resumeOpenRowSel}`');
  });

  it('项目级插件注册次序逐字冻结（拆分只改时机，不改名单与顺序）', () => {
    const expected = [
      // 第三个 adapter（eraFL，2026-10-24 批）。与 eraAkumaMaid 同理走项目级：它在欢迎页
      // 没有任何贡献面，而 `ensureProjectPlugins` 已保证它在 `project.open()` 之前入场。
      // `FLconfig.xml` 特征与另两个 adapter 无交集 ⇒ 谁排前面都不影响 detect 裁决。
      'createEraflAdapterPlugin',
      // 第二个 adapter（eraAkumaMaid，2026-10-18 批）。排首位不是"顺手放前面"：
      // `ensureProjectPlugins` 在 `kernel.project.open()` 之前注册全部项目级插件，而
      // 内核的 detect / loadProject 在 open 里就跑——adapter 晚一刻入场就轮不到它认目录。
      // 与 eraTW 的 detect 判据无交集（主路由 + CHARA CSV），两者次序不影响判定。
      'createErakumamaidAdapterPlugin',
      // 第四个 adapter（era紅魔館，2026-10-25 批）。同样走项目级：欢迎页无贡献面，
      // 且 `CSV/GameBase.csv` 标题是唯一强特征（与 eraFL 的 `ERB/口上` 目录不冲突）。
      'createKoumakanAdapterPlugin',
      // 第五个 adapter（eraSQC，2026-10-25 批）。同样走项目级；`CSV/GameBase.csv`
      // 标题是唯一强特征（与 eraAkumaMaid 的 `ERB/EVENT_K` 目录不冲突）。
      'createErasqcAdapterPlugin',
      // 第六个 adapter（eratohoK，2026-10-25 批）。同样走项目级；`CSV/GameBase.csv`
      // 标题是唯一强特征（与 eraFL / era紅魔館 的 `ERB/口上` 目录不冲突）。
      'createTohokAdapterPlugin',
      // 第七个 adapter（eraAV，2026-10-26 批，P0+P1）。同样走项目级：欢迎页无贡献面。
      // detect 三件套（`ERB/Lines` 目录 + `ERB/EVENT/EVENT_K.ERB` 文件 + GameBase 标题）
      // 与另六家实测零交集——最险的一处是 eraAkumaMaid 的主路由**同名** `EVENT_K.ERB`，
      // 本作靠父目录不同（`ERB/EVENT` vs `ERB/EVENT_K`）区分，故次序不参与判定。
      'createEraavAdapterPlugin',
      // 第八个 adapter（eratohoReverse，2026-10-26 批，P0+P1）。同样走项目级；
      // `CSV/GameBase.csv` 标题（真盘含西里尔 Я）是唯一强特征，
      // `ERB/口上/EVENT_K.ERB` 与 eraAV 的 `ERB/EVENT/EVENT_K.ERB` 靠父目录分开。
      'createEratohoreverseAdapterPlugin',
    ];
    // 适配器的名单与次序搬进**单一清单**（`src/adapter-manifest.ts`）：这里逐字钉住它。
    const manifest = projectAdapters();
    expect(manifest.map((e) => e.factory)).toEqual(expected);
    // 组合根不再逐个 import 适配器——清单是唯一入口（漏改一处＝这里红）
    expect(bootstrapSrc).toContain('projectAdapters()');
    expect(bootstrapSrc).not.toMatch(/import\('@kojo\/plugin-era[a-z]*-adapter'\)/);
    expect(bootstrapSrc).toContain('createAdapterPlugin(entry, adapterModules[idx]!)');
  });

  it('非适配器的项目级插件次序逐字冻结（拆分只改时机，不改名单与顺序）', () => {
    const expected = [
      'createConventionLinterPlugin',
      'createConditionExtractorPlugin',
      'createSavParserPlugin',
      'createStateReplayPlugin',
      'createKojoSugarPlugin',
      // Kojo 语言面插件（B2，2026-10-24）。位置紧随 sugar：两者都是"语言层"，
      // 且本插件零 require（判据全在 `@kojo/kojo-lang`），次序不参与激活判定。
      'createKojoLangPlugin',
      // LAU-4 第一步：ERB 语言面插件（高亮 / 扩选两条腿的供方）紧随 kojo 语言插件之后装配。
      'createErbLangPlugin',
      'createUiStatusPlugin',
      'createUiConventionReportPlugin',
      'createUiKojoNavigatorPlugin',
      'createUiConditionMatrixPlugin',
      'createUiStateReplayPlugin',
      'createUiArchiveBrowserPlugin',
      'createUiSnapshotInjectorPlugin',
      'createUiSugarLiftPlugin',
      'createUiSugarPreviewPlugin',
      'createUiSugarEditorPlugin',
      'createKojoMarketPlugin',
      'createUiMarketPlugin',
      // 口上 XML 面板（2026-10-24 eraFL 批）。末位＝追加，不插队：
      // 它的 `tryInject` 取 `kojo.xml` 服务，缺席时面板自己降级，次序不参与判定。
      'createUiKojoXmlPlugin',
      // 内联补全（幽灵文本）本地候选源（2026-10-27 IC-B 批）。同样末位追加：它只往槽
      // `completion.source` 挂一家供方，`tryInject` 取 `erb.parser` 的名录，缺席时整家
      // 走 `failed` 出声（不静默），次序与"谁赢"无关——槽内先后由各贡献自己的 `order` 定。
      'createInlineCompletionLocalPlugin',
    ];
    // 工厂调用可能包在条件装配里（LAU-3b：kojo1 插件族 `...(x === null ? [] : [x.create…()])`），
    // 所以这里按**装载器函数体**取调用名，不再要求调用出现在行首。
    const loaderBody = bootstrapSrc.slice(
      nthIndex(bootstrapSrc, 'async function loadProjectPlugins'),
      nthIndex(bootstrapSrc, 'function loadProjectPluginsOnce'),
    );
    const found = [...loaderBody.matchAll(/[\w.]+\.(create[A-Za-z]+Plugin)\(/g)].map((m) => m[1]!);
    expect(found).toEqual(expected);
    // 动态 import 的模块次序与工厂次序同一份名单（一一对应，不许多不许少）。
    // 只看**项目级装载器**本体：bootstrap 里还有「用户显式打开才装」的懒边
    //（L5 起 `ensureLauncherPlugin` 装 `launcher-core`），它不在项目级名单里，
    // 其「声明插件全集 ⊆ 动态名单」那条覆盖判据由 ps10-eager-graph 单独钉。
    const loaderSrc = bootstrapSrc.slice(
      nthIndex(bootstrapSrc, 'async function loadProjectPlugins'),
      nthIndex(bootstrapSrc, 'function loadProjectPluginsOnce'),
    );
    const dyn = [...loaderSrc.matchAll(/import\('@kojo\/plugin-([^']+)'\)/g)].map((m) => m[1]!);
    expect(dyn.length).toBe(expected.length);
  });

  it('两个服务水位接在项目级注册之后，不在开机那一趟（订不上不等于没值）', () => {
    const probe = bootstrapSrc.slice(nthIndex(bootstrapSrc, 'function installPerfProbe(kernel: Kernel)'));
    const probeBody = probe.slice(0, probe.indexOf('\n}\n'));
    expect(probeBody).not.toContain('ConditionExtractor');
    expect(probeBody).not.toContain('ConventionLinter');
    const attach = nthIndex(bootstrapSrc, 'function attachProjectPluginWatermarks');
    expect(attach).toBeGreaterThan(0);
    // 由 ensureProjectPlugins 在注册循环之后调用
    const ensureBody = bootstrapSrc.slice(nthIndex(bootstrapSrc, 'export function ensureProjectPlugins'), attach);
    expect(ensureBody).toContain('attachProjectPluginWatermarks(kernel)');
  });
});
