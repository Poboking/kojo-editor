/**
 * 转到定义 · 宿主接线（`collectDefinitionLocations` + `installDefinitionProvider`）单测。
 *
 * Monaco 绑定刻意薄：本文件用**桩 monaco**（只记录注册与 dispose）喂 provider，
 * 不引入真实 monaco-editor 运行时。覆盖：(a) 注册落在 ERB 与 `.kojo` 两个语言 id 上；
 * (b) 合并三态（`undefined` 跳过 / 空数组不加 / 有目标照收）、按贡献隔离抛错、去重；
 * (c) 无目标时不导航、有目标时导航**第一个**且**不**回 Location（跨文件由宿主通道落地）。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { EditorLanguageServiceContribution, EditorSymbolLocation } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { collectDefinitionLocations, installDefinitionProvider } from '../src/monaco/kojo-definition';

const REQUEST = {
  kind: 'definition',
  path: 'C:\\p\\a.ERB',
  text: '@A\n\tCALL B',
  line: 2,
  column: 8,
  project: null,
} as const;

function contribution(
  id: string,
  provide: EditorLanguageServiceContribution['provide'],
): EditorLanguageServiceContribution {
  return { id, provide };
}

const loc = (line: number, filePath = 'C:\\p\\b.ERB'): EditorSymbolLocation => ({ filePath, line });

describe('collectDefinitionLocations · 合并与隔离', () => {
  it('三态：`undefined` 跳过、空数组不加、有目标照收（顺序按槽序）', () => {
    const out = collectDefinitionLocations(
      [
        contribution('nope', () => undefined), // 不认这个文件
        contribution('none', () => ({ kind: 'definition', locations: [] })), // 认但无目标
        contribution('hit', () => ({ kind: 'definition', locations: [loc(3), loc(9)] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([loc(3), loc(9)]);
  });

  it('单个贡献抛错不影响其余（隔离；能力出错退化可见）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = collectDefinitionLocations(
      [
        contribution('bad', () => {
          throw new Error('boom');
        }),
        contribution('good', () => ({ kind: 'definition', locations: [loc(5)] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([loc(5)]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('去重：文件 + 行 + 列 全同只留一份（两条线同时命中同一目标）', () => {
    const out = collectDefinitionLocations(
      [
        contribution('a', () => ({ kind: 'definition', locations: [loc(1), { ...loc(1), column: 3 }] })),
        contribution('b', () => ({ kind: 'definition', locations: [loc(1), loc(2)] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([loc(1), { ...loc(1), column: 3 }, loc(2)]);
  });

  it('无贡献方 / 全不认 → 空数组', () => {
    expect(collectDefinitionLocations([], REQUEST)).toEqual([]);
    expect(collectDefinitionLocations([contribution('x', () => undefined)], REQUEST)).toEqual([]);
  });
});

/* ============================== Monaco 装配（桩 monaco） ============================== */

interface Registered {
  languageId: string;
  provider: Monaco.languages.DefinitionProvider;
}

function stubMonaco(): { monaco: typeof Monaco; registered: Registered[]; disposed: string[] } {
  const registered: Registered[] = [];
  const disposed: string[] = [];
  const monaco = {
    languages: {
      registerDefinitionProvider: (
        languageId: string,
        provider: Monaco.languages.DefinitionProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => disposed.push(languageId) };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered, disposed };
}

const model = {} as Monaco.editor.ITextModel;
const position = { lineNumber: 2, column: 8 } as Monaco.Position;

describe('installDefinitionProvider · 装配', () => {
  it('ERB 与 `.kojo` 两个语言 id 各注册一枚 provider；dispose 全部回收', () => {
    const { monaco, registered, disposed } = stubMonaco();
    const handle = installDefinitionProvider(monaco, { resolve: () => [], navigate: () => undefined });
    expect(registered.map((r) => r.languageId).sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
    handle.dispose();
    expect(disposed.sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
  });

  it('有目标：导航**第一个**，provider 返回 undefined（跨文件由宿主通道落地，不走 Monaco 自带跳转）', () => {
    const { monaco, registered } = stubMonaco();
    const navigate = vi.fn();
    installDefinitionProvider(monaco, { resolve: () => [loc(7), loc(8)], navigate });
    const ret = registered[0]!.provider.provideDefinition(model, position, {} as Monaco.CancellationToken);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(loc(7));
    expect(ret).toBeUndefined();
  });

  it('无目标：不导航，返回 undefined', () => {
    const { monaco, registered } = stubMonaco();
    const navigate = vi.fn();
    installDefinitionProvider(monaco, { resolve: () => [], navigate });
    const ret = registered[0]!.provider.provideDefinition(model, position, {} as Monaco.CancellationToken);
    expect(navigate).not.toHaveBeenCalled();
    expect(ret).toBeUndefined();
  });

  it('宿主 resolve 抛错 → 不导航、不崩（F12 不许掀桌子）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, registered } = stubMonaco();
    const navigate = vi.fn();
    installDefinitionProvider(monaco, {
      resolve: () => {
        throw new Error('boom');
      },
      navigate,
    });
    expect(() =>
      registered[0]!.provider.provideDefinition(model, position, {} as Monaco.CancellationToken),
    ).not.toThrow();
    expect(navigate).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
