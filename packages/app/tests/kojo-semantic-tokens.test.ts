/**
 * 结构化着色 · 宿主接线（B6：legend / 合并 / 夹取 / delta 编码 / 降级 / provider）单测。
 *
 * 桩 monaco（只给注册函数）+ 桩 model（只给行数与行长），口径同 `kojo-folding.test.ts`。
 * 钉死的是**协议翻译**这一层：编码错一位 Monaco 就会把整篇颜色画歪，而歪法肉眼难归因，
 * 所以 delta 的每条边界（首 token、换行、同行相对、重叠）都单独一条断言。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorSemanticTokenSpan,
} from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { LARGE_FILE_LINES } from '../src/ui/editor-options';
import {
  KOJO_SEMANTIC_TOKEN_LEGEND,
  collectSemanticTokenSpans,
  encodeSemanticTokens,
  installSemanticTokensProvider,
  normalizeSemanticSpans,
  semanticTokenModifierBits,
  semanticTokenTypeIndex,
  shouldComputeSemanticTokens,
} from '../src/monaco/kojo-semantic-tokens';

const REQUEST: EditorLanguageServiceRequest = {
  kind: 'semanticToken',
  path: 'C:\\p\\a.ERB',
  text: '@A\nCALL A',
  project: null,
};

const contribution = (
  id: string,
  provide: EditorLanguageServiceContribution['provide'],
): EditorLanguageServiceContribution => ({ id, provide });

const span = (
  line: number,
  startColumn: number,
  endColumn: number,
  tokenType: EditorSemanticTokenSpan['tokenType'],
  modifiers?: EditorSemanticTokenSpan['modifiers'],
): EditorSemanticTokenSpan => ({
  line,
  startColumn,
  endColumn,
  tokenType,
  ...(modifiers ? { modifiers } : {}),
});

/** 五元组解码（断言写给下一个读代码的人：直接读 Uint32Array 是看不出画歪在哪的） */
function decode(data: Uint32Array): { line: number; startColumn: number; length: number; type: number; bits: number }[] {
  const out: { line: number; startColumn: number; length: number; type: number; bits: number }[] = [];
  let line = 0;
  let start = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i]!;
    start = data[i] === 0 ? start + data[i + 1]! : data[i + 1]!;
    out.push({ line, startColumn: start, length: data[i + 2]!, type: data[i + 3]!, bits: data[i + 4]! });
  }
  return out;
}

/* ============================== legend ============================== */

describe('legend · 单一真源在宿主', () => {
  it('legend 就是契约词表那份（顺序 = 词表顺序；下标即 delta 数据里的类型序号）', () => {
    expect(KOJO_SEMANTIC_TOKEN_LEGEND.tokenTypes).toEqual(['function', 'variable', 'parameter']);
    expect(KOJO_SEMANTIC_TOKEN_LEGEND.tokenModifiers).toEqual(['declaration', 'readonly']);
  });

  it('legend 之外的类别 → -1 且**只**告警一次（不着色、不猜相近类别、不刷屏）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(semanticTokenTypeIndex('enumMember' as never)).toBe(-1);
    expect(semanticTokenTypeIndex('enumMember' as never)).toBe(-1);
    expect(semanticTokenTypeIndex('type' as never)).toBe(-1);
    expect(warn).toHaveBeenCalledTimes(2); // 两个不同的未知名字各一次
    expect(semanticTokenTypeIndex('function')).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2); // 已知名字不追加噪音
    warn.mockRestore();
  });

  it('未知修饰丢这一位、类别照旧着色；已知修饰按位叠加', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(semanticTokenModifierBits(['declaration'])).toBe(1);
    expect(semanticTokenModifierBits(['readonly'])).toBe(2);
    expect(semanticTokenModifierBits(['declaration', 'readonly'])).toBe(3);
    expect(semanticTokenModifierBits(['deprecated' as never, 'declaration'])).toBe(1);
    expect(semanticTokenModifierBits(undefined)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

/* ============================== 合并 ============================== */

describe('collectSemanticTokenSpans · 合并与隔离', () => {
  it('三态：`undefined` 跳过、空数组不加、有 span 照收（顺序按槽序）', () => {
    const out = collectSemanticTokenSpans(
      [
        contribution('nope', () => undefined),
        contribution('none', () => ({ kind: 'semanticToken', spans: [] })),
        contribution('hit', () => ({ kind: 'semanticToken', spans: [span(1, 1, 4, 'function')] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([span(1, 1, 4, 'function')]);
  });

  it('单枚贡献抛错不让整篇着色消失（隔离 + 退化可见）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = collectSemanticTokenSpans(
      [
        contribution('bad', () => {
          throw new Error('boom');
        }),
        contribution('good', () => ({ kind: 'semanticToken', spans: [span(2, 6, 9, 'variable')] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([span(2, 6, 9, 'variable')]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('同区间同类别去重；同行同区间**不同类别**两条都留（冲突交给编码层判定）', () => {
    const out = collectSemanticTokenSpans(
      [
        contribution('a', () => ({ kind: 'semanticToken', spans: [span(1, 1, 4, 'function'), span(3, 3, 5, 'parameter')] })),
        contribution('b', () => ({ kind: 'semanticToken', spans: [span(1, 1, 4, 'function'), span(3, 3, 8, 'variable')] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([span(1, 1, 4, 'function'), span(3, 3, 5, 'parameter'), span(3, 3, 8, 'variable')]);
  });

  it('其它判别成员的应答不参与合并（kind 不符即跳过）', () => {
    const out = collectSemanticTokenSpans(
      [
        contribution('sym', () => ({ kind: 'documentSymbol', symbols: [] })),
        contribution('fold', () => ({ kind: 'foldingRange', ranges: [] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([]);
  });
});

/* ============================== 夹取 ============================== */

describe('normalizeSemanticSpans · 列夹取 / 行丢弃', () => {
  /** 3 行模型：行长分别 5 / 0 / 2 个码元 ⇒ maxColumn = 长度 + 1 */
  const geometry = (lineCount: number, widths: readonly number[]): Parameters<typeof normalizeSemanticSpans>[1] => ({
    lineCount,
    maxColumn: (lineNumber) => (widths[lineNumber - 1] ?? 0) + 1,
  });

  it('列越界夹到行内（仍画在正确的行上），行越界**丢弃**（陈旧数据不许把颜色画到别的行）', () => {
    const g = geometry(3, [5, 0, 2]);
    const out = normalizeSemanticSpans(
      [span(1, 1, 99, 'function'), span(4, 1, 3, 'function'), span(0, 1, 2, 'function'), span(3, 1, 3, 'parameter')],
      g,
    );
    expect(out.spans).toEqual([
      span(1, 1, 6, 'function'), // 终点夹到 getLineMaxColumn(1)=6
      span(3, 1, 3, 'parameter'),
    ]);
    expect(out.droppedLines).toBe(2); // 第 4 行与第 0 行
    expect(out.droppedEmpty).toBe(0);
  });

  it('夹完塌成空区间的丢掉（整条都在行尾之后 / 贡献方给了零宽）', () => {
    const g = geometry(1, [3]);
    const out = normalizeSemanticSpans([span(1, 9, 12, 'function'), span(1, 2, 2, 'function')], g);
    expect(out.spans).toEqual([]);
    expect(out.droppedLines).toBe(0);
    expect(out.droppedEmpty).toBe(2);
  });

  it('非有限行号 / 列（NaN、Infinity）不进数据（夹取表达式会把它折成 1，等于编造落点）', () => {
    const g = geometry(2, [4, 4]);
    const out = normalizeSemanticSpans(
      [span(Number.NaN, 1, 3, 'function'), span(1, Number.NaN, Number.NaN, 'function'), span(1, 2, 4, 'function')],
      g,
    );
    expect(out.spans).toEqual([span(1, 2, 4, 'function')]);
    expect(out.droppedLines).toBe(1);
    expect(out.droppedEmpty).toBe(1); // NaN 列折成 [1,1) ⇒ 空区间
  });
});

/* ============================== delta 编码 ============================== */

describe('encodeSemanticTokens · delta 编码', () => {
  it('空输入 → 长度 0 的数组（"认这个文件但无可着色 span"与"不认"在协议层是同一份空数据）', () => {
    expect(encodeSemanticTokens([])).toEqual(new Uint32Array(0));
  });

  it('首 token 的 deltaLine 是绝对行号；换行时 deltaStart 也换成绝对列', () => {
    const data = encodeSemanticTokens([span(7, 3, 6, 'function'), span(9, 5, 8, 'variable', ['declaration'])]);
    expect(decode(data)).toEqual([
      { line: 7, startColumn: 3, length: 3, type: 0, bits: 0 },
      { line: 9, startColumn: 5, length: 3, type: 1, bits: 1 },
    ]);
    expect(Array.from(data.slice(0, 5))).toEqual([7, 3, 3, 0, 0]);
    expect(Array.from(data.slice(5, 10))).toEqual([2, 5, 3, 1, 1]); // 行差 2、新行取绝对列 5
  });

  it('同行多 token：第二个的 deltaStart 是相对前一起始列的差（可负）', () => {
    const data = encodeSemanticTokens([span(4, 2, 5, 'function'), span(4, 8, 11, 'function')]);
    expect(Array.from(data.slice(5, 10))).toEqual([0, 6, 3, 0, 0]); // 4-4=0 行差、8-2=6
  });

  it('输入乱序也稳定：按 (行, 起始列) 升序编码，同起点长区间在前', () => {
    const data = encodeSemanticTokens([
      span(10, 4, 7, 'function'),
      span(2, 9, 12, 'variable'),
      span(2, 2, 8, 'parameter'),
    ]);
    expect(decode(data)).toEqual([
      { line: 2, startColumn: 2, length: 6, type: 2, bits: 0 },
      { line: 2, startColumn: 9, length: 3, type: 1, bits: 0 },
      { line: 10, startColumn: 4, length: 3, type: 0, bits: 0 },
    ]);
  });

  it('同行重叠：保留先到的、丢后者并告警（两枚贡献方口径打架时不画双份）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const data = encodeSemanticTokens([span(3, 2, 8, 'function'), span(3, 5, 9, 'variable')]);
    expect(decode(data)).toEqual([{ line: 3, startColumn: 2, length: 6, type: 0, bits: 0 }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('legend 之外的类别整条不进数据（数据长度仍是 5 的倍数）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const data = encodeSemanticTokens([
      span(1, 1, 4, 'function'),
      span(2, 1, 4, 'string' as never),
      span(3, 1, 4, 'parameter'),
    ]);
    expect(data.length).toBe(10);
    expect(decode(data).map((t) => t.type)).toEqual([0, 2]);
    warn.mockRestore();
  });

  it('零宽区间不进数据', () => {
    expect(encodeSemanticTokens([span(1, 4, 4, 'function')])).toEqual(new Uint32Array(0));
  });
});

/* ============================== 降级判据 ============================== */

describe('shouldComputeSemanticTokens · 大文件降级', () => {
  it('阈值就是 `editor-options.ts` 的 `LARGE_FILE_LINES`（同一族"全文级"开销同开同关；档位一处真源）', () => {
    // 这里**不**再抄一遍 5000：`SEMANTIC_TOKEN_MAX_LINES` 直接等于那个常量，
    // 调档只改 `editor-options.ts` 一处，本断言随之移动（抄数字 = 第二真源，正是要防的漂移）。
    expect(shouldComputeSemanticTokens(LARGE_FILE_LINES)).toBe(true);
    expect(shouldComputeSemanticTokens(LARGE_FILE_LINES + 1)).toBe(false);
  });

  it('空文档 / 非有限行数不算（provider 不该为不存在的文本付全文扫描）', () => {
    expect(shouldComputeSemanticTokens(0)).toBe(false);
    expect(shouldComputeSemanticTokens(-3)).toBe(false);
    expect(shouldComputeSemanticTokens(Number.NaN)).toBe(false);
    expect(shouldComputeSemanticTokens(Number.POSITIVE_INFINITY)).toBe(false);
    expect(shouldComputeSemanticTokens(1)).toBe(true);
  });
});

/* ============================== 装配 ============================== */

function stubMonaco(): {
  monaco: typeof Monaco;
  registered: { languageId: string; provider: Monaco.languages.DocumentSemanticTokensProvider }[];
  disposed: string[];
} {
  const registered: { languageId: string; provider: Monaco.languages.DocumentSemanticTokensProvider }[] = [];
  const disposed: string[] = [];
  const monaco = {
    languages: {
      registerDocumentSemanticTokensProvider: (
        languageId: string,
        provider: Monaco.languages.DocumentSemanticTokensProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => disposed.push(languageId) };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered, disposed };
}

/** 桩 model：3 行，行长 5 / 0 / 2（`getLineMaxColumn` = 长度 + 1） */
function stubModel(): Monaco.editor.ITextModel {
  const widths = [5, 0, 2];
  return {
    uri: { toString: () => 'inmemory://stub.ERB' },
    getLineCount: () => widths.length,
    getLineMaxColumn: (lineNumber: number) => (widths[lineNumber - 1] ?? 0) + 1,
  } as unknown as Monaco.editor.ITextModel;
}

describe('installSemanticTokensProvider · 装配', () => {
  it('ERB 与 `.kojo` 各注册一枚 provider；dispose 全部回收', () => {
    const { monaco, registered, disposed } = stubMonaco();
    const handle = installSemanticTokensProvider(monaco, { resolve: () => [] });
    expect(registered.map((r) => r.languageId).sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
    expect(registered[0]!.provider.getLegend()).toBe(KOJO_SEMANTIC_TOKEN_LEGEND);
    handle.dispose();
    expect(disposed.sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
  });

  it('provider 产出的是**已按模型夹取并编码**的数据', () => {
    const { monaco, registered } = stubMonaco();
    installSemanticTokensProvider(monaco, { resolve: () => [span(1, 1, 99, 'function', ['declaration'])] });
    const value = registered[0]!.provider.provideDocumentSemanticTokens(
      stubModel(),
      null,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.SemanticTokens;
    expect(Array.from(value.data)).toEqual([1, 1, 5, 0, 1]);
  });

  it('宿主 resolve 抛错 → 空数据、不崩（着色不许掀桌子）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, registered } = stubMonaco();
    installSemanticTokensProvider(monaco, {
      resolve: () => {
        throw new Error('boom');
      },
    });
    const value = registered[0]!.provider.provideDocumentSemanticTokens(
      stubModel(),
      null,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.SemanticTokens;
    expect(value.data).toEqual(new Uint32Array(0));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('丢掉越界条数时报出去（铁律 4：退化可见，不静默少画）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, registered } = stubMonaco();
    installSemanticTokensProvider(monaco, { resolve: () => [span(99, 1, 4, 'function')] });
    registered[0]!.provider.provideDocumentSemanticTokens(stubModel(), null, {} as Monaco.CancellationToken);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
