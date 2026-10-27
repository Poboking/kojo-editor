/**
 * SUGGEST-2A · `.kojo` 原生区补全**跨装配路由**（`KOJO_COMPLETION_ASSEMBLY.route` +
 * `completion-core.createCompletionProvider`）端到端单测。
 *
 * 经**生产装配路径**（`installKojoCompletion` → `installCompletion` → `createCompletionProvider`）
 * 喂桩 monaco / 桩 model / 表桩，不引入真实 monaco-editor 运行时：
 * - `@FUNC` 块内 `CALL |` ⇒ 只出项目函数（`erb-functions`，系统函数被 `call-target` 门挡掉）；
 * - `#D|` ⇒ 只出 `#DIM*` 指令源；`CFLAG:|` ⇒ schema 变量名；`GOTO |` 在无 facts 时回退全文标签；
 * - `SETBIT CFLAG:1,|` ⇒ 位表；
 * - 糖位（`调用 |` / `时机 |` / 行首 `#D`）**绝不**混入 `erb-*` 候选（路由回自己）；
 *   行首 `#` 位自 v1.9 P2 起由糖侧 `kojo-native-marks` 发声明族候选（闭集扩张），
 *   仍不得出现 ERB 原生册的 `预处理指令` / 语句词形；
 * - `route` 在 `locate` 之前解出；provenance 记来源装配，`resolveCompletionItem` 按产出装配
 *   分派回表（自定义两册对照钉死，不靠同一份 resolver 的巧合）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { KojoLibraryTable, VariableSchema } from '@kojo/plugin-api';
// vendored contrib 内部模块没有 .d.ts（`monaco.d.ts` 只覆盖公开面）⇒ 类型面无，运行时直吃 ESM 源
// （口径照 `kojo-variable-suggest-chain.test.ts` 的先例：真实 CompletionModel 过滤数学，不另造过滤）
// @ts-expect-error TS7016 —— 见上注
import { CompletionModel, LineContext } from 'monaco-editor/editor/contrib/suggest/browser/completionModel.js';
import { ERB_COMPLETION_ASSEMBLY } from '../src/monaco/erb-completion';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  KOJO_COMPLETION_ASSEMBLY,
  installKojoCompletion,
  type CompletionTables,
} from '../src/monaco/kojo-completion';
import { kojoNativeZoneAt } from '../src/monaco/kojo-native-zone';
import {
  createCompletionProvider,
  type CompletionAssembly,
  type CompletionSource,
} from '../src/monaco/completion-core';

/* ============================== 桩 ============================== */

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

function stubMonaco(): { monaco: typeof Monaco; registered: Registered[] } {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: { Variable: 1, Keyword: 2, Operator: 3, Function: 4, Field: 5, Reference: 6, EnumMember: 7 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (
        languageId: string,
        provider: Monaco.languages.CompletionItemProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered };
}

/**
 * 桩 model：多行文本 + Monaco 默认词法的薄复刻（`#` / `[` / `]` 是词分隔符）。
 * `getLanguageId` 答真实语言 id（贴近宿主模型；路由本身不读它，只认原生区判据）。
 */
function modelOf(text: string, languageId = KOJO_LANGUAGE_ID): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getWordUntilPosition: (pos: Monaco.Position) => {
      const line = lines[pos.lineNumber - 1] ?? '';
      const m = /[A-Za-z0-9_]*$/.exec(line.slice(0, pos.column - 1));
      const word = m ? m[0] : '';
      return { word, startColumn: pos.column - word.length, endColumn: pos.column };
    },
    getLanguageId: () => languageId,
  } as unknown as Monaco.editor.ITextModel;
}

function labelText(label: Monaco.languages.CompletionItem['label']): string {
  return typeof label === 'string' ? label : label.label;
}

const labels = (items: readonly Monaco.languages.CompletionItem[]): string[] => items.map((i) => labelText(i.label));

const at = (lineNumber: number, column: number): Monaco.Position => ({ lineNumber, column }) as Monaco.Position;

function provideAt(
  provider: Monaco.languages.CompletionItemProvider,
  text: string,
  lineNumber: number,
  column: number,
  languageId = KOJO_LANGUAGE_ID,
): Monaco.languages.CompletionItem[] {
  const out = provider.provideCompletionItems(
    modelOf(text, languageId),
    at(lineNumber, column),
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions;
}

/* ============================== 表桩 ============================== */

const PROJECT_FNS: readonly string[] = ['M_KOJO_A', 'M_KOJO_B'];

/** `CFLAG` 族：名字 `好感度`（编号 1088）+ 编号 1 的位表 */
const schema: VariableSchema = {
  version: 'native-test',
  lookup: (variableName: string, index?: number | string) => {
    if (variableName === 'CFLAG' && String(index) === '1') {
      return { name: 'CFLAG', index: 1, bits: [{ bit: 8, label: '处女' }] };
    }
    return undefined;
  },
  names: (family: string) =>
    family === 'CFLAG'
      ? [{ name: '好感度', index: 1088, resolvedIndex: 1088, source: 'primary', description: '角色好感度' }]
      : [],
};

const libraryTable: KojoLibraryTable = {
  hasTable: true,
  lookupByName: () => undefined,
  lookupByFunction: (fn: string) => (fn === 'M_KOJO_A' ? '公告甲' : undefined),
};

const NATIVE_TABLES: CompletionTables = {
  variableSchema: schema,
  erbFunctionNames: () => PROJECT_FNS,
  libraryTable,
  // 糖位对照用：分野表只服务 `.kojo` 糖册，证明糖位照旧走自己的源
  faceTable: { faces: { 初见: { template: 'M_FACE_TEST' } } },
};

/** 装一枚 `.kojo` provider（生产路径），返回 provider */
function kojoProvider(tables: CompletionTables = NATIVE_TABLES): Monaco.languages.CompletionItemProvider {
  const { monaco, registered } = stubMonaco();
  installKojoCompletion(monaco, () => tables);
  return registered[0]!.provider;
}

/* ============================== 路由声明 ============================== */

describe('KOJO 装配 · route 契约', () => {
  it('原生位 route 到 ERB_COMPLETION_ASSEMBLY；糖位返回 undefined（用自己）', () => {
    const { monaco } = stubMonaco();
    const native = modelOf(['@F', '    CALL '].join('\n'));
    const sugar = modelOf(['时机 初见：', '    调用 某函数'].join('\n'));
    expect(KOJO_COMPLETION_ASSEMBLY.route!(monaco, native, at(2, 10))).toBe(ERB_COMPLETION_ASSEMBLY);
    expect(KOJO_COMPLETION_ASSEMBLY.route!(monaco, sugar, at(2, 10))).toBeUndefined();
  });

  it('派生装配替换了 sources ⇒ 不路由（路由选册 ≠ 覆盖选册：调用方的候选册覆盖优先）', () => {
    const { monaco } = stubMonaco();
    const derived: CompletionAssembly = { ...KOJO_COMPLETION_ASSEMBLY, sources: [] };
    const native = modelOf(['@F', '    CALL '].join('\n'));
    expect(derived.route!(monaco, native, at(2, 10))).toBeUndefined();
    // 对照：只换 locate 不改 sources 的派生装配照常路由（守卫只认"候选册被换掉"这一件事）
    const customized: CompletionAssembly = {
      ...KOJO_COMPLETION_ASSEMBLY,
      locate: () => undefined,
    };
    expect(customized.route!(monaco, native, at(2, 10))).toBe(ERB_COMPLETION_ASSEMBLY);
  });

  it('provider 的 triggerCharacters 含原生区记号 `#` / `[`（糖位各源自身零候选，不带来噪声）', () => {
    const provider = kojoProvider();
    const tc = provider.triggerCharacters ?? [];
    expect(tc).toContain('{');
    expect(tc).toContain('：');
    expect(tc).toContain('#');
    expect(tc).toContain('[');
  });
});

/* ============================== 原生区：ERB 册出货 ============================== */

describe('原生区补全 · `@FUNC` 块内按位路由到 ERB 源', () => {
  const provider = kojoProvider();

  it('`CALL |` ⇒ 只出项目函数（erb-functions；系统函数 `GETBIT` 被 call-target 门滤掉）', () => {
    const items = provideAt(provider, ['@M_KOJO_TEST', '    CALL '].join('\n'), 2, 10);
    expect(labels(items)).toEqual(['M_KOJO_A', 'M_KOJO_B']);
    expect(items.every((i) => i.kind === 4)).toBe(true); // Function（桩 kind 常量）
    const hit = items.find((i) => labelText(i.label) === 'M_KOJO_A')!;
    expect(hit.insertText).toBe('M_KOJO_A'); // 只插名字：ERB 调用位的实参由作者写
    expect(items.some((i) => ['GETBIT', 'RAND'].includes(labelText(i.label)))).toBe(false);
  });

  it('`#D|` ⇒ 只出 `#DIM*` 指令源（全部 detail=预处理指令，无系统函数 / 无 PRINTFORM）', () => {
    const items = provideAt(provider, ['@F', '    #D'].join('\n'), 2, 7);
    expect(labels(items)).toContain('#DIM');
    expect(labels(items).every((l) => l.startsWith('#D'))).toBe(true);
    expect(items.every((i) => i.detail === '预处理指令')).toBe(true);
    expect(items.some((i) => labelText(i.label) === 'GETBIT')).toBe(false);
  });

  it('`CFLAG:|` ⇒ schema 变量名（`erb-variables`，detail=族:编号）', () => {
    const items = provideAt(provider, ['@F', '    CFLAG:'].join('\n'), 2, 11);
    expect(labels(items)).toEqual(['好感度']);
    expect(items[0]!.detail).toBe('CFLAG:1088');
    expect(items[0]!.documentation).toBe('角色好感度');
  });

  it('`GOTO |` 在无 `erbFileFacts` 时回退全文标签（`labelsAt=undefined` 的既定语义）', () => {
    const items = provideAt(provider, ['@F', '$TARGET_ONE', '    GOTO '].join('\n'), 3, 10);
    expect(labels(items)).toEqual(['TARGET_ONE']);
    expect(items[0]!.insertText).toBe('TARGET_ONE');
    expect(items[0]!.detail).toBe('标签（本文件）');
  });

  it('`SETBIT CFLAG:1,|` ⇒ 位表（位号 + 中文位名，insertText=位号）', () => {
    const items = provideAt(provider, ['@F', '    SETBIT CFLAG:1,'].join('\n'), 2, 20);
    expect(labels(items)).toEqual(['8 处女']);
    expect(items[0]!.insertText).toBe('8');
  });

  it('resolve 沿 provenance 回表：`CALL` 候选补上项目函数详情（中文名来自库表反查）', () => {
    const items = provideAt(provider, ['@F', '    CALL '].join('\n'), 2, 10);
    const item = items.find((i) => labelText(i.label) === 'M_KOJO_A')!;
    const resolved = provider.resolveCompletionItem!(item, {} as Monaco.CancellationToken) as Monaco.languages.CompletionItem;
    const doc = (resolved.documentation as { value: string } | undefined)?.value ?? '';
    expect(doc).toContain('项目函数');
    expect(doc).toContain('中文名 公告甲');
  });
});

/* ============================== 糖区：路由回自己，零 erb 噪声 ============================== */

describe('糖位补全 · 绝不路由进 ERB 册', () => {
  const provider = kojoProvider();

  it('`调用 |` ⇒ 仍出 kojo-functions（项目函数名），且无 `#DIM` / 无英文系统函数', () => {
    const text = ['时机 初见：', '    调用 '].join('\n');
    expect(kojoNativeZoneAt(modelOf(text), 2)).toBe(false);
    const items = provideAt(provider, text, 2, 8);
    expect(labels(items)).toContain('M_KOJO_A');
    expect(labels(items)).toContain('M_KOJO_B');
    expect(labels(items)).not.toContain('#DIM');
    expect(items.some((i) => labelText(i.label) === 'GETBIT')).toBe(false);
  });

  it('`时机 初` ⇒ 分野候选照旧，且不混入 ERB 的 `预处理指令`', () => {
    const items = provideAt(provider, '时机 初', 1, 5);
    expect(labels(items)).toContain('初见'); // 糖册 faceTable 出货
    expect(items.find((i) => labelText(i.label) === '初见')!.detail).toBe('M_FACE_TEST');
    expect(items.every((i) => i.detail !== '预处理指令')).toBe(true);
  });

  it('行首 `#D` 在糖区给声明族候选（v1.9 P2），但不出 ERB 原生册', () => {
    const text = '    #D';
    expect(kojoNativeZoneAt(modelOf(text), 1)).toBe(false);
    const items = provideAt(provider, text, 1, 7);
    expect(labels(items)).toContain('#DIM');
    const declarations = items.filter((i) => (i.detail ?? '').includes('声明族'));
    expect(declarations.length).toBeGreaterThan(0);
    expect(declarations.every((i) => labelText(i.label).startsWith('#'))).toBe(true);
    expect(labels(items)).toContain('#FUNCTION');
    expect(items.every((i) => i.detail !== '预处理指令')).toBe(true);
    expect(items.some((i) => labelText(i.label) === 'PRINTFORM')).toBe(false);
  });
});

/* ============================== 装配核：route 在 locate 前 + resolve 按装配分派 ============================== */

describe('completion-core · route 先于 locate，resolve 按产出装配分派', () => {
  const token = {} as Monaco.CancellationToken;

  function sourceOf(id: string, label: string): CompletionSource {
    return {
      id,
      provide({ monaco, range }): Monaco.languages.CompletionItem[] {
        return [{ label, kind: monaco.languages.CompletionItemKind.Keyword, insertText: label, range }];
      },
    };
  }

  it('路由命中 ⇒ 用被路由装配的 locate/sources；resolve 调被路由装配的 resolveDetail', () => {
    const { monaco } = stubMonaco();
    let rootLocateCalls = 0;
    let routedRouteCalls = 0;
    let rootResolveCalls = 0;
    const routed: CompletionAssembly = {
      languageId: 'kojo',
      logTag: '[routed-test]',
      triggerCharacters: [],
      sources: [sourceOf('routed-src', 'ROUTED')],
      callForm: { sourceIds: new Set() },
      route() {
        routedRouteCalls += 1; // 一跳：被路由装配自己的 route 不应被追问
        return undefined;
      },
      locate() {
        return { range: { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 1 } as Monaco.IRange, prefix: '' };
      },
      resolveDetail() {
        return { documentation: { value: 'routed-detail' } };
      },
    };
    const root: CompletionAssembly = {
      languageId: 'kojo',
      logTag: '[root-test]',
      triggerCharacters: [],
      sources: [sourceOf('root-src', 'ROOT')],
      callForm: { sourceIds: new Set() },
      route() {
        return routed;
      },
      locate() {
        rootLocateCalls += 1;
        throw new Error('root locate 不应运行（route 必须先于 locate 解出）');
      },
      resolveDetail() {
        rootResolveCalls += 1;
        return { documentation: { value: 'root-detail' } };
      },
    };
    const provider = createCompletionProvider(monaco, root, () => ({}));
    const items = provideAt(provider, 'x', 1, 1);
    expect(rootLocateCalls).toBe(0); // 若 root.locate 先跑会抛错 ⇒ 空候选
    expect(routedRouteCalls).toBe(0); // 只走一跳
    expect(labels(items)).toEqual(['ROUTED']);
    const resolved = provider.resolveCompletionItem!(items[0]!, token) as Monaco.languages.CompletionItem;
    expect((resolved.documentation as { value: string }).value).toBe('routed-detail');
    expect(rootResolveCalls).toBe(0);
  });
});

/* ============================== 真实 CompletionModel 过滤链（先例口径：kojo-variable-suggest-chain） ============================== */

/**
 * 最小 SuggestItem（形状 = vendor `suggest.js` 的 `CompletionItem` 里 `CompletionModel` 读到的字段；
 * 与 `kojo-variable-suggest-chain.test.ts` 的先例同构——本文件只换候选来源，不另造过滤逻辑）。
 */
interface MinimalSuggestItem {
  completion: Monaco.languages.CompletionItem;
  container: { incomplete: boolean };
  provider: object;
  position: { lineNumber: number; column: number };
  editStart: { lineNumber: number; column: number };
  editInsertEnd: { lineNumber: number; column: number };
  editReplaceEnd: { lineNumber: number; column: number };
  isInvalid: boolean;
  textLabel: string;
  labelLow: string;
  filterTextLow: string | undefined;
  sortTextLow: string | undefined;
  score: number[];
  distance: number;
  idx: number;
}

const SUGGEST_PROVIDER = { provideCompletionItems: () => undefined };

function asSuggestItems(
  items: readonly Monaco.languages.CompletionItem[],
  atColumn: number,
): MinimalSuggestItem[] {
  return items.map((completion) => {
    const label = labelText(completion.label);
    const range = completion.range as Monaco.IRange;
    return {
      completion,
      container: { incomplete: false },
      provider: SUGGEST_PROVIDER,
      position: { lineNumber: 1, column: atColumn },
      editStart: { lineNumber: 1, column: range.startColumn },
      editInsertEnd: { lineNumber: 1, column: range.endColumn },
      editReplaceEnd: { lineNumber: 1, column: range.endColumn },
      isInvalid: false,
      textLabel: label,
      labelLow: label.toLowerCase(),
      filterTextLow: typeof completion.filterText === 'string' ? completion.filterText.toLowerCase() : undefined,
      sortTextLow: completion.sortText?.toLowerCase(),
      score: [-100, 0],
      distance: 0,
      idx: 0,
    };
  });
}

/** 生产口径的构造参数（`suggestModel.js:496-499`；先例同款） */
function completionModelOf(items: MinimalSuggestItem[], triggerColumn: number, line: string): unknown {
  return new CompletionModel(
    items,
    triggerColumn,
    new LineContext(line, 0),
    { distance: () => 0 },
    { filterGraceful: true },
    'inline',
    { boostFullMatch: true, firstMatchCanBeWeak: false },
  );
}

const visibleLabels = (model: unknown): string[] =>
  (model as { items: readonly { textLabel: string }[] }).items.map((i) => i.textLabel);

describe('真实 CompletionModel · 原生 `CALL` 候选经路由后仍可被继续输入过滤', () => {
  it('`CALL M_KOJO|` 当拍两枚项目函数可见；输入 `_A` ⇒ 真实过滤数学只留 M_KOJO_A', () => {
    const line = '    CALL M_KOJO';
    const column = line.length + 1;
    const items = provideAt(kojoProvider(), line, 1, column);
    expect(labels(items)).toEqual(['M_KOJO_A', 'M_KOJO_B']);

    const model = completionModelOf(asSuggestItems(items, column), column, line) as {
      items: readonly { textLabel: string }[];
      lineContext: unknown;
    };
    expect(visibleLabels(model)).toEqual(['M_KOJO_A', 'M_KOJO_B']);

    model.lineContext = new LineContext(`${line}_A`, 2); // 模拟继续敲 `_A`（word = M_KOJO_A）
    expect(visibleLabels(model)).toEqual(['M_KOJO_A']);
  });
});
