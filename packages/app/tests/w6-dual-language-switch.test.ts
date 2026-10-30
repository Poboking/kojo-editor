/**
 * W6 收尾（2026-10-17）·「翻一次开关，两种语言同时生效」的钉子测试。
 *
 * 全假表：假 monaco（只记注册面）+ 假 model（只给行数字符），不碰真盘、不起编辑器。
 * 钉的是**注册面与开关的形状**，不是插件的判据（判据同源那条由
 * `packages/plugins/kojo-sugar/tests/langsvc-parity.test.ts` 用两枚真插件对拍打）：
 *
 * ① **一枚 provider 挂多门语言**（B8 注解 / LS-R6 提示两面如此）——
 *    两次注册拿到的是**同一个对象引用**。这一条是"开关跨语言"的全部技术内容：
 *    开关若是按语言各挂一份，就得各翻一次；共用一枚 provider 时开关只能落在
 *    Monaco 的**编辑器级选项**上（`codeLens` 等），翻一次天然覆盖两种语言。
 *    **着色面（B6）自 B3 语义收口（`ceedc0c8`）起是例外**：`getLegend()` 不带 model
 *    参数，图例只能是 provider 级的，而 kojo2 的语法角色层与 ERB 的名字层正交（D6
 *    不许合并）⇒ 只能一门语言一枚、各发各的图例。开关仍是编辑器级
 *    （`semanticHighlighting.enabled`），但"共用一枚"这个前提对它不成立，
 *    所以那一格改钉"分枚 + 图例按语言声明"（判据仍只有一份）。
 * ② **同一次应答**：`.erb` 与 `.kojo1` 两个 model 走同一个 provider 都拿到真实候选，
 *    条数与形状一致（不是"一边有另一边空"）。
 * ③ **守门谓词只许一份**：这里的两个供方各用契约层的 `isErbDialectPath` /
 *    `resolveSugarTarget` 自守——本文件刻意**不写**任何扩展名正则，第二份谓词一旦出现
 *    就会在这里露出来（`.ERB`/`.erm`/`.ERH` 大小写形态逐个都答）。
 * ④ **无数据 = 空数组**：不认领的路径、抛错的供方，两门语言都拿到"没有"而不是异常。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import { isErbDialectPath, resolveSugarTarget } from '@kojo/plugin-api';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  CODE_LENS_COMMAND,
  collectCodeLenses,
  installCodeLensProvider,
} from '../src/monaco/kojo-code-lens';
import { collectInlayHints, installInlayHintsProvider } from '../src/monaco/kojo-inlay-hints';
import {
  collectSemanticTokenSpans,
  installSemanticTokensProvider,
} from '../src/monaco/kojo-semantic-tokens';
import { loadCodeLensPref, saveCodeLensPref } from '../src/ui/code-lens-pref';
import {
  applyNameColorPref,
  loadNameColorPref,
  setNameColorPref,
  subscribeNameColorPref,
  type NameColorTarget,
} from '../src/ui/semantic-color-pref';

const ERB_PATH = 'C:/p/ERB/A.ERB';
// LAU-3b-FLIP：kojo1 面的源只剩封存层 `.kojo1`（`.kojo` 已归 2.0）
const KOJO_PATH = 'C:/p/KOJO/A.kojo1';
const FOREIGN_PATH = 'C:/p/notes.txt';

/* ----------------------------- 两枚按契约谓词自守的假供方 ----------------------------- */

/**
 * 同一个"事实"在两门语言上各说一遍（标签逐字相同 ⇒ 下面能钉"形状一致"）。
 * 守门用**契约层那两份谓词**，本文件零扩展名正则。
 */
function responder(id: string, accepts: (path: string) => boolean): EditorLanguageServiceContribution {
  return {
    id,
    provide: (request) => {
      if (!('path' in request) || !accepts(request.path)) return undefined;
      switch (request.kind) {
        case 'codeLens':
          return { kind: 'codeLens', lenses: [{ line: 2, label: '被 2 处用到' }] };
        case 'inlayHint':
          return { kind: 'inlayHint', hints: [{ line: 2, column: 12, label: 'ARG', tooltip: '第 1 参：ARG' }] };
        case 'semanticToken':
          return {
            kind: 'semanticToken',
            spans: [{ line: 1, startColumn: 2, endColumn: 9, tokenType: 'function', modifiers: ['declaration'] }],
          };
        default:
          return undefined;
      }
    },
  };
}

const CONTRIBUTIONS: readonly EditorLanguageServiceContribution[] = [
  responder('fixture-erb', (path) => isErbDialectPath(path)),
  responder('fixture-kojo', (path) => resolveSugarTarget(path) !== null),
];

/* ---------------------------------- 假 monaco / model ---------------------------------- */

interface Registration {
  languageId: string;
  provider: unknown;
}

function stubMonaco() {
  const lens: Registration[] = [];
  const hints: Registration[] = [];
  const semantic: Registration[] = [];
  const commands: { id: string; handler: (...args: unknown[]) => void }[] = [];
  const disposed: string[] = [];
  const sub = (kind: string, languageId: string) => ({ dispose: () => disposed.push(`${kind}:${languageId}`) });
  const monaco = {
    languages: {
      registerCodeLensProvider: (languageId: string, provider: Monaco.languages.CodeLensProvider) => {
        lens.push({ languageId, provider });
        return sub('lens', languageId);
      },
      registerInlayHintsProvider: (languageId: string, provider: Monaco.languages.InlayHintsProvider) => {
        hints.push({ languageId, provider });
        return sub('hints', languageId);
      },
      registerDocumentSemanticTokensProvider: (
        languageId: string,
        provider: Monaco.languages.DocumentSemanticTokensProvider,
      ) => {
        semantic.push({ languageId, provider });
        return sub('semantic', languageId);
      },
      InlayHintKind: { Type: 1, Parameter: 2 },
    },
    editor: {
      registerCommand: (id: string, handler: (...args: unknown[]) => void) => {
        commands.push({ id, handler });
        return sub('command', id);
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, lens, hints, semantic, commands, disposed };
}

const LANG_BY_PATH: Record<string, string> = {
  [ERB_PATH]: ERB_LANGUAGE_ID,
  [KOJO_PATH]: KOJO_LANGUAGE_ID,
  [FOREIGN_PATH]: 'plaintext',
};

function modelFor(path: string): Monaco.editor.ITextModel {
  return {
    uri: { toString: () => `file:///${path.replace(/\\/g, '/')}` },
    getLanguageId: () => LANG_BY_PATH[path] ?? 'plaintext',
    getLineCount: () => 8,
    getLineMaxColumn: () => 60,
    getValue: () => '行内容\n行内容\n',
  } as unknown as Monaco.editor.ITextModel;
}

/** 宿主侧的问法（与 `EditorPane` 的 resolve 逐字同形：路径来自 model、判据全在供方） */
function ask(kind: EditorLanguageServiceRequest['kind'], path: string): EditorLanguageServiceRequest {
  return { kind, path, text: '行内容\n行内容\n', project: null, lineCount: 8 } as EditorLanguageServiceRequest;
}

const sortedLanguages = (rs: readonly Registration[]): string[] => rs.map((r) => r.languageId).sort();

/* ---------------------------------------- ① 注册面 ---------------------------------------- */

describe('W6 · 注解 / 提示各一枚挂多门语言，着色按语言分枚（开关仍必然是编辑器级）', () => {
  it('codeLens / inlayHint 的多次注册是同一对象引用；semanticToken 各语言一枚、图例按语言声明', () => {
    const a = stubMonaco();
    installCodeLensProvider(a.monaco, { resolve: () => [], navigate: () => undefined });
    installInlayHintsProvider(a.monaco, { resolve: () => [] });
    installSemanticTokensProvider(a.monaco, { resolve: () => [] });
    expect(sortedLanguages(a.lens)).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
    // B2c：kojo2 的 descriptor 点名了 `slotServices: ['inlayHint']`，共享收口于是也给它挂上
    // **同一枚** provider（供方是插件）。这里跟着变的是"几门语言"，不是"几枚 provider"——
    // 所以下面那两条 `toBe` 的判据（同一对象引用）一个字没改。
    expect(sortedLanguages(a.hints)).toEqual(
      [ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, KOJO2_LANGUAGE_ID].sort(),
    );
    // B3 语义收口（`ceedc0c8`）之后着色面**不再共用一枚**：Monaco 的 `getLegend()` 不带 model
    // 参数，图例只能是 provider 级的；而 kojo2 的语法角色层与 ERB 的名字层是两套正交命名
    // （D6 明令不许合并进同一份图例）⇒ 只能一门语言一枚。
    // 所以这一格断的不再是"同一对象引用"，而是**分枚且各发各的图例**——分枚不是为了各写一套
    // 判据（判据仍是同一份，由 `collectSemanticTokenSpans` 统一裁），只是为了各带一份词表。
    expect(sortedLanguages(a.semantic)).toEqual(
      [ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, KOJO2_LANGUAGE_ID].sort(),
    );
    expect(new Set(a.semantic.map((r) => r.provider)).size).toBe(3);
    const legendOf = (id: string) => {
      const reg = a.semantic.find((r) => r.languageId === id)!;
      return (reg.provider as Monaco.languages.DocumentSemanticTokensProvider).getLegend!();
    };
    // 名字层（ERB / `.kojo1`）三值 + 两枚修饰；角色层（kojo2）按自己的角色表，无修饰。
    expect(legendOf(ERB_LANGUAGE_ID).tokenTypes).toEqual(['function', 'variable', 'parameter']);
    expect(legendOf(ERB_LANGUAGE_ID).tokenModifiers).toEqual(['declaration', 'readonly']);
    expect(legendOf(KOJO2_LANGUAGE_ID).tokenModifiers).toEqual([]);
    expect(legendOf(KOJO2_LANGUAGE_ID).tokenTypes).not.toEqual(
      legendOf(ERB_LANGUAGE_ID).tokenTypes,
    );
    expect(a.lens[0]!.provider).toBe(a.lens[1]!.provider);
    expect(new Set(a.hints.map((r) => r.provider)).size).toBe(1);
  });

  it('dispose 成对回收（codeLens 连点击命令一共三条）', () => {
    const { monaco, disposed } = stubMonaco();
    const h1 = installCodeLensProvider(monaco, { resolve: () => [], navigate: () => undefined });
    const h2 = installInlayHintsProvider(monaco, { resolve: () => [] });
    const h3 = installSemanticTokensProvider(monaco, { resolve: () => [] });
    h1.dispose();
    h2.dispose();
    h3.dispose();
    expect(disposed.filter((d) => d.startsWith('lens:'))).toHaveLength(2);
    // 三门语言 ⇒ 三次注册，dispose 一次全收回（多挂一门不许留孤儿订阅）
    expect(disposed.filter((d) => d.startsWith('hints:'))).toHaveLength(3);
    expect(disposed.filter((d) => d.startsWith('semantic:'))).toHaveLength(3);
    expect(disposed).toContain(`command:${CODE_LENS_COMMAND}`);
  });
});

/* --------------------------------- ② 同一份应答，两门语言 --------------------------------- */

describe('W6 · 同一个 provider 对 `.erb` 与 `.kojo` 都给出真实候选', () => {
  it('codeLens：两种语言的 model 各出一条注解，文本逐字相同（判据同源的外部表现）', () => {
    const { monaco, lens } = stubMonaco();
    installCodeLensProvider(monaco, {
      resolve: (model) => collectCodeLenses(CONTRIBUTIONS, ask('codeLens', pathOf(model))),
      navigate: () => undefined,
    });
    const provider = lens[0]!.provider as Monaco.languages.CodeLensProvider;
    const erb = lensesOf(provider, ERB_PATH);
    const kojo = lensesOf(provider, KOJO_PATH);
    expect(erb.map((l) => l.command?.title)).toEqual(['被 2 处用到']);
    expect(kojo.map((l) => l.command?.title)).toEqual(erb.map((l) => l.command?.title));
    expect(kojo[0]!.range).toEqual(erb[0]!.range);
  });

  it('inlayHint：两种语言同一条提示、同一种类（Parameter），行列都落在合法区间内', () => {
    const { monaco, hints } = stubMonaco();
    installInlayHintsProvider(monaco, {
      resolve: (model) => collectInlayHints(CONTRIBUTIONS, ask('inlayHint', pathOf(model))),
    });
    const provider = hints[0]!.provider as Monaco.languages.InlayHintsProvider;
    const erb = hintsOf(provider, ERB_PATH);
    const kojo = hintsOf(provider, KOJO_PATH);
    expect(erb).toHaveLength(1);
    expect(kojo).toEqual(erb);
    expect(kojo[0]!.kind).toBe(2);
  });

  it('semanticToken：两种语言编码出的 delta 数据完全一致（legend 同一份，着色档位同一份）', () => {
    const { monaco, semantic } = stubMonaco();
    installSemanticTokensProvider(monaco, {
      resolve: (model) => collectSemanticTokenSpans(CONTRIBUTIONS, ask('semanticToken', pathOf(model))),
    });
    const provider = semantic[0]!.provider as Monaco.languages.DocumentSemanticTokensProvider;
    const erb = dataOf(provider, ERB_PATH);
    const kojo = dataOf(provider, KOJO_PATH);
    expect(erb.length).toBeGreaterThan(0);
    expect(Array.from(kojo)).toEqual(Array.from(erb));
    expect(provider.getLegend().tokenTypes.length).toBeGreaterThan(0);
  });

  it('方言族内每种大小写形态都被认（守门只有契约那一份谓词，这里没有第二张扩展名清单）', () => {
    for (const path of ['C:/p/A.ERB', 'C:/p/a.erb', 'C:/p/a.Erm', 'C:/p/a.erh', 'C:/p/目录/名.ERB']) {
      expect(isErbDialectPath(path), path).toBe(true);
      expect(collectCodeLenses(CONTRIBUTIONS, ask('codeLens', path))).toHaveLength(1);
    }
    expect(resolveSugarTarget(KOJO_PATH)).not.toBeNull();
    expect(collectCodeLenses(CONTRIBUTIONS, ask('codeLens', KOJO_PATH))).toHaveLength(1);
  });
});

/* ------------------------------- ③ 开关：翻一次两边同时翻 ------------------------------- */

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

/** 只记 `updateOptions` 载荷的假编辑器（开关的落点是编辑器级选项，载荷里**没有语言维度**） */
function stubEditor(): NameColorTarget & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return { calls, updateOptions: (options) => void calls.push(options) };
}

/** B8 那条腿的假 pane：`codeLens` 选项（与 `semanticHighlighting.enabled` 同为编辑器级、无语言维度） */
function stubLensEditor(): { calls: Record<string, unknown>[]; updateOptions(o: { codeLens: boolean }): void } {
  const calls: Record<string, unknown>[] = [];
  return { calls, updateOptions: (options) => void calls.push(options) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('W6 · B6「名字按角色分色」开关跨语言生效', () => {
  it('真源一份（localStorage）：翻一次 ⇒ 一次编辑器级写入，载荷不含语言维度', () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() });
    const editor = stubEditor();
    const seen: boolean[] = [];
    const unsub = subscribeNameColorPref(() => {
      applyNameColorPref(editor);
      seen.push(loadNameColorPref());
    });

    setNameColorPref(true);
    expect(editor.calls).toEqual([{ 'semanticHighlighting.enabled': true }]);
    setNameColorPref(false);
    expect(editor.calls).toEqual([
      { 'semanticHighlighting.enabled': true },
      { 'semanticHighlighting.enabled': false },
    ]);
    expect(seen).toEqual([true, false]);
    // 载荷里没有任何按语言分支的字段：provider 两语言共用（见①），所以这一次写入同时管两边
    for (const call of editor.calls) expect(Object.keys(call)).toEqual(['semanticHighlighting.enabled']);
    unsub();
  });

  it('开着时两门语言同时有着色数据；关掉即 Monaco 不再问 provider（这里钉"关掉后 provider 一次都不被调用"的宿主侧半边：开关不在 resolve 里）', () => {
    vi.stubGlobal('window', { localStorage: fakeStorage({ 'kojo.ui.nameColor.v1': 'on' }) });
    let asked = 0;
    const { monaco, semantic } = stubMonaco();
    installSemanticTokensProvider(monaco, {
      resolve: (model) => {
        asked++;
        return collectSemanticTokenSpans(CONTRIBUTIONS, ask('semanticToken', pathOf(model)));
      },
    });
    const provider = semantic[0]!.provider as Monaco.languages.DocumentSemanticTokensProvider;
    expect(loadNameColorPref()).toBe(true);
    expect(dataOf(provider, KOJO_PATH).length).toBeGreaterThan(0);
    expect(dataOf(provider, ERB_PATH).length).toBeGreaterThan(0);
    // resolve 不判开关（判在 Monaco 的选项上）⇒ 关掉后 Monaco 根本不发请求，这里零调用才是设计：
    // 宿主这侧**不许**再抄一份门禁，否则开关就有两个真源。
    expect(asked).toBe(2);
  });
});

describe('W6 · B8「行上内联注解 / 被谁调用」开关跨语言生效', () => {
  it('真源一份：`saveCodeLensPref` 写、`loadCodeLensPref` 读 ⇒ 两个 pane（一 `.erb` 一 `.kojo`）各写同一个编辑器级选项', () => {
    const storage = fakeStorage();
    vi.stubGlobal('window', { localStorage: storage });
    // 与 `EditorPane` 那条 effect 同形的落地（选项名 `codeLens`，值现读偏好；偏好只有一个真源）
    const apply = (ed: ReturnType<typeof stubLensEditor>): void => {
      ed.updateOptions({ codeLens: loadCodeLensPref() });
    };
    const erbPane = stubLensEditor();
    const kojoPane = stubLensEditor();
    saveCodeLensPref(true);
    apply(erbPane);
    apply(kojoPane);
    expect(erbPane.calls).toEqual([{ codeLens: true }]);
    expect(kojoPane.calls).toEqual([{ codeLens: true }]);
    saveCodeLensPref(false);
    apply(erbPane);
    apply(kojoPane);
    expect(erbPane.calls).toEqual([{ codeLens: true }, { codeLens: false }]);
    expect(kojoPane.calls).toEqual(erbPane.calls);
    // 关 = 不占键位（不留 "off" 这种第二形态 ⇒ 不存在两份读法）
    expect(storage.getItem('kojo.ui.codeLens.v1')).toBeNull();
  });

  it('同一枚 code lens provider 服务两门语言 ⇒ 这一次编辑器选项翻转同时翻转两边', () => {
    const { monaco, lens } = stubMonaco();
    installCodeLensProvider(monaco, {
      resolve: (model) => collectCodeLenses(CONTRIBUTIONS, ask('codeLens', pathOf(model))),
      navigate: () => undefined,
    });
    const provider = lens[0]!.provider as Monaco.languages.CodeLensProvider;
    expect(lens[1]!.provider).toBe(provider);
    const erb = lensesOf(provider, ERB_PATH);
    const kojo = lensesOf(provider, KOJO_PATH);
    // 同一条命令 id（点击通道也只有一条）
    expect(kojo[0]!.command?.id).toBe(erb[0]!.command?.id);
    expect(kojo[0]!.command?.title).toBe(erb[0]!.command?.title);
  });
});

/* ------------------------------------ ④ 无数据纪律 ------------------------------------ */

describe('W6 · 无数据 = 空数组，不抛、不猜', () => {
  it('不被任何供方认领的路径（`notes.txt`）：三面都返回空，两门语言的 provider 同一个', () => {
    const { monaco, lens, hints, semantic } = stubMonaco();
    installCodeLensProvider(monaco, {
      resolve: (model) => collectCodeLenses(CONTRIBUTIONS, ask('codeLens', pathOf(model))),
      navigate: () => undefined,
    });
    installInlayHintsProvider(monaco, {
      resolve: (model) => collectInlayHints(CONTRIBUTIONS, ask('inlayHint', pathOf(model))),
    });
    installSemanticTokensProvider(monaco, {
      resolve: (model) => collectSemanticTokenSpans(CONTRIBUTIONS, ask('semanticToken', pathOf(model))),
    });
    const l = lens[0]!.provider as Monaco.languages.CodeLensProvider;
    const h = hints[0]!.provider as Monaco.languages.InlayHintsProvider;
    const s = semantic[0]!.provider as Monaco.languages.DocumentSemanticTokensProvider;
    expect(lensesOf(l, FOREIGN_PATH)).toEqual([]);
    expect(hintsOf(h, FOREIGN_PATH)).toEqual([]);
    expect(Array.from(dataOf(s, FOREIGN_PATH))).toEqual([]);
  });

  it('供方抛错 ⇒ 两门语言都退化成"没有"，并且 warn 得出去（铁律 4）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const boom: EditorLanguageServiceContribution = {
      id: 'fixture-boom',
      provide: () => {
        throw new Error('供方炸了');
      },
    };
    const { monaco, lens, hints, semantic } = stubMonaco();
    installCodeLensProvider(monaco, {
      resolve: (model) => collectCodeLenses([boom], ask('codeLens', pathOf(model))),
      navigate: () => undefined,
    });
    installInlayHintsProvider(monaco, {
      resolve: (model) => collectInlayHints([boom], ask('inlayHint', pathOf(model))),
    });
    installSemanticTokensProvider(monaco, {
      resolve: (model) => collectSemanticTokenSpans([boom], ask('semanticToken', pathOf(model))),
    });
    const boomLens = lens[0]!.provider as Monaco.languages.CodeLensProvider;
    const boomHints = hints[0]!.provider as Monaco.languages.InlayHintsProvider;
    const boomSemantic = semantic[0]!.provider as Monaco.languages.DocumentSemanticTokensProvider;
    for (const path of [ERB_PATH, KOJO_PATH]) {
      expect(lensesOf(boomLens, path)).toEqual([]);
      expect(hintsOf(boomHints, path)).toEqual([]);
      expect(Array.from(dataOf(boomSemantic, path))).toEqual([]);
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/* -------------------------------------- 公共小工具 -------------------------------------- */

/** 从假 model 的 uri 取回路径（`EditorPane` 用的是标签的 `filePathRef`，这里等价） */
function pathOf(model: Monaco.editor.ITextModel): string {
  return model.uri.toString().replace(/^file:\/\/\/C\//, 'C:/');
}

const NO_TOKEN = { isCancellationRequested: false } as never;

/**
 * Monaco 的类型面允许 Thenable；宿主三面都**同步**交回（见各 `install*` 的实现），
 * 这里按既有测试的口径收窄一次，免得每个断言重复一遍联合。
 */
const lensesOf = (p: Monaco.languages.CodeLensProvider, path: string): readonly Monaco.languages.CodeLens[] =>
  (p.provideCodeLenses(modelFor(path), NO_TOKEN) as Monaco.languages.CodeLensList).lenses;

const hintsOf = (p: Monaco.languages.InlayHintsProvider, path: string): readonly Monaco.languages.InlayHint[] =>
  (p.provideInlayHints(modelFor(path), {} as never, NO_TOKEN) as Monaco.languages.InlayHintList).hints;

const dataOf = (p: Monaco.languages.DocumentSemanticTokensProvider, path: string): Uint32Array =>
  (p.provideDocumentSemanticTokens(modelFor(path), null, NO_TOKEN) as Monaco.languages.SemanticTokens).data;
