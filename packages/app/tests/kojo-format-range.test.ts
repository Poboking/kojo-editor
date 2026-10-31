/**
 * 选区格式化 + 打字规范化（T13）单测。
 *
 * 全部 node 可跑（桩 monaco，同 `kojo-format.test.ts` 口径），钉四件事：
 * (a) 裁剪层：区间外一条编辑都不许出现（含倒置区间、边界行、单行）；
 * (b) 等价性：ERB 形下"整篇算 + 按行裁剪" ≡ "把选区切出来单独算"逐字节相同
 *     （策略 b 的合法性钉子——规则长歪成跨行语义时这条先红）；
 * (c) 行内规范化正反例：缩进/注释区折半角、纯空白行归空；台词正文的 U+3000 不动；
 * (d) on-type：编辑只落触发字符所在那一行；行中 `;`（非整行注释）零编辑。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { computeFormatEdits, type FormatEdit } from '@kojo/plugin-kojo-sugar';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import {
  clipFormatEditsToLines,
  installErbOnTypeFormatter,
  ON_TYPE_TRIGGER_CHARACTERS,
  formatRangeEdits,
} from '../src/monaco/kojo-format-range';

const FW = FULLWIDTH_SPACE;

/** ERB 夹具：1 缩进全角、2 台词（行中全角＝要打印的字）、3 注释区全角、4 纯空白、5 无需改 */
const DOC_LINES = [`${FW}IF X`, `PRINTFORMW 　「呀」`, `;　注释　文`, `${FW}${FW}`, `ENDIF`];
const DOC = `${DOC_LINES.join('\n')}\n`;
const erbRequest = (text: string) => ({ text, dialect: 'erb' as const });

/** 行号区间内每行的旧内容（等价性用例的切片底料） */
function sliceText(lines: readonly string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n');
}

describe('clipFormatEditsToLines · 区间裁剪', () => {
  const edits: FormatEdit[] = [
    { line: 1, startColumn: 1, endColumn: 2, text: 'a' },
    { line: 3, startColumn: 1, endColumn: 2, text: 'b' },
    { line: 5, startColumn: 1, endColumn: 2, text: 'c' },
  ];

  it('区间内的保留、区间外的滤掉（边界行含端点）', () => {
    expect(clipFormatEditsToLines(edits, 2, 3)).toEqual([{ line: 3, startColumn: 1, endColumn: 2, text: 'b' }]);
    expect(clipFormatEditsToLines(edits, 1, 5)).toEqual(edits);
  });

  it('倒置区间 ⇒ 空（宁可不做也不猜方向）', () => {
    expect(clipFormatEditsToLines(edits, 4, 2)).toEqual([]);
  });

  it('单行区间只留该行', () => {
    expect(clipFormatEditsToLines(edits, 5, 5)).toEqual([{ line: 5, startColumn: 1, endColumn: 2, text: 'c' }]);
  });
});

describe('formatRangeEdits · 等价性与不越界', () => {
  it('等价性：整篇算+裁剪 ≡ 区间切片单独算（逐行偏移后逐字节相同）——全区间扫描', () => {
    const lineCount = DOC_LINES.length;
    for (let start = 1; start <= lineCount; start++) {
      for (let end = start; end <= lineCount; end++) {
        const clipped = formatRangeEdits(erbRequest(DOC), start, end);
        const sliced = computeFormatEdits(sliceText(DOC_LINES, start, end), 'erb').map((e) => ({
          ...e,
          line: e.line + start - 1,
        }));
        expect(clipped).toEqual(sliced);
      }
    }
  });

  it('整篇有 3 行要改，选区只盖第 1 行 ⇒ 只有第 1 行的编辑（绝不越界）', () => {
    const out = formatRangeEdits(erbRequest(DOC), 1, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.line).toBe(1);
    expect(out[0]!.text).toBe('  IF X');
  });

  it('选区盖住的行全都无需改 ⇒ 空数组（无变化就是无变化）', () => {
    expect(formatRangeEdits(erbRequest(DOC), 5, 5)).toEqual([]);
  });

  it('行内规范化正例：缩进全角折 2 半角、注释区全角折 1 半角、纯空白行归空', () => {
    const out = formatRangeEdits(erbRequest(DOC), 3, 4);
    expect(out).toEqual([
      { line: 3, startColumn: 1, endColumn: DOC_LINES[2]!.length + 1, text: `; 注释 文` },
      { line: 4, startColumn: 1, endColumn: DOC_LINES[3]!.length + 1, text: '' },
    ]);
  });

  it('行内规范化反例：台词行中段的 U+3000 是要打印的字，选区盖住它也不动', () => {
    expect(formatRangeEdits(erbRequest(DOC), 2, 2)).toEqual([]);
  });

  it('CRLF 文本同样成立（换行符不属于规则层关心的事）', () => {
    const crlfLines = [`${FW}甲`, `乙`];
    const doc = crlfLines.join('\r\n');
    expect(formatRangeEdits(erbRequest(doc), 1, 1)).toEqual([
      { line: 1, startColumn: 1, endColumn: 3, text: '  甲' },
    ]);
  });
});

describe('installErbOnTypeFormatter · 装配与隔离', () => {
  interface Registered {
    kind: 'range' | 'onType';
    languageId: string;
    provider: Monaco.languages.DocumentRangeFormattingEditProvider &
      Partial<Monaco.languages.OnTypeFormattingEditProvider>;
  }

  function stubMonaco() {
    const registered: Registered[] = [];
    const disposed: string[] = [];
    const monaco = {
      languages: {
        registerDocumentRangeFormattingEditProvider(languageId: string, provider: unknown) {
          registered.push({ kind: 'range', languageId, provider: provider as Registered['provider'] });
          return { dispose: () => void disposed.push(languageId) };
        },
        registerOnTypeFormattingEditProvider(languageId: string, provider: unknown) {
          registered.push({ kind: 'onType', languageId, provider: provider as Registered['provider'] });
          return { dispose: () => void disposed.push(languageId) };
        },
      },
    } as unknown as typeof Monaco;
    return { monaco, registered, disposed };
  }

  function stubModel(text: string) {
    const lines = text.split(/\r\n|\r|\n/);
    return {
      getValue: () => text,
      getLineCount: () => lines.length,
      getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? '').length + 1,
    } as unknown as Monaco.editor.ITextModel;
  }

  const formatOpts = {} as Monaco.languages.FormattingOptions;
  const token = {} as Monaco.CancellationToken;
  const range = (start: number, end: number) =>
    ({ startLineNumber: start, endLineNumber: end }) as unknown as Monaco.Range;
  const pos = (lineNumber: number, column = 1) => ({ lineNumber, column }) as Monaco.Position;

  it('只对 ERB 语言注册 on-type 一枚（区间那一枚随 ERB-PARITY G2 移出本模块）；dispose 回收；触发字符就两个', () => {
    const { monaco, registered, disposed } = stubMonaco();
    const handle = installErbOnTypeFormatter(monaco, { resolve: () => null });
    // ERB 的整篇 / 区间两枚 provider 由槽腿工厂（`slot-service-providers.ts` 的
    // `legOf('formatting', …)`）挂上、插件供方作答——本模块不再注册区间那一枚（一门语言每种
    // provider 恰好一枚，输出不再取决于注册序）。
    expect(registered.map((r) => [r.kind, r.languageId])).toEqual([['onType', ERB_LANGUAGE_ID]]);
    const onType = registered.find((r) => r.kind === 'onType')!;
    expect(onType.provider.autoFormatTriggerCharacters).toEqual(ON_TYPE_TRIGGER_CHARACTERS);
    expect(ON_TYPE_TRIGGER_CHARACTERS).toEqual([';', FW]);
    handle.dispose();
    expect(disposed).toEqual([ERB_LANGUAGE_ID]);
  });

  it('onType provider：整篇有三行可改，触发行只有一行 ⇒ 编辑只落那一行', () => {
    const { monaco, registered } = stubMonaco();
    installErbOnTypeFormatter(monaco, { resolve: (m) => erbRequest(m.getValue()) });
    const onType = registered.find((r) => r.kind === 'onType')!.provider;
    const out = onType.provideOnTypeFormattingEdits!(
      stubModel(DOC),
      pos(2, DOC_LINES[1]!.length + 2),
      FW,
      formatOpts,
      token,
    ) as Monaco.languages.TextEdit[];
    // 第 2 行是台词行：行中全角不动 ⇒ 这一触发零编辑（第 1/3 行的可改处不越界过来）
    expect(out).toEqual([]);
    const comment = onType.provideOnTypeFormattingEdits!(
      stubModel(DOC),
      pos(3, 2),
      FW,
      formatOpts,
      token,
    ) as Monaco.languages.TextEdit[];
    expect(comment).toHaveLength(1);
    expect(comment[0]!.range.startLineNumber).toBe(3);
    expect(comment[0]!.range.endLineNumber).toBe(3);
  });

  it('onType 反例：行中 `;` 不构成整行注释 ⇒ 零编辑（打字不乱跳）', () => {
    const { monaco, registered } = stubMonaco();
    installErbOnTypeFormatter(monaco, { resolve: (m) => erbRequest(m.getValue()) });
    const onType = registered.find((r) => r.kind === 'onType')!.provider;
    const out = onType.provideOnTypeFormattingEdits!(
      stubModel(`IF X; 备注`),
      pos(1, 6),
      ';',
      formatOpts,
      token,
    ) as Monaco.languages.TextEdit[];
    expect(out).toEqual([]);
  });

  it('onType 正例：`;` 成形整行注释 / 行首 U+3000 折 2 半角', () => {
    const { monaco, registered } = stubMonaco();
    installErbOnTypeFormatter(monaco, { resolve: (m) => erbRequest(m.getValue()) });
    const onType = registered.find((r) => r.kind === 'onType')!.provider;
    const semi = onType.provideOnTypeFormattingEdits!(
      stubModel(`;${FW}注`),
      pos(1, 2),
      ';',
      formatOpts,
      token,
    ) as Monaco.languages.TextEdit[];
    expect(semi).toHaveLength(1);
    expect(semi[0]!.text).toBe('; 注');
    const indent = onType.provideOnTypeFormattingEdits!(
      stubModel(`${FW}甲`),
      pos(1, 2),
      FW,
      formatOpts,
      token,
    ) as Monaco.languages.TextEdit[];
    expect(indent).toHaveLength(1);
    expect(indent[0]!.text).toBe('  甲');
  });

  it('宿主不应答（糖视图派生 model / 语言认不出）⇒ 零编辑', () => {
    const { monaco, registered } = stubMonaco();
    installErbOnTypeFormatter(monaco, { resolve: () => null });
    const onType = registered[0]!.provider;
    expect(onType.provideOnTypeFormattingEdits!(stubModel(DOC), pos(1, 1), ';', formatOpts, token)).toEqual([]);
  });

  it('resolve 抛错 ⇒ 返回空、只 warn 一次（不许掀编辑器的桌子）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, registered } = stubMonaco();
    installErbOnTypeFormatter(monaco, {
      resolve: () => {
        throw new Error('boom');
      },
    });
    const onType = registered[0]!.provider;
    expect(onType.provideOnTypeFormattingEdits!(stubModel(DOC), pos(1, 1), ';', formatOpts, token)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

/* ==================== 块上下文：on-type 的单行窗口不许与整篇腿分叉（`559a878` 留下的口子） ==================== */

/**
 * ERB 形有了跨行的块状态（数据表块体 / 停用死区）之后，"切片 ≡ 整篇"不再自动成立：
 * 窗口起点落在区里时切片看不见开词 ⇒ 会把整篇腿明确保护的字节改掉。这一组用例钉的就是
 * on-type 那条**前推锚点**（`erbNewContentWithPrefix`：把前缀行按数组喂进同一台状态机），
 * **回退它这里就红**——保护区里的行本来就被逐行规则判成"要改"，免检通道救不了。
 *
 * **选区格式化那半条腿不在这里**（ERB-PARITY G2）：它已整条移出本模块，现在由插件供方
 * （`@kojo/plugin-erb-lang` 的 `erb-formatting`）按"整篇 text + 行区间"作答——判据仍是同一份
 * `computeFormatEdits`，保护区照样一个字节都不动，只是不再走宿主的窗口取文。
 */
describe('installErbOnTypeFormatter · 单行窗口带块上下文（与整篇腿同判据）', () => {
  const BODY = [
    `${FW}PRINTL 区外缩进要折`, //        1 区外：可折（对照组）
    'PRINTDATA', //                        2 数据表区首（结构行）
    `${FW}${FW}DATA ${FW}表体缩进不许动`, //  3 块体：逐行规则想折它的缩进 ⇒ 必须拦住
    '    ', //                             4 块体：纯空白行不许清空
    `;　块体注释不许折`, //                  5 块体：注释折算也不许做
    'ENDDATA', //                          6 收束（结构行）
    '[SKIPSTART]', //                      7 死区首（结构行）
    `${FW}散文式自注释不许动`, //            8 死区正文：全角缩进不许折
    '   ', //                             9 死区纯空白：不许清空
    '[SKIPEND]', //                       10 死区尾（结构行）
    `;　区外注释要折`, //                   11 区外：可折（对照组）
  ];
  const formatOpts = {} as Monaco.languages.FormattingOptions;
  const token = {} as Monaco.CancellationToken;

  interface Fake {
    model: Monaco.editor.ITextModel;
    windowCalls: () => number;
    fullCalls: () => number;
  }

  /** 假 model：`getValueInRange` 按行切片（与宿主 `formatRequestWindowFor` 同形状），并记取文次数 */
  function fakeDoc(lines: readonly string[], opts: { lineContent?: boolean } = {}): Fake {
    const state = { windows: 0, full: 0 };
    const model: Record<string, unknown> = {
      getLanguageId: () => ERB_LANGUAGE_ID,
      getLineCount: () => lines.length,
      getLineMaxColumn: (l: number) => (lines[l - 1] ?? '').length + 1,
      getValue: () => {
        state.full++;
        return lines.join('\n');
      },
      getValueInRange: (r: Monaco.IRange) => {
        state.windows++;
        return lines.slice(r.startLineNumber - 1, r.endLineNumber).join('\n');
      },
      getAlternativeVersionId: () => 1,
    };
    // 老 model / 桩 model 没有逐行取文这条腿（on-type 的前缀扫描会据此让路）
    if (opts.lineContent !== false) model.getLineContent = (l: number) => lines[l - 1] ?? '';
    return {
      model: model as unknown as Monaco.editor.ITextModel,
      windowCalls: () => state.windows,
      fullCalls: () => state.full,
    };
  }

  /** 装好 on-type 一枚，宿主给 `resolve`（整篇）+ `resolveRange`（窗口）两条腿 */
  function installOnType(
    override?: (m: Monaco.editor.ITextModel) => { text: string; dialect: 'erb' } | null,
  ): Monaco.languages.OnTypeFormattingEditProvider {
    let provider: Monaco.languages.OnTypeFormattingEditProvider | null = null;
    const monaco = {
      languages: {
        registerOnTypeFormattingEditProvider: (_id: string, p: unknown) => {
          provider = p as Monaco.languages.OnTypeFormattingEditProvider;
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    installErbOnTypeFormatter(monaco, {
      resolve: override ?? ((m) => ({ text: m.getValue(), dialect: 'erb' as const })),
      resolveRange: (m, start, end) => ({
        text: m.getValueInRange({
          startLineNumber: start,
          startColumn: 1,
          endLineNumber: end,
          endColumn: m.getLineMaxColumn(end),
        }),
        dialect: 'erb' as const,
      }),
    });
    if (provider === null) throw new Error('on-type 供方没注册上');
    return provider;
  }

  const asKeys = (out: readonly Monaco.languages.TextEdit[]): string[] =>
    out.map((e) => `${e.range.startLineNumber}:${e.range.startColumn}:${e.range.endColumn}:${e.text}`);
  const wholeKeys = (lines: readonly string[], startLine: number, endLine: number): string[] =>
    computeFormatEdits(lines.join('\n'), 'erb')
      .filter((e) => e.line >= startLine && e.line <= endLine)
      .map((e) => `${e.line}:${e.startColumn}:${e.endColumn}:${e.text}`);

  it('夹具自证：保护区里的行**确实**是逐行规则想改的（否则这组用例是空面自欺）', () => {
    const protectedLines = [3, 4, 5, 8, 9];
    for (const l of protectedLines) {
      expect(computeFormatEdits(BODY[l - 1]!, 'erb'), `第 ${l} 行必须"裸看"是要改的`).not.toEqual([]);
      expect(wholeKeys(BODY, l, l), `第 ${l} 行在整篇腿上必须零编辑`).toEqual([]);
    }
  });

  it('打字落在数据表块体中间：保护区字节一个都不动', () => {
    for (const l of [3, 4, 5]) {
      const onType = installOnType();
      expect(
        asKeys(
          onType.provideOnTypeFormattingEdits!(
            fakeDoc(BODY).model,
            { lineNumber: l, column: 2 } as Monaco.Position,
            FW,
            formatOpts,
            token,
          ) as Monaco.languages.TextEdit[],
        ),
        `打字落在第 ${l} 行（块体中间）⇒ 必须零编辑`,
      ).toEqual([]);
    }
  });

  it('打字落在停用死区中间：保护区字节一个都不动', () => {
    for (const l of [8, 9]) {
      const onType = installOnType();
      expect(
        asKeys(
          onType.provideOnTypeFormattingEdits!(
            fakeDoc(BODY).model,
            { lineNumber: l, column: 2 } as Monaco.Position,
            ';',
            formatOpts,
            token,
          ) as Monaco.languages.TextEdit[],
        ),
        `打字落在第 ${l} 行（死区中间）⇒ 必须零编辑`,
      ).toEqual([]);
    }
  });

  it('逐行扫描：每一行的 on-type 结果都与整篇腿裁到该行逐字节相同（含空档与末行）', () => {
    const model = fakeDoc(BODY).model;
    const onType = installOnType();
    for (let line = 1; line <= BODY.length; line++) {
      expect(
        asKeys(
          onType.provideOnTypeFormattingEdits!(
            model,
            { lineNumber: line, column: 2 } as Monaco.Position,
            FW,
            formatOpts,
            token,
          ) as Monaco.languages.TextEdit[],
        ),
        `onType 第 ${line} 行`,
      ).toEqual(wholeKeys(BODY, line, line));
    }
  });

  it('模型没有逐行取文这条腿 ⇒ `anchor` 让路并退回整篇那条腿（绝不"当作区外"放行）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const doc = fakeDoc(BODY, { lineContent: false });
    const onType = installOnType();
    const out = asKeys(
      onType.provideOnTypeFormattingEdits!(
        doc.model,
        { lineNumber: 3, column: 2 } as Monaco.Position,
        FW,
        formatOpts,
        token,
      ) as Monaco.languages.TextEdit[],
    );
    // 保护区一行：整篇腿也是零编辑（若当成"区外"放行，这里会折出一条第 3 行的缩进编辑）
    expect(out).toEqual([]);
    expect(doc.fullCalls()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('anchor');
    warn.mockRestore();
  });

  it('降级都有一条 `onDegraded` 出口（不只 console）；回调抛错不许打断请求', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notices: string[] = [];
    let provider: Monaco.languages.OnTypeFormattingEditProvider | null = null;
    const monaco = {
      languages: {
        registerOnTypeFormattingEditProvider: (_id: string, p: unknown) => {
          provider = p as Monaco.languages.OnTypeFormattingEditProvider;
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    installErbOnTypeFormatter(monaco, {
      resolve: () => {
        throw new Error('解析炸了');
      },
      onDegraded: (n) => {
        notices.push(`${n.where}/${n.stage}/${n.reason}`);
        throw new Error('呈现面自己炸了');
      },
    });
    const doc = fakeDoc(BODY);
    expect(
      provider!.provideOnTypeFormattingEdits!(
        doc.model,
        { lineNumber: 1, column: 2 } as Monaco.Position,
        ';',
        formatOpts,
        token,
      ),
    ).toEqual([]);
    expect(notices).toEqual(['resolve/onType/解析炸了']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('窗口这条腿对方言再钉一枚闸：宿主交回 `.kojo` ⇒ 交回整篇那条腿', () => {
    const doc = fakeDoc(DOC_LINES);
    let rangeLegCalls = 0;
    let provider: Monaco.languages.OnTypeFormattingEditProvider | null = null;
    const monaco = {
      languages: {
        registerOnTypeFormattingEditProvider: (_id: string, p: unknown) => {
          provider = p as Monaco.languages.OnTypeFormattingEditProvider;
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    installErbOnTypeFormatter(monaco, {
      resolve: (m) => ({ text: m.getValue(), dialect: 'kojo' as const }),
      resolveRange: (m, start, end) => {
        rangeLegCalls++;
        return {
          text: m.getValueInRange({
            startLineNumber: start,
            startColumn: 1,
            endLineNumber: end,
            endColumn: m.getLineMaxColumn(end),
          }),
          dialect: 'kojo' as const,
        };
      },
    });
    const out = asKeys(
      provider!.provideOnTypeFormattingEdits!(
        doc.model,
        { lineNumber: 1, column: 2 } as Monaco.Position,
        ';',
        formatOpts,
        token,
      ) as Monaco.languages.TextEdit[],
    );
    expect(out).toEqual(
      computeFormatEdits(DOC, 'kojo')
        .filter((e) => e.line === 1)
        .map((e) => `${e.line}:${e.startColumn}:${e.endColumn}:${e.text}`),
    );
    // 只该被叫一次（窗口那条腿被方言闸挡下，不再问第二次）
    expect(rangeLegCalls).toBe(1);
  });
});