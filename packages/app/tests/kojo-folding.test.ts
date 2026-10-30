/**
 * 折叠区间 · 宿主接线（D3：`collectFoldingRanges` + `toMonacoFoldingRanges` +
 * `installFoldingRangeProvider`）单测。
 *
 * 桩 monaco（只给注册函数）+ 桩 model（只给行数），同 `kojo-symbols.test.ts` 的口径：
 * 覆盖 (a) 合并三态与抛错隔离、同区间去重；(b) 行号夹取与"无可隐藏行即丢弃"；
 * (c) 注册落在 ERB 与 `.kojo` 两个语言 id、dispose 全回收；(d) resolve 抛错只"没折叠"。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { EditorFoldingRange, EditorLanguageServiceContribution, EditorLanguageServiceRequest } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { collectFoldingRanges, installFoldingRangeProvider, toMonacoFoldingRanges } from '../src/monaco/kojo-folding';

const REQUEST: EditorLanguageServiceRequest = {
  kind: 'foldingRange',
  path: 'C:\\p\\a.ERB',
  text: '@A\nIF x\nENDIF',
  project: null,
};

const contribution = (
  id: string,
  provide: EditorLanguageServiceContribution['provide'],
): EditorLanguageServiceContribution => ({ id, provide });

const range = (startLine: number, endLine: number): EditorFoldingRange => ({ startLine, endLine });

describe('collectFoldingRanges · 合并与隔离', () => {
  it('三态：`undefined` 跳过、空数组不加、有区间照收（顺序按槽序）', () => {
    const out = collectFoldingRanges(
      [
        contribution('nope', () => undefined),
        contribution('none', () => ({ kind: 'foldingRange', ranges: [] })),
        contribution('hit', () => ({ kind: 'foldingRange', ranges: [range(1, 2), range(3, 9)] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([range(1, 2), range(3, 9)]);
  });

  it('单个贡献抛错不影响其余（隔离；能力出错退化可见）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = collectFoldingRanges(
      [
        contribution('bad', () => {
          throw new Error('boom');
        }),
        contribution('good', () => ({ kind: 'foldingRange', ranges: [range(1, 5)] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([range(1, 5)]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('同区间去重：两枚贡献报同一块只留一份，且不吞后面的正常区间', () => {
    const out = collectFoldingRanges(
      [
        contribution('a', () => ({ kind: 'foldingRange', ranges: [range(1, 2), range(7, 8)] })),
        contribution('b', () => ({ kind: 'foldingRange', ranges: [range(1, 2), range(9, 9)] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([range(1, 2), range(7, 8), range(9, 9)]);
  });

  it('其它判别成员（documentSymbol / definition）不参与折叠合并', () => {
    const out = collectFoldingRanges(
      [
        contribution('sym', () => ({
          kind: 'documentSymbol',
          symbols: [{ name: 'A', kind: 'function', startLine: 1, endLine: 2 }],
        })),
        contribution('def', () => ({ kind: 'definition', locations: [{ filePath: 'x', line: 1 }] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([]);
  });
});

/* ============================== Monaco 装配（桩 monaco） ============================== */

function stubMonaco(): {
  monaco: typeof Monaco;
  registered: { languageId: string; provider: Monaco.languages.FoldingRangeProvider }[];
  disposed: string[];
} {
  const registered: { languageId: string; provider: Monaco.languages.FoldingRangeProvider }[] = [];
  const disposed: string[] = [];
  const monaco = {
    languages: {
      registerFoldingRangeProvider: (
        languageId: string,
        provider: Monaco.languages.FoldingRangeProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => disposed.push(languageId) };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered, disposed };
}

/** 桩 model：5 行 */
const stubModel = (): Monaco.editor.ITextModel =>
  ({ getLineCount: () => 5 }) as unknown as Monaco.editor.ITextModel;

describe('toMonacoFoldingRanges · 协议翻译', () => {
  it('夹取到模型现实：越界夹回、倒挂/同点丢弃（没有可隐藏行的区间不留假箭头）', () => {
    const out = toMonacoFoldingRanges(stubModel(), [
      range(3, 9999), // 终点越界 → 夹到 5
      range(7, 2), // 起终点都夹到 5 → 同点 → 丢
      range(0, 2), // 起点下溢 → 夹到 1
      range(4, 4), // 同点 → 丢
    ]);
    expect(out).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 5 },
    ]);
  });

  it('排序：起点升序、同起点终点降序（外层块在前，gutter 呈现稳定）；夹取后再去重', () => {
    const out = toMonacoFoldingRanges(stubModel(), [range(2, 4), range(1, 5), range(1, 99), range(2, 3)]);
    expect(out).toEqual([
      { start: 1, end: 5 },
      { start: 2, end: 4 },
      { start: 2, end: 3 },
    ]);
  });
});

describe('installFoldingRangeProvider · 装配', () => {
  it('ERB / `.kojo1` 与点名了 `foldingRange` 的 kojo2 各注册一枚；dispose 全部回收', () => {
    const { monaco, registered, disposed } = stubMonaco();
    const handle = installFoldingRangeProvider(monaco, { resolve: () => [] });
    // B3h：折叠改走共享收口带能力名 `foldingRange` ⇒ 除两门 v1 语义语言外，
    // descriptor 里 `slotServices` 点名这一格的 kojo2 也挂上（它的快照由宿主预取）。
    const expected = [ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, KOJO2_LANGUAGE_ID].sort();
    expect(registered.map((r) => r.languageId).sort()).toEqual(expected);
    handle.dispose();
    expect(disposed.sort()).toEqual(expected);
  });

  it('provider 把契约区间翻成 Monaco FoldingRange（模型决定行号上限）', () => {
    const { monaco, registered } = stubMonaco();
    installFoldingRangeProvider(monaco, { resolve: () => [range(1, 4)] });
    const out = registered[0]!.provider.provideFoldingRanges(
      stubModel(),
      {} as Monaco.languages.FoldingContext,
      {} as Monaco.CancellationToken,
    );
    expect(out).toEqual([{ start: 1, end: 4 }]);
  });

  it('宿主 resolve 抛错 → 返回空数组、不崩（折叠不许掀桌子）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, registered } = stubMonaco();
    installFoldingRangeProvider(monaco, {
      resolve: () => {
        throw new Error('boom');
      },
    });
    const out = registered[0]!.provider.provideFoldingRanges(
      stubModel(),
      {} as Monaco.languages.FoldingContext,
      {} as Monaco.CancellationToken,
    );
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
