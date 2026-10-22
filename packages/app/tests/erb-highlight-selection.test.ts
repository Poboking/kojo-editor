/**
 * ERB-HIGHLIGHT-SELECT · ERB 侧**同符号高亮 + 选择范围**的闸（batch-9）。
 *
 * 覆盖四件事：
 * 1. **高亮判据**：控制流关键字块配对（开块 write / 分支 text / 收束 read）、函数名
 *    （`@NAME` 写 + `CALL` 直系族名字槽读 + 代码面同名提及 text）、`$` 标签
 *    （定义写 + `JUMP` / `GOTO` 目标读）；字符串 / 注释 / `[SKIPSTART]` 死区**不误报**；
 *    无符号 ⇒ `[]`；
 * 2. **扩选层级**：词 → 行 → 分支段 → ERB 标签块（可多级）→ 函数块 → 全文；死区不扩、
 *    越界显式空、行尾光标取左侧词；
 * 3. **Monaco 面**：DocumentHighlight / SelectionRange（0.57：每位点一条扁平数组）形状、
 *    只挂 `ERB_LANGUAGE_ID`、不看任何偏好开关、dispose 幂等、provider 异常回空；
 * 4. **源码卫生**：Monaco 只 type-only、零 `@kojo/plugin-*` import、不碰结构层开关
 *    （与 kojo2 两枚语言服务同一层纪律）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import {
  erbDocumentHighlights,
  erbHighlightKindToMonaco,
  erbStructureOf,
  installErbHighlightProvider,
  type ErbDocumentHighlight,
  type ErbHighlightKind,
  type ErbPosition,
  type ErbRange,
} from '../src/monaco/erb-highlight';
import {
  erbSelectionRangeAt,
  installErbSelectionRangeProvider,
  type ErbSelectionRange,
} from '../src/monaco/erb-selection-range';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

/* ============================== 夹具 ============================== */

/**
 * 高亮主夹具（每行都按内容定位）。埋伏的陷阱：
 * - 第 1 行注释里写满 `IF` / `CALL FUNC` / `$LOOP`；
 * - 第 6 行字符串里有 `IF` 与 `FUNC`；
 * - 第 9 行是没有 `CALL` 的散文式同名提及（⇒ text 档）；
 * - 第 10 行 `SIF` 是单行语句（没有配对块）；
 * - 第 15–18 行是 `[SKIPSTART]` 死区，里面还有一枚 `IF` 与一处 `CALL FUNC`；
 * - 第 20 行的 `IF` 在函数边界（第 22 行）前没有收束。
 */
const HILITE: string = [
  '; 顶部注释：IF / CALL FUNC / $LOOP 都不是符号',
  '#DIM CNT, 10',
  '@FUNC(A, B)',
  '    $LOOP',
  '    IF A AND B',
  '        PRINTL "字符串里的 IF 与 FUNC"',
  '        CALL OTHER(1)',
  '        CALL FUNC(A)',
  '        PRINTL FUNC について',
  '        SIF A > 1',
  '        PRINTLX',
  '    ELSE',
  '        CALL FUNC(B)',
  '    ENDIF',
  '    [SKIPSTART]',
  '    IF A',
  '    CALL FUNC(A)',
  '    [SKIPEND]',
  '    JUMP LOOP',
  '    IF A',
  '        PRINTL 未闭合',
  '@OTHER()',
  '    CALL FUNC(1)',
].join('\n');

/** 扩选主夹具：两层控制块（IF ⊃ SELECTCASE）+ 一个分支段 + 两个函数 */
const SELECT: string = [
  '; 头部',
  '@FUNC(A)',
  '    IF A',
  '        SELECTCASE A',
  '            CASE 1',
  '                PRINTL 一',
  '        ENDSELECT',
  '    ENDIF',
  '@OTHER()',
  '    CALL FUNC(1)',
].join('\n');

/** `ELSE` 分支段夹具（IF 块里只有一条分支） */
const BRANCH: string = [
  '@FUNC(A, B)',
  '    IF A AND B',
  '        PRINTL "字符串"',
  '    ELSE',
  '        CALL FUNC(B)',
  '    ENDIF',
  '@OTHER()',
  '    CALL FUNC(1)',
].join('\n');

/** 死区夹具：`[SKIPSTART]` 里还写着 `IF B`（不解析、不扩选） */
const DEAD: string = [
  '@FUNC(A)',
  '    IF A',
  '        [SKIPSTART]',
  '        IF B',
  '        [SKIPEND]',
  '    ENDIF',
].join('\n');

/** 大小写 / CJK：`if` / `endif` 小写形态与中文函数名 */
const CJK: string = [
  '@中文函(A)',
  '    CALL 中文函(A)',
  '    if A > 1',
  '        PRINTL A',
  '    endif',
].join('\n');

/** `TRYCCALL` 既是 try 开块、又把函数名放在名字槽里（引擎同一语句两种身份） */
const TRY: string = [
  '@T()',
  '    TRYCCALL 靶(1)',
  '        CALL 靶(2)',
  '    CATCH',
  '        PRINTL 捕',
  '    ENDCATCH',
].join('\n');

/** 跳转目标带 `$` / `*` 前缀（引擎两种写法都认） */
const LABEL: string = [
  '@L()',
  '    $NEXT',
  '    JUMP $NEXT',
  '    GOTO NEXT',
].join('\n');

/** 空行落在函数块里（没有词级，但函数 / 全文仍在） */
const BLANK: string = ['@FUNC(A)', '', '    PRINTL 一', '@OTHER()', '    PRINTL 二'].join('\n');

/** 没有函数头的顶层块（没有函数级，块与全文同级时只留一级） */
const TOPLEVEL: string = ['IF A', '    PRINTL 一', 'ENDIF'].join('\n');

/* ============================== 假 Monaco / 假 model ============================== */

const HIGHLIGHT_KINDS = { Text: 0, Read: 1, Write: 2 } as const;

interface Registration {
  readonly selector: string;
  readonly provider: unknown;
}

interface FakeMonaco {
  readonly monaco: typeof Monaco;
  readonly registrations: Registration[];
  readonly disposeCalls: number[];
}

function fakeMonaco(): FakeMonaco {
  const registrations: Registration[] = [];
  const disposeCalls: number[] = [];
  const fake = {
    languages: {
      DocumentHighlightKind: HIGHLIGHT_KINDS,
      registerDocumentHighlightProvider: (selector: string, provider: unknown) => {
        registrations.push({ selector, provider });
        return { dispose: () => disposeCalls.push(registrations.length) };
      },
      registerSelectionRangeProvider: (selector: string, provider: unknown) => {
        registrations.push({ selector, provider });
        return { dispose: () => disposeCalls.push(registrations.length) };
      },
    },
  };
  return { monaco: fake as unknown as typeof Monaco, registrations, disposeCalls };
}

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  readonly breakModel: () => void;
}

function fakeModel(text: string): FakeModel {
  let broken = false;
  const model = {
    getValue: () => {
      if (broken) throw new Error('桩：模型已释放');
      return text;
    },
    getLineCount: () => text.split(/\r\n|\r|\n/).length,
    getLineContent: (line: number) => text.split(/\r\n|\r|\n/)[line - 1] ?? '',
    isDisposed: () => broken,
    getLanguageId: () => ERB_LANGUAGE_ID,
  } as unknown as Monaco.editor.ITextModel;
  return { model, breakModel: () => (broken = true) };
}

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

/* ============================== 小工具 ============================== */

function splitLines(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

function lineText(source: string, line: number): string {
  return splitLines(source)[line - 1] ?? '';
}

/** 第 `line` 行第 `occurrence` 个 `needle` 的首列（1 基） */
function at(source: string, line: number, needle: string, occurrence = 1): ErbPosition {
  const text = lineText(source, line);
  let index = -1;
  let from = 0;
  for (let i = 0; i < occurrence; i++) {
    index = text.indexOf(needle, from);
    if (index < 0) throw new Error(`第 ${line} 行没有第 ${i + 1} 个「${needle}」`);
    from = index + 1;
  }
  return { line, column: index + 1 };
}

/** 1 基区间 → `[行, 列, 行, 列]` */
function flat(range: ErbRange): [number, number, number, number] {
  return [range.startLine, range.startColumn, range.endLine, range.endColumn];
}

function flatIRange(range: Monaco.IRange): [number, number, number, number] {
  return [range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn];
}

/** 桩 `Position`（provider 的入参只读 `lineNumber` / `column`） */
function position(lineNumber: number, column: number): Monaco.Position {
  return { lineNumber, column } as unknown as Monaco.Position;
}

/** 高亮结果 → `[行, 起列, 行, 终列, 档位]`（便于整表对拍） */
function hitsOf(source: string, at_: ErbPosition): Array<[number, number, number, number, ErbHighlightKind]> {
  return erbDocumentHighlights(source, at_).map((hit) => [...flat(hit.range), hit.kind] as [number, number, number, number, ErbHighlightKind]);
}

/** 扩选链（最内层在前）→ 1 基区间数组 */
function chainOf(source: string, at_: ErbPosition): ErbRange[] {
  const node = erbSelectionRangeAt(source, [at_])[0];
  const out: ErbRange[] = [];
  let cursor: ErbSelectionRange | undefined = node;
  while (cursor !== undefined) {
    out.push({
      startLine: cursor.range.startLineNumber,
      startColumn: cursor.range.startColumn,
      endLine: cursor.range.endLineNumber,
      endColumn: cursor.range.endColumn,
    });
    cursor = cursor.parent;
  }
  return out;
}

function chainFlats(source: string, at_: ErbPosition): Array<[number, number, number, number]> {
  return chainOf(source, at_).map(flat);
}

function highlightProviderOf(fake: FakeMonaco): Monaco.languages.DocumentHighlightProvider {
  const registration = fake.registrations[0];
  if (registration === undefined) throw new Error('没有注册 DocumentHighlightProvider');
  return registration.provider as Monaco.languages.DocumentHighlightProvider;
}

function selectionProviderOf(fake: FakeMonaco): Monaco.languages.SelectionRangeProvider {
  const registration = fake.registrations[0];
  if (registration === undefined) throw new Error('没有注册 SelectionRangeProvider');
  return registration.provider as Monaco.languages.SelectionRangeProvider;
}

/* ============================== ① 高亮：控制流关键字配对 ============================== */

describe('高亮：控制流关键字块配对', () => {
  const IF_BLOCK: Array<[number, number, number, number, ErbHighlightKind]> = [
    [5, 5, 5, 7, 'write'],
    [12, 5, 12, 9, 'text'],
    [14, 5, 14, 10, 'read'],
  ];

  it('光标在开块 `IF` 上：开块 write + 分支 text + 收束 read', () => {
    expect(hitsOf(HILITE, at(HILITE, 5, 'IF'))).toEqual(IF_BLOCK);
  });

  it('光标在收束 `ENDIF` 上：给出同一条块（对称）', () => {
    expect(hitsOf(HILITE, at(HILITE, 14, 'ENDIF'))).toEqual(IF_BLOCK);
  });

  it('光标在分支 `ELSE` 上：给出它所属那一条块', () => {
    expect(hitsOf(HILITE, at(HILITE, 12, 'ELSE'))).toEqual(IF_BLOCK);
  });

  it('死区里的 `IF` 不开块 ⇒ `[]`（引擎不编译那些行）', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 16, 'IF'))).toEqual([]);
  });

  it('函数边界前的未闭合 `IF`：配对缺席时只给自己的那一枚（不猜收束）', () => {
    expect(hitsOf(HILITE, at(HILITE, 20, 'IF'))).toEqual([[20, 5, 20, 7, 'write']]);
  });

  it('`SIF` 是单行语句（没有配对块）⇒ `[]`', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 10, 'SIF'))).toEqual([]);
  });

  it('`TRYCCALL … CATCH … ENDCATCH`：开块 write + 分支 text + 收束 read', () => {
    expect(hitsOf(TRY, at(TRY, 2, 'TRYCCALL'))).toEqual([
      [2, 5, 2, 13, 'write'],
      [4, 5, 4, 10, 'text'],
      [6, 5, 6, 13, 'read'],
    ]);
  });

  it('结构事实：死区行不是控制行，未闭合的开块不产块', () => {
    const structure = erbStructureOf(HILITE);
    expect(structure.controlByLine.has(16)).toBe(false);
    expect(structure.controlByLine.has(17)).toBe(false);
    expect(structure.blocks).toHaveLength(1);
    expect(structure.blocks[0]!.open.line).toBe(5);
    expect(structure.blocks[0]!.close?.line).toBe(14);
  });
});

/* ============================== ② 高亮：函数名与 `$` 标签 ============================== */

describe('高亮：函数名（声明写 / 调用读 / 提及弱）', () => {
  const FUNC_HITS: Array<[number, number, number, number, ErbHighlightKind]> = [
    [3, 2, 3, 6, 'write'],
    [8, 14, 8, 18, 'read'],
    [9, 16, 9, 20, 'text'],
    [13, 14, 13, 18, 'read'],
    [23, 10, 23, 14, 'read'],
  ];

  it('`@FUNC` 声明 + 两处 `CALL` 名字槽 + 一处散文提及（text）', () => {
    expect(hitsOf(HILITE, at(HILITE, 3, 'FUNC'))).toEqual(FUNC_HITS);
  });

  it('光标停在 `@` 上也解析到同一枚声明（与正文面同一条符号）', () => {
    expect(hitsOf(HILITE, { line: 3, column: 1 })).toEqual(FUNC_HITS);
  });

  it('死区里的 `CALL FUNC` 不进结果（第 17 行缺席）', () => {
    expect(FUNC_HITS.some(([line]) => line === 17)).toBe(false);
  });

  it('字符串里的同名 `FUNC` 不进结果（第 6 行缺席）', () => {
    expect(FUNC_HITS.some(([line]) => line === 6)).toBe(false);
  });

  it('声明之外的第二枚函数：声明 + 它自己的调用点', () => {
    expect(hitsOf(HILITE, at(HILITE, 22, 'OTHER'))).toEqual([
      [7, 14, 7, 19, 'read'],
      [22, 2, 22, 7, 'write'],
    ]);
  });

  it('`CALL` 关键字本身不是符号 ⇒ `[]`', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 7, 'CALL'))).toEqual([]);
  });

  it('`CALLFORM` 的参数不是名字槽（未声明的名字 ⇒ `[]`，判窄不判宽）', () => {
    const source = ['@F()', '    CALLFORM UNDECLARED'].join('\n');
    expect(erbDocumentHighlights(source, { line: 2, column: source.split('\n')[1]!.indexOf('UNDECLARED') + 1 })).toEqual([]);
  });

  it('`TRYCCALL` 的目标同时是名字槽（既是 try 开块又按名调用）', () => {
    expect(hitsOf(TRY, at(TRY, 3, '靶'))).toEqual([
      [2, 14, 2, 15, 'read'],
      [3, 14, 3, 15, 'read'],
    ]);
  });
});

describe('高亮：`$` 标签（定义写 / 跳转读）', () => {
  it('`$LOOP` 定义 + `JUMP LOOP` 目标', () => {
    expect(hitsOf(HILITE, at(HILITE, 4, 'LOOP'))).toEqual([
      [4, 6, 4, 10, 'write'],
      [19, 10, 19, 14, 'read'],
    ]);
  });

  it('跳转目标可带 `$` 前缀（两种写法都是同一枚标签）', () => {
    expect(hitsOf(LABEL, at(LABEL, 2, 'NEXT'))).toEqual([
      [2, 6, 2, 10, 'write'],
      [3, 11, 3, 15, 'read'],
      [4, 10, 4, 14, 'read'],
    ]);
  });

  it('纯数字跳转目标是行号不是标签名（不产标签符号）', () => {
    const source = ['@L()', '    GOTO 123'].join('\n');
    expect(erbDocumentHighlights(source, { line: 2, column: 10 })).toEqual([]);
  });
});

/* ============================== ③ 高亮：不误报 / 边界 ============================== */

describe('高亮：字符串 / 注释 / 死区 / 无符号', () => {
  it('字符串内容不出符号（光标落在串里的 `IF`）', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 6, 'IF'))).toEqual([]);
  });

  it('字符串内容不出符号（光标落在串里的 `FUNC`）', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 6, 'FUNC'))).toEqual([]);
  });

  it('整行注释不出符号', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 1, 'CALL'))).toEqual([]);
    expect(erbDocumentHighlights(HILITE, at(HILITE, 1, 'LOOP'))).toEqual([]);
  });

  it('死区里的 `CALL FUNC` 不出符号', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 17, 'FUNC'))).toEqual([]);
  });

  it('空白 / 数字 / 未知词 / `#DIM` 指令行 ⇒ `[]`', () => {
    expect(erbDocumentHighlights(HILITE, { line: 2, column: 6 })).toEqual([]); // #DIM CNT
    expect(erbDocumentHighlights(HILITE, at(HILITE, 10, '1'))).toEqual([]); // 条件里的数字
    expect(erbDocumentHighlights(HILITE, at(HILITE, 21, 'PRINTL'))).toEqual([]); // 未声明词
  });

  it('越界行 / 越界列 / 非法坐标 / 空文件 / 非字符串 ⇒ `[]`（不抛）', () => {
    expect(erbDocumentHighlights(HILITE, { line: 9_999, column: 1 })).toEqual([]);
    expect(erbDocumentHighlights(HILITE, { line: 3, column: 999 })).toEqual([]);
    expect(erbDocumentHighlights(HILITE, { line: 0, column: 1 })).toEqual([]);
    expect(erbDocumentHighlights(HILITE, { line: 1, column: 0 })).toEqual([]);
    expect(erbDocumentHighlights(HILITE, { line: Number.NaN, column: 1 })).toEqual([]);
    expect(erbDocumentHighlights('', { line: 1, column: 1 })).toEqual([]);
    expect(erbDocumentHighlights(null as unknown as string, { line: 1, column: 1 })).toEqual([]);
  });
});

describe('高亮：确定性、CRLF、大小写、CJK', () => {
  it('同输入两次逐字相等', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 3, 'FUNC'))).toEqual(
      erbDocumentHighlights(HILITE, at(HILITE, 3, 'FUNC')),
    );
  });

  it('CRLF 与 LF 同结果（列口径不受行尾影响）', () => {
    const crlf = HILITE.replace(/\n/g, '\r\n');
    expect(erbDocumentHighlights(crlf, at(crlf, 3, 'FUNC'))).toEqual(
      erbDocumentHighlights(HILITE, at(HILITE, 3, 'FUNC')),
    );
  });

  it('关键字大小写不敏感：小写 `if` 配对小写 `endif`', () => {
    expect(hitsOf(CJK, at(CJK, 3, 'if'))).toEqual([
      [3, 5, 3, 7, 'write'],
      [5, 5, 5, 10, 'read'],
    ]);
  });

  it('中文函数名整词（声明 + 调用）', () => {
    expect(hitsOf(CJK, at(CJK, 1, '中文函'))).toEqual([
      [1, 2, 1, 5, 'write'],
      [2, 10, 2, 13, 'read'],
    ]);
  });

  it('档位 → Monaco DocumentHighlightKind（唯一映射表）', () => {
    const fake = fakeMonaco();
    expect(erbHighlightKindToMonaco(fake.monaco, 'text')).toBe(HIGHLIGHT_KINDS.Text);
    expect(erbHighlightKindToMonaco(fake.monaco, 'read')).toBe(HIGHLIGHT_KINDS.Read);
    expect(erbHighlightKindToMonaco(fake.monaco, 'write')).toBe(HIGHLIGHT_KINDS.Write);
  });
});

/* ============================== ④ 高亮 provider ============================== */

describe('高亮 provider：只挂 ERB、dispose 幂等、异常回空', () => {
  it('注册一枚，selector 只有 `ERB_LANGUAGE_ID`（不看任何偏好开关）', () => {
    const fake = fakeMonaco();
    installErbHighlightProvider(fake.monaco);
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]!.selector).toBe(ERB_LANGUAGE_ID);
  });

  it('provider 形状：IRange + DocumentHighlightKind（write=2 / read=1 / text=0）', () => {
    const fake = fakeMonaco();
    installErbHighlightProvider(fake.monaco);
    const result = highlightProviderOf(fake).provideDocumentHighlights(
      fakeModel(HILITE).model,
      position(5, 6),
      TOKEN,
    ) as Monaco.languages.DocumentHighlight[];
    expect(result.map((hit) => [flatIRange(hit.range), hit.kind])).toEqual([
      [[5, 5, 5, 7], HIGHLIGHT_KINDS.Write],
      [[12, 5, 12, 9], HIGHLIGHT_KINDS.Text],
      [[14, 5, 14, 10], HIGHLIGHT_KINDS.Read],
    ]);
  });

  it('模型已释放 / 取文抛错 ⇒ `[]`（不抛进 Monaco）', () => {
    const fake = fakeMonaco();
    installErbHighlightProvider(fake.monaco);
    const broken = fakeModel(HILITE);
    broken.breakModel();
    expect(
      highlightProviderOf(fake).provideDocumentHighlights(broken.model, position(5, 6), TOKEN),
    ).toEqual([]);
  });

  it('dispose 幂等：两次只撤一轮', () => {
    const fake = fakeMonaco();
    const handle = installErbHighlightProvider(fake.monaco);
    handle.dispose();
    handle.dispose();
    expect(fake.disposeCalls).toHaveLength(1);
  });
});

/* ============================== ⑤ 扩选：层级 ============================== */

describe('扩选：词 → 行 → 分支段 → 块（多级）→ 函数 → 全文', () => {
  it('嵌套块：词 / 行 / CASE 段 / SELECTCASE 块 / IF 块 / 函数 / 全文 七级', () => {
    expect(chainFlats(SELECT, at(SELECT, 6, 'PRINTL'))).toEqual([
      [6, 17, 6, 23],
      [6, 1, 6, 25],
      [5, 1, 6, 25],
      [4, 1, 7, 18],
      [3, 1, 8, 10],
      [2, 1, 8, 10],
      [1, 1, 10, 17],
    ]);
  });

  it('行级恒为整行（含缩进；起列 1、终列行长 + 1）', () => {
    const chain = chainOf(SELECT, at(SELECT, 6, 'PRINTL'));
    expect(chain[1]!.startColumn).toBe(1);
    expect(chain[1]!.endColumn).toBe(lineText(SELECT, 6).length + 1);
  });

  it('`ELSE` 分支段：兄弟分支不并进来，段尾 = 收束前一行', () => {
    expect(chainFlats(BRANCH, at(BRANCH, 5, 'FUNC'))).toEqual([
      [5, 14, 5, 18],
      [5, 1, 5, 21],
      [4, 1, 5, 21],
      [2, 1, 6, 10],
      [1, 1, 6, 10],
      [1, 1, 8, 17],
    ]);
  });

  it('函数块不跨到下一个 `@`（`@OTHER` 之后的内容归 OTHER）', () => {
    expect(chainFlats(SELECT, at(SELECT, 10, 'FUNC'))).toEqual([
      [10, 10, 10, 14],
      [10, 1, 10, 17],
      [9, 1, 10, 17],
      [1, 1, 10, 17],
    ]);
  });

  it('死区不扩：词 → 行 → 全文（块 / 函数边界在那里没有判据）', () => {
    expect(chainFlats(DEAD, at(DEAD, 4, 'B'))).toEqual([
      [4, 12, 4, 13],
      [4, 1, 4, 13],
      [1, 1, 6, 10],
    ]);
  });

  it('死区标记行本身也不扩（`[SKIPSTART]` 行）', () => {
    expect(chainFlats(DEAD, at(DEAD, 3, 'SKIPSTART'))).toEqual([
      [3, 10, 3, 19],
      [3, 1, 3, 20],
      [1, 1, 6, 10],
    ]);
  });

  it('空行位点：没有词级，行 → 函数 → 全文', () => {
    expect(chainFlats(BLANK, { line: 2, column: 1 })).toEqual([
      [2, 1, 2, 1],
      [1, 1, 3, 13],
      [1, 1, 5, 13],
    ]);
  });

  it('没有函数头时链只有 词 / 行 / 块（块与全文同级只留一级）', () => {
    expect(chainFlats(TOPLEVEL, at(TOPLEVEL, 2, 'PRINTL'))).toEqual([
      [2, 5, 2, 11],
      [2, 1, 2, 13],
      [1, 1, 3, 6],
    ]);
  });

  it('全文区间 = 1:1 到末行末列', () => {
    const chain = chainOf(SELECT, at(SELECT, 6, 'PRINTL'));
    expect(flat(chain[chain.length - 1]!)).toEqual([
      1,
      1,
      splitLines(SELECT).length,
      lineText(SELECT, splitLines(SELECT).length).length + 1,
    ]);
  });
});

/* ============================== ⑥ 扩选：空 / 越界 / 多光标 ============================== */

describe('扩选：空文件、越界、多光标、确定性', () => {
  it('空串 / 纯空白 / 空位点数组 ⇒ `[]`', () => {
    expect(erbSelectionRangeAt('', [{ line: 1, column: 1 }])).toEqual([]);
    expect(erbSelectionRangeAt('   \n\t\n', [{ line: 1, column: 1 }])).toEqual([]);
    expect(erbSelectionRangeAt(SELECT, [])).toEqual([]);
  });

  it('越界行 / 越界列 / 非法坐标 ⇒ 该位点显式空（不夹取）', () => {
    expect(erbSelectionRangeAt(SELECT, [{ line: 9_999, column: 1 }])).toEqual([]);
    expect(erbSelectionRangeAt(SELECT, [{ line: 1, column: 0 }])).toEqual([]);
    expect(erbSelectionRangeAt(SELECT, [{ line: 1, column: 999 }])).toEqual([]);
    expect(erbSelectionRangeAt(SELECT, [{ line: Number.NaN, column: 1 }])).toEqual([]);
    expect(erbSelectionRangeAt(SELECT, [{ line: 1, column: Number.POSITIVE_INFINITY }])).toEqual([]);
  });

  it('多光标：结果与输入同序、各自一条链', () => {
    const positions = [at(SELECT, 6, 'PRINTL'), at(BRANCH, 5, 'FUNC')];
    const chains = erbSelectionRangeAt(SELECT, positions);
    expect(chains).toHaveLength(2);
    expect(chainOf(SELECT, positions[0]!)[0]!.startLine).toBe(6);
    expect(chainOf(SELECT, positions[1]!)[0]!.startLine).toBe(5);
  });

  it('行末光标取左侧词（行尾列可停靠）', () => {
    const end = { line: 3, column: lineText(SELECT, 3).length + 1 };
    const chain = chainOf(SELECT, end);
    expect(flat(chain[0]!)).toEqual([3, 8, 3, 9]);
  });

  it('中文名字整词（不按字节切）', () => {
    expect(flat(chainOf(CJK, at(CJK, 1, '中文函'))[0]!)).toEqual([1, 2, 1, 5]);
  });

  it('CRLF 与 LF 同结果', () => {
    const crlf = SELECT.replace(/\n/g, '\r\n');
    expect(chainFlats(crlf, at(crlf, 6, 'PRINTL'))).toEqual(chainFlats(SELECT, at(SELECT, 6, 'PRINTL')));
  });
});

/* ============================== ⑦ 扩选 provider ============================== */

describe('扩选 provider：0.57 形状（每位点一条扁平数组）、dispose、异常', () => {
  it('注册一枚，selector 只有 `ERB_LANGUAGE_ID`', () => {
    const fake = fakeMonaco();
    installErbSelectionRangeProvider(fake.monaco);
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]!.selector).toBe(ERB_LANGUAGE_ID);
  });

  it('provider 返回 SelectionRange[][]：每位点一条内 → 外的链', () => {
    const fake = fakeMonaco();
    installErbSelectionRangeProvider(fake.monaco);
    const result = selectionProviderOf(fake).provideSelectionRanges(
      fakeModel(SELECT).model,
      [position(6, 17)],
      TOKEN,
    ) as Monaco.languages.SelectionRange[][];
    expect(result).toHaveLength(1);
    expect(result[0]!.map((node) => flatIRange(node.range))).toEqual([
      [6, 17, 6, 23],
      [6, 1, 6, 25],
      [5, 1, 6, 25],
      [4, 1, 7, 18],
      [3, 1, 8, 10],
      [2, 1, 8, 10],
      [1, 1, 10, 17],
    ]);
  });

  it('多位点 ⇒ 数组与位点一一对应；越界位点给空数组（不缩短外层）', () => {
    const fake = fakeMonaco();
    installErbSelectionRangeProvider(fake.monaco);
    const result = selectionProviderOf(fake).provideSelectionRanges(
      fakeModel(SELECT).model,
      [position(6, 17), position(9_999, 1)],
      TOKEN,
    ) as Monaco.languages.SelectionRange[][];
    expect(result).toHaveLength(2);
    expect(result[0]!.length).toBeGreaterThan(1);
    expect(result[1]).toEqual([]);
  });

  it('模型已释放 / 取文抛错 ⇒ `[]`（不抛进 Monaco）', () => {
    const fake = fakeMonaco();
    installErbSelectionRangeProvider(fake.monaco);
    const broken = fakeModel(SELECT);
    broken.breakModel();
    expect(
      selectionProviderOf(fake).provideSelectionRanges(broken.model, [position(6, 17)], TOKEN),
    ).toEqual([]);
  });

  it('dispose 幂等：两次只撤一轮', () => {
    const fake = fakeMonaco();
    const handle = installErbSelectionRangeProvider(fake.monaco);
    handle.dispose();
    handle.dispose();
    expect(fake.disposeCalls).toHaveLength(1);
  });
});

/* ============================== ⑧ 源码卫生 ============================== */

describe('源码卫生：Monaco 只 type-only、零插件包 import、不碰结构层开关', () => {
  const highlightSource = readFileSync(
    resolve(REPO_ROOT, 'packages', 'app', 'src', 'monaco', 'erb-highlight.ts'),
    'utf8',
  );
  const selectionSource = readFileSync(
    resolve(REPO_ROOT, 'packages', 'app', 'src', 'monaco', 'erb-selection-range.ts'),
    'utf8',
  );

  it('Monaco 运行时只许 type-only 引入', () => {
    for (const source of [highlightSource, selectionSource]) {
      expect(source).toMatch(/import type \* as Monaco from '\.\/entry'/);
      expect(source).not.toMatch(/import \* as Monaco from/);
      expect(source).not.toMatch(/from 'monaco-editor'/);
    }
  });

  it('不 import 任何插件包、不出现游戏名词', () => {
    for (const source of [highlightSource, selectionSource]) {
      expect(source).not.toMatch(/from\s+['"]@kojo\/plugin-/);
      expect(source).not.toMatch(/\b(eratw|eraK|eraSQN|eraNAS)\b/i);
    }
  });

  it('不看结构层开关（编辑器语言服务），且只挂 ERB_LANGUAGE_ID', () => {
    for (const source of [highlightSource, selectionSource]) {
      // 不读偏好 / 不 import 结构层与 2.0 开关：这两枚 provider 与那条实验开关无关
      expect(source).not.toMatch(/isKojo2CutoverEnabled|localStorage/);
      expect(source).not.toMatch(/from '\.\.?\/ui\/kojo2-flag'/);
      expect(source).not.toMatch(/from '\.\.?\/?(?:monaco\/)?tree-sitter/);
    }
    expect(highlightSource).toMatch(/registerDocumentHighlightProvider\(ERB_LANGUAGE_ID/);
    expect(selectionSource).toMatch(/registerSelectionRangeProvider\(ERB_LANGUAGE_ID/);
  });
});
