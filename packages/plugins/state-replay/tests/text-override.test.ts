/**
 * 缓冲区文本回放（`ReplayFunctionOptions.textOverride`；2026-11-05 状态回放可用性批）。
 *
 * 宿主已有 `editor.documentChanged`（带缓冲区文本），未保存的编辑必须能进回放链：
 * - `replayFunction` 把 override **透传给抽取器**（第二形参），抽取器按它解析、不读盘；
 * - 台词推演与循环量窗口档取行也优先用 override 切行（改一行正文能反映到推演）；
 * - override **不进 lineCache**：随后不带 override 的回放必须仍读盘、拿磁盘正文
 *   （否则就是新的"看不出来的不一致"）。
 *
 * 全部用假 deps（不碰真实内核 / 抽取器）：本文件钉引擎侧编排与取行口径，抽取器侧
 * 判据在 `condition-extractor/tests/function-predicates-override.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import type { FunctionPredicates, Logger, SnapshotArchive } from '@kojo/plugin-api';
import { splitEolLines } from '@kojo/plugin-api/eol';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { StateReplayEngine } from '../src/engine';

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 一份正文的行字符总数（与 `lineCache` 的记账尺子同量纲：验"缓存里存的是谁"） */
function charsOf(text: string): number {
  return splitEolLines(text).reduce((n, s) => n + s.length, 0);
}

/** 一个角色 NO=49、CFLAG:2=800、PALAM:0..2=5 的合成档 */
function archive(): SnapshotArchive {
  return {
    path: 'D:/fake/save.sav',
    fileName: 'save.sav',
    size: 0,
    format: 'gzip',
    version: 1808,
    fileType: 'normal',
    uniqueCode: '7153',
    gameVersion: '0',
    saveMes: '',
    charCount: 1,
    decompressedSize: 0,
    bodySize: 0,
    consumed: 0,
    remaining: 0,
    chars: [
      {
        index: 0,
        dimSepIndex: null,
        vars: [
          { type: 'int', key: 'NO', value: 49, offset: 0 },
          { type: 'str', key: 'NAME', value: '古明地 觉', offset: 0 },
          {
            type: 'int-array-1d',
            key: 'CFLAG',
            saveLen: [100],
            cursor: [100],
            nonEmpty: 1,
            cells: [{ index: [2], value: 800 }],
            offset: 0,
          },
          {
            type: 'int-array-1d',
            key: 'PALAM',
            saveLen: [100],
            cursor: [100],
            nonEmpty: 3,
            cells: [
              { index: [0], value: 5 },
              { index: [1], value: 5 },
              { index: [2], value: 5 },
            ],
            offset: 0,
          },
        ],
      },
    ],
    vars: [],
  };
}

const A_FILE = 'D:/fake/kojo/fn-a.erb';
const LOOP_FILE = 'D:/fake/kojo/fn-loop.erb';

/** 盘上正文（`FN_A`：谓词假 / 磁盘台词 / 一处写） */
const DISK_A = ['@FN_A()', 'IF CFLAG:2 >= 900', 'ENDIF', 'PRINTL 磁盘台词', 'CFLAG:2 += 10', ''].join('\n');
/** 编辑器缓冲区正文（未保存：谓词真 / 缓冲台词 / 另一处写） */
const BUFFER_A = ['@FN_A()', 'IF CFLAG:2 >= 500', 'ENDIF', 'PRINTL 缓冲台词', 'CFLAG:2 += 20', ''].join('\n');

/** 盘上正文（`FN_LOOP`：循环量窗口干净 ⇒ 逐值试算可判） */
const DISK_LOOP = ['@FN_LOOP()', 'LOCAL = 0', 'FOR LOCAL,0,2', 'LOCAL:1 = 5', 'IF PALAM:LOCAL > 3', 'ENDIF', 'NEXT'].join('\n');
/** 缓冲区正文（窗口里写了循环量本身 ⇒ 窗口档失效，落回 unknown） */
const BUFFER_LOOP = ['@FN_LOOP()', 'LOCAL = 0', 'FOR LOCAL,0,2', 'LOCAL = 7', 'IF PALAM:LOCAL > 3', 'ENDIF', 'NEXT'].join('\n');

const DISK_FILES: Record<string, string> = { [A_FILE]: DISK_A, [LOOP_FILE]: DISK_LOOP };

/**
 * **插行场景**（评审 P0 的复现形状）：盘上函数 1..12，谓词在第 9 行、写点在第 11 行；
 * 缓冲区在文件顶部插 5 行（未保存）⇒ 函数 6..17、谓词 14、写点 16。
 */
const SHIFTED_DISK = [
  '@FN_A()', // 1
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
const SHIFTED_INSERTED = ['; 插入 1', '; 插入 2', '; 插入 3', '; 插入 4', '; 插入 5'].join('\n');
const SHIFTED_BUFFER = `${SHIFTED_INSERTED}\n${[
  '@FN_A()', // 6
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

/** 从一份正文（按行）建 `FN_A` 明细：谓词取第一行 `IF`，显示行取第一行 `PRINTL`
 *  `startLine` 取 `@FN_A` 头所在行（**缓冲区坐标**——抽取器修好 P0 后就是这份语义）。 */
function detailOfA(text: string): FunctionPredicates {
  const lines = text.split('\n');
  const startLine = lines.findIndex((l) => /^@FN_A\s*\(/i.test(l.trim())) + 1;
  const predicates: FunctionPredicates['predicates'] = [];
  const displays: NonNullable<FunctionPredicates['displays']> = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    const ifm = /^IF\s+(.+)$/i.exec(t);
    if (ifm) predicates.push({ kind: 'IF', text: ifm[1]!, expr: parseExpression(ifm[1]!), line: i + 1, depth: 0 });
    const pm = /^PRINTL\s+(.+)$/i.exec(t);
    if (pm) displays.push({ line: i + 1, verb: 'PRINTL', payload: pm[1]!, interpolations: [] });
  });
  return {
    normalizedName: 'FN_A',
    filePath: A_FILE,
    startLine: startLine > 0 ? startLine : 1,
    endLine: lines.length,
    statements: [],
    predicates,
    assignments: [],
    returns: [],
    ...(displays.length > 0 ? { displays } : {}),
  };
}

/** 从一份正文建 `FN_LOOP` 明细：循环元数据固定（`FOR LOCAL,0,2`，区间 [0,2]） */
function detailOfLoop(text: string): FunctionPredicates {
  const lines = text.split('\n');
  const lineOf = (re: RegExp): number => lines.findIndex((l) => re.test(l.trim())) + 1;
  const exprText = 'PALAM:LOCAL > 3';
  return {
    normalizedName: 'FN_LOOP',
    filePath: LOOP_FILE,
    startLine: 1,
    endLine: lines.length,
    statements: [],
    predicates: [
      { kind: 'IF', text: exprText, expr: parseExpression(exprText), line: lineOf(/^IF\s/), depth: 0 },
    ],
    assignments: [],
    returns: [],
    loopCounters: [
      {
        name: 'LOCAL',
        index: 0,
        openLine: lineOf(/^FOR\s/),
        closeLine: lineOf(/^NEXT/),
        lo: 0,
        hi: 2,
        firstBodyLine: lineOf(/^FOR\s/) + 1,
      },
    ],
  };
}

interface Harness {
  readonly engine: StateReplayEngine;
  /** functionPredicates 的调用记录（name + 第二形参） */
  readonly calls: Array<{ name: string; textOverride?: string }>;
  /** readFileText（磁盘正文）调用次数 */
  readonly reads: () => number;
}

/**
 * 假 deps：`functionPredicates` 按 override 优先选正文（模拟抽取器的新形参语义），
 * `readFileText` 只返回盘上正文并记次。
 * `files`：盘上正文表（缺省 `DISK_FILES`）；`failRead`：模拟磁盘不可读（取行失败）。
 */
function makeHarness(
  provider: (text: string, name: string) => FunctionPredicates | null,
  opts: { files?: Record<string, string>; failRead?: boolean } = {},
): Harness {
  const files = opts.files ?? DISK_FILES;
  const calls: Array<{ name: string; textOverride?: string }> = [];
  let readCount = 0;
  const engine = new StateReplayEngine({
    log: silent,
    parseArchive: async () => archive(),
    functionPredicates: async (name, textOverride) => {
      calls.push({ name, ...(textOverride === undefined ? {} : { textOverride }) });
      const text = textOverride ?? files[name === 'FN_LOOP' ? LOOP_FILE : A_FILE] ?? '';
      return provider(text, name);
    },
    getSchemaLookup: () => undefined,
    readFileText: async (path) => {
      readCount++;
      if (opts.failRead) throw new Error(`磁盘不可读：${path}`);
      const t = files[path];
      if (t === undefined) throw new Error(`not found: ${path}`);
      return t;
    },
  });
  return { engine, calls, reads: () => readCount };
}

function harness(): Harness {
  return makeHarness((text, name) => (name === 'FN_LOOP' ? detailOfLoop(text) : detailOfA(text)));
}

const SAV = 'D:/fake/save.sav';

describe('textOverride：引擎 → 抽取器 → 取行', () => {
  it('override 原样透传给 functionPredicates（第二形参）；取行走 override，lineCache 只存磁盘正文', async () => {
    const h = harness();
    const view = await h.engine.createView(SAV, 49);
    // 缓冲区比盘上多一行注释（字数不同：用来证明 lineCache 里存的不是缓冲区）
    const buffer = `${BUFFER_A}\n; 缓冲区多出来的尾行（长度与磁盘不同）`;
    const r = (await h.engine.replayFunction(view, 'FN_A', { textOverride: buffer }))!;
    expect(h.calls[0]).toEqual({ name: 'FN_A', textOverride: buffer });
    // 台词推演的取行来自 buffer（若走了 lineCache，会是磁盘台词）
    expect(r.transcript?.[0]?.text).toBe('缓冲台词');
    // 缓冲文本回放（2026-11-05 边界批起）：内联预热也吃缓冲正文 ⇒ 这次回放**不该把盘上正文
    // 烤进 lineCache**；正向判据 = 缓存里若真有正文，只能是磁盘那份，绝不能等于 buffer。
    expect(h.engine.cacheStats().chars).not.toBe(charsOf(buffer));
    expect([0, charsOf(DISK_A)]).toContain(h.engine.cacheStats().chars);
  });

  it('台词推演 / 谓词 / 写点都来自 override 文本（改一行正文能反映到推演）', async () => {
    const h = harness();
    const view = await h.engine.createView(SAV, 49);
    const r = (await h.engine.replayFunction(view, 'FN_A', { textOverride: BUFFER_A }))!;
    expect(r.predicates[0]!.outcome).toEqual({ kind: 'true' }); // CFLAG:2=800 >= 500
    expect(r.transcript?.[0]?.text).toBe('缓冲台词');
    expect(r.unmodeledWrites).toEqual([{ line: 5, text: 'CFLAG:2 += 20', kind: 'assign' }]);
  });

  it('P0 插行场景：缓冲区插 5 行 ⇒ startLine / 谓词行 / 写点行都跟缓冲区走', async () => {
    const h = makeHarness((text) => detailOfA(text), { files: { [A_FILE]: SHIFTED_DISK } });
    const view = await h.engine.createView(SAV, 49);

    // 无 override：盘上坐标（函数 1..12、谓词 9、写点 11）
    const fromDisk = (await h.engine.replayFunction(view, 'FN_A'))!;
    expect(fromDisk.startLine).toBe(1);
    expect(fromDisk.predicates[0]!.line).toBe(9);
    expect(fromDisk.unmodeledWrites).toEqual([{ line: 11, text: 'CFLAG:2 += 10', kind: 'assign' }]);

    // 有 override：缓冲区坐标（函数 6..17、谓词 14、写点 16）——
    // 旧实现拿磁盘索引区间切缓冲区，会得到 predicates: [] + confidence: 'exact'（P0）
    const fromBuffer = (await h.engine.replayFunction(view, 'FN_A', { textOverride: SHIFTED_BUFFER }))!;
    expect(fromBuffer.startLine).toBe(6);
    expect(fromBuffer.predicates).toHaveLength(1);
    expect(fromBuffer.predicates[0]!.line).toBe(14);
    expect(fromBuffer.predicates[0]!.outcome).toEqual({ kind: 'true' }); // 800 >= 500
    expect(fromBuffer.unmodeledWrites).toEqual([{ line: 16, text: 'CFLAG:2 += 20', kind: 'assign' }]);
  });

  it('override 不污染下一次无 override 的回放（拿回磁盘正文）', async () => {
    const h = harness();
    const view = await h.engine.createView(SAV, 49);

    const fromBuffer = (await h.engine.replayFunction(view, 'FN_A', { textOverride: BUFFER_A }))!;
    expect(fromBuffer.predicates[0]!.outcome).toEqual({ kind: 'true' });

    const fromDisk = (await h.engine.replayFunction(view, 'FN_A'))!;
    // 最后一次分派不再带 override（inline 预热的那次调用本来就不带）
    expect(h.calls[h.calls.length - 1]).toEqual({ name: 'FN_A' });
    expect(h.reads()).toBeGreaterThanOrEqual(1); // 磁盘正文确实被取过（内联预热 / 取行）
    expect(fromDisk.predicates[0]!.outcome).toEqual({ kind: 'false' }); // 800 >= 900
    expect(fromDisk.transcript?.[0]?.text).toBe('磁盘台词');
    expect(fromDisk.unmodeledWrites).toEqual([{ line: 5, text: 'CFLAG:2 += 10', kind: 'assign' }]);
    expect(h.engine.cacheStats().files).toBe(1); // 磁盘正文在缓存里（只有一份，按文件路径）
  });

  it('算过、零写点 ⇒ `unmodeledWrites: []`（空数组 = 结论可信；与缺省"不知道"分开）', async () => {
    const plain = ['@FN_A()', 'IF CFLAG:2 >= 500', 'ENDIF', ''].join('\n');
    const h = makeHarness((text, name) =>
      name === 'FN_LOOP' ? detailOfLoop(text) : { ...detailOfA(text), displays: undefined, predicates: [] },
    );
    const view = await h.engine.createView(SAV, 49);
    const r = (await h.engine.replayFunction(view, 'FN_A', { textOverride: plain }))!;
    expect(r.unmodeledWrites).toEqual([]); // 行文本拿到了、判据跑完了：零写点
    expect(r).not.toHaveProperty('transcript');
  });

  it('行文本不可得 ⇒ `unmodeledWrites` 缺省（undefined = 不知道，不许当零写点）', async () => {
    const h = makeHarness((text) => detailOfA(text), { failRead: true });
    const view = await h.engine.createView(SAV, 49);
    const r = (await h.engine.replayFunction(view, 'FN_A'))!;
    expect(r).not.toHaveProperty('unmodeledWrites');
    expect(r).not.toHaveProperty('transcript');
  });
});

describe('textOverride：循环量窗口档的取行也走 override', () => {
  it('lineCache 已是盘上正文时，override 的脏窗口仍生效 ⇒ 判不出（证明窗口行来自 override）', async () => {
    const h = harness();
    const view = await h.engine.createView(SAV, 49);

    // 先跑盘上正文：窗口 `LOCAL:1 = 5` 写不到循环量 ⇒ 逐值试算 [0,1,2] 恒真；
    // 这一次也把盘上正文烤进 lineCache（内联预热会读本文件的行）。
    const fromDisk = (await h.engine.replayFunction(view, 'FN_LOOP'))!;
    expect(fromDisk.predicates[0]!.outcome).toEqual({ kind: 'true' });

    // 再跑缓冲区：窗口里 `LOCAL = 7` 写了循环量本身 ⇒ 窗口档失效、落回 unknown。
    // 若取行走的是 lineCache（盘上正文），这次仍会判 true。
    const fromBuffer = (await h.engine.replayFunction(view, 'FN_LOOP', { textOverride: BUFFER_LOOP }))!;
    expect(fromBuffer.predicates[0]!.outcome.kind).toBe('unknown');
  });
});
