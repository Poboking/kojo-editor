/**
 * K2-PROJECT-WIRE · 2.0 项目级扫描的**惰性 adapter 接线**判据闸。
 *
 * 钉四组事：
 * 1. `resolveKojo2ProjectAdapter` / `analyzeKojo2ProjectAsync` 的解析语义：直接事实、惰性
 *    getter（同步 / 异步）、每个 getter 只求值一次、失败（抛 / 拒绝 / undefined）折成
 *    `unavailable` 而**不 reject**、失败读数只报一次。
 * 2. 失败降级：分析照常跑（跨文件结论仍在）、`stats.adapterUnavailable = true`、织面退回
 *    `analyzeProject`（`weaveLayers:false`、`weaveUnits:[]`），未配置 adapter 不算失败。
 * 3. `createLazyKojo2ProjectOptions` / `installKojo2ProjectScan`：工厂零副作用、flag 关零动作、
 *    装载器成功/失败两态、缺省装载器 = "本轮拿不到"（LAU-1a：本文件零适配器 import，
 *    装载目标由宿主按当前项目注入）。
 * 4. 扫描器透传：`MountProjectScanOptions.kojo2Project` 原样进 `scannerDeps`；
 *    `kojo2ProjectFactory` 每次 `armProject` 新建装配面（换项目 ⇒ 新 getter ⇒ 重解析）；
 *    端到端一轮里惰性 adapter 成功 ⇒ 织面读数与项目级问题都上账，失败 ⇒ 整轮不崩、v1 照旧、降级可见。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameProject, LineDecoration } from '@kojo/plugin-api';
import {
  analyzeKojo2Project,
  analyzeKojo2ProjectAsync,
  kojo2ProjectPassEnabled,
  resolveKojo2ProjectAdapter,
  type Kojo2ProjectAdapterFacts,
  type Kojo2ProjectAdapterGetter,
  type Kojo2ProjectDocument,
  type Kojo2ProjectPassOptions,
} from '../src/ui/kojo2-project-analysis';
import {
  createLazyKojo2ProjectOptions,
  installKojo2ProjectScan,
} from '../src/ui/kojo2-project-scan-adapter';
import { createProjectScanner, type ProjectScannerDeps } from '../src/ui/project-diagnostics';
import { mountProjectScan, type ScanKernel } from '../src/ui/project-scan-schedule';
import { clearAllProblems, clearProjectScan, type EditorProblem } from '../src/ui/problem-store';

/* ============================== 夹具 ============================== */

const ROOT = 'D:/kojo2-wire';
const A = `${ROOT}/a.kojo2`;
const B = `${ROOT}/b.kojo2`;
const C = `${ROOT}/c.kojo`;

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const doc = (filePath: string, lines: readonly string[]): Kojo2ProjectDocument => ({
  path: filePath,
  text: lines.join('\n'),
});

/** 跨文件同名的两份 `@函`（无 adapter 也能判出 duplicate-name） */
const DUP_A = doc(A, ['@函 共同()', '    @返 1']);
const DUP_B = doc(B, ['@函 共同()', '    @返 2']);

/** 同事件两枚「接管」（adapter 在时由 analyzeWeaveLayers 判 multiple-only） */
const TAKEOVER_A = doc(A, ['@织 回合末 接管', '    > 甲。']);
const TAKEOVER_B = doc(B, ['@织 回合末 接管', '    > 乙。']);

/** 最小 adapter 事实（与 core `WeaveLayerAdapterFacts` 同形；不真装载插件包） */
const ADAPTER: Kojo2ProjectAdapterFacts = {
  eventCatalog: { events: [{ event: '回合末', priority: 'emuera-buckets' }] },
  layerPolicy: {
    defaultMode: 'unique',
    rules: [{ target: 'function', mode: 'unique' }],
  },
};

const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

const deco = (line: number): LineDecoration => ({
  line,
  severity: 'error',
  message: '结构不闭合',
  code: 'fake.structure',
});

const structuralContributor = {
  id: 'structure',
  decorate: ({ text }: { text: string }): LineDecoration[] =>
    text.includes('BAD') ? [deco(1)] : [],
};

/** 装配面上的 adapter 是加法联合：测试要调它时先窄化（不是事实对象才可调用） */
const lazyOf = (options: Kojo2ProjectPassOptions): Kojo2ProjectAdapterGetter => {
  const adapter = options.adapter;
  if (typeof adapter !== 'function') throw new Error('期望惰性 adapter getter');
  return adapter;
};

afterEach(() => {
  vi.restoreAllMocks();
  clearAllProblems();
  clearProjectScan();
});

/* ============================== 1. 解析语义 ============================== */

describe('resolveKojo2ProjectAdapter · 事实 / 惰性 / 失败三态', () => {
  it('直接给事实：原样交出、lazy=false、unavailable=false', async () => {
    await expect(resolveKojo2ProjectAdapter(ADAPTER)).resolves.toEqual({
      facts: ADAPTER,
      unavailable: false,
      reason: null,
      lazy: false,
    });
  });

  it('未配置：facts undefined 且 unavailable=false（缺席 ≠ 失败）', async () => {
    await expect(resolveKojo2ProjectAdapter(undefined)).resolves.toEqual({
      facts: undefined,
      unavailable: false,
      reason: null,
      lazy: false,
    });
  });

  it('同步 getter：await 一次拿到事实（lazy=true，只调一次）', async () => {
    const getter = vi.fn(() => ADAPTER);
    const resolution = await resolveKojo2ProjectAdapter(getter);
    expect(resolution).toEqual({ facts: ADAPTER, unavailable: false, reason: null, lazy: true });
    expect(getter).toHaveBeenCalledTimes(1);
  });

  it('异步 getter：同一个实例并发两次也只求值一次（缓存命中同一份读数对象）', async () => {
    const getter = vi.fn(async () => ADAPTER);
    const [first, second] = await Promise.all([
      resolveKojo2ProjectAdapter(getter),
      resolveKojo2ProjectAdapter(getter),
    ]);
    expect(getter).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('getter 抛错：归一成 unavailable + reason，不 reject', async () => {
    const resolution = await resolveKojo2ProjectAdapter(() => {
      throw new Error('接线炸了');
    });
    expect(resolution).toMatchObject({ facts: undefined, unavailable: true, reason: '接线炸了', lazy: true });
  });

  it('getter 返回拒绝的 Promise：同样归一成 unavailable', async () => {
    const resolution = await resolveKojo2ProjectAdapter(() => Promise.reject(new Error('插件不在')));
    expect(resolution).toMatchObject({ facts: undefined, unavailable: true, reason: '插件不在' });
  });

  it('getter 返回 undefined：unavailable（原因点名不是沉默）', async () => {
    const resolution = await resolveKojo2ProjectAdapter(() => undefined);
    expect(resolution).toMatchObject({ facts: undefined, unavailable: true, lazy: true });
    expect(resolution.reason).toContain('undefined');
  });

  it('失败读数只报一次：同一条 getter 第二次不再叫 onUnavailable', async () => {
    const onUnavailable = vi.fn();
    const getter = (): never => {
      throw new Error('adapter 缺席');
    };
    const first = await resolveKojo2ProjectAdapter(getter, onUnavailable);
    const second = await resolveKojo2ProjectAdapter(getter, onUnavailable);
    expect(first.unavailable).toBe(true);
    expect(second.unavailable).toBe(true);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledWith('adapter 缺席');
  });
});

/* ============================== 2. 异步分析的 await 分支 ============================== */

describe('analyzeKojo2ProjectAsync · 惰性 adapter 成功与降级', () => {
  it('惰性 getter 成功：织面走 analyzeWeaveLayers，adapterUnavailable=false', async () => {
    const result = await analyzeKojo2ProjectAsync({
      documents: [TAKEOVER_A, TAKEOVER_B],
      adapter: async () => ADAPTER,
    });
    expect(result.stats.weaveLayers).toBe(true);
    expect(result.stats.adapterUnavailable).toBe(false);
    expect(result.stats.layerConflicts).toBe(1);
    expect(result.problems.map((problem) => problem.code)).toContain('core/weave/multiple-only');
  });

  it('getter 拒绝：跨文件结论照常、adapterUnavailable=true、织面退回且只剩一条可见读数', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await analyzeKojo2ProjectAsync({
      documents: [DUP_A, DUP_B],
      adapter: () => Promise.reject(new Error('装载失败')),
    });
    expect(result.problems.map((problem) => problem.code)).toContain('core/decl/duplicate-name');
    expect(result.stats.adapterUnavailable).toBe(true);
    expect(result.stats.weaveLayers).toBe(false);
    expect(result.weaveUnits).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('装载失败');
  });

  it('getter 返回 undefined：同样降级，不炸也不静默', async () => {
    const onUnavailable = vi.fn();
    const result = await analyzeKojo2ProjectAsync({
      documents: [DUP_A, DUP_B],
      adapter: () => undefined,
      onAdapterUnavailable: onUnavailable,
    });
    expect(result.stats.adapterUnavailable).toBe(true);
    expect(result.problems.map((problem) => problem.code)).toContain('core/decl/duplicate-name');
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('没配 adapter：adapterUnavailable=false（未配置不是失败）', async () => {
    const result = await analyzeKojo2ProjectAsync({ documents: [DUP_A, DUP_B] });
    expect(result.stats.adapterUnavailable).toBe(false);
    expect(result.stats.weaveLayers).toBe(false);
  });

  it('同步入口恒 adapterUnavailable=false（两个入口的统计形状一致）', () => {
    const result = analyzeKojo2Project({ documents: [DUP_A, DUP_B] });
    expect(result.stats.adapterUnavailable).toBe(false);
  });

  it('同一个 getter 跨两轮只求值一次（缓存：扫描器每轮重跑不重复装载）', async () => {
    const getter = vi.fn(async () => ADAPTER);
    const first = await analyzeKojo2ProjectAsync({ documents: [TAKEOVER_A], adapter: getter });
    const second = await analyzeKojo2ProjectAsync({ documents: [TAKEOVER_B], adapter: getter });
    expect(getter).toHaveBeenCalledTimes(1);
    expect(first.stats.weaveLayers).toBe(true);
    expect(second.stats.weaveLayers).toBe(true);
    expect(second.stats.adapterUnavailable).toBe(false);
  });

  it('注入 onAdapterUnavailable：优先于 console.warn，且缓存后不重复叫', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onUnavailable = vi.fn();
    const getter = (): never => {
      throw new Error('动态装载失败');
    };
    await analyzeKojo2ProjectAsync({ documents: [DUP_A], adapter: getter, onAdapterUnavailable: onUnavailable });
    await analyzeKojo2ProjectAsync({ documents: [DUP_B], adapter: getter, onAdapterUnavailable: onUnavailable });
    expect(warn).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledWith('动态装载失败');
  });

  it('默认读数（console.warn）只出现一次：第二轮命中缓存不再刷屏', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getter = (): never => {
      throw new Error('只报一次');
    };
    await analyzeKojo2ProjectAsync({ documents: [DUP_A], adapter: getter });
    await analyzeKojo2ProjectAsync({ documents: [DUP_B], adapter: getter });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('只报一次');
  });

  it('惰性事实与直接事实：判定结果逐条相同（只是来路不同）', async () => {
    const direct = analyzeKojo2Project({ documents: [TAKEOVER_A, TAKEOVER_B], adapter: ADAPTER });
    const lazy = await analyzeKojo2ProjectAsync({
      documents: [TAKEOVER_A, TAKEOVER_B],
      adapter: () => ADAPTER,
    });
    expect(lazy.problems).toEqual(direct.problems);
    expect(lazy.weaveUnits).toEqual(direct.weaveUnits);
    expect(lazy.stats.adapterUnavailable).toBe(false);
  });
});

/* ============================== 3. 薄接线工厂 ============================== */

describe('createLazyKojo2ProjectOptions / installKojo2ProjectScan', () => {
  it('缺省启用判据 = 既有 2.0 诊断开关（node 无 window ⇒ 关）', () => {
    const options = createLazyKojo2ProjectOptions();
    expect(options.enabled?.()).toBe(false);
    expect(kojo2ProjectPassEnabled(options)).toBe(false);
  });

  it('工厂本身零副作用：创建时不装载、不调 isEnabled', () => {
    const load = vi.fn(async () => ADAPTER);
    const isEnabled = vi.fn(() => true);
    const options = createLazyKojo2ProjectOptions({ isEnabled, loadAdapter: load });
    expect(load).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled();
    expect(kojo2ProjectPassEnabled(options)).toBe(true);
    expect(isEnabled).toHaveBeenCalledTimes(1);
  });

  it('惰性 getter：成功装载一次并缓存（两次调用同一份事实）', async () => {
    const load = vi.fn(async () => ADAPTER);
    const options = createLazyKojo2ProjectOptions({ isEnabled: () => true, loadAdapter: load });
    const adapter = lazyOf(options);
    const [first, second] = await Promise.all([adapter(), adapter()]);
    expect(first).toBe(ADAPTER);
    expect(second).toBe(ADAPTER);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('装载器拒绝 ⇒ getter 交 undefined（接线层不抛）', async () => {
    const options = createLazyKojo2ProjectOptions({
      isEnabled: () => true,
      loadAdapter: async () => {
        throw new Error('插件不在');
      },
    });
    await expect(lazyOf(options)()).resolves.toBeUndefined();
  });

  it('装载器同步抛错 ⇒ 同样交 undefined（失败形态只有一种）', async () => {
    const options = createLazyKojo2ProjectOptions({
      isEnabled: () => true,
      loadAdapter: () => {
        throw new Error('模块求值就炸');
      },
    });
    await expect(lazyOf(options)()).resolves.toBeUndefined();
  });

  it('缺省装载器（未注入 loadAdapter）＝"本轮拿不到"：getter 交 undefined，不取任何游戏的事实', async () => {
    // LAU-1a：旧实现在这里无条件动态 import eraTW——打开任何盘 2.0 扫描都吃它的事实。
    // 现在缺省即缺席：分析器会把它折成 `stats.adapterUnavailable` 的可见降级。
    const options = createLazyKojo2ProjectOptions({ isEnabled: () => true });
    await expect(lazyOf(options)()).resolves.toBeUndefined();
  });

  it('按项目注入的装载器（宿主生产口径的替身）：eraFL 项目拿到 eraFL 事实，绝不落回 eraTW', async () => {
    const { kojo2AdapterForProject, registerKojo2Adapter } = await import('../src/bootstrap');
    const erafl = await import('@kojo/plugin-erafl-adapter');
    const eraTW = await import('@kojo/plugin-eratw-adapter');
    registerKojo2Adapter(erafl.ERAFL.gameId, erafl.ERAFL_GAME_ADAPTER);
    const load = vi.fn(async () => kojo2AdapterForProject({ adapterId: 'erafl' }) ?? undefined);
    const options = createLazyKojo2ProjectOptions({ isEnabled: () => true, loadAdapter: load });
    const facts = await lazyOf(options)();
    expect(facts).toBe(erafl.ERAFL_GAME_ADAPTER);
    expect(facts).not.toBe(eraTW.ERATW_GAME_ADAPTER);
    // 没有 2.0 面的项目 ⇒ undefined（同一装载器、同一口径，不借表）
    const loadNoSurface = vi.fn(
      async () => kojo2AdapterForProject({ adapterId: 'eraakumamaid' }) ?? undefined,
    );
    const degraded = createLazyKojo2ProjectOptions({ isEnabled: () => true, loadAdapter: loadNoSurface });
    await expect(lazyOf(degraded)()).resolves.toBeUndefined();
  });

  it('installKojo2ProjectScan：返回可直接摊进 mountProjectScan 的一格，可注入 flag / loader', async () => {
    const load = vi.fn(async () => ADAPTER);
    const wiring = installKojo2ProjectScan({ isEnabled: () => true, loadAdapter: load });
    expect(Object.keys(wiring)).toEqual(['kojo2Project']);
    expect(kojo2ProjectPassEnabled(wiring.kojo2Project)).toBe(true);
    await expect(lazyOf(wiring.kojo2Project)()).resolves.toBe(ADAPTER);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('源码：本接线文件零适配器 import（连动态边与豁免标记都不该有）', () => {
    const source = read('packages/app/src/ui/kojo2-project-scan-adapter.ts');
    expect(source).not.toMatch(/@kojo\/plugin-[a-z0-9-]+-adapter/);
    expect(source).not.toMatch(/audit-allow/);
    expect(source).not.toMatch(/eratw|erafl/i);
    // 接线文件不许被调度器静态拉进来（否则装配面工厂白设）：只允许 type import。
    const schedule = read('packages/app/src/ui/project-scan-schedule.ts');
    expect(schedule).not.toMatch(/from\s+['"]\.\/kojo2-project-scan-adapter['"]/);
  });
});

/* ============================== 4. 扫描器装配与端到端 ============================== */

interface ScanHarness {
  readonly out: Awaited<ReturnType<ReturnType<typeof createProjectScanner>['run']>>;
  readonly published: Map<string, readonly EditorProblem[]>;
  readonly reads: string[];
}

async function runScan(opts: {
  files: Record<string, string>;
  kojo2Project?: Kojo2ProjectPassOptions;
}): Promise<ScanHarness> {
  const published = new Map<string, readonly EditorProblem[]>();
  const reads: string[] = [];
  const scanner = createProjectScanner({
    listFiles: () => Object.keys(opts.files),
    roots: () => [ROOT],
    project: () => null,
    contributors: () => [structuralContributor],
    readFile: async (filePath) => {
      reads.push(filePath);
      const text = opts.files[filePath];
      if (text === undefined) throw new Error(`ENOENT ${filePath}`);
      return text;
    },
    publish: (filePath, problems) => {
      published.set(filePath, problems);
    },
    perBatch: 8,
    maxFiles: 0,
    ...(opts.kojo2Project === undefined ? {} : { kojo2Project: opts.kojo2Project }),
  });
  return { out: await scanner.run(), published, reads };
}

describe('扫描器透传 · mountProjectScan → scannerDeps → 采集器', () => {
  const project = {
    rootDir: 'D:/kojo2-wire',
    adapterId: 'eratw',
    kojoPaths: [ROOT],
    charaIndex: new Map(),
  } as unknown as GameProject;

  const mountWith = (
    kojo2Project: Kojo2ProjectPassOptions | undefined,
  ): { deps: ProjectScannerDeps; dispose: () => void } => {
    let captured: ProjectScannerDeps | null = null;
    const kernel = {
      bus: { on: () => () => {} },
      io: {
        readText: async () => ({ text: '', encoding: 'utf-8', eol: 'lf', mtimeMs: 0 }),
        walkDir: async () => [],
      },
      slots: { query: () => [] },
      services: { tryGet: () => undefined },
      project: { current: () => project },
      compute: { yieldToMain: async () => {} },
      workspaces: { roots: () => [] },
    } as unknown as ScanKernel;
    const handle = mountProjectScan({
      kernel,
      ...(kojo2Project === undefined ? {} : { kojo2Project }),
      createScanner: (deps) => {
        captured = deps;
        return createProjectScanner(deps);
      },
      // 不挂真定时器：本组只验装配，调度判据归 project-scan-schedule.test.ts
      schedule: () => () => {},
    });
    return { deps: captured!, dispose: () => handle.dispose() };
  };

  it('MountProjectScanOptions.kojo2Project 原样进 scannerDeps（同一对象，不复制）', () => {
    const options = createLazyKojo2ProjectOptions({ isEnabled: () => true, loadAdapter: async () => ADAPTER });
    const mounted = mountWith(options);
    try {
      expect(mounted.deps.kojo2Project).toBe(options);
    } finally {
      mounted.dispose();
    }
  });

  it('未装配时 scannerDeps 不带 kojo2Project（v1 路径零改动）', () => {
    const mounted = mountWith(undefined);
    try {
      expect(mounted.deps.kojo2Project).toBeUndefined();
    } finally {
      mounted.dispose();
    }
  });

  it('kojo2ProjectFactory：每次 armProject 新建装配面（换项目 ⇒ 新 getter ⇒ adapter 重解析）', () => {
    // LAU-1a 的换项目口径：装配面若跨项目共用一份，分析侧按 getter 实例缓存的 adapter
    // 事实会跟着上一个项目走——工厂形态让每次重装配拿到全新 getter。
    const built: Kojo2ProjectPassOptions[] = [];
    const factory = vi.fn((): Kojo2ProjectPassOptions => {
      const options = createLazyKojo2ProjectOptions({ isEnabled: () => true, loadAdapter: async () => ADAPTER });
      built.push(options);
      return options;
    });
    const handlers = new Map<string, (ev: unknown) => void>();
    const projectB = { ...project, rootDir: 'D:/kojo2-wire-b' } as unknown as GameProject;
    let current: GameProject | null = project;
    const kernel = {
      bus: {
        on: (ev: string, cb: (payload: unknown) => void) => {
          handlers.set(ev, cb);
          return () => handlers.delete(ev);
        },
      },
      io: {
        readText: async () => ({ text: '', encoding: 'utf-8', eol: 'lf', mtimeMs: 0 }),
        walkDir: async () => [],
      },
      slots: { query: () => [] },
      services: { tryGet: () => undefined },
      project: { current: () => current },
      compute: { yieldToMain: async () => {} },
      workspaces: { roots: () => [] },
    } as unknown as ScanKernel;
    const depsSeen: ProjectScannerDeps[] = [];
    const handle = mountProjectScan({
      kernel,
      kojo2ProjectFactory: factory,
      createScanner: (deps) => {
        depsSeen.push(deps);
        return createProjectScanner(deps);
      },
      schedule: () => () => {},
    });
    try {
      // 挂载补真相（项目已在场）⇒ 第一份装配面
      expect(factory).toHaveBeenCalledTimes(1);
      expect(depsSeen[0]?.kojo2Project).toBe(built[0]);
      // 换项目 ⇒ armProject 重装配 ⇒ 工厂再叫一次，装配面是新实例
      current = projectB;
      handlers.get('project.opened')?.({ project: projectB });
      expect(factory).toHaveBeenCalledTimes(2);
      expect(built[1]).not.toBe(built[0]);
      expect(depsSeen[1]?.kojo2Project).toBe(built[1]);
    } finally {
      handle.dispose();
    }
  });

  it('kojo2Project 与 kojo2ProjectFactory 同时给出时静态那份优先（additive 不退化旧消费方）', () => {
    const factory = vi.fn(() => createLazyKojo2ProjectOptions({ isEnabled: () => true }));
    const options = createLazyKojo2ProjectOptions({ isEnabled: () => true, loadAdapter: async () => ADAPTER });
    const captured: ProjectScannerDeps[] = [];
    const kernel = {
      bus: { on: () => () => {} },
      io: {
        readText: async () => ({ text: '', encoding: 'utf-8', eol: 'lf', mtimeMs: 0 }),
        walkDir: async () => [],
      },
      slots: { query: () => [] },
      services: { tryGet: () => undefined },
      project: { current: () => project },
      compute: { yieldToMain: async () => {} },
      workspaces: { roots: () => [] },
    } as unknown as ScanKernel;
    const handle = mountProjectScan({
      kernel,
      kojo2Project: options,
      kojo2ProjectFactory: factory,
      createScanner: (deps) => {
        captured.push(deps);
        return createProjectScanner(deps);
      },
      schedule: () => () => {},
    });
    try {
      expect(captured[0]?.kojo2Project).toBe(options);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      handle.dispose();
    }
  });

  it('端到端：惰性 adapter 成功 ⇒ 织面读数 + 项目级问题合并上账（一轮只装载一次）', async () => {
    const load = vi.fn(async () => ADAPTER);
    const options = createLazyKojo2ProjectOptions({ isEnabled: () => true, loadAdapter: load });
    const { out, published, reads } = await runScan({
      files: { [A]: TAKEOVER_A.text, [B]: TAKEOVER_B.text },
      kojo2Project: options,
    });
    expect(out.status).toBe('complete');
    expect(out.kojo2?.weaveLayers).toBe(true);
    expect(out.kojo2?.adapterUnavailable).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    expect(reads.slice().sort()).toEqual([A, B].sort());
    // 冲突 / 被压分别锚在各自该锚的文件上：这里只验"项目级结论确实进了同一上账通道"
    const codes = [...published.values()].flat().map((problem) => problem.code ?? '');
    expect(codes).toContain('core/weave/multiple-only');
  });

  it('端到端：惰性 adapter 失败 ⇒ 整轮不崩、v1 照旧、降级可见且不重复报', async () => {
    const onUnavailable = vi.fn();
    const options: Kojo2ProjectPassOptions = {
      ...createLazyKojo2ProjectOptions({
        isEnabled: () => true,
        loadAdapter: async () => {
          throw new Error('插件不在');
        },
      }),
      onAdapterUnavailable: onUnavailable,
    };
    const { out, published } = await runScan({
      files: { [A]: DUP_A.text, [B]: DUP_B.text, [C]: 'BAD' },
      kojo2Project: options,
    });
    expect(out.status).toBe('complete');
    expect(out.kojo2?.adapterUnavailable).toBe(true);
    expect(out.kojo2?.weaveLayers).toBe(false);
    expect(out.degraded).toBe(0);
    // v1 那一路（.kojo）照常上账；跨文件重名仍落在 B 上
    expect(published.get(C)).toHaveLength(1);
    expect(published.get(B)?.map((problem) => problem.code)).toContain('core/decl/duplicate-name');
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledWith('getter 返回 undefined');
  });

  it('开关关：连 `.kojo2` 判据都不调、adapter getter 零调用、读数保持 null', async () => {
    const load = vi.fn(async () => ADAPTER);
    const isKojo2 = vi.fn(() => true);
    const options: Kojo2ProjectPassOptions = {
      ...createLazyKojo2ProjectOptions({ isEnabled: () => false, loadAdapter: load }),
      isKojo2,
    };
    const { out, published } = await runScan({
      files: { [A]: TAKEOVER_A.text, [C]: 'BAD' },
      kojo2Project: options,
    });
    expect(out.kojo2).toBeNull();
    expect(isKojo2).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(published.get(A)).toHaveLength(0);
    expect(published.get(C)).toHaveLength(1);
  });
});
