/**
 * C-2 · `.erb` 补全的**二段式供给**单测：`resolveCompletionItem`（中文名 / 签名详情）+
 * **括号调用形态**候选按 `callProtocol` 插成带 tabstop 的 snippet。
 *
 * 桩 monaco / 桩 model / 桩表（同 `erb-completion.test.ts` 纪律）：候选数据全部来自注入的
 * adapter 表与语言层词表，**app 侧零硬编码 ERB / 游戏词**——本文件也正是拿这一点做断言：
 * `erb-directives` 一路 resolve **不产任何详情**（中文说法不在任何注入的表里 ⇒ 不编）。
 *
 * 覆盖：(a) provider 现在带 `resolveCompletionItem`；(b) 变量 / 项目函数 / 系统函数三条回表
 * 路径都出详情，外来候选原样交回；(c) 表缺席 ⇒ 不抛、不加详情；(d) snippet 只在
 * `insertText` 恰为 `名字(` 时改写，退化判据（无协议 / 不认 / 已自己写了左括号 / 桩无枚举）
 * 逐条；(e) `erb-functions`（`CALL 名字` / `@名字` 位）**保持纯文本**——那里的实参形态不是括号。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { KojoCallProtocol, KojoCallSlot, KojoLibraryTable, VariableSchema } from '@kojo/plugin-api';
import {
  applyCallSnippet,
  buildCallSnippetText,
  createErbCompletionProvenanceStore,
  escapeSnippetText,
  installErbCompletion,
  resolveErbCompletionDetail,
  slotsForCallee,
  type ErbCompletionProvenance,
  type ErbCompletionTables,
} from '../src/monaco/erb-completion';

/* ============================== 桩 ============================== */

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

function stubMonaco(options: { readonly insertTextRule?: boolean } = {}): {
  monaco: typeof Monaco;
  registered: Registered[];
} {
  const registered: Registered[] = [];
  const languages: Record<string, unknown> = {
    CompletionItemKind: {
      Variable: 1,
      Keyword: 2,
      Operator: 3,
      Function: 4,
      Field: 5,
      Reference: 6,
      EnumMember: 7,
      Property: 8,
    },
    registerCompletionItemProvider: (
      languageId: string,
      provider: Monaco.languages.CompletionItemProvider,
    ): Monaco.IDisposable => {
      registered.push({ languageId, provider });
      return { dispose: () => undefined };
    },
  };
  if (options.insertTextRule !== false) {
    languages.CompletionItemInsertTextRule = { None: 0, KeepWhitespace: 1, InsertAsSnippet: 4 };
  }
  return { monaco: { languages } as unknown as typeof Monaco, registered };
}

/** 桩 model：`getWordUntilPosition` 复刻 Monaco 默认词法（`#` / `:` 都是词分隔符，只给词字符） */
function modelOf(text: string): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getWordUntilPosition: (pos: Monaco.Position) => {
      const line = lines[pos.lineNumber - 1] ?? '';
      const before = line.slice(0, Math.min(pos.column - 1, line.length));
      const m = /[A-Za-z0-9_]+$/.exec(before);
      const word = m ? m[0] : '';
      return { word, startColumn: pos.column - word.length, endColumn: pos.column };
    },
  } as unknown as Monaco.editor.ITextModel;
}

function labelText(label: Monaco.languages.CompletionItem['label']): string {
  return typeof label === 'string' ? label : label.label;
}

function provide(provider: Monaco.languages.CompletionItemProvider, text: string, column = 1) {
  const out = provider.provideCompletionItems(
    modelOf(text),
    { lineNumber: 1, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions;
}

function pick(items: Monaco.languages.CompletionItem[], label: string): Monaco.languages.CompletionItem {
  const hit = items.find((i) => labelText(i.label) === label);
  if (hit === undefined) throw new Error(`候选里没有「${label}」`);
  return hit;
}

function resolveItem(
  provider: Monaco.languages.CompletionItemProvider,
  item: Monaco.languages.CompletionItem,
): Monaco.languages.CompletionItem {
  const fn = provider.resolveCompletionItem;
  if (fn === undefined) throw new Error('provider 没有 resolveCompletionItem');
  return fn.call(provider, item, {} as Monaco.CancellationToken) as Monaco.languages.CompletionItem;
}

function docValue(item: Monaco.languages.CompletionItem): string | undefined {
  const doc = item.documentation;
  if (typeof doc === 'string') return doc;
  if (doc !== undefined && typeof doc.value === 'string') return doc.value;
  return undefined;
}

/** 手搓一枚候选（`kind` 按契约必填，桩里给个数字即可；两形态断言只用 label / insertText） */
function mkItem(
  label: string,
  insertText?: string,
  extra?: { readonly detail?: string; readonly documentation?: string },
): Monaco.languages.CompletionItem {
  return { label, kind: 4, ...(insertText === undefined ? {} : { insertText }), ...extra } as unknown as Monaco.languages.CompletionItem;
}

/* ============================== 桩表 ============================== */

const SLOTS = new Map<string, readonly KojoCallSlot[]>([
  ['GETBIT', [{ index: 0, kind: 'int', label: '变量' }, { index: 1, kind: 'int', label: '位号' }]],
  ['M_KOJO_A', [{ index: 2, kind: 'str', label: '文本' }]],
]);

const protocol: KojoCallProtocol = {
  slotsFor: (name) => {
    if (name === 'BOOM') throw new Error('协议坏了');
    return SLOTS.get(name) ?? null;
  },
};

const variableSchema: VariableSchema = {
  version: 't',
  lookup: (name, index) =>
    name === 'CFLAG' && String(index) === '1'
      ? { name: 'CFLAG', index: 1, bits: [{ bit: 0, label: '接吻' }] }
      : undefined,
  names: (family) =>
    family === 'CFLAG'
      ? [{ name: '好感度', index: 1088, resolvedIndex: 1088, description: '角色好感度', source: 'primary' }]
      : [],
};

const libraryTable: KojoLibraryTable = {
  hasTable: true,
  lookupByName: () => undefined,
  lookupByFunction: (fn) => (fn === 'M_KOJO_A' ? '角色文本' : undefined),
  names: () => [],
};

const PROJECT_FNS: readonly string[] = ['M_KOJO_A'];

const FULL: ErbCompletionTables = {
  variableSchema,
  libraryTable,
  erbFunctionNames: () => PROJECT_FNS,
  callProtocol: protocol,
};

/* ============================== (a) resolve 已挂上 ============================== */

describe('C-2 · ERB provider 带 resolveCompletionItem', () => {
  it('注册的 provider 上有 resolveCompletionItem（此前只返回 { suggestions } ⇒ 右侧空白）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => FULL);
    expect(typeof registered[0]!.provider.resolveCompletionItem).toBe('function');
  });
});

/* ============================== (b) 三条回表路径 ============================== */

describe('C-2 · ERB 候选的二次详情', () => {
  it('变量名（`CFLAG:好感`）⇒ 编号 / 说明 / 名表来源进文档，且返回**同一引用**', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => FULL);
    const provider = registered[0]!.provider;
    const item = pick(provide(provider, 'CFLAG:好感', 9), '好感度');
    const resolved = resolveItem(provider, item);
    expect(resolved).toBe(item);
    const doc = docValue(resolved) ?? '';
    expect(doc).toContain('1088');
    expect(doc).toContain('角色好感度');
    expect(doc).toContain('主名表');
  });

  it('项目函数（`CALL M_KOJO_A`）⇒ 中文名来自库表反查面、签名来自调用协议', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => FULL);
    const provider = registered[0]!.provider;
    const item = pick(provide(provider, 'CALL M_KOJO_A', 14), 'M_KOJO_A');
    const doc = docValue(resolveItem(provider, item)) ?? '';
    expect(doc).toContain('中文名 角色文本');
    expect(doc).toContain('调用签名 `M_KOJO_A(ARGS:2 文本)`');
  });

  it('系统函数（`IF GETBI…`）⇒ 中文名 + 签名', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => FULL);
    const provider = registered[0]!.provider;
    const item = pick(provide(provider, 'IF GETBI', 9), 'GETBIT');
    const doc = docValue(resolveItem(provider, item)) ?? '';
    expect(doc).toContain('**GETBIT** ↔ 获取标记');
    expect(doc).toContain('调用签名 `GETBIT(ARG:0 变量, ARG:1 位号)`');
  });

  it('指令 / 关键字一路**不产详情**（中文说法不在任何注入的表里 ⇒ 不硬编码、不编话术）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => FULL);
    const provider = registered[0]!.provider;
    const item = pick(provide(provider, '#D', 3), '#DIM');
    const resolved = resolveItem(provider, item);
    expect(resolved).toBe(item);
    expect(resolved.documentation).toBeUndefined();
    expect(resolved.detail).toBe('预处理指令');
  });

  it('位槽候选保持 provide 阶段的位名（resolve 不覆盖已有的浅详情）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => FULL);
    const provider = registered[0]!.provider;
    const item = pick(provide(provider, 'SETBIT CFLAG:1, ', 17), '0 接吻');
    expect(docValue(resolveItem(provider, item))).toBe('接吻');
  });

  it('外来候选（不是本装配点产出的对象）⇒ 原样交回', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => FULL);
    const foreign = mkItem('来历不明', '来历不明');
    expect(resolveItem(registered[0]!.provider, foreign)).toBe(foreign);
    expect(foreign.documentation).toBeUndefined();
  });

  it('登记表按对象身份：同 label 的另一枚对象取不到出处', () => {
    const store = createErbCompletionProvenanceStore();
    const a = mkItem('GETBIT');
    const b = mkItem('GETBIT');
    const provenance: ErbCompletionProvenance = { sourceId: 'erb-system-functions', label: 'GETBIT', tables: FULL };
    store.register(a, provenance);
    expect(store.lookup(a)).toBe(provenance);
    expect(store.lookup(b)).toBeUndefined();
  });
});

/* ============================== (c) 缺席 / 抛错 ============================== */

describe('C-2 · ERB 表缺席与坏表（不猜、不抛）', () => {
  it('变量表在场出详情；库表 / 协议缺席 ⇒ 项目函数候选无任何详情可加', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({ ...FULL, libraryTable: undefined, callProtocol: undefined }));
    const provider = registered[0]!.provider;
    const item = pick(provide(provider, 'CALL M_KOJO_A', 14), 'M_KOJO_A');
    expect(docValue(resolveItem(provider, item))).toBeUndefined();
  });

  it('resolveCompletionDetail 不认的 sourceId / 查不到事实 ⇒ undefined', () => {
    const directive: ErbCompletionProvenance = { sourceId: 'erb-directives', label: '#DIM', tables: FULL };
    expect(resolveErbCompletionDetail(mkItem('#DIM'), directive)).toBeUndefined();
    const miss: ErbCompletionProvenance = { sourceId: 'erb-variables', label: '没这个名字', tables: FULL };
    expect(resolveErbCompletionDetail(mkItem('没这个名字', undefined, { detail: 'CFLAG:9' }), miss)).toBeUndefined();
  });

  it('协议抛错 ⇒ 详情与片段双双退化（不崩整轮候选）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({ ...FULL, callProtocol: { slotsFor: () => { throw new Error('坏了'); } } }));
    const provider = registered[0]!.provider;
    const items = provide(provider, 'IF GETBI', 9);
    const item = pick(items, 'GETBIT');
    expect(item.insertText).toBe('GETBIT(');
    expect(item.insertTextRules).toBeUndefined();
    expect(items.length).toBeGreaterThan(0);
  });
});

/* ============================== (d) snippet ============================== */

describe('C-2 · ERB 括号调用形态 → snippet', () => {
  const providerOf = (tables: ErbCompletionTables, options: { insertTextRule?: boolean } = {}) => {
    const { monaco, registered } = stubMonaco(options);
    installErbCompletion(monaco, () => tables);
    return registered[0]!.provider;
  };

  it('`GETBIT(` ⇒ `GETBIT(${1:ARG:0 变量}, ${2:ARG:1 位号})` + InsertAsSnippet', () => {
    const item = pick(provide(providerOf(FULL), 'IF GETBI', 9), 'GETBIT');
    expect(item.insertText).toBe('GETBIT(${1:ARG:0 变量}, ${2:ARG:1 位号})');
    expect(item.insertTextRules).toBe(4);
  });

  it('退化一：无调用协议 ⇒ 纯文本 `GETBIT(`', () => {
    const item = pick(provide(providerOf({ ...FULL, callProtocol: undefined }), 'IF GETBI', 9), 'GETBIT');
    expect(item.insertText).toBe('GETBIT(');
    expect(item.insertTextRules).toBeUndefined();
  });

  it('退化二：作者已经自己写了左括号 ⇒ 不再插片段', () => {
    // 光标停在名字与作者已写的 `(` **之间**（列 10 = `GETBIT` 之后、`(` 之前）：
    // 候选替换区间右端紧邻的就是那个 `(` ⇒ 判据成立。写成列 11（`(` 的**右侧**）时
    // 区间是空区间、`(` 落在区间**左侧**，插进去的片段自带右括号并不算多余一对——那不是本判据的情形。
    const item = pick(provide(providerOf(FULL), 'IF GETBIT(', 10), 'GETBIT');
    expect(item.insertText).toBe('GETBIT(');
    expect(item.insertTextRules).toBeUndefined();
  });

  it('退化三：桩 monaco 没有 InsertAsSnippet 枚举 ⇒ 不改写', () => {
    const item = pick(provide(providerOf(FULL, { insertTextRule: false }), 'IF GETBI', 9), 'GETBIT');
    expect(item.insertText).toBe('GETBIT(');
    expect(item.insertTextRules).toBeUndefined();
  });

  it('`CALL 名字` / `@名字` 位保持纯文本（那里跟的是逗号实参，插括号形态是非法）', () => {
    const item = pick(provide(providerOf(FULL), 'CALL M_KOJO_A', 14), 'M_KOJO_A');
    expect(item.insertText).toBe('M_KOJO_A');
    expect(item.insertTextRules).toBeUndefined();
    const def = pick(provide(providerOf(FULL), '@M_KOJO_A', 10), 'M_KOJO_A');
    expect(def.insertText).toBe('M_KOJO_A');
    expect(def.insertTextRules).toBeUndefined();
  });

  it('applyCallSnippet 直接可测：形态不符（非 `名字(`）一律 false', () => {
    const { monaco } = stubMonaco();
    const item = mkItem('GETBIT', 'GETBIT');
    const provenance: ErbCompletionProvenance = { sourceId: 'erb-system-functions', label: 'GETBIT', tables: FULL };
    expect(applyCallSnippet(monaco, item, provenance, undefined)).toBe(false);
    item.insertText = 'GETBIT(';
    expect(applyCallSnippet(monaco, item, provenance, undefined)).toBe(true);
    expect(item.insertText).toBe('GETBIT(${1:ARG:0 变量}, ${2:ARG:1 位号})');
    expect(applyCallSnippet(monaco, mkItem('X', 'X('), {
      ...provenance,
      sourceId: 'erb-functions',
      label: 'X',
    }, undefined)).toBe(false);
  });
});

/* ============================== (e) 纯 helper ============================== */

describe('C-2 · ERB snippet / 取槽纯 helper', () => {
  it('escapeSnippetText 只转义 snippet 控制字符', () => {
    expect(escapeSnippetText('位号')).toBe('位号');
    expect(escapeSnippetText('a$b}c\\d')).toBe('a\\$b\\}c\\\\d');
  });

  it('buildCallSnippetText：undefined ⇒ 退化；空数组 ⇒ `名字()`（协议声明的确定事实）', () => {
    expect(buildCallSnippetText('F', undefined)).toBeUndefined();
    expect(buildCallSnippetText('F', [])).toBe('F()');
    expect(buildCallSnippetText('F', SLOTS.get('M_KOJO_A'))).toBe('F(${1:ARGS:2 文本})');
  });

  it('slotsForCallee：表缺席 / 不认 / 抛错 ⇒ undefined；命中即返回', () => {
    expect(slotsForCallee(undefined, ['GETBIT'])).toBeUndefined();
    expect(slotsForCallee(protocol, ['不认识'])).toBeUndefined();
    expect(slotsForCallee(protocol, [undefined, '', 'GETBIT'])).toBe(SLOTS.get('GETBIT'));
    expect(slotsForCallee(protocol, ['BOOM', 'GETBIT'])).toBe(SLOTS.get('GETBIT'));
  });
});
