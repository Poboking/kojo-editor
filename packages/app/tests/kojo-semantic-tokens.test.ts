/**
 * 结构化着色 · 宿主接线（B6：legend / 合并 / 夹取 / delta 编码 / 降级 / provider）单测。
 *
 * 桩 monaco（只给注册函数）+ 桩 model（只给行数与行长），口径同 `kojo-folding.test.ts`。
 * 钉死的是**协议翻译**这一层：编码错一位 Monaco 就会把整篇颜色画歪，而歪法肉眼难归因，
 * 所以 delta 的每条边界（首 token、换行、同行相对、重叠）都单独一条断言。
 *
 * **解码器是 Monaco 自己的**（`tests/helpers/monaco-semantic-decode.ts` 调 `toMultilineTokens2`）：
 * 这里以前各写一份"从 line = 0 起算"的解码器，与编码器同为 1 基 ⇒ 两边一起错、闸一直绿
 * （2026-10-26 真机：整篇结构色下沉一行）。落行读数只认 Monaco 的，不再自洽。
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
import { descriptorForLanguageId } from '../src/monaco/language-registry';
import { HUGE_FILE_LINES, LARGE_FILE_LINES } from '../src/ui/editor-options';
import {
  KOJO_SEMANTIC_TOKEN_LEGEND,
  SEMANTIC_TOKEN_MAX_LINES,
  collectSemanticTokenSpans,
  encodeSemanticTokens,
  installSemanticTokensProvider,
  normalizeSemanticSpans,
  semanticTokenModifierBits,
  semanticTokenTypeIndex,
  semanticTokensWindowed,
  shouldComputeSemanticTokens,
} from '../src/monaco/kojo-semantic-tokens';
import { decodeWithMonaco } from './helpers/monaco-semantic-decode';
// 判据真源是 descriptor 表（`lineWindow`），不是本文件里的语言名字面量：装表之后再断言。
// 生产路径上这张表由 `register-dialects.ts` 的 `import './languages'` 保证先于任何 provider 就位。
import '../src/monaco/languages';

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

  it('首 token 的 deltaLine 是 0 基行、换行时 deltaStart 是 0 基绝对列（Monaco 解码器把 deltaLine 加到 lastLineNumber=1 上）', async () => {
    const data = encodeSemanticTokens([span(7, 3, 6, 'function'), span(9, 5, 8, 'variable', ['declaration'])]);
    expect(await decodeWithMonaco(data)).toEqual([
      { line: 7, startColumn: 3, endColumn: 6, type: 0, bits: 0 },
      { line: 9, startColumn: 5, endColumn: 8, type: 1, bits: 1 },
    ]);
    expect(Array.from(data.slice(0, 5))).toEqual([6, 2, 3, 0, 0]); // 行 7-1、列 3-1
    expect(Array.from(data.slice(5, 10))).toEqual([2, 4, 3, 1, 1]); // 行差 2、新行取 0 基绝对列 5-1
  });

  it('同行多 token：第二个的 deltaStart 是相对前一起始列的差（可负；与基数无关）', async () => {
    const data = encodeSemanticTokens([span(4, 2, 5, 'function'), span(4, 8, 11, 'function')]);
    expect(Array.from(data.slice(5, 10))).toEqual([0, 6, 3, 0, 0]); // 4-4=0 行差、8-2=6
    expect(await decodeWithMonaco(data)).toEqual([
      { line: 4, startColumn: 2, endColumn: 5, type: 0, bits: 0 },
      { line: 4, startColumn: 8, endColumn: 11, type: 0, bits: 0 },
    ]);
  });

  it('输入乱序也稳定：按 (行, 起始列) 升序编码，同起点长区间在前', async () => {
    const data = encodeSemanticTokens([
      span(10, 4, 7, 'function'),
      span(2, 9, 12, 'variable'),
      span(2, 2, 8, 'parameter'),
    ]);
    expect(await decodeWithMonaco(data)).toEqual([
      { line: 2, startColumn: 2, endColumn: 8, type: 2, bits: 0 },
      { line: 2, startColumn: 9, endColumn: 12, type: 1, bits: 0 },
      { line: 10, startColumn: 4, endColumn: 7, type: 0, bits: 0 },
    ]);
  });

  it('同行重叠：保留先到的、丢后者并告警（两枚贡献方口径打架时不画双份）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const data = encodeSemanticTokens([span(3, 2, 8, 'function'), span(3, 5, 9, 'variable')]);
    expect(await decodeWithMonaco(data)).toEqual([{ line: 3, startColumn: 2, endColumn: 8, type: 0, bits: 0 }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('legend 之外的类别整条不进数据（数据长度仍是 5 的倍数）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const data = encodeSemanticTokens([
      span(1, 1, 4, 'function'),
      span(2, 1, 4, 'string' as never),
      span(3, 1, 4, 'parameter'),
    ]);
    expect(data.length).toBe(10);
    expect((await decodeWithMonaco(data)).map((t) => t.type)).toEqual([0, 2]);
    warn.mockRestore();
  });

  it('零宽区间不进数据', () => {
    expect(encodeSemanticTokens([span(1, 4, 4, 'function')])).toEqual(new Uint32Array(0));
  });

  it('真机回归：第 10 / 11 / 12 行的 token 各自落回本行第 1 列（旧码整篇下移一行、列再右移一格）', async () => {
    // 真机症状：第 11 行 `IF LOCAL` 的结构色画到了第 10 行第 2 列起（整行注释那条 token 跨行落位）。
    const data = encodeSemanticTokens([
      span(10, 1, 4, 'function'),
      span(11, 1, 20, 'variable'),
      span(12, 1, 9, 'parameter'),
    ]);
    expect((await decodeWithMonaco(data)).map((t) => [t.line, t.startColumn])).toEqual([
      [10, 1],
      [11, 1],
      [12, 1],
    ]);
  });
});

/* ============================== 降级判据 ============================== */

describe('shouldComputeSemanticTokens · 大文件降级', () => {
  it('阈值就是 `editor-options.ts` 的 `HUGE_FILE_LINES`（2026-10-28 从 LARGE 档抬到 HUGE 档）', () => {
    // 这里**不**抄数字：`SEMANTIC_TOKEN_MAX_LINES` 直接等于那个常量，调档只改
    // `editor-options.ts` 一处，本断言随之移动（抄数字 = 第二真源，正是要防的漂移）。
    // 抬档依据：本供方是一趟线性扫描（24,197 行 43.9 ms），不是 Monaco 那种常驻全文索引；
    // 169,247 行那份 435 ms + 16.8 万 span 仍留在闸外。
    expect(SEMANTIC_TOKEN_MAX_LINES).toBe(HUGE_FILE_LINES);
    expect(shouldComputeSemanticTokens(HUGE_FILE_LINES)).toBe(true);
    expect(shouldComputeSemanticTokens(HUGE_FILE_LINES + 1)).toBe(false);
    expect(shouldComputeSemanticTokens(LARGE_FILE_LINES + 1)).toBe(true); // large 档不再让位
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
    // R3 起 provider 会读这三格（会话层按版本/语言分流）；真 model 恒有，桩补齐即可
    getVersionId: () => 1,
    getLanguageId: () => ERB_LANGUAGE_ID,
    getValue: () => 'AAAAA\n\nBB',
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
    // 第 1 行第 1 列 ⇒ 0 基 delta (0, 0)；终点夹到 getLineMaxColumn(1)=6 ⇒ 宽度 5
    expect(Array.from(value.data)).toEqual([0, 0, 5, 0, 1]);
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

/* ======================= R3：增量会话（变更窗口 → edits） ======================= */

/**
 * 可变桩 model：行数组 + 版本号 + 内容变更事件。
 *
 * 只实现 provider 真会碰的那几格，并且**行文本与 span 由同一份数组派生**——
 * 这样"整篇重算"与"窗口拼装"读的是同一个事实源，对拍才有意义。
 */
interface FakeDoc {
  readonly model: Monaco.editor.ITextModel;
  readonly lines: string[];
  spansOf(lines: readonly string[]): EditorSemanticTokenSpan[];
  /** 把整行 `[at, at+removed-1]` 换成 `added`，推版本并**发一次内容变更事件** */
  replace(at: number, removed: number, added: readonly string[], shape?: 'one' | 'many' | 'flush'): void;
}

function fakeDoc(initial: readonly string[], languageId = ERB_LANGUAGE_ID): FakeDoc {
  const lines = [...initial];
  let versionId = 1;
  const listeners: ((event: unknown) => void)[] = [];
  const spansOf = (rows: readonly string[]): EditorSemanticTokenSpan[] => {
    const out: EditorSemanticTokenSpan[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]!.includes('@')) {
        out.push({ line: i + 1, startColumn: 1, endColumn: 3, tokenType: 'function', modifiers: ['declaration'] });
      } else if (rows[i]!.trim().length > 0) {
        out.push({ line: i + 1, startColumn: 1, endColumn: 2, tokenType: 'variable' });
      }
    }
    return out;
  };
  const model = {
    uri: { toString: () => 'inmemory://fake.ERB' },
    getLineCount: () => lines.length,
    getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
    getVersionId: () => versionId,
    getLanguageId: () => languageId,
    getValue: () => lines.join('\n'),
    getOffsetAt: (position: { lineNumber: number; column: number }) => {
      let at = 0;
      for (let i = 1; i < position.lineNumber; i++) at += (lines[i - 1]?.length ?? 0) + 1;
      return at + position.column - 1;
    },
    getValueInRange: (range: {
      startLineNumber: number;
      endLineNumber: number;
      startColumn: number;
      endColumn: number;
    }) => {
      const rows = lines.slice(range.startLineNumber - 1, range.endLineNumber);
      const text = rows.join('\n');
      const head = range.startColumn - 1;
      const tail = rows.length === 1 ? range.endColumn - 1 : undefined;
      return text.slice(head, tail);
    },
    onDidChangeContent: (listener: (event: unknown) => void) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    lines,
    spansOf,
    replace(at, removed, added, shape = 'one') {
      lines.splice(at - 1, removed, ...added);
      versionId += 1;
      const change = {
        range: { startLineNumber: at, startColumn: 1, endLineNumber: at + removed, endColumn: 1 },
        rangeOffset: 0,
        rangeLength: 0,
        text: added.length === 0 ? '' : `${added.join('\n')}\n`,
      };
      const event = {
        isFlush: shape === 'flush',
        versionId,
        changes: shape === 'many' ? [change, change] : [change],
      };
      for (const listener of [...listeners]) listener(event);
    },
  };
}

/** 按 Monaco 的算法把 `edits` 套到上一版（与 `semantic-token-delta.test.ts` 同一份口径） */
function applyEdits(src: Uint32Array, edits: readonly Monaco.languages.SemanticTokensEdit[]): Uint32Array {
  let delta = 0;
  for (const edit of edits) delta += (edit.data ? edit.data.length : 0) - edit.deleteCount;
  const dest = new Uint32Array(src.length + delta);
  let srcLast = src.length;
  let destLast = dest.length;
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i]!;
    const copyCount = srcLast - (edit.start + edit.deleteCount);
    if (copyCount > 0) {
      dest.set(src.subarray(srcLast - copyCount, srcLast), destLast - copyCount);
      destLast -= copyCount;
    }
    if (edit.data) {
      dest.set(edit.data, destLast - edit.data.length);
      destLast -= edit.data.length;
    }
    srcLast = edit.start;
  }
  if (srcLast > 0) dest.set(src.subarray(0, srcLast), 0);
  return dest;
}

interface Reply {
  readonly data?: Uint32Array;
  readonly edits?: readonly Monaco.languages.SemanticTokensEdit[];
  readonly resultId?: string;
}

/** 一套装配好的 provider + 可变文档（`spansOf` 由文档行派生，窗口是否被供方尊重可切换） */
function harness(
  initial: readonly string[],
  options: { languageId?: string; honorWindow?: boolean } = {},
): {
  doc: FakeDoc;
  ranges: (Monaco.IRange | undefined)[];
  ask(lastResultId: string | null): Reply;
  full(): Uint32Array;
} {
  const doc = fakeDoc(initial, options.languageId ?? ERB_LANGUAGE_ID);
  const ranges: (Monaco.IRange | undefined)[] = [];
  const { monaco, registered } = stubMonaco();
  installSemanticTokensProvider(monaco, {
    resolve: (_model, window) => {
      ranges.push(window);
      const all = doc.spansOf(doc.lines);
      // 两种供方都要能工作：尊重窗口的（真 ERB 腿）与忽略窗口的（其余腿）
      return options.honorWindow === true && window !== undefined
        ? all.filter((s) => s.line >= window.startLineNumber && s.line <= window.endLineNumber)
        : all;
    },
  });
  const provider = registered[0]!.provider;
  return {
    doc,
    ranges,
    ask: (lastResultId) =>
      provider.provideDocumentSemanticTokens(doc.model, lastResultId, {} as Monaco.CancellationToken) as Reply,
    full: () => encodeSemanticTokens(doc.spansOf(doc.lines)),
  };
}

const isEdits = (reply: Reply): boolean => Array.isArray(reply.edits);

describe('installSemanticTokensProvider · 增量会话（R3）', () => {
  for (const honorWindow of [true, false]) {
    it(`一路编辑下去：累积结果逐字节等于整篇重算（供方${honorWindow ? '尊重' : '忽略'}窗口）`, () => {
      const h = harness(['@A', 'B', 'C', 'D'], { honorWindow });
      const first = h.ask(null);
      expect(isEdits(first)).toBe(false);
      expect(Array.from(first.data!)).toEqual(Array.from(h.full()));
      expect(h.ranges).toEqual([undefined]);

      let data = first.data!;
      let resultId = first.resultId!;
      const steps: [number, number, string[]][] = [
        [2, 1, ['@B']], // 改一行
        [2, 0, ['X', 'Y']], // 插两行
        [1, 2, []], // 删两行
        [h.doc.lines.length, 1, []], // 删文末一行
        [1, 1, ['', '']], // 头部换两行空行
      ];
      for (const [at, removed, added] of steps) {
        h.doc.replace(at, removed, added);
        const reply = h.ask(resultId);
        expect(isEdits(reply), `编辑 ${at}/${removed} 之后该走增量`).toBe(true);
        data = applyEdits(data, reply.edits!);
        expect(Array.from(data), `编辑 ${at}/${removed}`).toEqual(Array.from(h.full()));
        // 供方只该被问到一个**窄窗口**：整篇那种「不给 range」绝不许出现
        expect(h.ranges.at(-1), `编辑 ${at}/${removed} 的窗口`).toBeDefined();
        resultId = reply.resultId!;
      }
    });
  }

  it('窗口就是变更行（不是整篇）：改第 3 行，窗口从第 3 行起、不蔓延到别处', () => {
    const h = harness(['@A', 'B', 'C', 'D', 'E'], { honorWindow: true });
    const first = h.ask(null);
    h.doc.replace(3, 1, ['CC']);
    h.ask(first.resultId!);
    // 整行替换的 `range` 末行是**下一行第 1 列**（Monaco 的口径）⇒ 窗口 [3, 4] 正好把那一行含进来
    expect(h.ranges.at(-1)).toMatchObject({ startLineNumber: 3, endLineNumber: 4 });
    expect(h.ranges.at(-1)!.endLineNumber).toBeLessThan(5);
  });

  it('多段变更（多光标）⇒ 退回整篇：不猜窗口', () => {
    const h = harness(['@A', 'B', 'C'], { honorWindow: true });
    const first = h.ask(null);
    h.doc.replace(2, 1, ['BB'], 'many');
    const reply = h.ask(first.resultId!);
    expect(isEdits(reply)).toBe(false);
    expect(Array.from(reply.data!)).toEqual(Array.from(h.full()));
  });

  it('`isFlush`（`setValue` / 撤销越界）⇒ 退回整篇', () => {
    const h = harness(['@A', 'B', 'C'], { honorWindow: true });
    const first = h.ask(null);
    h.doc.replace(1, 3, ['Z'], 'flush');
    const reply = h.ask(first.resultId!);
    expect(isEdits(reply)).toBe(false);
    expect(Array.from(reply.data!)).toEqual(Array.from(h.full()));
  });

  it('`resultId` 对不上 ⇒ 退回整篇（Monaco 手里那份不是我们拼的基线）', () => {
    const h = harness(['@A', 'B', 'C'], { honorWindow: true });
    const first = h.ask(null);
    h.doc.replace(2, 1, ['BB']);
    const reply = h.ask('别人的 resultId');
    expect(isEdits(reply)).toBe(false);
    expect(Array.from(reply.data!)).toEqual(Array.from(h.full()));
  });

  it('版本没变（重问，不是编辑）⇒ 退回整篇：索引可能已经变了', () => {
    const h = harness(['@A', 'B', 'C'], { honorWindow: true });
    const first = h.ask(null);
    const again = h.ask(first.resultId!);
    expect(isEdits(again)).toBe(false);
    expect(h.ranges.at(-1)).toBeUndefined();
  });

  it('model 缺 `getVersionId` ⇒ 退回整篇、不抛（着色面不许因为几何缺一格就掀桌子）', () => {
    const doc = fakeDoc(['@A', 'B', 'C']);
    // 抹掉版本号那一格：模拟只实现了行数的桩 / 跟 Monaco 对过口径的替身
    delete (doc.model as unknown as { getVersionId?: unknown }).getVersionId;
    const ranges: (Monaco.IRange | undefined)[] = [];
    const { monaco, registered } = stubMonaco();
    installSemanticTokensProvider(monaco, {
      resolve: (_model, window) => {
        ranges.push(window);
        return doc.spansOf(doc.lines);
      },
    });
    const provider = registered[0]!.provider;
    const ask = (id: string | null): Reply =>
      provider.provideDocumentSemanticTokens(doc.model, id, {} as Monaco.CancellationToken) as Reply;
    const first = ask(null);
    expect(Array.from(first.data!)).toEqual(Array.from(encodeSemanticTokens(doc.spansOf(doc.lines))));
    doc.replace(2, 1, ['BB']);
    const reply = ask(first.resultId!);
    expect(isEdits(reply)).toBe(false);
    expect(Array.from(reply.data!)).toEqual(Array.from(encodeSemanticTokens(doc.spansOf(doc.lines))));
    expect(ranges.every((range) => range === undefined)).toBe(true);
  });

  it('窗口里出现 `[SKIP` 标记 ⇒ 退回整篇（它改的是跨行可见性）', () => {
    const h = harness(['@A', 'B', 'C'], { honorWindow: true });
    const first = h.ask(null);
    h.doc.replace(2, 1, ['[SKIPSTART]']);
    const reply = h.ask(first.resultId!);
    expect(isEdits(reply)).toBe(false);
    // 之后这份文档常驻"有标记"状态：再来一次普通编辑也只能整篇
    h.doc.replace(2, 1, ['BB']);
    const after = h.ask(reply.resultId!);
    expect(isEdits(after)).toBe(false);
  });

  it('非 ERB 语言（`.kojo`）⇒ 从不发窗口、永远整篇', () => {
    const h = harness(['@A', 'B', 'C'], { languageId: KOJO_LANGUAGE_ID, honorWindow: true });
    const first = h.ask(null);
    h.doc.replace(2, 1, ['BB']);
    const reply = h.ask(first.resultId!);
    expect(isEdits(reply)).toBe(false);
    expect(h.ranges.every((range) => range === undefined)).toBe(true);
  });

  it('`semanticTokensWindowed` 只认声明了 `lineWindow` 的语言（ERB）', () => {
    // 声明面与查表结果必须一致：谓词不自己认语言名，只读 descriptor
    expect(descriptorForLanguageId(ERB_LANGUAGE_ID)?.lineWindow).toBe(true);
    expect(descriptorForLanguageId(KOJO_LANGUAGE_ID)?.lineWindow).toBeUndefined();
    expect(semanticTokensWindowed(ERB_LANGUAGE_ID)).toBe(true);
    expect(semanticTokensWindowed(KOJO_LANGUAGE_ID)).toBe(false);
    expect(semanticTokensWindowed('plaintext')).toBe(false);
  });
});
