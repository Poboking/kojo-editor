import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
    // App 只保留开机预取这一个 bootstrap 进口；项目级注册的进口在 hook 里
    expect(appSrc).toContain("import { bootstrapKernel, prefetchProjectPlugins } from '../bootstrap';");
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

  it('预取由空闲抢跑改成意图触发：意图选择器 + 兜底闸都在，且兜底赶在取证窗口之前', () => {
    expect(appSrc).toContain(`const WELCOME_OPEN_INTENT_SELECTOR = '.welcome-recent, .welcome-resume'`);
    const ms = appSrc.match(/const PREFETCH_FALLBACK_MS\s*=\s*([\d_]+)\s*;/)?.[1];
    expect(ms).toBeTruthy();
    const fallbackMs = Number(ms!.replace(/_/g, ''));
    // 下限：远晚于"开机就点最近项目"那一下（旧接线是空闲一帧就抢跑）
    expect(fallbackMs).toBeGreaterThanOrEqual(1_500);
    // 上限：**从探针源码现读**，不抄第二份数。`captureBootNetwork` 在采到可点标记后只等
    // `settleMs` 就切 Network 域读数，而它的反空匹配自证要求「可点之后看得见 monaco」；
    // 兜底晚于这个窗口 ⇒ 整轮 monaco 计数为 0 ⇒ `judgeNetwork` 判 unproven（断言②不可自证）。
    const probeSrc = read('tools/boot-probe.mjs');
    const settle = Number(probeSrc.match(/settleMs\s*=\s*([\d_]+)/)?.[1]);
    expect(settle, 'boot-probe 的 settleMs 默认值读不到，判据会退化成空匹配').toBeGreaterThan(0);
    // 两个调用方（smoke-tauri-dom / boot-marks）都没另传 settleMs ⇒ 默认值就是真窗口
    expect(probeSrc).not.toMatch(/captureBootNetwork\(\{[^}]*settleMs/s);
    expect(fallbackMs).toBeLessThan(settle);
    // 意图触发面确实挂在 pointerdown 上（不是只留了个常量）
    expect(appSrc).toContain("window.addEventListener('pointerdown', onPointer, true)");
    expect(appSrc).toContain('target.closest(WELCOME_OPEN_INTENT_SELECTOR)');
  });

  it('项目级插件注册次序逐字冻结（拆分只改时机，不改名单与顺序）', () => {
    const expected = [
      // 第二个 adapter（eraAkumaMaid，2026-10-18 批）。排首位不是"顺手放前面"：
      // `ensureProjectPlugins` 在 `kernel.project.open()` 之前注册全部项目级插件，而
      // 内核的 detect / loadProject 在 open 里就跑——adapter 晚一刻入场就轮不到它认目录。
      // 与 eraTW 的 detect 判据无交集（主路由 + CHARA CSV），两者次序不影响判定。
      'createErakumamaidAdapterPlugin',
      'createConventionLinterPlugin',
      'createConditionExtractorPlugin',
      'createSavParserPlugin',
      'createStateReplayPlugin',
      'createKojoSugarPlugin',
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
    ];
    const found = [...bootstrapSrc.matchAll(/(?:^|\n)\s*[\w.]+.(create[A-Za-z]+Plugin)\(/g)].map((m) => m[1]!);
    expect(found).toEqual(expected);
    // 动态 import 的模块次序与工厂次序同一份名单（一一对应，不许多不许少）
    const dyn = [...bootstrapSrc.matchAll(/import\('@kojo\/plugin-([^']+)'\)/g)].map((m) => m[1]!);
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
