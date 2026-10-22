/**
 * K2-LSP-HILITE-SELECT · Kojo 2.0 **同符号高亮 + 选择范围**的闸。
 *
 * 覆盖四件事：
 * 1. **高亮档位**：声明 = `write`、代码面 / 插值 = `read`、叙事正文同名文字 = `text`；
 *    字符串字面量 / `@原生` 围栏 / 注释 / 表体数据行**不误报**；光标下没有声明符号 ⇒ `[]`；
 * 2. **扩选层级**：词 → 行 → 块（声明体 / `?` 分支体 / `@原生` 整块 / `# 机` 体）→ `# 幕` → 全文；
 *    边界写死：`?` 链按分支、`@原生` 整块一级、表行整行、幕之后的文件级声明不并进幕；
 * 3. **空 / 越界**：空文件、纯空白、越界行列、非法坐标显式空（不夹取、不猜）；
 * 4. **Monaco 面**：DocumentHighlight / SelectionRange（0.57：每位点一条扁平数组）形状、
 *    flag 关零注册、只挂 `kojo2`、dispose 幂等、provider 异常回空，外加源码卫生。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-constants';
import {
  installKojo2HighlightProvider,
  kojo2DocumentHighlights,
  kojo2HighlightKindToMonaco,
  type Kojo2DocumentHighlight,
  type Kojo2HighlightKind,
} from '../src/monaco/kojo2-highlight';
import {
  installKojo2SelectionRangeProvider,
  kojo2SelectionRangeAt,
  type Kojo2SelectionRange,
} from '../src/monaco/kojo2-selection-range';
import type { Kojo2SymbolPosition, Kojo2SymbolRange } from '../src/monaco/kojo2-symbols';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';

/* ============================== 夹具 ============================== */

/**
 * 高亮夹具（每行都可以按内容定位）：
 * - 声明：幕 / 视 / 机 / 变量 / 常量 / 表 / 池 / 函 / 织；
 * - 引用：表 `由` 表达式、`?` 条件、函数体赋值、`!` 触发行、台词插值；
 * - 误报陷阱：注释、字符串字面量、表体数据行的 `心情`、`@原生` 体内的 `心情`；
 * - `text` 档：`> 心情`（旁白正文）与 `\心情`（转义字面文本）。
 */
const HILITE = [
  '// 心情', // 1 注释
  '# 幕 神社清晨', // 2
  '# 视 灵梦', // 3
  '# 机 指令 310', // 4
  '# 变量 心情 整数 = 0 存档', // 5
  '# 常量 引号 字符串 = "心情"', // 6 字符串字面量
  '# 表 心情表 由 心情', // 7
  '    0..99 疏远', // 8
  '    100..499 心情', // 9 表体数据行
  '    否 未知', // 10
  '', // 11
  '# 池 早安问候', // 12
  '    ? 心情 >= 100', // 13
  '        「心情不错。」', // 14（正文连续成词，不该切成 `心情`）
  '    ? 否', // 15
  '        「早安。」', // 16
  '', // 17
  '@函 增加(数值)', // 18
  '    心情 = 心情 + 数值', // 19
  '    ! 早安问候', // 20
  '    ! 增加(心情)', // 21
  '', // 22
  '@织 指令 之后', // 23
  '    > 监听', // 24
  '', // 25
  '> 心情', // 26 text 档
  '灵梦：「{心情}今天。」', // 27 插值 = read
  '\\心情', // 28 转义字面文本 = text 档
  '@原生', // 29
  '    心情 = 1', // 30 原生体（不误报）
].join('\n');

/**
 * 扩选夹具：两幕 + 表 / 池（两条 `?` 分支）/ 函 / 顶层 `@原生` / 幕间空行。
 * 幕 1 的 AST 区间到第 23 行（最后一个叙事节点），第 25 行起的第二幕不并进来。
 */
const SELECT = [
  '# 幕 神社清晨', // 1
  '# 视 灵梦', // 2
  '# 机 指令 310', // 3
  '# 变量 心情 整数 = 0 存档', // 4
  '# 表 心情表 由 心情', // 5
  '    0..99 疏远', // 6
  '    100..499 平常', // 7
  '    否 未知', // 8
  '', // 9
  '# 池 早安问候', // 10
  '    ? 心情 >= 100', // 11
  '        「心情不错。」', // 12
  '    ? 否', // 13
  '        「早安。」', // 14
  '', // 15
  '@函 增加(数值)', // 16
  '    心情 = 心情 + 数值', // 17
  '    ! 早安问候', // 18
  '', // 19
  '@原生', // 20
  '    CALL 心情', // 21
  '', // 22（围栏内的空行归原生块）
  '> 正文', // 23
  '', // 24
  '# 幕 神社黄昏', // 25
  '> 夕阳。', // 26
].join('\n');

/* ============================== 假 Monaco / 假 model ============================== */

const HIGHLIGHT_KINDS = { Text: 0, Read: 1, Write: 2 } as const;

interface Registration {
  readonly selector: unknown;
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
      registerDocumentHighlightProvider: (selector: unknown, provider: unknown) => {
        registrations.push({ selector, provider });
        return { dispose: () => disposeCalls.push(registrations.length) };
      },
      registerSelectionRangeProvider: (selector: unknown, provider: unknown) => {
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
    isDisposed: () => broken,
    getLanguageId: () => KOJO2_LANGUAGE_ID,
  } as unknown as Monaco.editor.ITextModel;
  return { model, breakModel: () => (broken = true) };
}

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

function stubFlag(on: boolean): void {
  const store = new Map<string, string>();
  if (on) store.set(KOJO2_KEY, 'on');
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ============================== 小工具 ============================== */

function splitLines(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

function lineText(source: string, line: number): string {
  return splitLines(source)[line - 1] ?? '';
}

/** 第 `line` 行第 `occurrence` 个 `needle` 的首列（1 基） */
function at(
  source: string,
  line: number,
  needle: string,
  occurrence = 1,
): Kojo2SymbolPosition {
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

/** 1 基区间 → `[行, 列, 行, 列]`（比较用） */
function flat(range: Kojo2SymbolRange): [number, number, number, number] {
  return [range.startLine, range.startColumn, range.endLine, range.endColumn];
}

function flatIRange(range: Monaco.IRange): [number, number, number, number] {
  return [range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn];
}

/** 桩 `Position`（provider 的入参只读 `lineNumber` / `column`，不碰类方法） */
function position(lineNumber: number, column: number): Monaco.Position {
  return { lineNumber, column } as unknown as Monaco.Position;
}

function rangesOf(hits: readonly Kojo2DocumentHighlight[]): Array<[number, number, number, number]> {
  return hits.map((hit) => flat(hit.range));
}

function kindsOf(hits: readonly Kojo2DocumentHighlight[]): Kojo2HighlightKind[] {
  return hits.map((hit) => hit.kind);
}

/** 扩选链（最内层在前）→ 1 基区间数组 */
function chainOf(source: string, position: Kojo2SymbolPosition): Kojo2SymbolRange[] {
  const node = kojo2SelectionRangeAt(source, [position])[0];
  const out: Kojo2SymbolRange[] = [];
  let cursor: Kojo2SelectionRange | undefined = node;
  while (cursor !== undefined) {
    const range = cursor.range;
    out.push({
      startLine: range.startLineNumber,
      startColumn: range.startColumn,
      endLine: range.endLineNumber,
      endColumn: range.endColumn,
    });
    cursor = cursor.parent;
  }
  return out;
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

/* ============================== ① 高亮：读 / 写 / 文 ============================== */

describe('高亮：声明 write、代码面 / 插值 read、叙事正文 text', () => {
  const hits = kojo2DocumentHighlights(HILITE, at(HILITE, 5, '心情'));

  it('光标在声明名上：声明处是唯一 write', () => {
    expect(hits.filter((hit) => hit.kind === 'write').map((hit) => flat(hit.range))).toEqual([
      [5, 6, 5, 8],
    ]);
  });

  it('read：表 `由` 表达式 / 条件 / 函数体 / 触发行实参 / 台词插值', () => {
    const reads = hits.filter((hit) => hit.kind === 'read');
    expect(reads.map((hit) => hit.range.startLine)).toEqual([7, 13, 19, 19, 21, 27]);
    expect(reads.every((hit) => hit.range.startColumn === hit.range.endColumn - 2)).toBe(true);
  });

  it('text：旁白正文与转义字面文本的同名词单独一档', () => {
    expect(hits.filter((hit) => hit.kind === 'text').map((hit) => hit.range.startLine)).toEqual([
      26, 28,
    ]);
  });

  it('总数 = 1 write + 6 read + 2 text，且按源码序', () => {
    expect(hits).toHaveLength(9);
    const starts = hits.map((hit) => hit.range.startLine * 1_000 + hit.range.startColumn);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('光标停在声明头（名字之前）也解析到同一条声明', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 5, '变量'))).toEqual(hits);
  });

  it('字符串字面量里的同名文字不误报（不是引用）', () => {
    expect(hits.some((hit) => hit.range.startLine === 6)).toBe(false);
  });

  it('`@原生` 围栏体不误报', () => {
    expect(hits.some((hit) => hit.range.startLine === 30)).toBe(false);
  });

  it('整行注释不误报', () => {
    expect(hits.some((hit) => hit.range.startLine === 1)).toBe(false);
  });

  it('表体数据行不误报（那里的 `心情` 是单元格值）', () => {
    expect(hits.some((hit) => hit.range.startLine === 9)).toBe(false);
  });

  it('词边界：`心情` 不会误命中声明名 `心情表`，但会命中表头的 `由 心情`', () => {
    const tableLine = lineText(HILITE, 7);
    const nameColumn = tableLine.indexOf('心情表') + 1;
    expect(hits.some((hit) => hit.range.startLine === 7 && hit.range.startColumn === nameColumn)).toBe(
      false,
    );
    const subject = hits.filter((hit) => hit.range.startLine === 7);
    expect(subject).toHaveLength(1);
    expect(subject[0]!.kind).toBe('read');
    expect(subject[0]!.range.startColumn).toBe(tableLine.indexOf('心情', nameColumn) + 1);
  });

  it('高亮表名 `心情表`：只有它自己的 write（主题表达式是别的名字）', () => {
    const tableHits = kojo2DocumentHighlights(HILITE, at(HILITE, 7, '心情表'));
    expect(tableHits).toHaveLength(1);
    expect(tableHits[0]!.kind).toBe('write');
    expect(flat(tableHits[0]!.range)).toEqual([7, 5, 7, 8]);
  });

  it('`@函`：声明 write + `!` 调用位 read', () => {
    const functionHits = kojo2DocumentHighlights(HILITE, at(HILITE, 18, '增加'));
    expect(functionHits.map((hit) => [hit.range.startLine, hit.kind])).toEqual([
      [18, 'write'],
      [21, 'read'],
    ]);
  });

  it('`# 池`：声明 write + `!` 调用位 read', () => {
    const poolHits = kojo2DocumentHighlights(HILITE, at(HILITE, 12, '早安问候'));
    expect(poolHits.map((hit) => [hit.range.startLine, hit.kind])).toEqual([
      [12, 'write'],
      [20, 'read'],
    ]);
  });

  it('`# 机` 与 `@织` 的事件名互为同名声明（两处都是 write）', () => {
    const eventHits = kojo2DocumentHighlights(HILITE, at(HILITE, 4, '指令'));
    expect(eventHits.map((hit) => [hit.range.startLine, hit.kind])).toEqual([
      [4, 'write'],
      [23, 'write'],
    ]);
  });

  it('`# 视` 目标只在自己那一行：说话人 / 台词正文不算引用', () => {
    const viewHits = kojo2DocumentHighlights(HILITE, at(HILITE, 3, '灵梦'));
    expect(viewHits.map((hit) => [hit.range.startLine, hit.kind])).toEqual([[3, 'write']]);
  });
});

/* ============================== ② 高亮：无符号 / 边界 ============================== */

describe('高亮：光标下没有声明符号 ⇒ []', () => {
  it('叙事正文里的词（不是插值）不产高亮', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 26, '心情'))).toEqual([]);
  });

  it('字符串字面量内部 ⇒ []', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 6, '心情'))).toEqual([]);
  });

  it('`@原生` 体内 ⇒ []', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 30, '心情'))).toEqual([]);
  });

  it('注释行 ⇒ []', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 1, '心情'))).toEqual([]);
  });

  it('未声明的外部名 / 数字 / 空白行 ⇒ []', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 4, '310'))).toEqual([]);
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 11, ''))).toEqual([]);
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 24, '监听'))).toEqual([]);
  });

  it('越界 / 非法坐标 / 空文件 / 非字符串 ⇒ []（不抛）', () => {
    expect(kojo2DocumentHighlights(HILITE, { line: 9_999, column: 1 })).toEqual([]);
    expect(kojo2DocumentHighlights(HILITE, { line: 0, column: 1 })).toEqual([]);
    expect(kojo2DocumentHighlights(HILITE, { line: 1, column: 0 })).toEqual([]);
    expect(kojo2DocumentHighlights(HILITE, { line: Number.NaN, column: 1 })).toEqual([]);
    expect(kojo2DocumentHighlights('', { line: 1, column: 1 })).toEqual([]);
    expect(kojo2DocumentHighlights(null as unknown as string, { line: 1, column: 1 })).toEqual([]);
  });
});

/* ============================== ③ 高亮：确定性 / 映射 ============================== */

describe('高亮：确定性、CRLF、档位映射', () => {
  it('同输入两次逐字相等', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 5, '心情'))).toEqual(
      kojo2DocumentHighlights(HILITE, at(HILITE, 5, '心情')),
    );
  });

  it('CRLF 与 LF 同结果（列口径不受行尾影响）', () => {
    const crlf = HILITE.replace(/\n/g, '\r\n');
    expect(kojo2DocumentHighlights(crlf, at(crlf, 5, '心情'))).toEqual(
      kojo2DocumentHighlights(HILITE, at(HILITE, 5, '心情')),
    );
  });

  it('`text` / `read` / `write` → Monaco DocumentHighlightKind（唯一映射表）', () => {
    const fake = fakeMonaco();
    expect(kojo2HighlightKindToMonaco(fake.monaco, 'text')).toBe(HIGHLIGHT_KINDS.Text);
    expect(kojo2HighlightKindToMonaco(fake.monaco, 'read')).toBe(HIGHLIGHT_KINDS.Read);
    expect(kojo2HighlightKindToMonaco(fake.monaco, 'write')).toBe(HIGHLIGHT_KINDS.Write);
  });
});

/* ============================== ④ 高亮 provider ============================== */

describe('高亮 provider：只挂 kojo2、flag 关零注册、dispose 幂等、异常回空', () => {
  it('flag 关 ⇒ 一次注册都没发生，句柄可重复 dispose', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const highlight = installKojo2HighlightProvider(fake.monaco);
    const selection = installKojo2SelectionRangeProvider(fake.monaco);
    expect(fake.registrations).toEqual([]);
    expect(() => {
      highlight.dispose();
      highlight.dispose();
      selection.dispose();
      selection.dispose();
    }).not.toThrow();
    expect(fake.disposeCalls).toEqual([]);
  });

  it('flag 开 ⇒ 一枚注册，selector 只有 kojo2', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2HighlightProvider(fake.monaco);
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]!.selector).toBe(KOJO2_LANGUAGE_ID);
  });

  it('provider 形状：IRange + DocumentHighlightKind（write=2 / read=1 / text=0）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2HighlightProvider(fake.monaco);
    const provider = highlightProviderOf(fake);
    const result = provider.provideDocumentHighlights(
      fakeModel(HILITE).model,
      position(5, 6),
      TOKEN,
    ) as Monaco.languages.DocumentHighlight[];
    expect(result.map((hit) => [flatIRange(hit.range), hit.kind])).toEqual([
      [[5, 6, 5, 8], HIGHLIGHT_KINDS.Write],
      [[7, 11, 7, 13], HIGHLIGHT_KINDS.Read],
      [[13, 7, 13, 9], HIGHLIGHT_KINDS.Read],
      [[19, 5, 19, 7], HIGHLIGHT_KINDS.Read],
      [[19, 10, 19, 12], HIGHLIGHT_KINDS.Read],
      [[21, 10, 21, 12], HIGHLIGHT_KINDS.Read],
      [[26, 3, 26, 5], HIGHLIGHT_KINDS.Text],
      [[27, 6, 27, 8], HIGHLIGHT_KINDS.Read],
      [[28, 2, 28, 4], HIGHLIGHT_KINDS.Text],
    ]);
  });

  it('模型已释放 / 取文抛错 ⇒ []（不抛进 Monaco）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2HighlightProvider(fake.monaco);
    const broken = fakeModel(HILITE);
    broken.breakModel();
    expect(
      highlightProviderOf(fake).provideDocumentHighlights(
        broken.model,
        position(5, 6),
        TOKEN,
      ),
    ).toEqual([]);
  });

  it('dispose 幂等：两次只撤一轮', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const handle = installKojo2HighlightProvider(fake.monaco);
    handle.dispose();
    handle.dispose();
    expect(fake.disposeCalls).toHaveLength(1);
  });
});

/* ============================== ⑤ 扩选：层级 ============================== */

describe('扩选：词 → 行 → 块 → 幕 → 全文', () => {
  it('函数体里的变量：词 / 行 / 函块 / 幕 / 全文 五级', () => {
    const chain = chainOf(SELECT, at(SELECT, 17, '心情'));
    expect(chain).toHaveLength(5);
    expect(chain.map((range) => range.startLine)).toEqual([17, 17, 16, 1, 1]);
    expect(flat(chain[0]!)).toEqual([17, 5, 17, 7]);
    expect(flat(chain[1]!)).toEqual([17, 1, 17, lineText(SELECT, 17).length + 1]);
    expect(flat(chain[2]!)).toEqual([16, 1, 18, lineText(SELECT, 18).length + 1]);
    expect(flat(chain[3]!)).toEqual([1, 1, 23, lineText(SELECT, 23).length + 1]);
    expect(flat(chain[4]!)).toEqual([1, 1, 26, lineText(SELECT, 26).length + 1]);
  });

  it('行级恒为整行（含缩进；起列 1、终列行长 + 1）', () => {
    const chain = chainOf(SELECT, at(SELECT, 17, '心情'));
    const line = chain[1]!;
    expect(line.startColumn).toBe(1);
    expect(line.endColumn).toBe(lineText(SELECT, 17).length + 1);
  });

  it('表行整行：词 / 行 / 表体（声明体）/ 幕 / 全文，不切单元格', () => {
    const chain = chainOf(SELECT, at(SELECT, 6, '疏远'));
    expect(chain).toHaveLength(5);
    expect(flat(chain[1]!)).toEqual([6, 1, 6, lineText(SELECT, 6).length + 1]);
    expect(flat(chain[2]!)).toEqual([5, 1, 8, lineText(SELECT, 8).length + 1]);
    expect(chain[3]!.startLine).toBe(1);
    expect(chain[4]!.endLine).toBe(26);
  });

  it('`?` 链按分支：分支体到分支正文末行，下一条分支不并进来', () => {
    const chain = chainOf(SELECT, at(SELECT, 11, '心情'));
    expect(chain.map((range) => range.startLine)).toEqual([11, 11, 11, 10, 1, 1]);
    expect(flat(chain[2]!)).toEqual([11, 1, 12, lineText(SELECT, 12).length + 1]);
    expect(chain[2]!.endLine).toBe(12);
    // 池声明体（声明体一级：11 的分支 ⊂ 池）
    expect(flat(chain[3]!)).toEqual([10, 1, 14, lineText(SELECT, 14).length + 1]);
  });

  it('第二条 `? 否` 分支自成一块（13–14 行），不含上一条分支', () => {
    const chain = chainOf(SELECT, at(SELECT, 14, '早安'));
    expect(flat(chain[2]!)).toEqual([13, 1, 14, lineText(SELECT, 14).length + 1]);
  });

  it('`@原生` 整块一级：头行到围栏末个非空行，原生体不再细分', () => {
    const chain = chainOf(SELECT, at(SELECT, 21, '心情'));
    expect(chain.map((range) => range.startLine)).toEqual([21, 21, 20, 1, 1]);
    expect(flat(chain[2]!)).toEqual([20, 1, 21, lineText(SELECT, 21).length + 1]);
    expect(chain[3]!.startLine).toBe(1);
  });

  it('`@原生` 写在 `@函` 体里：原生块仍完整落在函块内（尾随空行不吃掉外层）', () => {
    const nested = ['# 幕 一', '@函 甲()', '    @原生', '        CALL X', '> 正文'].join('\n');
    const chain = chainOf(nested, at(nested, 4, 'CALL'));
    expect(chain.map((range) => range.startLine)).toEqual([4, 4, 3, 2, 1]);
    expect(flat(chain[2]!)).toEqual([3, 1, 4, lineText(nested, 4).length + 1]);
    expect(flat(chain[3]!)).toEqual([2, 1, 4, lineText(nested, 4).length + 1]);
  });

  it('`# 幕` 头行：词 / 行 / 幕 / 全文（单行声明不再出块级）', () => {
    const chain = chainOf(SELECT, at(SELECT, 1, '神社清晨'));
    expect(chain.map((range) => range.startLine)).toEqual([1, 1, 1, 1]);
    expect(flat(chain[2]!)).toEqual([1, 1, 23, lineText(SELECT, 23).length + 1]);
    expect(chain[3]!.endLine).toBe(26);
  });

  it('第二幕正文只给第二幕，不串到第一幕', () => {
    const chain = chainOf(SELECT, at(SELECT, 26, '夕阳'));
    expect(flat(chain[2]!)).toEqual([25, 1, 26, lineText(SELECT, 26).length + 1]);
    expect(chain[3]!.endLine).toBe(26);
  });

  it('幕之后的文件级声明不被幕收进去（`@织` 在幕外）', () => {
    const outside = ['# 幕 一', '> 正文', '@织 指令 之前', '    > 监听'].join('\n');
    const chain = chainOf(outside, at(outside, 4, '监听'));
    // 幕 1–2，织块 3–4，全文 1–4
    expect(chain.map((range) => range.startLine)).toEqual([4, 4, 3, 1]);
    expect(flat(chain[2]!)).toEqual([3, 1, 4, lineText(outside, 4).length + 1]);
    expect(chain[3]!.endLine).toBe(4);
  });
});

/* ============================== ⑥ 扩选：`# 机` 体 / 无幕 ============================== */

describe('扩选：没有 `# 幕` 时 `# 机` 体是一级', () => {
  const machineOnly = ['# 机 指令 310', '# 变量 甲 整数', '> 正文', '', ''].join('\n');

  it('机体 = 机声明行到最后一个非空行（规范 §3.7）', () => {
    const chain = chainOf(machineOnly, at(machineOnly, 3, '正文'));
    expect(chain.map((range) => range.startLine)).toEqual([3, 3, 1, 1]);
    expect(flat(chain[2]!)).toEqual([1, 1, 3, lineText(machineOnly, 3).length + 1]);
    expect(chain[3]!.endLine).toBe(5);
  });

  it('有机体时表体嵌在机体内（机体 → 表 → 行 → 词）', () => {
    const source = ['# 机 指令 310', '# 表 甲 由 乙', '    0..9 丙', '', ''].join('\n');
    const chain = chainOf(source, at(source, 3, '丙'));
    expect(chain.map((range) => range.startLine)).toEqual([3, 3, 2, 1, 1]);
    expect(flat(chain[2]!)).toEqual([2, 1, 3, lineText(source, 3).length + 1]);
  });

  it('声明区写在首个幕之前：没有幕父（词 / 行 / 全文）', () => {
    const source = ['# 变量 甲 整数', '# 幕 开场', '> 正文'].join('\n');
    const chain = chainOf(source, at(source, 1, '甲'));
    expect(chain.map((range) => range.startLine)).toEqual([1, 1, 1]);
    expect(chain[2]!.endLine).toBe(3);
  });
});

/* ============================== ⑦ 扩选：空 / 越界 / 多光标 ============================== */

describe('扩选：空文件、越界、多光标、确定性', () => {
  it('空串 / 纯空白 / 空位点数组 ⇒ []', () => {
    expect(kojo2SelectionRangeAt('', [{ line: 1, column: 1 }])).toEqual([]);
    expect(kojo2SelectionRangeAt('   \n\t\n', [{ line: 1, column: 1 }])).toEqual([]);
    expect(kojo2SelectionRangeAt(SELECT, [])).toEqual([]);
  });

  it('越界行 / 越界列 / 非法坐标 ⇒ 该位点显式空（不夹取）', () => {
    expect(kojo2SelectionRangeAt(SELECT, [{ line: 9_999, column: 1 }])).toEqual([]);
    expect(kojo2SelectionRangeAt(SELECT, [{ line: 1, column: 0 }])).toEqual([]);
    expect(kojo2SelectionRangeAt(SELECT, [{ line: 1, column: 999 }])).toEqual([]);
    expect(kojo2SelectionRangeAt(SELECT, [{ line: Number.NaN, column: 1 }])).toEqual([]);
    expect(kojo2SelectionRangeAt(SELECT, [{ line: 1, column: Number.POSITIVE_INFINITY }])).toEqual(
      [],
    );
  });

  it('多光标：结果与输入同序、各自一条链', () => {
    const positions = [at(SELECT, 17, '心情'), at(SELECT, 6, '疏远'), at(SELECT, 14, '早安')];
    const chains = kojo2SelectionRangeAt(SELECT, positions);
    expect(chains).toHaveLength(3);
    expect(chainOf(SELECT, positions[0]!)[0]!.startLine).toBe(17);
    expect(chainOf(SELECT, positions[1]!)[0]!.startLine).toBe(6);
    expect(chainOf(SELECT, positions[2]!)[0]!.startLine).toBe(14);
  });

  it('行末光标取左侧词（行尾列可停靠）', () => {
    const end = { line: 3, column: lineText(SELECT, 3).length + 1 };
    const chain = chainOf(SELECT, end);
    expect(chain[0]!.startColumn).toBe(lineText(SELECT, 3).indexOf('310') + 1);
    expect(chain[0]!.endColumn).toBe(lineText(SELECT, 3).length + 1);
  });

  it('空行位点：没有词级，行 → 全文（不猜块）', () => {
    const chain = chainOf(SELECT, { line: 24, column: 1 });
    expect(chain.map((range) => range.startLine)).toEqual([24, 1]);
    expect(flat(chain[0]!)).toEqual([24, 1, 24, 1]);
    expect(chain[1]!.endLine).toBe(26);
  });

  it('CRLF 与 LF 同结果', () => {
    const crlf = SELECT.replace(/\n/g, '\r\n');
    const lfChain = chainOf(SELECT, at(SELECT, 11, '心情'));
    expect(chainOf(crlf, at(crlf, 11, '心情'))).toEqual(lfChain);
  });

  it('中文名字整词（不按字节切）', () => {
    const chain = chainOf(SELECT, at(SELECT, 1, '神社清晨'));
    expect(flat(chain[0]!)).toEqual([1, 5, 1, 9]);
  });
});

/* ============================== ⑧ 扩选 provider ============================== */

describe('扩选 provider：0.57 形状（每位点一条扁平数组）、flag、dispose、异常', () => {
  it('flag 开 ⇒ 一枚注册，selector 只有 kojo2', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2SelectionRangeProvider(fake.monaco);
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]!.selector).toBe(KOJO2_LANGUAGE_ID);
  });

  it('provider 返回 SelectionRange[][]：每位点一条内 → 外的链', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2SelectionRangeProvider(fake.monaco);
    const provider = selectionProviderOf(fake);
    const result = provider.provideSelectionRanges(
      fakeModel(SELECT).model,
      [position(17, 5)],
      TOKEN,
    ) as Monaco.languages.SelectionRange[][];
    expect(result).toHaveLength(1);
    expect(result[0]!.map((node) => flatIRange(node.range))).toEqual([
      [17, 5, 17, 7],
      [17, 1, 17, lineText(SELECT, 17).length + 1],
      [16, 1, 18, lineText(SELECT, 18).length + 1],
      [1, 1, 23, lineText(SELECT, 23).length + 1],
      [1, 1, 26, lineText(SELECT, 26).length + 1],
    ]);
  });

  it('多位点 ⇒ 数组与位点一一对应；越界位点给空数组（不缩短外层）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2SelectionRangeProvider(fake.monaco);
    const provider = selectionProviderOf(fake);
    const result = provider.provideSelectionRanges(
      fakeModel(SELECT).model,
      [
        position(17, 5),
        position(9_999, 1),
      ],
      TOKEN,
    ) as Monaco.languages.SelectionRange[][];
    expect(result).toHaveLength(2);
    expect(result[0]!.length).toBeGreaterThan(1);
    expect(result[1]).toEqual([]);
  });

  it('模型已释放 / 取文抛错 ⇒ []（不抛进 Monaco）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2SelectionRangeProvider(fake.monaco);
    const broken = fakeModel(SELECT);
    broken.breakModel();
    expect(
      selectionProviderOf(fake).provideSelectionRanges(
        broken.model,
        [position(17, 5)],
        TOKEN,
      ),
    ).toEqual([]);
  });

  it('dispose 幂等：两次只撤一轮', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const handle = installKojo2SelectionRangeProvider(fake.monaco);
    handle.dispose();
    handle.dispose();
    expect(fake.disposeCalls).toHaveLength(1);
  });
});

/* ============================== ⑨ 源码卫生 ============================== */

describe('源码卫生：Monaco 只 type-only、不碰插件包、flag 自身再挡一次', () => {
  const highlightSource = readFileSync(
    resolve(REPO_ROOT, 'packages', 'app', 'src', 'monaco', 'kojo2-highlight.ts'),
    'utf8',
  );
  const selectionSource = readFileSync(
    resolve(REPO_ROOT, 'packages', 'app', 'src', 'monaco', 'kojo2-selection-range.ts'),
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

  it('安装器自带 flag 闸，且只挂 KOJO2_LANGUAGE_ID', () => {
    expect(highlightSource).toMatch(/if \(!isKojo2CutoverEnabled\(\)\) return NOOP_DISPOSABLE;/);
    expect(selectionSource).toMatch(/if \(!isKojo2CutoverEnabled\(\)\) return NOOP_DISPOSABLE;/);
    expect(highlightSource).toMatch(
      /registerDocumentHighlightProvider\(\s*KOJO2_LANGUAGE_ID/,
    );
    expect(selectionSource).toMatch(/registerSelectionRangeProvider\(\s*KOJO2_LANGUAGE_ID/);
  });
});
