/**
 * 离线抽取（`ConditionExtractorService.extractIndex`，additive）测试。
 *
 * 钉三件：
 * ① 传入的任意 `ErbIndex`（合成的工作区包索引）能被抽取，`byFunction` 拿得到依赖
 *    （schema 标注、批量读路径与全量抽取同源）；
 * ② 离线抽取**不碰父 engine**：`currentIndex()` 同一对象、订阅者不通知、
 *    明细 / 正文缓存不被污染；
 * ③ 空索引返回形状稳定的空结果（不抛）。
 */
import { describe, expect, it } from 'vitest';
import type { ComputePool, ControlFlowStatement, ErbFile, ErbIndex, GameProject, Logger } from '@kojo/plugin-api';
import { ConditionEngine } from '../src/engine';
import { conditionExtractorTasks } from '../src/offload';
import type { SchemaLookup } from '../src/extract';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const project = { rootDir: 'D:/game', adapterId: 'eratw', inputDigest: 'd1' } as unknown as GameProject;

/** 计算池替身：`offload` 执行注册的任务实现，`runSliced` 顺序跑完窗口
 *（口径同 engine-snapshot 测试） */
function makeComputeStub(tasks: ReturnType<typeof conditionExtractorTasks>): ComputePool {
  return {
    async runSliced<T, R>(items: readonly T[], _o: unknown, fn: (t: T, i: number) => R | Promise<R>): Promise<R[]> {
      const out: R[] = [];
      for (let i = 0; i < items.length; i++) out.push(await fn(items[i]!, i));
      return out;
    },
    async offload<R>(kind: string, payload: unknown): Promise<R> {
      const impl = tasks[kind];
      if (!impl) throw new Error(`No local implementation registered for compute task '${kind}'`);
      return (await impl(payload as never)) as R;
    },
    stats: () => ({
      tasks: [],
      yields: 0,
      interactiveActive: false,
      offload: { parallel: false, dispatched: 0, fellBack: 0, inline: 0 },
    }),
  } as unknown as ComputePool;
}

/** 纯扫描器：只认行首 IF（与 detail-cache-cap 测试同款，任务表与明细路径共用） */
function scanOnce(text: string): readonly ControlFlowStatement[] {
  const out: ControlFlowStatement[] = [];
  text.split('\n').forEach((line, idx) => {
    const m = /^IF\s+(.*)$/.exec(line);
    if (m) out.push({ kind: 'IF', expression: m[1]!, depth: 0, line: idx + 1 });
    if (/^ENDIF/.test(line)) out.push({ kind: 'ENDIF', expression: '', depth: 0, line: idx + 1 });
  });
  return out;
}

function erbFileOf(path: string, name: string, startLine: number, endLine: number): ErbFile {
  return {
    path,
    functions: [
      { name, normalizedName: name, params: [], startLine, endLine, filePath: path, isExpressionFunction: false },
    ],
    dims: [],
    hasFunctionDirective: false,
    lineCount: endLine + 1,
  } as ErbFile;
}

/** 合成索引（文件 + 函数）：`byName` 的值是引用数组，与契约一致 */
function makeIndex(files: readonly ErbFile[]): ErbIndex {
  const fileMap = new Map<string, ErbFile>();
  const byName = new Map<string, unknown[]>();
  for (const f of files) {
    fileMap.set(f.path, f);
    for (const fn of f.functions) {
      const list = byName.get(fn.normalizedName) ?? [];
      list.push(fn);
      byName.set(fn.normalizedName, list);
    }
  }
  return { files: fileMap, byName } as unknown as ErbIndex;
}

/** 一棵最小 ERB：`@名称()` 在第 1 行，体内一条 IF（第 2 行） */
function erbText(name: string, cond: string): string {
  return [`@${name}()`, `IF ${cond}`, 'ENDIF', ''].join('\n');
}

function makeHarness(opts: {
  /** deps.getIndex() 返回的"当前项目索引"（父 engine 的 last 来源） */
  currentIndex: ErbIndex;
  /** 盘上正文（readFiles 批量通道） */
  texts: Map<string, string>;
  lookup?: SchemaLookup;
}) {
  const batchCalls: string[][] = [];
  const engine = new ConditionEngine({
    log: silentLog,
    getProject: () => project,
    getIndex: () => opts.currentIndex,
    readFile: async (path) => {
      const t = opts.texts.get(path);
      if (t === undefined) throw new Error(`not found: ${path}`);
      return t;
    },
    readFiles: async (paths) => {
      batchCalls.push([...paths]);
      return paths.map((p) => opts.texts.get(p) ?? null);
    },
    scanControlFlow: async (text): Promise<ControlFlowStatement[]> => [...scanOnce(text)],
    getSchemaLookup: () => opts.lookup,
    compute: makeComputeStub(conditionExtractorTasks(scanOnce)),
  });
  return { engine, batchCalls };
}

const WORK = 'D:/game/workspace/K1.ERB';
const WORK_NAME = 'M_KOJO_K1_WORK';

describe('ConditionEngine.extractIndex（离线抽取）', () => {
  it('对传入索引抽取：byFunction 拿得到 dependencies（schema 标注 + 批量读一次）', async () => {
    const offlineIndex = makeIndex([erbFileOf(WORK, WORK_NAME, 1, 3)]);
    const lookup: SchemaLookup = (name, index) =>
      name === 'CFLAG' && index === 2 ? { name: 'CFLAG', index: 2, description: '好感度' } : undefined;
    const { engine, batchCalls } = makeHarness({
      currentIndex: makeIndex([]),
      texts: new Map([[WORK, erbText(WORK_NAME, 'CFLAG:2 >= 500')]]),
      lookup,
    });

    const out = await engine.extractIndex(offlineIndex);

    const cond = out.byFunction.get(WORK_NAME);
    expect(cond).toBeDefined();
    expect(cond!.filePath).toBe(WORK);
    expect(cond!.predicateCount).toBe(1);
    expect(cond!.dependencies).toHaveLength(1);
    expect(cond!.dependencies[0]).toMatchObject({
      key: 'CFLAG:2',
      name: 'CFLAG',
      indices: ['2'],
      count: 1,
      comparisons: [{ op: '>=', value: 500, text: '500' }],
      schema: { name: 'CFLAG', index: 2, description: '好感度' },
    });
    expect(out.stats).toMatchObject({ functions: 1, functionsWithDeps: 1, predicates: 1, dependencies: 1 });
    expect(out.projectRoot).toBe(project.rootDir);
    expect(batchCalls).toEqual([[WORK]]); // 复用 deps.readFiles 批量通道
    expect(engine.currentIndex()).toBeNull(); // 父引擎从未跑过全量索引，离线抽取不填充它
  });

  it('不碰父 engine：currentIndex 不变、订阅者不通知、明细 / 正文缓存不污染', async () => {
    const home = 'D:/game/home/P1.ERB';
    const homeName = 'M_KOJO_P1_HOME';
    const offlineIndex = makeIndex([erbFileOf(WORK, WORK_NAME, 1, 3)]);
    const { engine } = makeHarness({
      currentIndex: makeIndex([erbFileOf(home, homeName, 1, 3)]),
      texts: new Map([
        [home, erbText(homeName, 'CFLAG:3 >= 100')],
        [WORK, erbText(WORK_NAME, 'CFLAG:2 >= 500')],
      ]),
    });

    await engine.ensureIndex();
    const parentBefore = engine.currentIndex();
    expect(parentBefore!.byFunction.has(homeName)).toBe(true);
    expect(parentBefore!.byFunction.has(WORK_NAME)).toBe(false);

    const events: unknown[] = [];
    const unsub = engine.subscribe((i) => events.push(i));
    expect(events).toHaveLength(1); // 订阅立即回调当前值

    const out = await engine.extractIndex(offlineIndex);

    // 结果独立：离线索引的函数进结果，父索引的函数不进
    expect(out.byFunction.has(WORK_NAME)).toBe(true);
    expect(out.byFunction.has(homeName)).toBe(false);
    // 父状态逐项未被触碰
    expect(engine.currentIndex()).toBe(parentBefore);
    expect(engine.currentIndex()!.byFunction.has(homeName)).toBe(true);
    expect(events).toHaveLength(1); // extractIndex 没有 notify
    expect(engine.cacheStats()).toMatchObject({ details: 0, textFiles: 0, textChars: 0 });
    unsub();
  });

  it('空索引返回稳定空结果，不抛、也不读盘', async () => {
    const { engine, batchCalls } = makeHarness({ currentIndex: makeIndex([]), texts: new Map() });
    const out = await engine.extractIndex(makeIndex([]));
    expect(out.byFunction.size).toBe(0);
    expect(out.stats).toEqual({ functions: 0, functionsWithDeps: 0, predicates: 0, unparsed: 0, dependencies: 0 });
    expect(batchCalls.flat()).toEqual([]); // 无 pending 文件（批量通道可能收到空数组）
  });

  it('texts 覆盖表：不落盘的生成 ERB 也能抽取（不给表仍走读盘）', async () => {
    const virtualPath = 'D:/workspace/K1_生成.ERB';
    const virtualName = 'M_KOJO_K1_VIRTUAL';
    const offlineIndex = makeIndex([erbFileOf(virtualPath, virtualName, 1, 3)]);
    const { engine, batchCalls } = makeHarness({ currentIndex: makeIndex([]), texts: new Map() });

    // 盘上没有这个文件：不给覆盖表 ⇒ 读失败 ⇒ 该文件不留桶
    const withoutText = await engine.extractIndex(offlineIndex);
    expect(withoutText.byFunction.size).toBe(0);
    expect(batchCalls).toHaveLength(1); // 仍尝试过批量读

    const covered = new Map([[virtualPath, erbText(virtualName, 'CFLAG:7 >= 12')]]);
    const out = await engine.extractIndex(offlineIndex, covered);
    expect(out.byFunction.get(virtualName)?.dependencies[0]).toMatchObject({ key: 'CFLAG:7' });
    expect(batchCalls).toHaveLength(1); // 覆盖表命中 ⇒ 不再读盘
  });
});
