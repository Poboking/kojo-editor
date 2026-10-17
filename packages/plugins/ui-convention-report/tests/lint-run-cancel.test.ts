/**
 * 叫停那一手（ZH-F4b）在 `lint-run` 这一层的形状。
 *
 * 只钉三件事，全都不依赖 DOM：
 * ① 取消位由 `store` 铸造、原样交给 `linter.run`，面板与命令按的是**同一枚**；
 * ② "这一轮不完整"只由引擎在报告上说 (`report.incomplete`)——服务不理取消位、真把整轮
 *    跑完时，读数必须说"跑完了"，UI 不许自己猜；
 * ③ 被叫停那一档的文案与"跑坏/跑完"互不相同，数字来自桩返回的那份报告（反恒真）。
 */
import { describe, expect, it } from 'vitest';
import type {
  ConventionLinterService,
  ConventionReport,
  EditorCommandContribution,
  ErbParserService,
  GameProject,
  Logger,
  Plugin,
  PluginContext,
  SlotRegistry,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import {
  LINT_PROJECT_COMMAND_ID,
  LINT_STOP_COMMAND_ID,
  LINT_STOP_COMMAND_TITLE,
  createLintRunStore,
  driveLintRun,
  lintRunBrief,
  lintRunText,
} from '../src/lint-run';
import { createUiConventionReportPlugin } from '../src/index';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function halfReport(over: Partial<ConventionReport> = {}): ConventionReport {
  return {
    adapterId: 'test',
    startedAt: 1_000,
    finishedAt: 3_000,
    durationMs: 2_000,
    issues: [
      { ruleId: 'r.a', severity: 'error', message: 'x', filePath: '/p/a.ERB', line: 1 },
      { ruleId: 'r.a', severity: 'warning', message: 'y', filePath: '/p/b.ERB', line: 2 },
    ],
    counts: { error: 1, warning: 1, info: 0 },
    ruleCount: 2,
    failedRules: [],
    incomplete: { unitsDone: 12, unitsTotal: 20 },
    ...over,
  };
}

/** 记取消位的桩校验器：`honoursCancel` = false 时它压根不看那枚 signal（第三方实现照样能用） */
function stubLinter(
  result: ConventionReport,
  seen: Array<{ force?: boolean; signal?: AbortSignal }>,
  gate?: Promise<void>,
): ConventionLinterService {
  return {
    async run(opts) {
      seen.push({ ...(opts?.force !== undefined ? { force: opts.force } : {}), ...(opts?.signal ? { signal: opts.signal } : {}) });
      if (gate) await gate;
      return result;
    },
    report: () => result,
    subscribe: () => () => {},
    rules: () => [],
  };
}

describe('取消位归 store 管', () => {
  it('driveLintRun 把 store 交出的那一枚原样交给 linter.run；cancel() 按的就是它', async () => {
    const seen: Array<{ force?: boolean; signal?: AbortSignal }> = [];
    const store = createLintRunStore();
    const p = driveLintRun({ linter: stubLinter(halfReport(), seen), store, coveredFiles: () => 20 });
    expect(seen).toHaveLength(1);
    const signal = seen[0]!.signal;
    expect(signal, '取消位没交给引擎').toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);

    store.cancel();
    expect(signal!.aborted).toBe(true);
    await p;
    // 两次叫停只按同一枚（不许造第二次收摊）
    const store2 = createLintRunStore();
    const seen2: Array<{ signal?: AbortSignal }> = [];
    const p2 = driveLintRun({ linter: stubLinter(halfReport(), seen2), store: store2, coveredFiles: () => 3 });
    store2.cancel();
    store2.cancel();
    await p2;
    expect(seen2[0]!.signal!.aborted).toBe(true);
  });

  it('不在跑的时候叫停 = 空操作（状态一个字都不动）', () => {
    const store = createLintRunStore();
    const before = store.get();
    store.cancel();
    expect(store.get()).toBe(before);
    expect(store.get().phase).toBe('idle');
  });

  it('引擎说这一轮不完整 ⇒ phase 落到被叫停那一档，数字取自报告（不自己编）', async () => {
    const store = createLintRunStore();
    await driveLintRun({ linter: stubLinter(halfReport(), []), store, coveredFiles: () => 20, now: () => 1_000 });
    const s = store.get();
    expect(s.phase).toBe('stopped');
    expect(s.incomplete).toEqual({ unitsDone: 12, unitsTotal: 20 });
    expect(s.issueCount).toBe(2);
    const text = lintRunText(s, 4_000);
    expect(text).toContain('这轮校验被你叫停：20 项里算完了 12 项');
    expect(text).toContain('结论不完整');
    expect(text).toContain('没存进结果缓存');
    expect(text).toContain('下面那张清单没跟着变');
    expect(lintRunBrief(s, 4_000)).toBe('校验被叫停 · 结论不完整');
    // 作者面零英文码直出（叫停那一档也不许漏出 id / 异常名那种字）
    expect(/[a-zA-Z]{4,}/.test(text), text).toBe(false);
    // 三档读数互不相同（反恒真：叫停 ≠ 跑坏 ≠ 跑完）
    const failed = { ...s, phase: 'failed' as const, errorText: '索引炸了' };
    const done = { ...s, phase: 'done' as const, incomplete: null };
    expect(text).not.toBe(lintRunText(failed, 4_000));
    expect(text).not.toBe(lintRunText(done, 4_000));
  });

  it('服务不理取消位、真把整轮跑完 ⇒ 读数说跑完（不完整与否只在引擎那一处判定）', async () => {
    const seen: Array<{ force?: boolean; signal?: AbortSignal }> = [];
    const store = createLintRunStore();
    const p = driveLintRun({ linter: stubLinter(halfReport({ incomplete: undefined }), seen), store, coveredFiles: () => 20 });
    store.cancel();
    await p;
    expect(seen[0]!.signal!.aborted).toBe(true); // 确实叫停过
    expect(store.get().phase).toBe('done'); // 但那一轮是完整的 ⇒ 不许冒充半轮
    expect(store.get().incomplete).toBeNull();
    expect(lintRunText(store.get(), 4_000)).toBe('查了 20 个文件 · 用时 2.0 秒 · 2 处问题');
  });

  it('叫停那一轮之后仍能重新跑一轮（同一入口，第二轮照样拿到新的取消位）', async () => {
    const seen: Array<{ force?: boolean; signal?: AbortSignal }> = [];
    const store = createLintRunStore();
    const first = driveLintRun({ linter: stubLinter(halfReport(), seen), store, coveredFiles: () => 20 });
    store.cancel();
    await first;
    expect(store.get().phase).toBe('stopped');
    await driveLintRun({ linter: stubLinter(halfReport({ incomplete: undefined }), seen), store, coveredFiles: () => 20 });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.signal).not.toBe(seen[1]!.signal);
    expect(store.get().phase).toBe('done');
  });
});

/* ---------------- 命令面板那一条叫停命令（假上下文） ---------------- */

function activate(
  seen: Array<{ force?: boolean; signal?: AbortSignal }>,
  result: ConventionReport,
  gate?: Promise<void>,
) {
  const registered: Array<{ slot: string; item: Record<string, unknown> }> = [];
  const project: GameProject = {
    rootDir: '/p',
    adapterId: 'test',
    kojoPaths: ['/p/kojo'],
    writablePaths: [],
    charaIndex: new Map(),
  };
  const parser = {
    currentIndex: () => ({ files: new Map([['/p/a.ERB', {}]]), byName: new Map() }),
  } as unknown as ErbParserService;
  const slots = {
    register(slot: string, item: Record<string, unknown>) {
      registered.push({ slot, item });
      return () => {};
    },
    query: (slot: string) => registered.filter((r) => r.slot === slot).map((r) => r.item) as never,
  } as unknown as SlotRegistry;
  const ctx = {
    pluginId: 'ui-convention-report',
    log: silentLog,
    bus: { emit: () => {}, on: () => () => {} },
    storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    slots,
    provide: () => {},
    inject: (key: string) => {
      if (key === WellKnownServices.ConventionLinter) return stubLinter(result, seen);
      if (key === WellKnownServices.ErbParser) return parser;
      if (key === KernelServices.Project) return { current: () => project };
      if (key === KernelServices.Slots) return slots;
      throw new Error(`假上下文未装配服务：${key}`);
    },
    tryInject: () => undefined,
    onDispose: () => {},
  } as unknown as PluginContext;
  (createUiConventionReportPlugin() as Plugin).activate(ctx);
  const commands = registered.filter((r) => r.slot === 'editor.command').map((r) => r.item) as unknown as EditorCommandContribution[];
  const byId = (id: string): EditorCommandContribution => {
    const c = commands.find((x) => x.id === id);
    if (!c) throw new Error(`命令未注册：${id}`);
    return c;
  };
  return { byId, commandIds: commands.map((c) => c.id) };
}

describe('命令面板的叫停入口', () => {
  it('两条命令都在（跑 / 停），停那条只按取消位、不再起第二轮取数', async () => {
    const seen: Array<{ force?: boolean; signal?: AbortSignal }> = [];
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = activate(seen, halfReport(), gate);
    expect(h.commandIds).toEqual(expect.arrayContaining([LINT_PROJECT_COMMAND_ID, LINT_STOP_COMMAND_ID]));
    const stop = h.byId(LINT_STOP_COMMAND_ID);
    expect(stop.title).toBe(LINT_STOP_COMMAND_TITLE);
    // 作者面零英文码直出
    expect(/[a-zA-Z]{4,}/.test(stop.title ?? '')).toBe(false);
    expect(stop.keybinding).toBeUndefined();
    expect(stop.when).toBeUndefined();

    const running = h.byId(LINT_PROJECT_COMMAND_ID).run({ project: null } as never);
    expect(seen).toHaveLength(1);
    await stop.run({ project: null } as never);
    expect(seen[0]!.signal!.aborted, '停的那条没按到在跑那一轮的取消位').toBe(true);
    expect(seen).toHaveLength(1); // 停的那一条没碰 `linter.run`
    release();
    await running;
  });

  it('没在跑的时候按停 ⇒ 一声不响、不留半轮读数', async () => {
    const seen: Array<{ force?: boolean; signal?: AbortSignal }> = [];
    const h = activate(seen, halfReport({ incomplete: undefined }));
    await h.byId(LINT_STOP_COMMAND_ID).run({ project: null } as never);
    expect(seen).toEqual([]);
  });
});
