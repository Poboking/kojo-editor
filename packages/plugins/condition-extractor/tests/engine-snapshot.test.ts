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
    async runSliced<T, R>(
      items: readonly T[],
      _opts: unknown,
      fn: (item: T, i: number) => R | Promise<R>,
    ): Promise<R[]> {
      const out: R[] = [];
      for (let i = 0; i < items.length; i++) out.push(await fn(items[i]!, i));
      return out;
    },
  } as unknown as ComputePool;
}

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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

const erbIndex = (): ErbIndex =>
  ({
    files: new Map([['D:/game/a.ERB', file]]),
    byName: new Map([[file.functions[0]!.normalizedName, [file.functions[0]!]]]),
    fingerprint: 'fp-erb',
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

/** 判据由**插件**组装（引擎不懂指纹从哪来），测试里也照这个边界给替身 */
const EXPECT: CacheExpect = { projectRoot: 'D:/game', adapterId: 'eratw', fingerprint: 'combined-fp' };

type Port = NonNullable<ConstructorParameters<typeof ConditionEngine>[0]['snapshot']>;

function makeEngine(args: {
  port?: Partial<Pick<Port, 'load' | 'save'>> & { expectFor?: () => CacheExpect | null };
  counters?: { reads: number; scans: number };
}) {
  const counters = args.counters ?? { reads: 0, scans: 0 };
  const port: Port | undefined = args.port
    ? {
        expectFor: args.port.expectFor ?? (() => EXPECT),
        load: args.port.load ?? (async () => null),
        save: args.port.save ?? (() => undefined),
      }
    : undefined;
  const engine = new ConditionEngine({
    log: silentLog,
    getProject: () => project,
    getIndex: erbIndex,
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
    snapshot: port,
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
      port: {
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
    expect(loads).toEqual([EXPECT]);
  });

  it('未命中 ⇒ 全量计算，并把**本次实际使用的判据**交给 save（途中换索引也不污染）', async () => {
    const saved: { index: ConditionIndex; expect: CacheExpect }[] = [];
    const { engine, counters } = makeEngine({
      port: {
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
    expect(saved[0]!.expect).toEqual(EXPECT);
    expect(saved[0]!.index.stats.functions).toBe(1);
  });

  it('判据不全（expectFor 返回 null）⇒ 既不还原也不落盘，但仍真算', async () => {
    let touched = 0;
    const { engine, counters } = makeEngine({
      port: {
        expectFor: () => null,
        async load() {
          touched++;
          return null;
        },
        save() {
          touched++;
        },
      },
    });
    const out = await engine.run();
    expect(touched).toBe(0);
    expect(counters.reads).toBe(1);
    expect(out.byFunction.size).toBe(1);
  });

  it('判据每次运行现取（改文件后 expectFor 变 ⇒ 老快照不会误命中）', async () => {
    const seen: string[] = [];
    let n = 0;
    const { engine } = makeEngine({
      port: {
        expectFor: () => ({ ...EXPECT, fingerprint: `fp-${n++}` }),
        async load(expect) {
          seen.push(expect.fingerprint);
          return null;
        },
        save() {
          /* 不落盘即可 */
        },
      },
    });
    await engine.ensureIndex();
    await engine.run();
    expect(seen).toEqual(['fp-0', 'fp-1']);
  });

  it('无 snapshot 端口时行为与改造前一致（可选依赖，零副作用）', async () => {
    const { engine } = makeEngine({});
    const out = await engine.run();
    expect(out.byFunction.size).toBe(1);
  });

  it('并发 ensureIndex 只算一次（自动触发与面板显式调用共享在途 Promise）', async () => {
    // 真实语料上一次全量抽取 ≈ 8.8 s；并发两条全量抽取就是白等两个 8.8 s。
    // 级联实测（2026-10-12）曾因自动路径调 run()、显式路径调 ensureIndex() 跑了两遍。
    let saves = 0;
    const { engine, counters } = makeEngine({
      port: {
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

  it('restore 立即对订阅者可见，且明细缓存被旁路（不会拿旧项目的谓词）', () => {
    const { engine } = makeEngine({});
    const seen: (ConditionIndex | null)[] = [];
    engine.subscribe((i) => seen.push(i));
    engine.restore(cachedIndex());
    expect(seen).toHaveLength(2); // subscribe 立即回调一次（null）+ restore 一次
    expect(seen[1]!.byFunction.size).toBe(1);
    expect(engine.functionConditions('M_KOJO_K1_A')?.predicateCount).toBe(1);
  });
});
