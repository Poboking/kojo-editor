/**
 * ERB-CALLHIER · `erb-callhierarchy-provider.ts` 行为闸（批次九）。
 *
 * 覆盖面（按 describe 分组）：
 * - **prepare**：函数声明 / 体内任意行交回同一枚 item；调用位交回**所在函数**（与调用层级
 *   面板同一把尺子——判据住 `@kojo/plugin-erb-parser`，本层只转手）；函数之间 / 越界 /
 *   未知文件 / 索引缺席 / 坏位点 / 已释放 model 一律 `null`；`nameColumn` 缺席时行首退化；
 *   取数口交回的节点就是终局（命中即翻形状、抛错回空）；
 * - **入边**：按调用者分组、组内点位序与判据逐条对拍；跨文件调用者的区间尾列退化；
 *   名字大小写不敏感；JSON 往返后仍可查询；坏 item / 无名 / 无索引 / 取数腿抛错都回空；
 * - **出边**：只认本函数区间内的 `call`、组序按首调用行；跨文件被调函数的区间尾列退化；
 *   与判据逐条对拍；坏 item / 无索引 / 反向索引缺席都回空；
 * - **安装**：Monaco 0.57 无 `registerCallHierarchyProvider` ⇒ **零注册**且句柄幂等；
 *   有注册位 + 有取数口 ⇒ 恰好一枚、selector 只有 `ERB_LANGUAGE_ID`；无取数口 ⇒ 零注册
 *   （不装一枚永远答空的 provider）；dispose 幂等 / 撤不掉不抛 / 注册失败外抛；
 *   注册后的 provider 与 `createErbCallHierarchyProvider` 逐字同一份读数；取数口按调用时现取；
 * - **源码卫生 / 确定性**：Monaco 只 type-only、不碰 monaco 运行时、不 import 插件包；
 *   provider 里没有第二份引用判据（`bySymbol` / `kind === 'call'` 一概不出现）；
 *   同输入逐字相等、CRLF 同结果、item 区间包住 selectionRange。
 *
 * 夹具索引与 `packages/plugins/erb-parser/tests/call-hierarchy.test.ts` 同形（假 `ErbIndex`，
 * 不依赖内核 / Monaco 运行时）：用例里的取数口把**真判据**（插件供方）接到假索引上，
 * 于是 provider 交出的读数与判据逐条可对拍——翻译层不许漂。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import type {
  EditorLanguageServiceRequest,
  ErbFile,
  ErbFunction,
  ErbFunctionRef,
  ErbIndex,
  ErbReference,
} from '@kojo/plugin-api';
import {
  incomingCalls,
  outgoingCalls,
  provideErbCallHierarchy,
  resolveEnclosingFunction,
} from '@kojo/plugin-erb-parser';
import {
  createErbCallHierarchyProvider,
  installErbCallHierarchyProvider,
  type CallHierarchyAsk,
  type ErbCallHierarchyDeps,
  type ErbCallHierarchyItem,
  type ErbCallHierarchyProvider,
  type ErbIncomingCall,
  type ErbOutgoingCall,
} from '../src/monaco/erb-callhierarchy-provider';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';

/* ============================== 夹具：假索引 ============================== */

const FILE_A = 'C:\\game\\ERB\\A.ERB';
const FILE_B = 'C:\\game\\ERB\\B.ERB';
const FILE_C = 'C:\\game\\ERB\\C.ERB';

function fn(
  name: string,
  filePath: string,
  startLine: number,
  endLine: number,
  nameColumn?: number,
): ErbFunction {
  return {
    name,
    normalizedName: name.toUpperCase(),
    params: [],
    startLine,
    endLine,
    filePath,
    ...(nameColumn === undefined ? {} : { nameColumn }),
  };
}

function fnRef(
  name: string,
  filePath: string,
  startLine: number,
  endLine: number,
  nameColumn?: number,
): ErbFunctionRef {
  return {
    name,
    normalizedName: name.toUpperCase(),
    filePath,
    startLine,
    endLine,
    ...(nameColumn === undefined ? {} : { nameColumn }),
  };
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

function file(filePath: string, functions: ErbFunction[]): ErbFile {
  return { path: filePath, functions, dims: [], hasFunctionDirective: false, lineCount: 200 };
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
    ...(opts.withReferences === false
      ? {}
      : { references: { bySymbol: new Map(opts.bySymbol ?? []) } }),
  } as ErbIndex;
}

const FILES: ErbFile[] = [
  file(FILE_A, [
    fn('TARGET', FILE_A, 10, 20, 2),
    fn('BAR', FILE_A, 22, 24, 2),
    fn('CALLER1', FILE_A, 30, 40, 2),
    fn('PLAIN', FILE_A, 45, 47),
  ]),
  file(FILE_B, [fn('CALLER2', FILE_B, 5, 15, 2), fn('CALLEE', FILE_B, 20, 28, 2)]),
];

const BY_NAME: ReadonlyArray<[string, ErbFunctionRef[]]> = [
  ['TARGET', [fnRef('TARGET', FILE_A, 10, 20, 2)]],
  ['BAR', [fnRef('BAR', FILE_A, 22, 24, 2)]],
  ['CALLER1', [fnRef('CALLER1', FILE_A, 30, 40, 2)]],
  ['CALLER2', [fnRef('CALLER2', FILE_B, 5, 15, 2)]],
  ['CALLEE', [fnRef('CALLEE', FILE_B, 20, 28, 2)]],
  ['PLAIN', [fnRef('PLAIN', FILE_A, 45, 47)]],
];

/**
 * 反向索引：`TARGET` 的两条 `call` 落在 CALLER1 体内、一条 `mention` 落在 CALLER2 体内、
 * 还有一条 `call` 在顶层（不在任何函数体内 ⇒ 纯模型 fail-open 跳过）。
 * `CALLEE` / `BAR` 给 TARGET 的出边；`QUX` 在 `byName` 里没有定义（纯模型 fail-open 跳过）。
 */
const BY_SYMBOL: ReadonlyArray<[string, ErbReference[]]> = [
  [
    'TARGET',
    [
      ref('definition', FILE_A, 10, 2, 8),
      ref('call', FILE_A, 31, 3, 9),
      ref('call', FILE_A, 33, 5, 11),
      ref('mention', FILE_B, 7, 1, 7),
      ref('call', FILE_A, 99, 1, 6),
    ],
  ],
  [
    'CALLEE',
    [ref('call', FILE_A, 12, 1, 6), ref('call', FILE_B, 22, 1, 6)],
  ],
  [
    'BAR',
    [
      ref('mention', FILE_A, 14, 1, 4),
      ref('call', FILE_A, 18, 2, 5),
      ref('call', FILE_A, 31, 1, 4),
      ref('call', FILE_B, 12, 1, 4),
    ],
  ],
  ['QUX', [ref('call', FILE_A, 11, 1, 4)]],
];

const INDEX = makeIndex({ files: FILES, byName: BY_NAME, bySymbol: BY_SYMBOL });

/* ============================== 夹具：Monaco model ============================== */

/** 48 行源文：只给关键行内容（尾列翻译要行宽），其余行占位。 */
const TEXT_LINES: string[] = Array.from({ length: 48 }, (_, index) => `; 第 ${index + 1} 行`);
TEXT_LINES[9] = '@TARGET()'; // 10
TEXT_LINES[11] = '    CALL CALLEE'; // 12
TEXT_LINES[17] = '    CALL BAR'; // 18
TEXT_LINES[19] = '    RETURN'; // 20
TEXT_LINES[21] = '@BAR()'; // 22
TEXT_LINES[23] = '    RETURN'; // 24
TEXT_LINES[29] = '@CALLER1()'; // 30
TEXT_LINES[30] = '    CALL TARGET(1)'; // 31
TEXT_LINES[32] = '    CALL TARGET(2)'; // 33
TEXT_LINES[39] = '    RETURN'; // 40
TEXT_LINES[44] = '@PLAIN'; // 45
TEXT_LINES[46] = '    RETURN'; // 47
const TEXT_A = TEXT_LINES.join('\n');

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  readonly breakModel: () => void;
}

function fakeModel(text: string, filePath: string = FILE_A): FakeModel {
  let broken = false;
  const lines = text.split(/\r\n|\r|\n/);
  const model = {
    uri: { scheme: 'file', fsPath: filePath, path: filePath.replace(/\\/g, '/') },
    getValue: (): string => {
      if (broken) throw new Error('桩：模型已释放');
      return text;
    },
    getLineContent: (line: number): string => {
      if (broken) throw new Error('桩：模型已释放');
      return lines[line - 1] ?? '';
    },
    getLineCount: (): number => lines.length,
    isDisposed: (): boolean => broken,
    getLanguageId: (): string => ERB_LANGUAGE_ID,
  } as unknown as Monaco.editor.ITextModel;
  return { model, breakModel: () => void (broken = true) };
}

function positionAt(line: number, column = 2): Monaco.Position {
  return { lineNumber: line, column } as Monaco.Position;
}

/**
 * 取数口（与生产同一条腿的**测试替身**）：把真判据（插件供方 `provideErbCallHierarchy`）
 * 接到假索引上——`null` 索引 ⇒ 无人应答（与真插件"索引未建 ⇒ 弃权"同语义）。
 */
function askOf(index: ErbIndex | null): CallHierarchyAsk {
  return (path, text, line, subject) => {
    if (index === null) return undefined;
    const request: EditorLanguageServiceRequest = {
      kind: 'callHierarchy',
      path,
      line,
      project: null,
      ...(text === null ? {} : { text }),
      ...(subject === undefined ? {} : { subject }),
    };
    return provideErbCallHierarchy(request, index);
  };
}

function depsOf(index: ErbIndex | null): ErbCallHierarchyDeps {
  return { ask: askOf(index) };
}

function providerFor(index: ErbIndex | null = INDEX): ErbCallHierarchyProvider {
  return createErbCallHierarchyProvider(depsOf(index));
}

/* ============================== 小工具 ============================== */

function prepareAt(
  line: number,
  options: {
    readonly column?: number;
    readonly filePath?: string;
    readonly text?: string;
    readonly deps?: ErbCallHierarchyDeps;
  } = {},
): ErbCallHierarchyItem[] | null {
  const provider = createErbCallHierarchyProvider(options.deps ?? depsOf(INDEX));
  const { model } = fakeModel(options.text ?? TEXT_A, options.filePath ?? FILE_A);
  return provider.prepareCallHierarchy(model, positionAt(line, options.column ?? 2));
}

function itemAt(line: number): ErbCallHierarchyItem {
  const items = prepareAt(line);
  expect(items, `第 ${line} 行没有 call hierarchy item`).not.toBeNull();
  expect(items).toHaveLength(1);
  return items![0]!;
}

function incomingOf(
  item: ErbCallHierarchyItem,
  provider: ErbCallHierarchyProvider = providerFor(),
  model: Monaco.editor.ITextModel = fakeModel(TEXT_A).model,
): ErbIncomingCall[] | null {
  return provider.provideCallHierarchyIncomingCalls(model, item);
}

function outgoingOf(
  item: ErbCallHierarchyItem,
  provider: ErbCallHierarchyProvider = providerFor(),
  model: Monaco.editor.ITextModel = fakeModel(TEXT_A).model,
): ErbOutgoingCall[] | null {
  return provider.provideCallHierarchyOutgoingCalls(model, item);
}

/** 区间 → 便于对拍的元组 */
function rangeTuple(range: {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}): readonly [number, number, number, number] {
  return [range.startLine, range.startColumn, range.endLine, range.endColumn];
}

/* ============================== ① prepare ============================== */

describe('prepare：函数声明 / 体内行 / 调用位都落到"光标所在函数"', () => {
  it('函数声明行（`@` 行）→ item：真区间 + 名字段 + 可序列化 data', () => {
    expect(itemAt(10)).toEqual({
      name: 'TARGET',
      kind: 'function',
      range: { startLine: 10, startColumn: 2, endLine: 20, endColumn: 11 },
      selectionRange: { startLine: 10, startColumn: 2, endLine: 10, endColumn: 8 },
      data: {
        name: 'TARGET',
        normalizedName: 'TARGET',
        filePath: FILE_A,
        startLine: 10,
        endLine: 20,
      },
    });
  });

  it('函数体内任意一行 → 与声明行逐字同一枚 item', () => {
    expect(itemAt(15)).toEqual(itemAt(10));
  });

  it('调用位 → 所在函数（与槽供方 `resolveEnclosingFunction` 同一把尺子，不解析被调者）', () => {
    const viaProvider = itemAt(31); // 31 行是 CALLER1 体内对 TARGET 的调用点
    const viaModel = resolveEnclosingFunction(INDEX, null, FILE_A, 31);
    expect(viaModel?.name).toBe('CALLER1');
    expect(viaProvider.name).toBe(viaModel?.name);
    expect(viaProvider.data).toEqual({
      name: 'CALLER1',
      normalizedName: 'CALLER1',
      filePath: FILE_A,
      startLine: 30,
      endLine: 40,
    });
    // 名字段按索引给的 nameColumn（2）翻译，不按词法再扫一遍
    expect(viaProvider.selectionRange).toEqual({
      startLine: 30,
      startColumn: 2,
      endLine: 30,
      endColumn: 9,
    });
  });

  it('函数之间 / 文件尾之后 → null（不夹取到邻近函数）', () => {
    expect(prepareAt(25)).toBeNull(); // BAR 结束 24、CALLER1 开始 30 之间
    expect(prepareAt(99)).toBeNull();
  });

  it('未知文件（索引里没有这个 path）→ null', () => {
    expect(prepareAt(15, { filePath: FILE_C })).toBeNull();
  });

  it('索引未建 → null（不猜、不返回空 item 数组）', () => {
    expect(prepareAt(15, { deps: depsOf(null) })).toBeNull();
  });

  it('model 已释放 / 取文抛错 → null（异常回空）', () => {
    const broken = fakeModel(TEXT_A);
    broken.breakModel();
    const provider = providerFor();
    expect(provider.prepareCallHierarchy(broken.model, positionAt(15))).toBeNull();
  });

  it('坏位点（0 / 负数 / NaN / 非整数）→ null', () => {
    const provider = providerFor();
    const { model } = fakeModel(TEXT_A);
    for (const position of [
      { lineNumber: 0, column: 1 },
      { lineNumber: 15, column: 0 },
      { lineNumber: -1, column: 1 },
      { lineNumber: Number.NaN, column: 1 },
      { lineNumber: 1.5, column: 1 },
    ]) {
      expect(provider.prepareCallHierarchy(model, position as Monaco.Position)).toBeNull();
    }
  });

  it('`nameColumn` 缺席 ⇒ 名字段退化成行首起（不猜缩进，区间仍包住名字段）', () => {
    expect(itemAt(46)).toEqual({
      name: 'PLAIN',
      kind: 'function',
      range: { startLine: 45, startColumn: 1, endLine: 47, endColumn: 11 },
      selectionRange: { startLine: 45, startColumn: 1, endLine: 45, endColumn: 6 },
      data: {
        name: 'PLAIN',
        normalizedName: 'PLAIN',
        filePath: FILE_A,
        startLine: 45,
        endLine: 47,
      },
    });
  });

  it('取数口交回的节点就是终局（命中即翻形状，跨文件尾列退化）', () => {
    const items = prepareAt(15, {
      deps: {
        ask: () => ({
          kind: 'callHierarchy',
          subject: { name: 'VIRTUAL', normalizedName: 'VIRTUAL', filePath: FILE_A, startLine: 100, endLine: 110, nameColumn: 3 },
          incoming: [],
          outgoing: [],
          referencesAvailable: true,
        }),
      },
    });
    expect(items?.[0]?.name).toBe('VIRTUAL');
    expect(items?.[0]?.data.startLine).toBe(100);
    // 100..110 超出这份 model 的行表 ⇒ 尾列不拿好听数字补位
    expect(items?.[0]?.range.endColumn).toBe(1);
  });

  it('取数口抛错 ⇒ `null`（异常回空，不把一次查询带崩）', () => {
    const items = prepareAt(15, {
      deps: {
        ask: () => {
          throw new Error('service hiccup');
        },
      },
    });
    expect(items).toBeNull();
  });
});

/* ============================== ② 入边 ============================== */

describe('入边：与纯模型逐条对拍（组序 / 点位序 / 跨文件尾列）', () => {
  it('按调用者分组：CALLER1（两处）+ CALLER2（mention 一处），definition 与顶层调用点剔除', () => {
    const incoming = incomingOf(itemAt(10));
    expect(incoming).not.toBeNull();
    expect(incoming?.map((call) => call.from.name)).toEqual(['CALLER1', 'CALLER2']);
    expect(incoming?.[0]?.fromRanges.map(rangeTuple)).toEqual([
      [31, 3, 31, 9],
      [33, 5, 33, 11],
    ]);
    expect(incoming?.[1]?.fromRanges.map(rangeTuple)).toEqual([[7, 1, 7, 7]]);
  });

  it('与 `incomingCalls` 同一批引用点：名字与每处点位逐条相等', () => {
    const pure = incomingCalls(INDEX, null, 'TARGET');
    const viaProvider = incomingOf(itemAt(10));
    expect(viaProvider?.map((call) => call.from.name)).toEqual(
      pure.map((group) => group.symbol.name),
    );
    for (let index = 0; index < pure.length; index++) {
      expect(viaProvider?.[index]?.fromRanges.map(rangeTuple)).toEqual(
        pure[index]!.sites.map((site) => [site.line, site.column, site.line, site.endColumn]),
      );
    }
  });

  it('跨文件调用者：item 的区间尾列退化成末行行首，selectionRange 仍按索引名字段', () => {
    const incoming = incomingOf(itemAt(10));
    const fromOtherFile = incoming?.[1]?.from;
    expect(fromOtherFile?.range).toEqual({
      startLine: 5,
      startColumn: 2,
      endLine: 15,
      endColumn: 1,
    });
    expect(fromOtherFile?.selectionRange).toEqual({
      startLine: 5,
      startColumn: 2,
      endLine: 5,
      endColumn: 9,
    });
    expect(fromOtherFile?.data.filePath).toBe(FILE_B);
  });

  it('名字大小写不敏感（data.normalizedName 小写也走同一张归一表）', () => {
    const item = itemAt(10);
    if (item.data === undefined) throw new Error('夹具 item 缺 data');
    const lower: ErbCallHierarchyItem = {
      ...item,
      data: { ...item.data, normalizedName: 'target' },
    };
    expect(incomingOf(lower)?.map((call) => call.from.name)).toEqual(['CALLER1', 'CALLER2']);
  });

  it('Monaco 把 item 原样回传（JSON 往返）后仍给出同一份入边', () => {
    const item = itemAt(10);
    const roundTripped = JSON.parse(JSON.stringify(item)) as ErbCallHierarchyItem;
    expect(incomingOf(roundTripped)).toEqual(incomingOf(item));
  });

  it('名字无记录 ⇒ `[]`（认得出 item，只是没有边）', () => {
    const item = itemAt(10);
    if (item.data === undefined) throw new Error('夹具 item 缺 data');
    const nobody: ErbCallHierarchyItem = {
      ...item,
      data: { ...item.data, normalizedName: 'NOBODY' },
    };
    expect(incomingOf(nobody)).toEqual([]);
  });

  it('反向索引缺席 ⇒ `[]`（与出边同源：索引没有就都没有）', () => {
    const bare = makeIndex({ files: FILES, byName: BY_NAME, withReferences: false });
    expect(incomingOf(itemAt(10), providerFor(bare))).toEqual([]);
  });

  it('item 认不出（缺 data / 名字空 / 行列非法）⇒ `null`，不拿名字瞎猜', () => {
    const real = itemAt(10);
    const brokenItems = [
      null,
      {},
      { ...real, data: undefined },
      { ...real, data: { ...real.data, name: '' } },
      { ...real, data: { ...real.data, normalizedName: '' } },
      { ...real, data: { ...real.data, filePath: '' } },
      { ...real, data: { ...real.data, startLine: 0 } },
      { ...real, data: { ...real.data, endLine: 9 } },
      { ...real, data: { ...real.data, startLine: 1.5 } },
    ];
    for (const candidate of brokenItems) {
      expect(
        incomingOf(candidate as unknown as ErbCallHierarchyItem),
        JSON.stringify(candidate),
      ).toBeNull();
    }
  });

  it('索引未建 / 取数腿抛错 ⇒ `[]`（不抛进 Monaco）', () => {
    expect(incomingOf(itemAt(10), providerFor(null))).toEqual([]);
    const throwing: ErbCallHierarchyDeps = {
      ask: () => {
        throw new Error('index service hiccup');
      },
    };
    expect(incomingOf(itemAt(10), createErbCallHierarchyProvider(throwing))).toEqual([]);
  });

  it('反向索引的 `get` 抛错 ⇒ `[]`（异常回空，不把一次查询带崩）', () => {
    const broken = {
      files: INDEX.files,
      byName: INDEX.byName,
      references: {
        bySymbol: {
          get: () => {
            throw new Error('broken index');
          },
        } as unknown as ReadonlyMap<string, readonly ErbReference[]>,
      },
    } as ErbIndex;
    expect(incomingOf(itemAt(10), providerFor(broken))).toEqual([]);
  });

  it('model 已释放 ⇒ `[]`（异常回空）', () => {
    const broken = fakeModel(TEXT_A);
    broken.breakModel();
    expect(incomingOf(itemAt(10), providerFor(), broken.model)).toEqual([]);
  });
});

/* ============================== ③ 出边 ============================== */

describe('出边：只认函数区间内的 `call`，与纯模型逐条对拍', () => {
  it('TARGET 的出边按首调用行排序：CALLEE(12) → BAR(18)；mention / 外部名不进边', () => {
    const outgoing = outgoingOf(itemAt(10));
    expect(outgoing).not.toBeNull();
    expect(outgoing?.map((call) => call.to.name)).toEqual(['CALLEE', 'BAR']);
    expect(outgoing?.[0]?.fromRanges.map(rangeTuple)).toEqual([[12, 1, 12, 6]]);
    expect(outgoing?.[1]?.fromRanges.map(rangeTuple)).toEqual([[18, 2, 18, 5]]);
  });

  it('与 `outgoingCalls` 同一批调用点：被调名与每处点位逐条相等', () => {
    const pure = outgoingCalls(INDEX, { filePath: FILE_A, startLine: 10, endLine: 20 });
    const viaProvider = outgoingOf(itemAt(10));
    expect(viaProvider?.map((call) => call.to.name)).toEqual(
      pure.map((group) => group.symbol.name),
    );
    for (let index = 0; index < pure.length; index++) {
      expect(viaProvider?.[index]?.fromRanges.map(rangeTuple)).toEqual(
        pure[index]!.sites.map((site) => [site.line, site.column, site.line, site.endColumn]),
      );
    }
  });

  it('被调 item：同文件用当前 model 行宽，跨文件退化成末行行首', () => {
    const outgoing = outgoingOf(itemAt(10));
    expect(outgoing?.[0]?.to.range).toEqual({
      startLine: 20,
      startColumn: 2,
      endLine: 28,
      endColumn: 1,
    });
    expect(outgoing?.[1]?.to.range).toEqual({
      startLine: 22,
      startColumn: 2,
      endLine: 24,
      endColumn: 11,
    });
    expect(outgoing?.[1]?.to.selectionRange).toEqual({
      startLine: 22,
      startColumn: 2,
      endLine: 22,
      endColumn: 5,
    });
  });

  it('JSON 往返后仍给出同一份出边', () => {
    const item = itemAt(10);
    const roundTripped = JSON.parse(JSON.stringify(item)) as ErbCallHierarchyItem;
    expect(outgoingOf(roundTripped)).toEqual(outgoingOf(item));
  });

  it('item 认不出 ⇒ `null`；反向索引缺席 / 索引未建 ⇒ `[]`', () => {
    expect(outgoingOf(null as unknown as ErbCallHierarchyItem)).toBeNull();
    const bare = makeIndex({ files: FILES, byName: BY_NAME, withReferences: false });
    expect(outgoingOf(itemAt(10), providerFor(bare))).toEqual([]);
    expect(outgoingOf(itemAt(10), providerFor(null))).toEqual([]);
  });

  it('model 已释放 ⇒ `[]`（异常回空）', () => {
    const broken = fakeModel(TEXT_A);
    broken.breakModel();
    expect(outgoingOf(itemAt(10), providerFor(), broken.model)).toEqual([]);
  });
});

/* ============================== ④ 安装 / Monaco 0.57 ============================== */

interface Registration {
  readonly selector: unknown;
  readonly provider: ErbCallHierarchyProvider;
}

interface FakeMonaco {
  readonly monaco: typeof Monaco;
  readonly registrations: Registration[];
  readonly disposeCalls: number[];
}

interface FakeMonacoOptions {
  /** Monaco 0.57 没有这个注册位（结构性探测的缺省形态） */
  readonly withoutRegistrar?: boolean;
  readonly failRegister?: boolean;
  readonly failDispose?: boolean;
}

function fakeMonaco(options: FakeMonacoOptions = {}): FakeMonaco {
  const registrations: Registration[] = [];
  const disposeCalls: number[] = [];
  const languages: Record<string, unknown> = {};
  if (options.withoutRegistrar !== true) {
    languages.registerCallHierarchyProvider = (selector: unknown, provider: unknown) => {
      if (options.failRegister === true) throw new Error('桩：注册调用层级 provider 抛错');
      registrations.push({ selector, provider: provider as ErbCallHierarchyProvider });
      return {
        dispose: () => {
          if (options.failDispose === true) throw new Error('桩：撤调用层级 provider 抛错');
          disposeCalls.push(registrations.length);
        },
      };
    };
  }
  const fake = { languages };
  return { monaco: fake as unknown as typeof Monaco, registrations, disposeCalls };
}

describe('安装：0.57 零注册、有注册位只挂 ERB、句柄幂等、异常回空', () => {
  it('provider 形状：displayName + 三条腿都是函数（与 kojo2 同形）', () => {
    const provider = providerFor();
    expect(provider.displayName).toBe('erb');
    expect(typeof provider.prepareCallHierarchy).toBe('function');
    expect(typeof provider.provideCallHierarchyIncomingCalls).toBe('function');
    expect(typeof provider.provideCallHierarchyOutgoingCalls).toBe('function');
  });

  it('零参工厂 = 无取数口占位：三条腿回空、不抛（真实装配必须注入 ask）', () => {
    const provider = createErbCallHierarchyProvider();
    const { model } = fakeModel(TEXT_A);
    expect(provider.prepareCallHierarchy(model, positionAt(10))).toBeNull();
    const item = itemAt(10);
    expect(provider.provideCallHierarchyIncomingCalls(model, item)).toEqual([]);
    expect(provider.provideCallHierarchyOutgoingCalls(model, item)).toEqual([]);
  });

  it('Monaco 0.57（没有 `registerCallHierarchyProvider`）⇒ 零注册且句柄幂等', () => {
    const fake = fakeMonaco({ withoutRegistrar: true });
    const handle = installErbCallHierarchyProvider(fake.monaco, depsOf(INDEX));
    expect(fake.registrations).toEqual([]);
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
    expect(fake.disposeCalls).toEqual([]);
  });

  it('注册位存在 + 有数据源 ⇒ 恰好一枚，selector 只有 ERB_LANGUAGE_ID', () => {
    const fake = fakeMonaco();
    installErbCallHierarchyProvider(fake.monaco, depsOf(INDEX));
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]!.selector).toBe(ERB_LANGUAGE_ID);
    expect(fake.registrations[0]!.provider.displayName).toBe('erb');
  });

  it('注册位存在但没有数据源 ⇒ 零注册（不装一枚永远答空的 provider）', () => {
    const fake = fakeMonaco();
    const handle = installErbCallHierarchyProvider(fake.monaco);
    expect(fake.registrations).toEqual([]);
    expect(() => handle.dispose()).not.toThrow();
  });

  it('dispose 幂等：两次只撤一轮', () => {
    const fake = fakeMonaco();
    const handle = installErbCallHierarchyProvider(fake.monaco, depsOf(INDEX));
    handle.dispose();
    handle.dispose();
    expect(fake.disposeCalls).toHaveLength(1);
  });

  it('注册句柄的 dispose 抛错不带走卸载链', () => {
    const fake = fakeMonaco({ failDispose: true });
    const handle = installErbCallHierarchyProvider(fake.monaco, depsOf(INDEX));
    expect(() => handle.dispose()).not.toThrow();
  });

  it('注册失败 ⇒ 错误外抛（宿主那侧的"全有或全无"才有东西可回滚）', () => {
    const fake = fakeMonaco({ failRegister: true });
    expect(() => installErbCallHierarchyProvider(fake.monaco, depsOf(INDEX))).toThrow(
      /注册调用层级/,
    );
  });

  it('注册后的 provider 与 `createErbCallHierarchyProvider` 逐字同一份读数', () => {
    const fake = fakeMonaco();
    installErbCallHierarchyProvider(fake.monaco, depsOf(INDEX));
    const registered = fake.registrations[0]!.provider;
    const created = providerFor();
    const { model } = fakeModel(TEXT_A);

    const viaRegistered = registered.prepareCallHierarchy(model, positionAt(10));
    const viaCreated = created.prepareCallHierarchy(model, positionAt(10));
    expect(viaRegistered).toEqual(viaCreated);

    const item = viaRegistered![0]!;
    expect(registered.provideCallHierarchyIncomingCalls(model, item)).toEqual(
      created.provideCallHierarchyIncomingCalls(model, item),
    );
    expect(registered.provideCallHierarchyOutgoingCalls(model, item)).toEqual(
      created.provideCallHierarchyOutgoingCalls(model, item),
    );
  });

  it('取数口按调用时现取：换索引 / 索引消失立刻反映到下一次查询', () => {
    const fake = fakeMonaco();
    let current: ErbIndex | null = INDEX;
    installErbCallHierarchyProvider(fake.monaco, { ask: (path, text, line, subject) => askOf(current)(path, text, line, subject) });
    const provider = fake.registrations[0]!.provider;
    const { model } = fakeModel(TEXT_A);
    expect(provider.prepareCallHierarchy(model, positionAt(10))?.[0]?.name).toBe('TARGET');
    const item = provider.prepareCallHierarchy(model, positionAt(10))![0]!;

    current = null;
    expect(provider.prepareCallHierarchy(model, positionAt(10))).toBeNull();
    expect(provider.provideCallHierarchyIncomingCalls(model, item)).toEqual([]);
    expect(provider.provideCallHierarchyOutgoingCalls(model, item)).toEqual([]);
  });
});

/* ============================== ⑤ 源码卫生 / 确定性 ============================== */

describe('源码卫生：纯模型独任判定、Monaco 只 type-only、无第二份引用判据', () => {
  const source = readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'monaco', 'erb-callhierarchy-provider.ts'),
    'utf8',
  );

  it('Monaco 运行时只许 type-only 引入（node 池不把 monaco 拉进模块图）', () => {
    expect(source).toMatch(/import type \* as Monaco from '\.\/entry'/);
    expect(source).not.toMatch(/import \* as Monaco from/);
    expect(source).not.toMatch(/from 'monaco-editor'/);
  });

  it('不 import 任何插件包运行时（只允许 `import type` 取契约类型）', () => {
    const runtimePluginImports = source
      .split('\n')
      .filter((line) => /^\s*import\s+(?!type\b).*from\s+['"]@kojo\/plugin-/.test(line));
    expect(runtimePluginImports).toEqual([]);
    expect(source).not.toMatch(/\b(eratw|eraK|eraSQN|eraNAS)\b/i);
  });

  it('判定全部委托取数口（槽供方）：provider 里没有反向索引 / 调用点判据的抄本', () => {
    // 只看**代码行**：头注里引述判据口径（"入边剔 definition、出边只认 call"）是设计说明，不是抄本
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    // 判据搬走后这一层只剩三件事：model→请求（`deps.ask`）、契约→形状（itemOf / callSiteRange）、注册
    expect(code).toMatch(/\bdeps\.ask\b/);
    expect(code).toMatch(/function itemOf\(/);
    expect(code).toMatch(/function callSiteRange\(/);
    expect(code).not.toMatch(/bySymbol/);
    expect(code).not.toMatch(/kind === 'call'/);
    expect(code).not.toMatch(/enclosingAt/);
  });

  it('安装器结构性探测注册位（0.57 没有它），并只挂 ERB_LANGUAGE_ID', () => {
    expect(source).toMatch(/typeof register !== 'function'/);
    expect(source).toMatch(/registerCallHierarchyProvider\(\s*ERB_LANGUAGE_ID/);
  });
});

describe('确定性：同输入必同输出、CRLF 同结果、item 区间包住 selectionRange', () => {
  it('两次 prepare / 入边 / 出边逐字相等', () => {
    expect(itemAt(10)).toEqual(itemAt(10));
    const item = itemAt(10);
    expect(incomingOf(item)).toEqual(incomingOf(item));
    expect(outgoingOf(item)).toEqual(outgoingOf(item));
  });

  it('CRLF 与 LF 同结果（换行不是坐标语义）', () => {
    const crlf = TEXT_A.replace(/\n/g, '\r\n');
    expect(prepareAt(10, { text: crlf })).toEqual(prepareAt(10));
    const item = itemAt(10);
    expect(incomingOf(item, providerFor(), fakeModel(crlf).model)).toEqual(incomingOf(item));
  });

  it('每枚 item 的 range 都包住 selectionRange（客户端选中段不会落到区间外）', () => {
    const items: ErbCallHierarchyItem[] = [itemAt(10)];
    for (const call of incomingOf(itemAt(10)) ?? []) items.push(call.from);
    for (const call of outgoingOf(itemAt(10)) ?? []) items.push(call.to);
    for (const item of items) {
      const startsBefore =
        item.range.startLine < item.selectionRange.startLine ||
        (item.range.startLine === item.selectionRange.startLine &&
          item.range.startColumn <= item.selectionRange.startColumn);
      const endsAfter =
        item.range.endLine > item.selectionRange.endLine ||
        (item.range.endLine === item.selectionRange.endLine &&
          item.range.endColumn >= item.selectionRange.endColumn);
      expect(startsBefore, item.name).toBe(true);
      expect(endsAfter, item.name).toBe(true);
    }
  });
});
