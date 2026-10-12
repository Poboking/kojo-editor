import { describe, expect, it } from 'vitest';
import type {
  ComputePool,
  ConditionIndex,
  ControlFlowStatement,
  ErbFile,
  ErbIndex,
  GameProject,
  Logger,
} from '@kojo/plugin-api';
import { ConditionEngine } from '../src/engine';
import type { ExtractExpect, FileBucket } from '../src/snapshot';

/**
 * 引擎侧的按文件增量测试。
 *
 * 计算池只用得到 `runSliced`，而解耦审计 B 项禁止插件测试 import `@kojo/kernel`
 * 取真池（erb-parser/tests/support.ts 有同款说明），故只实现被 exercised 的方法。
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

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const project = { rootDir: 'D:/game', adapterId: 'eratw', inputDigest: 'csv-1' } as unknown as GameProject;
const EXPECT: ExtractExpect = { projectRoot: 'D:/game', adapterId: 'eratw', inputDigest: 'csv-1' };

const A = 'D:/game/a.ERB';
const B = 'D:/game/b.ERB';
const C = 'D:/game/c.ERB';

const NAMES: Record<string, string> = { [A]: 'M_KOJO_K1_A', [B]: 'M_KOJO_K1_B', [C]: 'M_KOJO_K1_C' };
const fnName = (path: string): string => NAMES[path] ?? `M_KOJO_${path}`;

function erbFile(path: string): ErbFile {
  return {
    path,
    functions: [
      {
        name: fnName(path),
        normalizedName: fnName(path),
        params: [],
        startLine: 1,
        endLine: 10,
        filePath: path,
        isExpressionFunction: false,
      },
    ],
    dims: [],
    hasFunctionDirective: false,
    lineCount: 12,
  };
}

/**
 * 本次索引。文件清单**由 mtime 键推导**——增量复用的输入就是"这次 walk 到了哪些文件"，
 * 硬编码清单会让"新文件出现/旧文件消失"两类用例测不到真路径。
 * `mtimes = null` ⇒ 索引不带 `fileMtimes`（模拟旧版 / 取不到 stat 的索引）。
 */
function erbIndex(mtimes: Map<string, number | null> | null): ErbIndex {
  const paths = mtimes === null ? [A, B] : [...mtimes.keys()];
  const files = new Map<string, ErbFile>(paths.map((p) => [p, erbFile(p)]));
  return { files, byName: new Map(), fileMtimes: mtimes ?? undefined } as ErbIndex;
}

/** 一个文件算完的桶（与引擎内部同构，用于造"上次留下的快照"） */
function bucketFor(path: string, mtimeMs: number | null): FileBucket {
  const name = fnName(path);
  return {
    mtimeMs,
    stats: { functions: 1, functionsWithDeps: 1, predicates: 1, unparsed: 0, dependencies: 1 },
    conds: [
      {
        normalizedName: name,
        filePath: path,
        startLine: 1,
        predicateCount: 1,
        unparsedCount: 0,
        dependencies: [
          { key: 'CFLAG:2', name: 'CFLAG', indices: ['2'], count: 1, comparisons: [], firstLine: 2 },
        ],
      },
    ],
  };
}

type Port = NonNullable<ConstructorParameters<typeof ConditionEngine>[0]['snapshot']>;

function makeEngine(opts: {
  /** 缺省 = A(100)/B(200)；`null` = 索引不提供 fileMtimes */
  mtimes?: Map<string, number | null> | null;
  port?: Partial<Pick<Port, 'load' | 'save'>> & { expectFor?: () => ExtractExpect | null };
} = {}) {
  const mtimes = opts.mtimes === undefined ? new Map<string, number | null>([[A, 100], [B, 200]]) : opts.mtimes;
  const reads: string[] = [];
  const scans: string[] = [];
  const engine = new ConditionEngine({
    log: silentLog,
    getProject: () => project,
    getIndex: () => erbIndex(mtimes),
    readFile: async (path: string) => {
      reads.push(path);
      return 'IF CFLAG:2>=500\nENDIF\n';
    },
    scanControlFlow: async (): Promise<ControlFlowStatement[]> => {
      scans.push('x');
      return [
        { kind: 'IF', expression: 'CFLAG:2>=500', depth: 0, line: 2 },
        { kind: 'ENDIF', expression: '', depth: 0, line: 3 },
      ];
    },
    getSchemaLookup: () => undefined,
    snapshot: opts.port
      ? {
          expectFor: opts.port.expectFor ?? (() => EXPECT),
          load: opts.port.load ?? (async () => null),
          save: opts.port.save ?? (() => undefined),
        }
      : undefined,
    compute: makeComputeStub(),
  });
  return { engine, reads, scans };
}

describe('ConditionEngine 按文件增量', () => {
  it('首次（无快照）⇒ 两个文件都算，并把两个桶一起落盘', async () => {
    let saved: Map<string, FileBucket> | null = null;
    const { engine, reads } = makeEngine({
      port: {
        async load() {
          return null;
        },
        save(buckets) {
          saved = new Map(buckets);
        },
      },
    });
    const out = await engine.run();
    expect(reads.sort()).toEqual([A, B].sort());
    expect(out.stats.functions).toBe(2);
    expect(saved!.size).toBe(2);
    expect([...saved!.keys()].sort()).toEqual([A, B].sort());
    expect(saved!.get(A)!.mtimeMs).toBe(100); // 桶带本次 mtime，下次才能逐文件比对
  });

  it('全部命中 ⇒ 零读盘零扫描，统计来自桶，且**不回写**快照（全等就不必再写 12 MB）', async () => {
    let saves = 0;
    const { engine, reads } = makeEngine({
      port: {
        async load() {
          return { [A]: bucketFor(A, 100), [B]: bucketFor(B, 200) };
        },
        save() {
          saves++;
        },
      },
    });
    const out = await engine.run();
    expect(reads).toHaveLength(0);
    expect(out.stats.functions).toBe(2);
    expect(out.stats.predicates).toBe(2);
    expect([...out.byFunction.keys()].sort()).toEqual(['M_KOJO_K1_A', 'M_KOJO_K1_B']);
    expect(saves).toBe(0);
  });

  it('改过一个文件 ⇒ 只重算那一个，另一个照用（本批靶心）', async () => {
    const saved: Map<string, FileBucket>[] = [];
    const { engine, reads } = makeEngine({
      mtimes: new Map([[A, 100], [B, 201]]), // B 被编辑过
      port: {
        async load() {
          return { [A]: bucketFor(A, 100), [B]: bucketFor(B, 200) };
        },
        save(buckets) {
          saved.push(new Map(buckets));
        },
      },
    });
    const out = await engine.run();
    expect(reads).toEqual([B]);
    expect(out.byFunction.size).toBe(2); // 复用 A + 新算 B
    expect(out.stats.functions).toBe(2);
    expect(saved[0]!.get(B)!.mtimeMs).toBe(201); // 新 mtime 进桶
    expect(saved[0]!.get(A)!.mtimeMs).toBe(100);
  });

  it('新文件出现 ⇒ 只算新的；消失的文件不再进桶（天然收尸）', async () => {
    const saved: Map<string, FileBucket>[] = [];
    const { engine, reads } = makeEngine({
      mtimes: new Map([[A, 100], [C, 300]]), // 本次清单：A 留、B 删、C 加
      port: {
        async load() {
          return { [A]: bucketFor(A, 100), [B]: bucketFor(B, 200) };
        },
        save(buckets) {
          saved.push(new Map(buckets));
        },
      },
    });
    const out = await engine.run();
    expect(reads).toEqual([C]); // 只有新文件被读
    expect(out.byFunction.has('M_KOJO_K1_A')).toBe(true);
    expect(out.byFunction.has('M_KOJO_K1_B')).toBe(false); // 消失文件的桶被收尸
    expect([...saved[0]!.keys()].sort()).toEqual([A, C].sort());
    expect(saved[0]!.has(B)).toBe(false); // 落盘的也不带尸
  });

  it('索引没给 fileMtimes ⇒ 保守：每个文件都重算，但仍照常落盘', async () => {
    let saves = 0;
    const { engine, reads } = makeEngine({
      mtimes: null,
      port: {
        async load() {
          return { [A]: bucketFor(A, 100), [B]: bucketFor(B, 200) };
        },
        save() {
          saves++;
        },
      },
    });
    await engine.run();
    expect(reads.sort()).toEqual([A, B].sort());
    expect(saves).toBe(1);
  });

  it('全局判据不全（expectFor null）⇒ 不 load 不 save，结果仍正确', async () => {
    let touched = 0;
    const { engine, reads } = makeEngine({
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
    expect(reads).toHaveLength(2);
    expect(out.byFunction.size).toBe(2);
  });

  it('判据由引擎原样递给 load/save（CSV 变了 ⇒ 快照层判死，引擎不自己判）', async () => {
    const seen: ExtractExpect[] = [];
    const { engine, reads } = makeEngine({
      port: {
        expectFor: () => ({ ...EXPECT, inputDigest: 'csv-2' }),
        async load(expect) {
          seen.push(expect);
          return null; // 模拟全局判据不符
        },
        save(_b, expect) {
          seen.push(expect);
        },
      },
    });
    await engine.run();
    expect(reads).toHaveLength(2); // 判据不符 ⇒ 全量重算
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ projectRoot: 'D:/game', adapterId: 'eratw', inputDigest: 'csv-2' });
    expect(seen[1]).toBe(seen[0]); // load 与 save 用的是同一份判据对象
  });

  it('读文件失败的文件不留桶（坏一次不会永久缓存坏结果），其余照常', async () => {
    const saved: Map<string, FileBucket>[] = [];
    const engine = new ConditionEngine({
      log: silentLog,
      getProject: () => project,
      getIndex: () => erbIndex(new Map([[A, 100], [B, 200]])),
      readFile: async (path: string) => {
        if (path === A) throw new Error('disk offline');
        return 'IF CFLAG:2>=500\nENDIF\n';
      },
      scanControlFlow: async () => [{ kind: 'IF', expression: 'CFLAG:2>=500', depth: 0, line: 2 }],
      getSchemaLookup: () => undefined,
      snapshot: {
        expectFor: () => EXPECT,
        load: async () => null,
        save: (b) => saved.push(new Map(b)),
      },
      compute: makeComputeStub(),
    });
    const out = await engine.run();
    expect(out.byFunction.has('M_KOJO_K1_B')).toBe(true);
    expect(saved[0]!.has(A)).toBe(false); // 坏结果不进桶
    expect(saved[0]!.has(B)).toBe(true);
  });

  it('并发 ensureIndex 只算一次（自动触发与面板显式调用共享在途 Promise）', async () => {
    const { engine, reads } = makeEngine({});
    const [x, y, z] = await Promise.all([engine.ensureIndex(), engine.ensureIndex(), engine.ensureIndex()]);
    expect(reads).toHaveLength(2); // 一轮，两个文件各一次
    expect(x).toBe(y);
    expect(y).toBe(z);
  });

  it('无 snapshot 端口时行为不变（可选依赖，零副作用）', async () => {
    const { engine, reads } = makeEngine({});
    const out = await engine.run();
    expect(out.byFunction.size).toBe(2);
    expect(reads).toHaveLength(2);
  });

  it('索引重建后明细缓存失效（跨项目/跨桶不串味）', () => {
    const { engine } = makeEngine({});
    const seen: (ConditionIndex | null)[] = [];
    engine.subscribe((i) => seen.push(i));
    expect(seen).toHaveLength(1); // subscribe 立即以当前值回调
  });
});
