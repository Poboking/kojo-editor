/**
 * 抽取器的 `functionPredicates(name, textOverride?)`（2026-11-05 状态回放可用性批；
 * 修 P0 后重写：**缓冲区分支必须用缓冲区自己的行号空间**）。
 *
 * 契约第二形参是**该函数所在文件的缓冲区文本**（未保存编辑）。判据：
 * - 给了 override ⇒ 按这份正文扫描 / 抽取，**不读盘**；行号**按缓冲区**——
 *   作者在函数前插/删行时，磁盘索引的 `startLine/endLine` 会整体错位，拿它切缓冲区
 *   会把整段谓词切成空集（评审 P0 实锤：`predicates: [] + confidence: 'exact'`，
 *   比报错更坏）。所以 override 分支在缓冲区里按行首 `@NAME` 重定位函数
 *   （`erb.parser.parseText`，与索引 scanner 同源），`startLine/endLine` 跟缓冲区走；
 * - 找不到同名函数（改名 / 删除 / 不在缓冲区里）⇒ **null**（显式，不伪造空结果）；
 * - override 走**临时分支**：不写 `detailCache` / `fileTextCache` ⇒ 随后不带 override
 *   的调用仍读盘、拿盘上正文（缓存未被污染）；盘上明细已在缓存里也不许把 override
 *   调用短路成旧正文。
 *
 * 本测试用**真实** `parseErbText`（不是手写假区间的假解析器）——P0 的教训就是
 * "两个行号空间被混用"，假解析器恰好会把这类错误盖住。
 */
import { parseErbText } from '@kojo/plugin-erb-parser';
import { functionLookupOf } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import type {
  ComputePool,
  ControlFlowStatement,
  ErbFile,
  ErbFunctionRef,
  ErbIndex,
  GameProject,
  Logger,
} from '@kojo/plugin-api';
import { ConditionEngine } from '../src/engine';
import { conditionExtractorTasks } from '../src/offload';

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const project = { rootDir: 'D:/game', adapterId: 'eratw', inputDigest: 'd1' } as unknown as GameProject;

const FILE = '/f/override.ERB';

/**
 * 盘上正文：函数在 1..12，谓词在**第 9 行**，写点在**第 11 行**
 * （形状照评审探针：函数区间在盘上索引里是 1..12）。
 */
const DISK = [
  '@FN()', // 1
  'LOCAL = 0', // 2
  '; pad 3', // 3
  '; pad 4', // 4
  '; pad 5', // 5
  '; pad 6', // 6
  '; pad 7', // 7
  '; pad 8', // 8
  'IF CFLAG:2 >= 900', // 9
  'ENDIF', // 10
  'CFLAG:2 += 10', // 11
  '; tail', // 12
].join('\n');

/** 缓冲区：在文件顶部**插 5 行**（未保存）⇒ 函数 6..17、谓词 14、写点 16 */
const INSERTED = ['; 插入 1', '; 插入 2', '; 插入 3', '; 插入 4', '; 插入 5'].join('\n');
const BUFFER = `${INSERTED}\n${[
  '@FN()', // 6
  'LOCAL = 0', // 7
  '; pad 3', // 8
  '; pad 4', // 9
  '; pad 5', // 10
  '; pad 6', // 11
  '; pad 7', // 12
  '; pad 8', // 13
  'IF CFLAG:2 >= 500', // 14
  'ENDIF', // 15
  'CFLAG:2 += 20', // 16
  '; tail', // 17
].join('\n')}`;

/** 缓冲区：**等长**改字（只改谓词常量与写点值，不插删行） */
const BUFFER_SAME_LINES = DISK.replace('>= 900', '>= 500').replace('+= 10', '+= 20');

/** 计算池替身（本用例只走按需明细路径，不触发全量抽取） */
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

/** 盘上索引的函数区间：用真 scanner 对盘上正文的判定，不手写 */
function erbFile(disk: string = DISK): ErbFile {
  const parsed = parseErbText(disk, FILE);
  return {
    path: FILE,
    functions: parsed.functions.map((fn) => ({
      name: fn.name,
      normalizedName: fn.normalizedName,
      params: [],
      startLine: fn.startLine,
      endLine: fn.endLine,
      filePath: FILE,
      isExpressionFunction: false,
    })),
    dims: [],
    hasFunctionDirective: false,
    lineCount: parsed.lineCount,
  } as ErbFile;
}

function byNameOf(files: Map<string, ErbFile>): Map<string, ErbFunctionRef[]> {
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const f of files.values()) {
    for (const fn of f.functions) {
      const list = byName.get(fn.normalizedName) ?? [];
      list.push(fn);
      byName.set(fn.normalizedName, list);
    }
  }
  return byName;
}

/** 纯扫描器：逐行认 `IF` / `ENDIF`（行号 = 文本自己的坐标系） */
function scan(text: string): ControlFlowStatement[] {
  const out: ControlFlowStatement[] = [];
  text.split('\n').forEach((line, idx) => {
    const m = /^IF\s+(.*)$/.exec(line);
    if (m) out.push({ kind: 'IF', expression: m[1]!, depth: 0, line: idx + 1 });
    if (/^ENDIF/.test(line)) out.push({ kind: 'ENDIF', expression: '', depth: 0, line: idx + 1 });
  });
  return out;
}

interface Harness {
  readonly engine: ConditionEngine;
  readonly reads: () => number;
  /** `parseText` 被调次数（override 路径的记忆是否真在省解析，用这个读数说话） */
  readonly parseCalls: () => number;
}

/**
 * `withParseText: false` 模拟**旧装配**（没有 `erb.parser.parseText` 依赖）：
 * 缓冲区分支必须显式 null，不许退回磁盘区间（那正是 P0）。
 * `disk`：盘上正文（缺省 `DISK`）；索引由真 `parseErbText` 对该正文判定生成。
 */
function makeHarness(opts: { withParseText?: boolean; disk?: string } = {}): Harness {
  const disk = opts.disk ?? DISK;
  const files = new Map<string, ErbFile>([[FILE, erbFile(disk)]]);
  const index = { files, byName: functionLookupOf(byNameOf(files)) } as unknown as ErbIndex;
  let readCount = 0;
  let parseCount = 0;
  const engine = new ConditionEngine({
    log: silent,
    getProject: () => project,
    getIndex: () => index,
    readFile: async (path) => {
      readCount++;
      if (path !== FILE) throw new Error(`not found: ${path}`);
      return disk;
    },
    scanControlFlow: async (text: string): Promise<ControlFlowStatement[]> => scan(text),
    ...(opts.withParseText === false
      ? {}
      : {
          parseText: (text: string, path?: string): ErbFile => {
            parseCount++;
            return parseErbText(text, path ?? FILE);
          },
        }),
    getSchemaLookup: () => undefined,
    compute: makeComputeStub(conditionExtractorTasks(scan)),
  });
  return { engine, reads: () => readCount, parseCalls: () => parseCount };
}

describe('functionPredicates(name, textOverride)：行号空间（P0）', () => {
  it('缓冲区在函数前插 5 行 ⇒ startLine / 谓词行号都跟缓冲区走（不读盘、不写缓存）', async () => {
    const h = makeHarness();
    const detail = await h.engine.functionPredicates('FN', BUFFER);
    expect(detail).not.toBeNull();
    // 盘上索引是 1..12；缓冲区里同一函数是 6..17
    expect(detail!.startLine).toBe(6);
    expect(detail!.endLine).toBe(17);
    // 谓词行号是缓冲区坐标（盘上第 9 行 → 缓冲区第 14 行）
    expect(detail!.predicates).toHaveLength(1);
    expect(detail!.predicates[0]!.line).toBe(14);
    expect(detail!.predicates[0]!.text).toBe('CFLAG:2 >= 500');
    // 临时分支：不读盘、不写两条缓存
    expect(h.reads()).toBe(0);
    expect(h.engine.cacheStats()).toMatchObject({ details: 0, textFiles: 0, textChars: 0 });
  });

  it('函数内**等长改字**（正例）：行号不动、内容按缓冲区', async () => {
    const h = makeHarness();
    const detail = await h.engine.functionPredicates('FN', BUFFER_SAME_LINES);
    expect(detail!.startLine).toBe(1);
    expect(detail!.endLine).toBe(12);
    expect(detail!.predicates[0]!.line).toBe(9);
    expect(detail!.predicates[0]!.text).toBe('CFLAG:2 >= 500');
    expect(h.reads()).toBe(0);
  });

  it('随后不带 override：仍读盘、拿磁盘正文（缓冲区没污染缓存）', async () => {
    const h = makeHarness();
    await h.engine.functionPredicates('FN', BUFFER);
    expect(h.engine.cacheStats()).toMatchObject({ details: 0, textFiles: 0 });

    const detail = await h.engine.functionPredicates('FN');
    expect(detail!.startLine).toBe(1); // 盘上坐标
    expect(detail!.endLine).toBe(12);
    expect(detail!.predicates[0]!.line).toBe(9);
    expect(detail!.predicates[0]!.text).toBe('CFLAG:2 >= 900');
    expect(h.reads()).toBe(1);
    expect(h.engine.cacheStats()).toMatchObject({ details: 1, textFiles: 1 });
  });

  it('盘上明细已入缓存时，override 不被缓存短路（仍按缓冲区重定位）', async () => {
    const h = makeHarness();
    expect((await h.engine.functionPredicates('FN'))!.startLine).toBe(1);
    const readsAfterWarm = h.reads();

    const fromBuffer = await h.engine.functionPredicates('FN', BUFFER);
    expect(fromBuffer!.startLine).toBe(6);
    expect(fromBuffer!.predicates[0]!.line).toBe(14);
    expect(h.reads()).toBe(readsAfterWarm); // 不读盘
    expect(h.engine.cacheStats()).toMatchObject({ details: 1, textFiles: 1 }); // 一条没多

    const again = await h.engine.functionPredicates('FN');
    expect(again!.startLine).toBe(1);
    expect(again!.predicates[0]!.line).toBe(9);
    expect(h.reads()).toBe(readsAfterWarm);
  });

  it('缓冲区里找不到同名函数（改名 / 删除）⇒ null，不伪造空明细', async () => {
    const h = makeHarness();
    const renamed = BUFFER.replace('@FN()', '@OTHER_FN()');
    expect(await h.engine.functionPredicates('FN', renamed)).toBeNull();
    expect(h.reads()).toBe(0);
  });

  it('旧装配没有 parseText ⇒ override 显式 null（绝不退回磁盘区间）', async () => {
    const h = makeHarness({ withParseText: false });
    expect(await h.engine.functionPredicates('FN', BUFFER)).toBeNull();
    expect(h.reads()).toBe(0);
  });

  it('override 不影响「函数不在索引里 ⇒ null」的既有语义', async () => {
    const h = makeHarness();
    expect(await h.engine.functionPredicates('NO_SUCH_FN', BUFFER)).toBeNull();
    expect(h.reads()).toBe(0);
  });
});

/**
 * override 解析记忆（单条目；2026-11-05 P0 收尾）。
 *
 * 糖预览一次按**产物函数逐个**回放：N 个函数共用同一份 150 KB 产物文本。修前每个函数都
 * `parseText` 一遍（N 次全文解析/击键）；修后只记上一份（同一文本 + 同一 path 直接复用
 * 那棵 `ErbFile`）⇒ 一轮预览 1 次。只留一条：多条目会把整份产物文本常驻。
 */
describe('functionPredicates textOverride：解析记忆（单条目）', () => {
  /** 两个函数的盘上正文：`FN` 1..12、`FN2` 13..15（追加在 `DISK` 之后，FN 区间不变） */
  const DISK_TWO = `${DISK}\n@FN2()\nIF CFLAG:2 == 800\nENDIF`;
  /** 对应缓冲区：顶部插 5 行 ⇒ `FN` 6..17、`FN2` 18..20 */
  const BUFFER_TWO = `${BUFFER}\n@FN2()\nIF CFLAG:2 == 800\nENDIF`;

  it('同一份缓冲区问两个函数 ⇒ parseText 只调 1 次（修前 2 次）', async () => {
    const h = makeHarness({ disk: DISK_TWO });
    const a = await h.engine.functionPredicates('FN', BUFFER_TWO);
    const b = await h.engine.functionPredicates('FN2', BUFFER_TWO);
    expect(a!.startLine).toBe(6);
    expect(a!.predicates[0]!.line).toBe(14);
    expect(b!.startLine).toBe(18);
    expect(b!.predicates[0]!.line).toBe(19);
    expect(h.parseCalls()).toBe(1);
  });

  it('N=6 个函数共用同一份文本 ⇒ parseText 仍只调 1 次（修前 6 次）', async () => {
    // 糖预览的真实形状：一份产物文本里有 N 个函数，逐个回放都带同一份 textOverride
    const extra = Array.from({ length: 5 }, (_, i) => `@F${i}()\nIF CFLAG:2 == 800\nENDIF`);
    const disk = `${DISK}\n${extra.join('\n')}`;
    const buffer = `${BUFFER}\n${extra.join('\n')}`;
    const h = makeHarness({ disk });
    for (let i = 0; i < 5; i++) expect(await h.engine.functionPredicates(`F${i}`, buffer)).not.toBeNull();
    expect(await h.engine.functionPredicates('FN', buffer)).not.toBeNull();
    expect(h.parseCalls()).toBe(1);
  });

  it('同一 (text,name) 连调两次 ⇒ 仍只解析 1 次', async () => {
    const h = makeHarness();
    const first = await h.engine.functionPredicates('FN', BUFFER);
    const second = await h.engine.functionPredicates('FN', BUFFER);
    expect(second).toEqual(first); // 同一棵树给的同一份明细
    expect(h.parseCalls()).toBe(1);
  });

  it('换一份文本 ⇒ 再解析一次；换回上一份 ⇒ 再解析（只留一条，没有多条目表）', async () => {
    const h = makeHarness();
    await h.engine.functionPredicates('FN', BUFFER);
    expect(h.parseCalls()).toBe(1);
    await h.engine.functionPredicates('FN', BUFFER_SAME_LINES);
    expect(h.parseCalls()).toBe(2);
    await h.engine.functionPredicates('FN', BUFFER); // 上一份已被替换 ⇒ 再来一次
    expect(h.parseCalls()).toBe(3);
  });

  it('先 override 后无 override ⇒ 磁盘分支不碰解析记忆（parseText 次数不涨）', async () => {
    const h = makeHarness();
    await h.engine.functionPredicates('FN', BUFFER);
    expect(h.parseCalls()).toBe(1);
    const diskDetail = await h.engine.functionPredicates('FN');
    expect(diskDetail!.startLine).toBe(1); // 盘上坐标，不受缓冲区影响
    expect(diskDetail!.predicates[0]!.text).toBe('CFLAG:2 >= 900');
    expect(h.parseCalls()).toBe(1); // 磁盘分支根本不调 parseText
    // 再来一次同一份 override：记忆仍是那一条（没被磁盘调用挤掉）
    await h.engine.functionPredicates('FN', BUFFER);
    expect(h.parseCalls()).toBe(1);
  });

  it('clear()（项目关闭 / 重置）⇒ 解析记忆清空，不常驻上一份正文', async () => {
    const h = makeHarness();
    await h.engine.functionPredicates('FN', BUFFER);
    expect(h.parseCalls()).toBe(1);
    h.engine.clear();
    await h.engine.functionPredicates('FN', BUFFER);
    expect(h.parseCalls()).toBe(2);
  });
});
