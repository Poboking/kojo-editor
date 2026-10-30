/**
 * ERB 调用层级判据（LAU-4 调用层级腿，2026-10-31）——从宿主 `monaco/erb-call-hierarchy.ts`
 * 搬进本插件，用例逐条跟过来、期望值一字未改（宿主那侧只留面板渲染与形状翻译）。
 *
 * 三条腿（假索引驱动，不依赖内核 / Monaco）：
 * - `resolveEnclosingFunction`：`functionAt` 三态（命中者权威 / 缺席退化自扫 / 抛错退化）；
 * - `incomingCalls`：`definition` 剔除、按调用者分组、索引缝条目 fail-open 跳过；
 * - `outgoingCalls`：只认 `kind === 'call'`、本文件 + 本函数区间、组间按首调用行排序；
 * 外加槽供方 `provideErbCallHierarchy` 的三态（弃权 / `subject: null` / 作答）与续问口径。
 */

import { describe, expect, it } from 'vitest';
import type { ErbFile, ErbFunction, ErbFunctionRef, ErbIndex, ErbReference } from '@kojo/plugin-api';
import {
  incomingCalls,
  outgoingCalls,
  resolveEnclosingFunction,
  type ErbFunctionAtResolver,
} from '../src/symbols';
import { provideErbCallHierarchy } from '../src/plugin';
import type { EditorLanguageServiceRequest } from '@kojo/plugin-api';

const FILE_A = 'C:\\game\\ERB\\A.ERB';
const FILE_B = 'C:\\game\\ERB\\B.ERB';

function fn(name: string, filePath: string, startLine: number, endLine: number): ErbFunction {
  return { name, normalizedName: name.toUpperCase(), params: [], startLine, endLine, filePath };
}

function fnRef(name: string, filePath: string, startLine: number, endLine: number): ErbFunctionRef {
  return { name, normalizedName: name.toUpperCase(), filePath, startLine, endLine };
}

function ref(
  kind: ErbReference['kind'],
  filePath: string,
  line: number,
  column = 1,
  endColumn = column + 5,
): ErbReference {
  return { filePath, line, column, endColumn, kind };
}

function file(path: string, functions: ErbFunction[]): ErbFile {
  return { path, functions, dims: [], hasFunctionDirective: false, lineCount: 200 };
}

function makeIndex(opts: {
  files?: ErbFile[];
  byName?: ReadonlyArray<[string, ErbFunctionRef[]]>;
  bySymbol?: ReadonlyArray<[string, ErbReference[]]>;
  withReferences?: boolean;
}): ErbIndex {
  return {
    files: new Map((opts.files ?? []).map((f) => [f.path, f])),
    byName: new Map(opts.byName ?? []),
    // references 是契约里的只读可选成员，构造期一次性给齐
    ...(opts.withReferences === false ? {} : { references: { bySymbol: new Map(opts.bySymbol ?? []) } }),
  } as ErbIndex;
}

/* ============================== 所属函数反查 ============================== */

describe('resolveEnclosingFunction', () => {
  const index = makeIndex({ files: [file(FILE_A, [fn('FOO', FILE_A, 10, 20), fn('BAR', FILE_A, 30, 40)])] });

  it('functionAt 在场 ⇒ 它的答案就是终局（答 undefined 也不退化自扫）', () => {
    const functionAt: ErbFunctionAtResolver = (path, line) =>
      path === FILE_A && line === 15 ? fn('FOO', FILE_A, 10, 20) : undefined;
    expect(resolveEnclosingFunction(index, functionAt, FILE_A, 15)?.name).toBe('FOO');
    // 25 行明明落在文件里两个函数之间——通道说没有就没有，不做第二判据叠加
    expect(resolveEnclosingFunction(index, functionAt, FILE_A, 25)).toBeUndefined();
  });

  it('functionAt 抛错 ⇒ 退化到索引定义区间判断', () => {
    const functionAt: ErbFunctionAtResolver = () => {
      throw new Error('service hiccup');
    };
    expect(resolveEnclosingFunction(index, functionAt, FILE_A, 35)?.name).toBe('BAR');
  });

  it('functionAt 缺席 ⇒ 直接走索引定义区间（含端点）', () => {
    expect(resolveEnclosingFunction(index, null, FILE_A, 10)?.name).toBe('FOO'); // @ 行本身
    expect(resolveEnclosingFunction(index, null, FILE_A, 20)?.name).toBe('FOO'); // 末行
    expect(resolveEnclosingFunction(index, null, FILE_A, 25)).toBeUndefined(); // 函数之间
    expect(resolveEnclosingFunction(index, null, FILE_B, 15)).toBeUndefined(); // 未知文件
  });
});

/* ============================== 入边 ============================== */

describe('incomingCalls', () => {
  const files = [
    file(FILE_A, [fn('TARGET', FILE_A, 10, 20), fn('CALLER1', FILE_A, 30, 40)]),
    file(FILE_B, [fn('CALLER2', FILE_B, 5, 15)]),
  ];
  const bySymbol: ReadonlyArray<[string, ErbReference[]]> = [
    [
      'TARGET',
      [
        ref('definition', FILE_A, 10, 2, 8), // 定义行自身：剔除
        ref('call', FILE_A, 31, 3, 9), // CALLER1 体内
        ref('call', FILE_A, 33, 5, 11), // CALLER1 体内第二处
        ref('mention', FILE_B, 7, 1, 7), // CALLER2 体内（表达式调用）
        ref('call', FILE_A, 99, 1, 6), // 顶层代码（不在任何函数体内）：fail-open 跳过
      ],
    ],
  ];
  const index = makeIndex({
    files,
    byName: [['TARGET', [fnRef('TARGET', FILE_A, 10, 20)]]],
    bySymbol,
  });

  it('名字大小写不敏感（归一化大写查表）', () => {
    expect(incomingCalls(index, null, 'target').length).toBeGreaterThan(0);
    expect(incomingCalls(index, null, 'TARGET').length).toBeGreaterThan(0);
  });

  it('definition 剔除；组内点位序、组间首现序；索引缝条目跳过', () => {
    const groups = incomingCalls(index, null, 'TARGET');
    expect(groups.map((g) => g.symbol.name)).toEqual(['CALLER1', 'CALLER2']);
    expect(groups[0]!.sites.map((s) => s.line)).toEqual([31, 33]);
    expect(groups[1]!.sites.map((s) => s.line)).toEqual([7]);
  });

  it('functionAt 在场时走通道（反查不了的行照样跳过）', () => {
    const functionAt: ErbFunctionAtResolver = (path, line) => {
      if (path === FILE_A && line >= 30 && line <= 40) return fn('CALLER1', FILE_A, 30, 40);
      return undefined; // CALLER2 的行反查不了 ⇒ 那条整组消失
    };
    const groups = incomingCalls(index, functionAt, 'TARGET');
    expect(groups.map((g) => g.symbol.name)).toEqual(['CALLER1']);
  });

  it('名字无记录 / 反向索引缺席 ⇒ 空数组（不猜）', () => {
    expect(incomingCalls(index, null, 'NOBODY')).toEqual([]);
    expect(incomingCalls(makeIndex({ files, withReferences: false }), null, 'TARGET')).toEqual([]);
  });
});

/* ============================== 出边 ============================== */

describe('outgoingCalls', () => {
  const index = makeIndex({
    files: [file(FILE_A, [fn('FOO', FILE_A, 10, 20), fn('BAR', FILE_A, 30, 40)])],
    byName: [
      ['FOO', [fnRef('FOO', FILE_A, 10, 20)]],
      ['BAR', [fnRef('BAR', FILE_A, 30, 40)]],
      ['BAZ', [fnRef('BAZ', FILE_B, 1, 9)]],
    ],
    bySymbol: [
      [
        'BAR',
        [
          ref('call', FILE_A, 12, 1, 4), // FOO 体内调 BAR
          ref('mention', FILE_A, 14, 1, 4), // mention 不进出边
          ref('call', FILE_A, 31, 1, 4), // BAR 自己体内——不属于 FOO
          ref('call', FILE_B, 12, 1, 4), // 别的文件
        ],
      ],
      ['BAZ', [ref('call', FILE_A, 18, 2, 6)]], // FOO 体内调 BAZ
      ['QUX', [ref('call', FILE_A, 11, 1, 4)]], // byName 没有这个名字：fail-open 跳过
    ],
  });

  it('只认 call + 本文件 + 本函数区间；组按首调用行排序', () => {
    const groups = outgoingCalls(index, { filePath: FILE_A, startLine: 10, endLine: 20 });
    // QUX（byName 查不到）被 fail-open 跳过；mention 与跨文件/跨函数的 call 都不沾；
    // 首调用行 12（BAR）在 18（BAZ）之前
    expect(groups.map((g) => g.symbol.name)).toEqual(['BAR', 'BAZ']);
    expect(groups[0]!.sites.map((s) => s.line)).toEqual([12]);
    expect(groups[1]!.sites.map((s) => s.line)).toEqual([18]);
  });

  it('区间按函数切：BAR 区间只收它体内的调用（含自调用递归边）', () => {
    const groups = outgoingCalls(index, { filePath: FILE_A, startLine: 30, endLine: 40 });
    // line 31 是 BAR 体内的 CALL BAR（自调用）；12/18 在 FOO 区间、FILE_B 的不沾
    expect(groups.map((g) => g.symbol.name)).toEqual(['BAR']);
    expect(groups[0]!.sites.map((s) => s.line)).toEqual([31]);
  });

  it('反向索引缺席 ⇒ 空数组（与入边同源，索引没有就都没有）', () => {
    const bare = makeIndex({ files: [file(FILE_A, [fn('FOO', FILE_A, 10, 20)])], withReferences: false });
    expect(outgoingCalls(bare, { filePath: FILE_A, startLine: 10, endLine: 20 })).toEqual([]);
  });
});

/* ============================== 槽供方三态 ============================== */

describe('provideErbCallHierarchy（槽 `callHierarchy` 供方）', () => {
  const index = makeIndex({
    files: [
      file(FILE_A, [
        fn('TARGET', FILE_A, 10, 20),
        fn('CALLER1', FILE_A, 30, 40),
        fn('LEAF', FILE_A, 50, 60),
      ]),
    ],
    byName: [
      ['TARGET', [fnRef('TARGET', FILE_A, 10, 20)]],
      ['CALLER1', [fnRef('CALLER1', FILE_A, 30, 40)]],
      ['LEAF', [fnRef('LEAF', FILE_A, 50, 60)]],
    ],
    bySymbol: [
      // TARGET 体内两处调用：15 调 CALLER1、16 调 LEAF
      ['CALLER1', [ref('call', FILE_A, 15, 3, 10)]],
      ['LEAF', [ref('call', FILE_A, 16, 3, 7)]],
      // CALLER1 体内一处：30..40 里的 31 调 TARGET
      ['TARGET', [ref('definition', FILE_A, 10, 2), ref('call', FILE_A, 31, 3)]],
    ],
  });

  function request(over: Partial<EditorLanguageServiceRequest> = {}): EditorLanguageServiceRequest {
    return {
      kind: 'callHierarchy',
      path: FILE_A,
      line: 15,
      project: null,
      ...over,
    } as EditorLanguageServiceRequest;
  }

  it('认这个文件就作答：光标处的函数 + 入边 + 出边 + 台账可用位', () => {
    const result = provideErbCallHierarchy(request(), index);
    expect(result).toBeDefined();
    expect(result!.kind).toBe('callHierarchy');
    expect(result!.subject?.name).toBe('TARGET');
    expect(result!.incoming.map((g) => g.symbol.name)).toEqual(['CALLER1']);
    expect(result!.incoming[0]!.sites.map((s) => s.line)).toEqual([31]);
    // 出边按各组首调用行排序：15（CALLER1）在 16（LEAF）之前
    expect(result!.outgoing.map((g) => g.symbol.name)).toEqual(['CALLER1', 'LEAF']);
    expect(result!.referencesAvailable).toBe(true);
  });

  it('这一行不在任何函数体内 ⇒ `subject: null`（作答，不夹取、不弃权）', () => {
    const result = provideErbCallHierarchy(request({ line: 25 }), index);
    expect(result).toEqual({ kind: 'callHierarchy', subject: null, incoming: [], outgoing: [], referencesAvailable: true });
  });

  it('反向索引缺席 ⇒ 两条腿都空，但 `referencesAvailable: false`（空 ≠ 没有调用关系）', () => {
    const bare = makeIndex({ files: [file(FILE_A, [fn('TARGET', FILE_A, 10, 20)])], withReferences: false });
    const result = provideErbCallHierarchy(request(), bare);
    expect(result!.subject?.name).toBe('TARGET');
    expect(result!.incoming).toEqual([]);
    expect(result!.outgoing).toEqual([]);
    expect(result!.referencesAvailable).toBe(false);
  });

  it('弃权两例：非 ERB 方言 / 索引未建（真没有 ≠ 我还没有名录）', () => {
    expect(provideErbCallHierarchy(request({ path: 'C:\\game\\ERB\\A.kojo' }), index)).toBeUndefined();
    expect(provideErbCallHierarchy(request(), null)).toBeUndefined();
  });

  it('续问（`subject`）：按节点取边，不再按位置求包围函数', () => {
    const subject = { name: 'CALLER1', normalizedName: 'CALLER1', filePath: FILE_A, startLine: 30, endLine: 40 };
    // line 指向函数之间的空行：若还按位置求，会是 `subject: null`
    const result = provideErbCallHierarchy(request({ line: 25, subject }), index);
    expect(result!.subject).toEqual(subject);
    expect(result!.incoming.map((g) => g.symbol.name)).toEqual(['TARGET']);
    expect(result!.outgoing.map((g) => g.symbol.name)).toEqual(['TARGET']);
  });
});