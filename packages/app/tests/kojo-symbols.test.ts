/**
 * 文档大纲 · 宿主接线（B3：`collectDocumentSymbols` + `toMonacoDocumentSymbols` +
 * `installDocumentSymbolProvider`）单测。
 *
 * 桩 monaco（只给用到的 `SymbolKind` 与注册函数），不引入 monaco 运行时：
 * 覆盖 (a) 合并三态与抛错隔离、重复项去重；(b) 行号夹取（陈旧/越界/倒挂）；
 * (c) 注册落在 ERB 与 `.kojo` 两个语言 id、dispose 全回收；(d) resolve 抛错只"没大纲"。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  EditorDocumentSymbol,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  collectDocumentSymbols,
  documentSymbolKindToMonaco,
  installDocumentSymbolProvider,
  toMonacoDocumentSymbols,
} from '../src/monaco/kojo-symbols';

const REQUEST: EditorLanguageServiceRequest = {
  kind: 'documentSymbol',
  path: 'C:\\p\\a.ERB',
  text: '@A\n@B',
  project: null,
};

const contribution = (
  id: string,
  provide: EditorLanguageServiceContribution['provide'],
): EditorLanguageServiceContribution => ({ id, provide });

const fn = (name: string, startLine: number, endLine: number): EditorDocumentSymbol => ({
  name,
  kind: 'function',
  startLine,
  endLine,
});

describe('collectDocumentSymbols · 合并与隔离', () => {
  it('三态：`undefined` 跳过、空数组不加、有项照收（顺序按槽序）', () => {
    const out = collectDocumentSymbols(
      [
        contribution('nope', () => undefined),
        contribution('none', () => ({ kind: 'documentSymbol', symbols: [] })),
        contribution('hit', () => ({ kind: 'documentSymbol', symbols: [fn('A', 1, 2), fn('B', 3, 9)] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([fn('A', 1, 2), fn('B', 3, 9)]);
  });

  it('单个贡献抛错不影响其余（隔离；能力出错退化可见）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = collectDocumentSymbols(
      [
        contribution('bad', () => {
          throw new Error('boom');
        }),
        contribution('good', () => ({ kind: 'documentSymbol', symbols: [fn('A', 1, 1)] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([fn('A', 1, 1)]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('去重：同 name + kind + 区间只留一份；重复项不吞掉它后面的正常项', () => {
    const out = collectDocumentSymbols(
      [
        contribution('a', () => ({ kind: 'documentSymbol', symbols: [fn('A', 1, 2), fn('C', 7, 8)] })),
        contribution('b', () => ({ kind: 'documentSymbol', symbols: [fn('A', 1, 2), fn('D', 9, 9)] })),
      ],
      REQUEST,
    );
    expect(out.map((s) => s.name)).toEqual(['A', 'C', 'D']);
  });

  it('其它判别成员（definition）不参与大纲合并', () => {
    const out = collectDocumentSymbols(
      [contribution('def', () => ({ kind: 'definition', locations: [{ filePath: 'x', line: 1 }] }))],
      REQUEST,
    );
    expect(out).toEqual([]);
  });
});

/* ============================== Monaco 装配（桩 monaco） ============================== */

/** 桩 monaco：SymbolKind 用可辨识的数字，注册函数只记录 */
function stubMonaco(): {
  monaco: typeof Monaco;
  registered: { languageId: string; provider: Monaco.languages.DocumentSymbolProvider }[];
  disposed: string[];
} {
  const registered: { languageId: string; provider: Monaco.languages.DocumentSymbolProvider }[] = [];
  const disposed: string[] = [];
  const monaco = {
    languages: {
      SymbolKind: {
        Function: 11,
        Namespace: 2,
        Object: 18,
        Variable: 12,
      } as unknown as typeof Monaco.languages.SymbolKind,
      registerDocumentSymbolProvider: (
        languageId: string,
        provider: Monaco.languages.DocumentSymbolProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => disposed.push(languageId) };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered, disposed };
}

/** 桩 model：5 行，每行最长 10 列 */
const stubModel = (): Monaco.editor.ITextModel =>
  ({
    getLineCount: () => 5,
    getLineMaxColumn: (line: number) => 10 + line,
  }) as unknown as Monaco.editor.ITextModel;

describe('toMonacoDocumentSymbols · 协议翻译', () => {
  it('类别映射：四种中性类别各落一枚 Monaco 图标（宿主零语言知识）', () => {
    const { monaco } = stubMonaco();
    expect(documentSymbolKindToMonaco(monaco, 'function')).toBe(monaco.languages.SymbolKind.Function);
    expect(documentSymbolKindToMonaco(monaco, 'section')).toBe(monaco.languages.SymbolKind.Namespace);
    expect(documentSymbolKindToMonaco(monaco, 'block')).toBe(monaco.languages.SymbolKind.Object);
    expect(documentSymbolKindToMonaco(monaco, 'declaration')).toBe(monaco.languages.SymbolKind.Variable);
  });

  it('区间夹取：越界 / 倒挂 / 非整数都不让大纲崩，选区只到块头', () => {
    const { monaco } = stubMonaco();
    const [hit] = toMonacoDocumentSymbols(monaco, stubModel(), [
      { name: 'A', kind: 'function', startLine: 3, endLine: 9999 },
      { name: 'B', kind: 'block', startLine: 7, endLine: 2 },
      { name: 'C', kind: 'declaration', startLine: 0, endLine: 0 },
    ]);
    expect(hit?.range).toEqual({ startLineNumber: 3, startColumn: 1, endLineNumber: 5, endColumn: 15 });
    const [, flipped, zero] = toMonacoDocumentSymbols(monaco, stubModel(), [
      { name: 'A', kind: 'function', startLine: 3, endLine: 9999 },
      { name: 'B', kind: 'block', startLine: 7, endLine: 2 },
      { name: 'C', kind: 'declaration', startLine: 0, endLine: 0 },
    ]);
    expect(flipped?.range.startLineNumber).toBe(5);
    expect(flipped?.range.endLineNumber).toBe(5);
    expect(zero?.range.startLineNumber).toBe(1);
    expect(hit?.selectionRange).toEqual({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 13 });
  });

  it('空 `children` 不翻译成子树（Monaco 会画出点不开的假箭头）', () => {
    const { monaco } = stubMonaco();
    const [symbol] = toMonacoDocumentSymbols(monaco, stubModel(), [
      { name: 'A', kind: 'block', startLine: 1, endLine: 2, children: [] },
    ]);
    expect(symbol?.children).toBeUndefined();
  });

  it('子树递归翻译（层次保住、detail 缺省成空串）', () => {
    const { monaco } = stubMonaco();
    const [timing] = toMonacoDocumentSymbols(monaco, stubModel(), [
      {
        name: '时机 指令 310',
        kind: 'function',
        startLine: 1,
        endLine: 5,
        children: [{ name: '若 噴乳', kind: 'section', startLine: 2, endLine: 3, detail: '备注' }],
      },
    ]);
    expect(timing?.detail).toBe('');
    expect(timing?.children?.[0]).toMatchObject({ name: '若 噴乳', detail: '备注' });
    expect(timing?.children?.[0]?.range.startLineNumber).toBe(2);
  });
});

describe('installDocumentSymbolProvider · 装配', () => {
  // B2（2026-10-24）：这枚 provider 现在多挂一门 `kojo2` —— 它的 descriptor 声明了
  // `slotServices: ['documentSymbol']`（"只挂点名的槽腿"），供方是插件
  // `@kojo/plugin-kojo-lang`。所以本文件断言的是**三枚**：两门 v1 一等语言（全铺）
  // 加 2.0（点名）。这条变化本身就是 B2 的判据：宿主不再自建 2.0 大纲 provider。
  it('ERB / `.kojo` / `kojo2` 各注册一枚 provider；dispose 全部回收', () => {
    const { monaco, registered, disposed } = stubMonaco();
    const handle = installDocumentSymbolProvider(monaco, { resolve: () => [] });
    const expected = [ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, 'kojo2'].sort();
    expect(registered.map((r) => r.languageId).sort()).toEqual(expected);
    handle.dispose();
    expect(disposed.sort()).toEqual(expected);
  });

  it('provider 把宿主给的契约符号翻译成 Monaco 树（模型决定行号上限）', () => {
    const { monaco, registered } = stubMonaco();
    installDocumentSymbolProvider(monaco, { resolve: () => [fn('A', 1, 4)] });
    const out = registered[0]!.provider.provideDocumentSymbols(stubModel(), {} as Monaco.CancellationToken);
    expect(Array.isArray(out)).toBe(true);
    expect((out as Monaco.languages.DocumentSymbol[])[0]).toMatchObject({ name: 'A', kind: 11 });
  });

  it('宿主 resolve 抛错 → 返回空树、不崩（大纲不许掀桌子）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, registered } = stubMonaco();
    installDocumentSymbolProvider(monaco, {
      resolve: () => {
        throw new Error('boom');
      },
    });
    const out = registered[0]!.provider.provideDocumentSymbols(stubModel(), {} as Monaco.CancellationToken);
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
