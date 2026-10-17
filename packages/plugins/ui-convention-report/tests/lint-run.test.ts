/**
 * 「一键全项目转译校验」的入口与读数闸（ZH-F4）。
 *
 * 钉三件事（判据一条都不落在"面板画了什么"上——本包编译在无 DOM 环境下，
 * 读数由 `lint-run.ts` 的纯函数产，面板只搬运）：
 * ① 命令**确实驱动 `linter.run`**：命令自己不算任何东西，桩服务记一次调用；
 * ② `failedRules` 与整轮抛错**照样可见**（内核铁律 4：不许静默）；
 * ③ 进度读数**不恒真**：运行中/跑完/跑坏三档文本各不相同，数字来自桩的真实返回。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
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
import { createKernel } from '../../../kernel/src/kernel';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { MemoryStorageBackend } from '../../../kernel/tests/helpers/memory-storage';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createConventionLinterPlugin } from '@kojo/plugin-convention-linter';
import {
  LINT_PROJECT_COMMAND_CATEGORY,
  LINT_PROJECT_COMMAND_ID,
  LINT_PROJECT_COMMAND_TITLE,
  createLintRunStore,
  driveLintRun,
  lintRunBrief,
  lintRunText,
} from '../src/lint-run';
import { createUiConventionReportPlugin } from '../src/index';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function report(over: Partial<ConventionReport> = {}): ConventionReport {
  return {
    adapterId: 'test',
    startedAt: 1_000,
    finishedAt: 6_123,
    durationMs: 5_123,
    issues: [{ ruleId: 'r.a', severity: 'error', message: 'x', filePath: '/p/a.kojo', line: 3 }],
    counts: { error: 1, warning: 0, info: 0 },
    ruleCount: 7,
    failedRules: [],
    ...over,
  };
}

/** 只记账不判定的桩校验器（判定归 convention-linter，本包不该有第二把尺） */
function stubLinter(result: ConventionReport | Error, calls: Array<{ force?: boolean }>): ConventionLinterService {
  return {
    async run(opts?: { force?: boolean }) {
      calls.push({ ...(opts?.force !== undefined ? { force: opts.force } : {}) });
      if (result instanceof Error) throw result;
      return result;
    },
    report: () => result instanceof Error ? null : result,
    subscribe: () => () => {},
    rules: () => [],
  };
}

describe('driveLintRun（跑一轮的唯一通道）', () => {
  it('驱动 linter.run({force:true})，读数取它返回的那份报告', async () => {
    const calls: Array<{ force?: boolean }> = [];
    const store = createLintRunStore();
    // 覆盖文件数：起头索引没建好（0），跑完已经有 9 棵——读数是问出来的，不是写死的
    let indexReady = false;
    await driveLintRun({
      linter: stubLinter(report(), calls),
      store,
      coveredFiles: () => (indexReady ? 9 : 0),
      now: () => 1_000,
    });
    indexReady = true; // 真跑里"跑完再问一次"就是这一句的效果
    expect(calls).toEqual([{ force: true }]);
    const s = store.get();
    expect(s.phase).toBe('done');
    expect(s.durationMs).toBe(5_123);
    expect(s.issueCount).toBe(1);
  });

  it('进度读数分档：跑前空 / 跑中只报已过时间 / 跑完报文件数·耗时·问题数', async () => {
    const store = createLintRunStore();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const linter: ConventionLinterService = {
      async run() {
        await gate;
        return report();
      },
      report: () => null,
      subscribe: () => () => {},
      rules: () => [],
    };
    const seen: string[] = [];
    store.subscribe((s) => seen.push(s.phase));

    expect(lintRunText(store.get(), 5_000)).toBe(''); // 还没跑过 ⇒ 不说话，不编读数
    const p = driveLintRun({ linter, store, coveredFiles: () => 2_325, now: () => 10_000 });
    expect(store.get().phase).toBe('running');
    // 运行中：只有"已过多久"（引擎没有分片进度可问，编百分比就是假象）
    expect(lintRunText(store.get(), 12_400)).toBe('正在校验 2325 个文件 · 已 2.4 秒');
    expect(lintRunBrief(store.get(), 12_400)).toBe('校验中 · 已 2.4 秒');
    release();
    await p;

    expect(seen).toEqual(['idle', 'running', 'done']);
    const done = lintRunText(store.get(), 15_123);
    expect(done).toBe('查了 2325 个文件 · 用时 5.1 秒 · 1 处问题');
    expect(done).not.toBe(lintRunText({ ...store.get(), phase: 'running' }, 15_123));
    expect(lintRunBrief(store.get(), 15_123)).toBe('');
  });

  it('规则失败与整轮抛错都出声（绝不静默）', async () => {
    const store = createLintRunStore();
    await driveLintRun({
      linter: stubLinter(report({ failedRules: [{ ruleId: 'sugar.static-conventions', error: '转译服务缺席' }] }), []),
      store,
      coveredFiles: () => 3,
    });
    expect(lintRunText(store.get(), 0)).toContain('1 条规则没跑成（原因列在下面）');

    const broken = createLintRunStore();
    await driveLintRun({
      linter: stubLinter(new Error('索引炸了'), []),
      store: broken,
      coveredFiles: () => 3,
    });
    expect(broken.get().phase).toBe('failed');
    expect(lintRunText(broken.get(), 0)).toBe('这轮校验没跑完：索引炸了');
    expect(lintRunBrief(broken.get(), 0)).toBe('校验没跑完');
  });

  it('在途不叠第二轮（读数不许把同一轮记成两次开始时刻）', async () => {
    const calls: Array<{ force?: boolean }> = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const linter: ConventionLinterService = {
      async run(opts) {
        calls.push({ ...(opts?.force !== undefined ? { force: opts.force } : {}) });
        return await gate.then(() => report());
      },
      report: () => null,
      subscribe: () => () => {},
      rules: () => [],
    };
    const store = createLintRunStore();
    const a = driveLintRun({ linter, store, coveredFiles: () => 1 });
    await driveLintRun({ linter, store, coveredFiles: () => 1 }); // 第二次应当直接退出
    release();
    await a;
    expect(calls.length).toBe(1);
  });
});

/* ------------------------- 命令注册与接线（假上下文） ------------------------- */

interface Harness {
  commands: Array<{ id: string; title?: string; category?: string; run: (ctx: never) => Promise<void> }>;
  /** 这次激活往哪些槽挂了贡献（落点是否齐备的读数） */
  registeredSlots: string[];
  runCommand(id: string): Promise<void>;
}

function activateWith(linter: ConventionLinterService, indexSize: number): Harness {
  const registered: Array<{ slot: string; item: Record<string, unknown> }> = [];
  const project: GameProject = {
    rootDir: '/p',
    adapterId: 'test',
    kojoPaths: ['/p/kojo'],
    writablePaths: [],
    charaIndex: new Map(),
  };
  const parser = {
    currentIndex: () => ({
      files: new Map(Array.from({ length: indexSize }, (_, i) => [`/p/kojo/f${i}.kojo`, {}])),
      byName: new Map(),
    }),
  } as unknown as ErbParserService;
  const slots = {
    register(slot: string, item: Record<string, unknown>): () => void {
      registered.push({ slot, item });
      return () => {};
    },
    query(slot: string) {
      return registered.filter((r) => r.slot === slot).map((r) => r.item) as never;
    },
  } as unknown as SlotRegistry;
  const ctx = {
    pluginId: 'ui-convention-report',
    log: silentLog,
    bus: { emit: () => {}, on: () => () => {} },
    storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    slots,
    provide: () => {},
    inject: (key: string) => {
      if (key === WellKnownServices.ConventionLinter) return linter;
      if (key === WellKnownServices.ErbParser) return parser;
      if (key === KernelServices.Project) return { current: () => project };
      if (key === KernelServices.Slots) return slots;
      throw new Error(`假上下文未装配服务：${key}`);
    },
    tryInject: () => undefined,
    onDispose: () => {},
  } as unknown as PluginContext;
  (createUiConventionReportPlugin() as Plugin).activate(ctx);
  const commands = registered.filter((r) => r.slot === 'editor.command').map((r) => r.item) as Harness['commands'];
  return {
    commands,
    registeredSlots: [...new Set(registered.map((r) => r.slot))],
    async runCommand(id: string) {
      const cmd = commands.find((c) => c.id === id);
      if (!cmd) throw new Error(`命令未注册：${id}`);
      await cmd.run({ project } as never);
    },
  };
}

describe('命令面板入口', () => {
  it('注册了一条中文命令，且它只是把 linter.run 叫起来', async () => {
    const calls: Array<{ force?: boolean }> = [];
    const h = activateWith(stubLinter(report({ durationMs: 900, issues: [] }), calls), 4);
    const cmd = h.commands.find((c) => c.id === LINT_PROJECT_COMMAND_ID);
    expect(cmd).toBeTruthy();
    expect(cmd!.title).toBe(LINT_PROJECT_COMMAND_TITLE);
    expect(cmd!.category).toBe(LINT_PROJECT_COMMAND_CATEGORY);
    // 作者面零英文码直出：标题里不许出现 id 那种 ASCII 码
    expect(/[a-zA-Z]{4,}/.test(cmd!.title ?? '')).toBe(false);

    await h.runCommand(LINT_PROJECT_COMMAND_ID);
    expect(calls).toEqual([{ force: true }]);
  });

  it('贡献形状 = 宿主注册表吃下的那一枚（无键位、无 when；落点面板与状态栏齐备）', () => {
    const h = activateWith(stubLinter(report(), []), 3);
    const contribution = h.commands.find((c) => c.id === LINT_PROJECT_COMMAND_ID) as unknown as EditorCommandContribution;
    expect(typeof contribution.run).toBe('function');
    expect(contribution.title).toBe(LINT_PROJECT_COMMAND_TITLE);
    expect(contribution.category).toBe(LINT_PROJECT_COMMAND_CATEGORY);
    // 不抢键位也不写 `when`：键位表留给用户自己挂；没项目时也要按得下去、由读数说话
    expect(contribution.keybinding).toBeUndefined();
    expect(contribution.when).toBeUndefined();
    // 结果的落点：既有面板 + 常驻状态栏（命令本身不开新面板）
    expect(h.registeredSlots).toEqual(expect.arrayContaining(['ui.panel', 'ui.statusbar', 'editor.command']));
  });

  it('整轮抛错不会把命令自己炸掉（Palette 那边是 `void cmd.run()`）', async () => {
    const h = activateWith(stubLinter(new Error('转译器起不来'), []), 2);
    await expect(h.runCommand(LINT_PROJECT_COMMAND_ID)).resolves.toBeUndefined();
  });
});

/* ----------------------------- 真实语料小样 ----------------------------- */

const SMOKE = process.env.KOJO_SMOKE_PROJECT;

describe.skipIf(!SMOKE)('真实语料小样 · 一条命令跑全项目', () => {
  it('真内核里注册得到、跑得完，读数与报告逐字对得上', async () => {
    const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-f4-corpus-'));
    const kernel = await createKernel({
      platform: new NodeBridge(appData),
      plugins: [
        createErbParserPlugin(),
        createEratwAdapterPlugin(),
        createConventionLinterPlugin(),
        createUiConventionReportPlugin(),
      ],
      storageBackend: new MemoryStorageBackend(),
    });
    await kernel.start();
    try {
      const project = await kernel.project.open(SMOKE!);
      const parser = kernel.services.get<ErbParserService>(WellKnownServices.ErbParser);
      await parser.ensureIndex();
      const linter = kernel.services.get<ConventionLinterService>(WellKnownServices.ConventionLinter);

      // ① 真装配里这条命令确实在注册表里（`kernel.compute` 在场 ⇒ 走的是池子那条调度）
      const cmd = kernel.slots.query('editor.command').find((c) => c.id === LINT_PROJECT_COMMAND_ID);
      expect(cmd).toBeTruthy();
      await cmd!.run({ project });

      // ② 读数由同一条通道算出，数字取自真报告（不是恒真的样板串）
      const store = createLintRunStore();
      await driveLintRun({
        linter,
        store,
        coveredFiles: () => parser.currentIndex()?.files.size ?? 0,
      });
      const rep = linter.report()!;
      const s = store.get();
      console.log(`[f4] ${lintRunText(s, Date.now())} · 失败规则 ${rep.failedRules.length} 条`);
      expect(s.phase).toBe('done');
      expect(s.coveredFiles).toBeGreaterThan(0);
      expect(s.issueCount).toBe(rep.issues.length);
      expect(s.durationMs).toBe(rep.durationMs);
      expect(rep.ruleCount).toBeGreaterThan(1); // 内置规则真参与了
      expect(lintRunText(s, Date.now())).toContain(`${s.coveredFiles} 个文件`);
      // 规则静默失败 ⇒ 出声（铁律 4 在语料上的那一半）
      if (rep.failedRules.length > 0) expect(lintRunText(s, Date.now())).toContain('条规则没跑成');
    } finally {
      await kernel.stop();
    }
  }, 300_000);
});
