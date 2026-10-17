/**
 * 转到定义 · 宿主接线（`collectDefinitionLocations` + `planDefinitionJump` +
 * `toDefinitionLinks` + `installDefinitionProvider`）单测。
 *
 * Monaco 绑定刻意薄：本文件用**桩 monaco**（只记录注册与 dispose）喂 provider，
 * 不引入真实 monaco-editor 运行时。桩 model 只提供行列口径所需的
 * `getLineCount` / `getLineMaxColumn` / `uri` / `getWordAtPosition`。
 * 覆盖：(a) 注册落在 ERB 与 `.kojo` 两个语言 id 上、opener 一并注册与回收；
 * (b) 合并三态（`undefined` 跳过 / 空数组不加 / 有目标照收）、按贡献隔离抛错、去重；
 * (c) D4 三条腿各自走哪条：**同文件 / 已开标签 ⇒ 真 `LocationLink[]`（多目标全给，
 *     Peek 才有的可选）**，**未打开文件 ⇒ 事件通道兜底**；
 * (d) 自证"绝不返回指向未建 model 的 URI"（缺 model 的目标一律不进列表；列表构造后
 *     为空则退回事件通道，不留空列表让 Monaco 哑掉）。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { EditorLanguageServiceContribution, EditorSymbolLocation } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  collectDefinitionLocations,
  installDefinitionProvider,
  planDefinitionJump,
  toDefinitionLinks,
} from '../src/monaco/kojo-definition';

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

  it('W9 合并取区间那一枚：同一处，一条腿给列、一条腿给区间 ⇒ 一份且带区间', () => {
    const out = collectDefinitionLocations(
      [
        contribution('erb', () => ({ kind: 'definition', locations: [{ filePath: 'C:\\p\\b.ERB', line: 7, column: 4 }] })),
        contribution('sugar', () => ({
          kind: 'definition',
          locations: [{ filePath: 'C:\\p\\b.ERB', line: 7, column: 4, span: { columnStart: 4, columnEnd: 11 } }],
        })),
      ],
      REQUEST,
    );
    expect(out).toEqual([
      { filePath: 'C:\\p\\b.ERB', line: 7, column: 4, span: { columnStart: 4, columnEnd: 11 } },
    ]);
  });

  it('无贡献方 / 全不认 → 空数组', () => {
    expect(collectDefinitionLocations([], REQUEST)).toEqual([]);
    expect(collectDefinitionLocations([contribution('x', () => undefined)], REQUEST)).toEqual([]);
  });
});

/* ============================== 桩 monaco / 桩 model ============================== */

interface Registered {
  languageId: string;
  provider: Monaco.languages.DefinitionProvider;
}

function stubMonaco(): {
  monaco: typeof Monaco;
  registered: Registered[];
  openers: Monaco.editor.ICodeEditorOpener[];
  disposed: string[];
} {
  const registered: Registered[] = [];
  const openers: Monaco.editor.ICodeEditorOpener[] = [];
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
    editor: {
      registerEditorOpener: (opener: Monaco.editor.ICodeEditorOpener): Monaco.IDisposable => {
        openers.push(opener);
        return { dispose: () => disposed.push('opener') };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered, openers, disposed };
}

/** 只提供行列口径的桩 model（`getLineMaxColumn` = 行长 + 1，与 Monaco 同口径） */
function fakeModel(
  uriString: string,
  opts: { lineCount?: number; lineLength?: number; word?: { startColumn: number; endColumn: number } } = {},
): Monaco.editor.ITextModel {
  const lineCount = opts.lineCount ?? 10;
  const lineLength = opts.lineLength ?? 19;
  return {
    uri: { toString: () => uriString },
    getLineCount: () => lineCount,
    getLineMaxColumn: (lineNumber: number) => (lineNumber >= 1 && lineNumber <= lineCount ? lineLength + 1 : 1),
    getWordAtPosition: () => opts.word ?? null,
  } as unknown as Monaco.editor.ITextModel;
}

const CURRENT_PATH = 'C:\\p\\a.ERB';
const CURRENT_URI = 'file:///c%3A/p/a.ERB';
const OTHER_PATH = 'C:\\p\\b.ERB';
const OTHER_URI = 'file:///c%3A/p/b.ERB';
const sourceModel = fakeModel(CURRENT_URI, { word: { startColumn: 7, endColumn: 12 } });
const otherModel = fakeModel(OTHER_URI);
const position = { lineNumber: 2, column: 8 } as Monaco.Position;
const liveModelFor = (filePath: string) =>
  filePath === CURRENT_PATH ? sourceModel : filePath === OTHER_PATH ? otherModel : undefined;

/* ============================== planDefinitionJump · 三条腿（纯逻辑） ============================== */

describe('planDefinitionJump · D4 分腿', () => {
  it('空目标 → none（不返回空列表，让 Monaco 自己提示"未找到定义"）', () => {
    expect(planDefinitionJump([], liveModelFor)).toEqual({ kind: 'none' });
  });

  it('同文件单目标 → peek（就地跳 + Peek 都有数据源，不再发事件）', () => {
    expect(planDefinitionJump([{ filePath: CURRENT_PATH, line: 4 }], liveModelFor)).toEqual({
      kind: 'peek',
      locations: [{ filePath: CURRENT_PATH, line: 4 }],
    });
  });

  it('多目标全部已开（同文件 + 别的标签）→ peek 且**全给**（Peek 列表就是选择器）', () => {
    const locations = [
      { filePath: OTHER_PATH, line: 3, column: 5 },
      { filePath: CURRENT_PATH, line: 7 },
      { filePath: OTHER_PATH, line: 11 },
    ];
    expect(planDefinitionJump(locations, liveModelFor)).toEqual({ kind: 'peek', locations });
  });

  it('任一目标没开 → navigate **第一个**（不部分返回：部分列表会让缺 model 的目标静默消失）', () => {
    const closed = { filePath: 'C:\\p\\c.ERB', line: 9 };
    expect(planDefinitionJump([closed, { filePath: CURRENT_PATH, line: 1 }], liveModelFor)).toEqual({
      kind: 'navigate',
      location: closed,
    });
    // 第一个是开着的、后面藏着没开的 ⇒ 整批仍走事件通道（判据是"这批能不能全交出去"）
    expect(planDefinitionJump([{ filePath: CURRENT_PATH, line: 1 }, closed], liveModelFor)).toEqual({
      kind: 'navigate',
      location: { filePath: CURRENT_PATH, line: 1 },
    });
  });

  it('宿主没接 openModelFor → 一律判成"没开"（D4 之前行为逐字保持，additive 接线零风险）', () => {
    expect(planDefinitionJump([{ filePath: CURRENT_PATH, line: 2 }], () => undefined)).toEqual({
      kind: 'navigate',
      location: { filePath: CURRENT_PATH, line: 2 },
    });
  });
});

/* ============================== toDefinitionLinks · 自证不交未建 model ============================== */

describe('toDefinitionLinks · 目标 → Monaco LocationLink', () => {
  it('没开 model 的目标**一律不进列表**（绝不给 Monaco 指向未建 model 的 URI）', () => {
    const links = toDefinitionLinks(
      [{ filePath: CURRENT_PATH, line: 3 }, { filePath: 'C:\\p\\nope.ERB', line: 4 }],
      liveModelFor,
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.uri.toString()).toBe(CURRENT_URI);
  });

  it('uri 取自现成 model 的 `model.uri`（真 Uri 对象——Monaco 会读 `loc.uri.scheme` 过滤）', () => {
    const links = toDefinitionLinks([{ filePath: OTHER_PATH, line: 1 }], liveModelFor);
    expect(links[0]!.uri).toBe(otherModel.uri);
    expect(links[0]!.uri.toString()).toBe(OTHER_URI);
  });

  it('给了列没给区间 → 选区**零宽**（光标放到那一列；不铺到行尾假装作者要那儿）', () => {
    const withColumn = toDefinitionLinks([{ filePath: CURRENT_PATH, line: 2, column: 6 }], liveModelFor)[0]!;
    expect(withColumn.targetSelectionRange).toEqual({
      startLineNumber: 2,
      startColumn: 6,
      endLineNumber: 2,
      endColumn: 6,
    });
    // 行级上下文（Peek 列表要显示这一整行）照旧是整行——**列表行**与**落点选区**是两件事
    expect(withColumn.range).toEqual({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 20 });
  });

  it('给了区间 → 选区就是那一段（这就是"两条腿只有一条带列"的收口处）', () => {
    const link = toDefinitionLinks(
      [{ filePath: CURRENT_PATH, line: 2, column: 6, span: { columnStart: 6, columnEnd: 13 } }],
      liveModelFor,
    )[0]!;
    expect(link.targetSelectionRange).toEqual({
      startLineNumber: 2,
      startColumn: 6,
      endLineNumber: 2,
      endColumn: 13,
    });
  });

  it('没给列也没给区间 → 行首零宽（不猜列）', () => {
    const withoutColumn = toDefinitionLinks([{ filePath: CURRENT_PATH, line: 2 }], liveModelFor)[0]!;
    expect(withoutColumn.targetSelectionRange).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 1,
    });
  });

  it('越界行列夹取到模型现实（陈旧目标不该让 Peek 崩，也不该画出不存在的落点）', () => {
    const links = toDefinitionLinks(
      [{ filePath: CURRENT_PATH, line: 999, column: 999, span: { columnStart: 999, columnEnd: 9999 } }],
      liveModelFor,
    );
    expect(links[0]!.targetSelectionRange).toEqual({
      startLineNumber: 10,
      startColumn: 20,
      endLineNumber: 10,
      endColumn: 20,
    });
  });

  it('originSelectionRange：传了才带（不传就不给 Monaco 造一个假来源）', () => {
    expect(toDefinitionLinks([{ filePath: CURRENT_PATH, line: 1 }], liveModelFor)[0]!.originSelectionRange).toBeUndefined();
    const origin = { startLineNumber: 2, startColumn: 7, endLineNumber: 2, endColumn: 12 };
    expect(toDefinitionLinks([{ filePath: CURRENT_PATH, line: 1 }], liveModelFor, origin)[0]!.originSelectionRange).toEqual(origin);
  });
});

/* ============================== Monaco 装配（桩 monaco） ============================== */

describe('installDefinitionProvider · 装配', () => {
  it('ERB 与 `.kojo` 两个语言 id 各注册一枚 provider，外加一枚 opener；dispose 全部回收', () => {
    const { monaco, registered, openers, disposed } = stubMonaco();
    const handle = installDefinitionProvider(monaco, {
      resolve: () => [],
      navigate: () => undefined,
    });
    expect(registered.map((r) => r.languageId).sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
    expect(openers).toHaveLength(1);
    handle.dispose();
    expect(disposed.sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, 'opener'].sort());
  });

  it('腿①同文件：返回真 LocationLink（**不**发事件）——`Alt+F12` 有东西可显示', () => {
    const { monaco, registered } = stubMonaco();
    const navigate = vi.fn();
    installDefinitionProvider(monaco, {
      resolve: () => [{ filePath: CURRENT_PATH, line: 5, column: 3 }],
      navigate,
      openModelFor: liveModelFor,
    });
    const ret = registered[0]!.provider.provideDefinition(sourceModel, position, {} as Monaco.CancellationToken);
    expect(navigate).not.toHaveBeenCalled();
    const links = ret as Monaco.languages.LocationLink[];
    expect(links).toHaveLength(1);
    expect(links[0]!.uri).toBe(sourceModel.uri);
    expect(links[0]!.targetSelectionRange).toEqual({
      startLineNumber: 5,
      startColumn: 3,
      endLineNumber: 5,
      endColumn: 3,
    });
    // 来源区间用光标下的词（Peek 列表标题与 `Ctrl+Click` 预览标的就是它）
    expect(links[0]!.originSelectionRange).toEqual({
      startLineNumber: 2,
      startColumn: 7,
      endLineNumber: 2,
      endColumn: 12,
    });
  });

  it('腿②别的标签（model 已在）：返回**全部**真 Location，多目标不再只取第一个', () => {
    const { monaco, registered } = stubMonaco();
    const navigate = vi.fn();
    installDefinitionProvider(monaco, {
      resolve: () => [
        { filePath: CURRENT_PATH, line: 5 },
        { filePath: OTHER_PATH, line: 8 },
        { filePath: OTHER_PATH, line: 9 },
      ],
      navigate,
      openModelFor: liveModelFor,
    });
    const ret = registered[0]!.provider.provideDefinition(sourceModel, position, {} as Monaco.CancellationToken);
    expect(ret).toHaveLength(3);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('腿③文件没打开：走 `editor.revealLocation` 兜底、返回 undefined（与 D4 之前逐字一致）', () => {    const { monaco, registered } = stubMonaco();
    const navigate = vi.fn();
    installDefinitionProvider(monaco, { resolve: () => [loc(7), loc(8)], navigate });
    const ret = registered[0]!.provider.provideDefinition(sourceModel, position, {} as Monaco.CancellationToken);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(loc(7));
    expect(ret).toBeUndefined();
  });

  it('混合（有的开着有的没开）：整批走事件通道，绝不返回残缺列表', () => {
    const { monaco, registered } = stubMonaco();
    const navigate = vi.fn();
    installDefinitionProvider(monaco, {
      resolve: () => [{ filePath: CURRENT_PATH, line: 1 }, { filePath: 'C:\\p\\closed.ERB', line: 2 }],
      navigate,
      openModelFor: liveModelFor,
    });
    const ret = registered[0]!.provider.provideDefinition(sourceModel, position, {} as Monaco.CancellationToken);
    expect(ret).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith({ filePath: CURRENT_PATH, line: 1 });
  });

  it('判 peek 之后 model 才没（并发关标签）：链接构造空了也**退回事件通道**，不留空列表', () => {
    const { monaco, registered } = stubMonaco();
    const navigate = vi.fn();
    let calls = 0;
    installDefinitionProvider(monaco, {
      resolve: () => [{ filePath: CURRENT_PATH, line: 1 }],
      navigate,
      // 分腿那一次查得到、构造链接那一次查不到
      openModelFor: () => (calls++ === 0 ? sourceModel : undefined),
    });
    const ret = registered[0]!.provider.provideDefinition(sourceModel, position, {} as Monaco.CancellationToken);
    expect(ret).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith({ filePath: CURRENT_PATH, line: 1 });
  });

  it('openModelFor 抛错 → 当"没开"处理，退回事件通道（不让 F12 崩）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, registered } = stubMonaco();
    const navigate = vi.fn();
    installDefinitionProvider(monaco, {
      resolve: () => [{ filePath: CURRENT_PATH, line: 1 }],
      navigate,
      openModelFor: () => {
        throw new Error('boom');
      },
    });
    expect(() =>
      registered[0]!.provider.provideDefinition(sourceModel, position, {} as Monaco.CancellationToken),
    ).not.toThrow();
    expect(navigate).toHaveBeenCalledWith({ filePath: CURRENT_PATH, line: 1 });
    warn.mockRestore();
  });

  it('无目标：不导航，返回 undefined', () => {
    const { monaco, registered } = stubMonaco();
    const navigate = vi.fn();
    installDefinitionProvider(monaco, { resolve: () => [], navigate, openModelFor: liveModelFor });
    const ret = registered[0]!.provider.provideDefinition(sourceModel, position, {} as Monaco.CancellationToken);
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
      openModelFor: liveModelFor,
    });
    expect(() =>
      registered[0]!.provider.provideDefinition(sourceModel, position, {} as Monaco.CancellationToken),
    ).not.toThrow();
    expect(navigate).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/* ============================== opener · 跨 model 跳转落回宿主通道 ============================== */

describe('installDefinitionProvider · registerEditorOpener', () => {
  function withOpener(navigate: (location: EditorSymbolLocation) => void): Monaco.editor.ICodeEditorOpener {
    const { monaco, openers } = stubMonaco();
    installDefinitionProvider(monaco, {
      resolve: () => [],
      navigate,
      openModelFor: liveModelFor,
      pathForUri: (uri) => (uri === CURRENT_URI ? CURRENT_PATH : uri === OTHER_URI ? OTHER_PATH : undefined),
    });
    return openers[0]!;
  }
  const editorWith = (model: Monaco.editor.ITextModel) =>
    ({ getModel: () => model }) as unknown as Monaco.editor.ICodeEditor;
  const uriOf = (value: string) => ({ toString: () => value }) as unknown as Monaco.Uri;

  it('同 model（同文件）请求 → 返回 false，交回 Monaco 缺省就地跳，不发事件（不跳两次）', () => {
    const navigate = vi.fn();
    const opener = withOpener(navigate);
    const handled = opener.openCodeEditor(editorWith(sourceModel), uriOf(CURRENT_URI), {
      lineNumber: 5,
      column: 3,
    });
    expect(handled).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('已开的别的标签 → 反查宿主路径、发一次 `editor.revealLocation`、返回 true（已处置）', () => {
    const navigate = vi.fn();
    const opener = withOpener(navigate);
    const handled = opener.openCodeEditor(editorWith(sourceModel), uriOf(OTHER_URI), {
      startLineNumber: 8,
      startColumn: 4,
      endLineNumber: 8,
      endColumn: 4,
    });
    expect(handled).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ filePath: OTHER_PATH, line: 8, column: 4 });
  });

  it('W9：Monaco 给的落点**带宽度** ⇒ 反手升级成区间（这条腿此前把终点整个丢了）', () => {
    const navigate = vi.fn();
    const opener = withOpener(navigate);
    expect(
      opener.openCodeEditor(editorWith(sourceModel), uriOf(OTHER_URI), {
        startLineNumber: 8,
        startColumn: 4,
        endLineNumber: 8,
        endColumn: 12,
      }),
    ).toBe(true);
    expect(navigate).toHaveBeenCalledWith({
      filePath: OTHER_PATH,
      line: 8,
      column: 4,
      span: { columnStart: 4, columnEnd: 12 },
    });
  });

  it('宿主不认识这个 URI / 没给落点 → false 且不发事件（不猜目标）', () => {
    const navigate = vi.fn();
    const opener = withOpener(navigate);
    expect(opener.openCodeEditor(editorWith(sourceModel), uriOf('file:///inMemory/x'), { lineNumber: 1, column: 1 })).toBe(
      false,
    );
    expect(opener.openCodeEditor(editorWith(sourceModel), uriOf(OTHER_URI))).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

