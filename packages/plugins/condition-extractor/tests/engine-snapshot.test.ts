import { describe, expect, it } from 'vitest';
import type {
  CacheExpect,
  ComputePool,
  ConditionIndex,
  ControlFlowStatement,
  ErbFile,
  ErbIndex,
  GameProject,
  Logger,
} from '@kojo/plugin-api';
import { ConditionEngine } from '../src/engine';

/**
 * 引擎侧的快照短路测试。
 *
 * 计算池只用得到 `runSliced`，而解耦审计 B 项禁止插件测试 import `@kojo/kernel`
 * 取真池（erb-parser/tests/support.ts 有同款说明），故这里只实现被 exercised 的方法。
 */
function makeComputeStub(): ComputePool {
  return {
    async runSliced<T, R>(items: readonly T[], _opts: unknown, fn: (item: T, i: number) => R | Promise<R>): Promise<R[]> {
      const out: R[] = [];
      for (let i = 0; i < items.length; i++) out.push(await fn(items[i]!, i));
      return out;
    },
  } as unknown as ComputePool;
}

const silentLog: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const project: GameProject = {
  id: 'p1',
  name: 'game',
  rootDir: 'D:/game',
  adapterId: 'eratw',
  charaIndex: new Map(),
  charaCount: 0,
  kojoPaths: ['D:/game/M_KOJO'],
  savDir: 'D:/game/sav',
  configPath: 'D:/game/emuera.config',
} as unknown as GameProject;

const file: ErbFile = {
  path: 'D:/game/a.ERB',
  functions: [
    {
      name: 'M_KOJO_K1_A',
      normalizedName: 'M_KOJO_K1_A',
      params: [],
      startLine: 1,
      endLine: 10,
      filePath: 'D:/game/a.ERB',
      isExpressionFunction: false,
    },
  ],
  dims: [],
  hasFunctionDirective: false,
  lineCount: 12,
};

const erbIndex = (fingerprint: string | null | undefined): ErbIndex =>
  ({
    files: new Map([['D:/game/a.ERB', file]]),
    byName: new Map([[file.functions[0]!.normalizedName, [file.functions[0]!]]]),
    fingerprint,
  }) as ErbIndex;

const cachedIndex = (): ConditionIndex => ({
  projectRoot: 'D:/game',
  finishedAt: 1,
  durationMs: 11300,
  byFunction: new Map([
    [
      'M_KOJO_K1_A',
      {
        normalizedName: 'M_KOJO_K1_A',
        filePath: 'D:/game/a.ERB',
        startLine: 1,
        predicateCount: 1,
        unparsedCount: 0,
        dependencies: [],
      },
    ],
  ]),
  stats: { functions: 1, functionsWithDeps: 0, predicates: 1, unparsed: 0, dependencies: 0 },
});

function makeEngine(args: {
  fingerprint?: string | null;
  snapshot?: { load(expect: CacheExpect): Promise<ConditionIndex | null>; save(index: ConditionIndex, expect: CacheExpect): void };
  counters?: { reads: number; scans: number };
}) {
  const counters = args.counters ?? { reads: 0, scans: 0 };
  const engine = new ConditionEngine({
    log: silentLog,
    getProject: () => project,
    getIndex: () => erbIndex(args.fingerprint === undefined ? 'fp1' : args.fingerprint),
    readFile: async () => {
      counters.reads++;
      return ';comment\nIF CFLAG:2>=500\nENDIF\n';
    },
    scanControlFlow: async (): Promise<ControlFlowStatement[]> => {
      counters.scans++;
      return [
        { kind: 'IF', expression: 'CFLAG:2>=500', depth: 0, line: 2 },
        { kind: 'ENDIF', expression: '', depth: 0, line: 3 },
      ];
    },
    getSchemaLookup: () => undefined,
    snapshot: args.snapshot,
    compute: makeComputeStub(),
  });
  return { engine, counters };
}

describe('ConditionEngine 的快照短路', () => {
  it('命中快照 ⇒ 零读盘零扫描、结果即快照、不再存一次', async () => {
    const counters = { reads: 0, scans: 0 };
    const cached = cachedIndex();
    const loads: CacheExpect[] = [];
    const saves: CacheExpect[] = [];
    const { engine } = makeEngine({
      counters,
      snapshot: {
        async load(expect) {
          loads.push(expect);
          return cached;
        },
        save(_i, expect) {
          saves.push(expect);
        },
      },
    });

    const out = await engine.run();
    expect(out).toBe(cached);
    expect(counters.reads).toBe(0);
    expect(counters.scans).toBe(0);
    expect(saves).toHaveLength(0);
    expect(loads).toEqual([{ projectRoot: 'D:/game', adapterId: 'eratw', fingerprint: 'fp1' }]);
  });

  it('未命中 ⇒ 全量计算，并把**本次实际使用的判据**交给 save（避免途中换索引造成污染）', async () => {
    const saved: { index: ConditionIndex; expect: CacheExpect }[] = [];
    const { engine, counters } = makeEngine({
      snapshot: {
        async load() {
          return null;
        },
        save(index, expect) {
          saved.push({ index, expect });
        },
      },
    });

    const out = await engine.run();
    expect(counters.reads).toBe(1);
    expect(out.byFunction.has('M_KOJO_K1_A')).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.expect).toEqual({ projectRoot: 'D:/game', adapterId: 'eratw', fingerprint: 'fp1' });
    expect(saved[0]!.index.stats.functions).toBe(1);
  });

  it('指纹不可得（null / 空串）⇒ 既不还原也不落盘（保守回退全量）', async () => {
    for (const fp of [null, ''] as const) {
      let called = 0;
      const { engine, counters } = makeEngine({
        fingerprint: fp,
        snapshot: {
          async load() {
            called++;
            return null;
          },
          save() {
            called++;
          },
        },
      });
      await engine.run();
      expect(called).toBe(0);
      expect(counters.reads).toBe(1); // 仍然真算，结果正确性不受影响
    }
  });

  it('无 snapshot 端口时行为与改造前一致（可选依赖，零副作用）', async () => {
    const { engine } = makeEngine({});
    const out = await engine.run();
    expect(out.byFunction.size).toBe(1);
  });

  it('restore 立即对订阅者可见，且明细缓存被旁路（不会拿旧项目的谓词）', () => {
    const { engine } = makeEngine({});
    const seen: (ConditionIndex | null)[] = [];
    engine.subscribe((i) => seen.push(i));
    engine.restore(cachedIndex());
    expect(seen).toHaveLength(2); // subscribe 立即回调一次（null）+ restore 一次
    expect(seen[1]!.byFunction.size).toBe(1);
    expect(engine.functionConditions('M_KOJO_K1_A')?.predicateCount).toBe(1);
  });

  it('并发 ensureIndex 只算一次（自动触发与面板显式调用共享在途 Promise）', async () => {
    // 真实语料上一次全量抽取 ≈ 8.8 s；两条并发的全量抽取就是白等两个 8.8 s。
    // 级联实测（2026-10-12）曾因自动路径调 run()、显式路径调 ensureIndex() 而跑了两遍。
    let saves = 0;
    const { engine, counters } = makeEngine({
      snapshot: {
        async load() {
          return null;
        },
        save() {
          saves++;
        },
      },
    });
    const [a, b, c] = await Promise.all([engine.ensureIndex(), engine.ensureIndex(), engine.ensureIndex()]);
    expect(counters.reads).toBe(1);
    expect(saves).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
