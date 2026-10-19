/**
 * `$` 标签导航（W-2，2026-10-19）：宿主侧作用域读数 + F12 / Shift+F12 接线。
 *
 * 数据源是**当前缓冲区文本**（脏缓冲也正确）：标签是函数局部事实，不依赖项目索引。
 * 覆盖：定义自跳、跳转目标、CJK 名、大小写不敏感、跨函数隔离、`.kojo` 不答、
 * 桩 model 无路径 fail-open，以及两条 provider 的落点区间（span → Monaco Range）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { installDefinitionProvider } from '../src/monaco/kojo-definition';
import { installReferenceProvider } from '../src/monaco/find-references';
import {
  labelDefinitionLocations,
  labelReferenceLocations,
  resolveErbLabelScopeAt,
} from '../src/monaco/erb-label-navigation';

const PATH = String.raw`c:\proj\erb\label.erb`;

/** 3 `$NEXT`｜5 `GOTO NEXT`｜7 `CALL NEXT`（函数调用不是标签）｜8 `@OTHER`｜9 另一函数的 `$NEXT` */
const TEXT = ['@MAIN', '  PRINTL A', '$NEXT', '  PRINTL B', '  GOTO NEXT', '  PRINTL C', '  CALL NEXT', '@OTHER', '$NEXT', '  GOTO NEXT'].join('\n');

function fakeModel(text: string, path: string | null): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    uri:
      path === null
        ? { toString: () => 'inmemory://model/1' }
        : { fsPath: path, path, toString: () => 'file:///label.erb' },
    getValue: () => text,
    getLineCount: () => lines.length,
    getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getWordAtPosition: () => ({ startColumn: 2, endColumn: 6 }),
  } as unknown as Monaco.editor.ITextModel;
}

const at = (lineNumber: number, column: number): Monaco.Position =>
  ({ lineNumber, column }) as Monaco.Position;

describe('$ 标签作用域 · 宿主读数', () => {
  const model = fakeModel(TEXT, PATH);

  it('跳转目标：给出定义与本函数的全部跳转（跨函数同名不混入）', () => {
    const scope = resolveErbLabelScopeAt(model, at(5, 8))!;
    expect(scope.normalizedName).toBe('NEXT');
    expect(scope.occurrences.map((o) => [o.line, o.kind])).toEqual([
      [3, 'definition'],
      [5, 'jump'],
    ]);
    expect(scope.occurrences[0]!.column).toBe(2);
    expect(scope.occurrences[0]!.endColumn).toBe(6);
    expect(scope.occurrences[1]!.column).toBe(8);
    expect(scope.occurrences[1]!.endColumn).toBe(12);
  });

  it('定义行入口：光标在名字内 / 词尾都算；`$` 自身不算', () => {
    expect(resolveErbLabelScopeAt(model, at(3, 2))?.occurrences.length).toBe(2);
    expect(resolveErbLabelScopeAt(model, at(3, 6))?.occurrences.length).toBe(2);
    expect(resolveErbLabelScopeAt(model, at(3, 1))).toBeNull();
  });

  it('非标签入口：CALL 同名 / 字符串 / 注释 / `.kojo` / 无路径 ⇒ null', () => {
    expect(resolveErbLabelScopeAt(model, at(7, 8))).toBeNull();
    expect(resolveErbLabelScopeAt(model, at(2, 4))).toBeNull();
    expect(resolveErbLabelScopeAt(fakeModel(TEXT, 'C:/proj/erb/label.kojo'), at(5, 8))).toBeNull();
    expect(resolveErbLabelScopeAt(fakeModel(TEXT, null), at(5, 8))).toBeNull();
  });

  it('CJK 标签名与大小写不敏感', () => {
    const cjk = fakeModel('@F\n$开始\n\tGOTO 开始\n', PATH);
    expect(resolveErbLabelScopeAt(cjk, at(3, 7))?.normalizedName).toBe('开始');
    const lower = fakeModel('@F\n$Next\n\tgoto next\n', PATH);
    expect(resolveErbLabelScopeAt(lower, at(3, 7))?.occurrences.map((o) => o.name)).toEqual(['Next', 'next']);
  });

  it('落点投影：定义带 kind=definition；跳转记 mention（不是 call）且带 span', () => {
    const scope = resolveErbLabelScopeAt(model, at(5, 8))!;
    expect(labelDefinitionLocations(scope)).toEqual([
      { filePath: PATH, line: 3, column: 2, span: { columnStart: 2, columnEnd: 6 }, kind: 'definition' },
    ]);
    expect(labelReferenceLocations(scope)).toEqual([
      { filePath: PATH, line: 3, column: 2, span: { columnStart: 2, columnEnd: 6 }, kind: 'definition' },
      { filePath: PATH, line: 5, column: 8, span: { columnStart: 8, columnEnd: 12 }, kind: 'mention' },
    ]);
  });
});

/* ============================== provider 接线（桩 monaco） ============================== */

function stubMonaco(): {
  monaco: typeof Monaco;
  definitions: { languageId: string; provider: Monaco.languages.DefinitionProvider }[];
  references: { languageId: string; provider: Monaco.languages.ReferenceProvider }[];
} {
  const definitions: { languageId: string; provider: Monaco.languages.DefinitionProvider }[] = [];
  const references: { languageId: string; provider: Monaco.languages.ReferenceProvider }[] = [];
  const monaco = {
    Uri: { file: (p: string) => ({ toString: () => `file:///${p}`, fsPath: p }) },
    languages: {
      registerDefinitionProvider: (languageId: string, provider: Monaco.languages.DefinitionProvider) => {
        definitions.push({ languageId, provider });
        return { dispose: () => undefined };
      },
      registerReferenceProvider: (languageId: string, provider: Monaco.languages.ReferenceProvider) => {
        references.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
    editor: { registerEditorOpener: () => ({ dispose: () => undefined }) },
  };
  return { monaco: monaco as unknown as typeof Monaco, definitions, references };
}

describe('$ 标签导航 · provider 接线', () => {
  const model = fakeModel(TEXT, PATH);

  it('F12 在 `$NEXT` 定义名上 → 定义自跳', () => {
    const { monaco, definitions } = stubMonaco();
    installDefinitionProvider(monaco, { resolve: () => [], navigate: () => undefined, openModelFor: () => model });
    const provider = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const links = provider.provideDefinition(model, at(3, 2), {} as Monaco.CancellationToken) as Monaco.languages.LocationLink[];
    expect(links.map((l) => [l.targetSelectionRange!.startLineNumber, l.targetSelectionRange!.startColumn])).toEqual([[3, 2]]);
  });

  it('F12 在 CJK 跳转目标上 → 槽腿认不出也照样跳到定义（宿主标签腿兜底）', () => {
    const cjk = fakeModel('@F\n$开始\n\tGOTO 开始\n', PATH);
    const { monaco, definitions } = stubMonaco();
    installDefinitionProvider(monaco, { resolve: () => [], navigate: () => undefined, openModelFor: () => cjk });
    const provider = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const links = provider.provideDefinition(cjk, at(3, 7), {} as Monaco.CancellationToken) as Monaco.languages.LocationLink[];
    expect(links.map((l) => l.targetSelectionRange!.startLineNumber)).toEqual([2]);
  });

  it('Shift+F12 → 定义 + 本函数全部跳转（区间来自 span）', () => {
    const { monaco, references } = stubMonaco();
    installReferenceProvider(monaco, { resolve: () => [], navigate: () => undefined, openModelFor: () => model });
    const provider = references.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const locations = provider.provideReferences!(
      model,
      at(5, 8),
      {} as Monaco.languages.ReferenceContext,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.Location[];
    expect(locations.map((l) => [l.range.startLineNumber, l.range.startColumn, l.range.endColumn])).toEqual([
      [3, 2, 6],
      [5, 8, 12],
    ]);
  });

  it('fail-open：桩 model 没有路径 ⇒ 两条腿都零贡献，且不抛', () => {
    const bare = fakeModel(TEXT, null);
    const { monaco, definitions, references } = stubMonaco();
    installDefinitionProvider(monaco, { resolve: () => [], navigate: () => undefined, openModelFor: () => bare });
    installReferenceProvider(monaco, { resolve: () => [], navigate: () => undefined, openModelFor: () => bare });
    const def = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const ref = references.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    expect(() => def.provideDefinition(bare, at(5, 8), {} as Monaco.CancellationToken)).not.toThrow();
    expect(def.provideDefinition(bare, at(5, 8), {} as Monaco.CancellationToken)).toBeUndefined();
    expect(
      ref.provideReferences!(bare, at(5, 8), {} as Monaco.languages.ReferenceContext, {} as Monaco.CancellationToken),
    ).toEqual([]);
  });
});
