/**
 * C-2 · `.kojo` 补全的**二段式供给**单测：`resolveCompletionItem`（选中出详情）+
 * 函数候选按 `callProtocol` 插成带 tabstop 的 snippet。
 *
 * Monaco 绑定刻意薄（同 `kojo-completion.test.ts` 纪律）：桩 monaco 只给两枚枚举 +
 * `registerCompletionItemProvider`，桩 model 只给 `getValue` / `getLineContent` /
 * `getWordUntilPosition`，表全部是桩 adapter 数据 ⇒ **零游戏名词、零真实 monaco 运行时**。
 *
 * 覆盖：
 * (a) provider 现在**带** `resolveCompletionItem`（此前只返回 `{suggestions}` ⇒ 弹层右侧空白）；
 * (b) 反查走 `WeakMap` **对象身份**：登记过才填、没登记原样交回、不往候选上挂私有字段；
 * (c) 表缺席 / 表里查不到 / 表抛错 ⇒ resolve **原样返回、不抛**（供给不静默也不虚报）；
 * (d) snippet 只在「调用形态 + 协议认得这个函数」时改写；**拿不到槽一律退化纯文本**；
 * (e) 纯 helper（`escapeSnippetText` / `buildCallSnippetText` / `slotsForCallee`）逐条判据。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  KojoCallProtocol,
  KojoCallSlot,
  KojoFaceTable,
  KojoInstructionTable,
  KojoLibraryTable,
  VariableSchema,
} from '@kojo/plugin-api';
import {
  applyCallSnippet,
  buildCallSnippetText,
  candidateRange,
  charAfterRange,
  createCompletionProvenanceStore,
  escapeSnippetText,
  installKojoCompletion,
  resolveCompletionDetail,
  slotsForCallee,
  type CompletionProvenance,
  type CompletionTables,
} from '../src/monaco/kojo-completion';

/* ============================== 桩 ============================== */

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

/**
 * 桩 monaco：`CompletionItemKind` + `CompletionItemInsertTextRule`。
 * `insertTextRule: false` 用来复现"桩 / 旧运行时拿不到那枚枚举"⇒ snippet 整条退化（不硬编码数字 4）。
 */
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
      EnumMember: 5,
      Property: 6,
      Field: 7,
      Reference: 8,
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

function modelOf(text: string): Monaco.editor.ITextModel {
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

/** 取一轮候选里的那个 label */
function pick(items: Monaco.languages.CompletionItem[], label: string): Monaco.languages.CompletionItem {
  const hit = items.find((i) => labelText(i.label) === label);
  if (hit === undefined) throw new Error(`候选里没有「${label}」`);
  return hit;
}

/** 走 provider 的 resolve（返回**同一个**对象引用；Monaco 就是按引用把详情合并回去的） */
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

/** 手搓一枚候选（契约上 `label` / `kind` / `insertText` 三个必填，桩里给数字 kind 即可） */
function mkItem(
  label: string,
  insertText?: string,
  extra?: { readonly detail?: string; readonly range?: Monaco.IRange },
): Monaco.languages.CompletionItem {
  return {
    label,
    kind: 4,
    ...(insertText === undefined ? {} : { insertText }),
    ...extra,
  } as unknown as Monaco.languages.CompletionItem;
}

/* ============================== 桩表 ============================== */

/** 只有 `HPH_PRINT` 有槽、`NO_SLOT_FN` 声明零槽、`BAD_FN` 抛错；其余一律「不认」（null） */
const SLOTS = new Map<string, readonly KojoCallSlot[]>([
  [
    'HPH_PRINT',
    [
      { index: 0, kind: 'int', label: '事件子参数' },
      { index: 1, kind: 'str', label: '文本' },
    ],
  ],
  ['NO_SLOT_FN', []],
]);

const protocol: KojoCallProtocol = {
  slotsFor: (name) => {
    if (name === 'BAD_FN') throw new Error('协议坏了');
    return SLOTS.get(name) ?? null;
  },
};

const variableSchema: VariableSchema = {
  version: 't',
  lookup: () => undefined,
  names: (family) =>
    family === 'CFLAG'
      ? [
          {
            name: '甲旗',
            index: 1088,
            resolvedIndex: 1088,
            description: '既成事实',
            source: 'primary',
            bits: [
              { bit: 0, label: '接吻' },
              { bit: 2, label: '恋人' },
            ],
          },
        ]
      : [],
};

const faceTable: KojoFaceTable = {
  faces: {
    初见: { template: 'M_FACE{t}_K{n}' },
    指令: {
      template: 'M_MSG{t}_${com}_K{n}_{i}',
      indexKind: 'command',
      autoIndex: false,
      success: { template: 'M_MSGCHECK_K{n}' },
      messageCheck: { template: 'M_MC_K{n}' },
      segments: { com: { COM: 'COM', SCOM: 'SCOM' } },
    },
  },
};

const instructionTable: KojoInstructionTable = {
  hasTable: true,
  lookupByName: (name) => (name === '摸屁股' ? 310 : undefined),
  lookupByNo: (no) => (no === 310 ? '摸屁股' : undefined),
  names: () => ['摸屁股'],
};

/**
 * 库函数的**表层显示名**刻意不取 `心形`（`kojo-completion-library.test.ts` 那份桩的名字）：
 * `心形` 同时是 `.kojo` 的行内关键字（`keywords.ts` 的 `inline.heart`），由**先注册**的
 * `kojo-lexicon` 一路产出 ⇒ 按 label 去重（先注册者胜）时 `kojo-library` 的候选被关键字那枚
 * 盖掉（产品上是对的：`心形 「台词」` 才是糖认的写法，`心形(…)` 不是合法调用形）。
 * 本文件要验的是**库函数那一路**，故显示名用与词表零碰撞的 `角色文本`。
 */
const LIB_CN = '角色文本';

const libraryTable: KojoLibraryTable = {
  hasTable: true,
  lookupByName: (name) => (name === LIB_CN ? 'HPH_PRINT' : name === '无槽' ? 'NO_SLOT_FN' : name === '坏表' ? 'BAD_FN' : undefined),
  lookupByFunction: () => undefined,
  names: () => [LIB_CN, '无槽', '坏表'],
};

const FULL: CompletionTables = {
  variableSchema,
  faceTable,
  instructionTable,
  libraryTable,
  callProtocol: protocol,
};

/* ============================== (a) resolve 已挂上 ============================== */

describe('C-2 · provider 带 resolveCompletionItem（选中出详情）', () => {
  it('注册出的 provider 有 resolveCompletionItem（此前只返回 { suggestions }）', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => FULL);
    const provider = registered[0]!.provider;
    expect(typeof provider.resolveCompletionItem).toBe('function');
  });
});

/* ============================== (b) WeakMap 身份反查 ============================== */

describe('C-2 · 反查登记表（WeakMap 按对象身份，不挂私有字段）', () => {
  it('登记过的对象取回出处；同 label 的另一个对象取不到（身份不是内容）', () => {
    const store = createCompletionProvenanceStore();
    const item = mkItem('甲旗');
    const twin = mkItem('甲旗');
    const provenance: CompletionProvenance = { sourceId: 'kojo-variable', label: '甲旗', tables: FULL };
    store.register(item, provenance);
    expect(store.lookup(item)).toBe(provenance);
    expect(store.lookup(twin)).toBeUndefined();
  });

  it('resolve 前后是**同一个引用**，且只动 detail / documentation（候选不带私有字段）', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => FULL);
    const provider = registered[0]!.provider;
    const item = pick(provide(provider, '{她的', 4), '甲旗');
    const before = Object.keys(item).sort().join(',');
    const resolved = resolveItem(provider, item);
    expect(resolved).toBe(item);
    expect(Object.keys(resolved).sort().join(',')).toBe(before); // 没新增 Monaco 不认的字段
    expect(docValue(resolved)).toContain('既成事实');
  });

  it('每个 source 的详情都回得了表：变量 / 分野 / 指令名 / 库函数 / 系统函数', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => FULL);
    const provider = registered[0]!.provider;

    const v = docValue(resolveItem(provider, pick(provide(provider, '{她的', 4), '甲旗'))) ?? '';
    expect(v).toContain('1088');
    expect(v).toContain('主名表');
    expect(v).toContain('0 接吻');

    const f = docValue(resolveItem(provider, pick(provide(provider, '时机 指令', 6), '指令'))) ?? '';
    expect(f).toContain('M_MSG{t}_${com}_K{n}_{i}');
    expect(f).toContain('按指令名表换算');
    expect(f).toContain('成否模板');
    expect(f).toContain('隐藏判定模板');
    expect(f).toContain('COM');

    const i = docValue(resolveItem(provider, pick(provide(provider, '时机 指令 摸', 8), '摸屁股'))) ?? '';
    expect(i).toContain('310');
    expect(i).toContain('编号反查');

    const l = docValue(resolveItem(provider, pick(provide(provider, LIB_CN, 5), LIB_CN))) ?? '';
    expect(l).toContain('HPH_PRINT');
    expect(l).toContain(`调用签名 \`${LIB_CN}(ARG:0 事件子参数, ARGS:1 文本)\``);

    const s = docValue(resolveItem(provider, pick(provide(provider, '获取标记', 5), '获取标记'))) ?? '';
    expect(s).toContain('原生名 `GETBIT`');
  });
});

/* ============================== (c) 缺席 / 抛错 ⇒ 原样返回 ============================== */

describe('C-2 · 表缺席与坏表（resolve 不猜、不抛）', () => {
  it('空 tables：非 adapter 派生的候选原样交回（关键字不编中文说明）', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => ({}));
    const provider = registered[0]!.provider;
    const item = pick(provide(provider, '如果', 1), '如果');
    const resolved = resolveItem(provider, item);
    expect(resolved).toBe(item);
    expect(resolved.documentation).toBeUndefined();
  });

  it('分野表在场 ⇒ 详情回得到模板；缺席 ⇒ 该路零候选 + 降级可见（resolve 无从参与）', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => FULL);
    const item = pick(provide(registered[0]!.provider, '时机 指令', 6), '指令');
    expect(docValue(resolveItem(registered[0]!.provider, item))).toContain('M_MSG{t}_${com}_K{n}_{i}');

    const bare = stubMonaco();
    const degrades: string[] = [];
    installKojoCompletion(bare.monaco, () => ({ variableSchema, instructionTable, libraryTable }), (d) =>
      degrades.push(`${d.sourceId}:${d.missing}`),
    );
    expect(provide(bare.registered[0]!.provider, '时机 指令', 6).some((i) => labelText(i.label) === '指令')).toBe(false);
    expect(degrades).toContain('kojo-face:faceTable');
  });

  it('外来候选（不是本装配点产出的对象）⇒ 原样交回', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => FULL);
    const foreign = mkItem('来历不明', '来历不明');
    expect(resolveItem(registered[0]!.provider, foreign)).toBe(foreign);
    expect(foreign.documentation).toBeUndefined();
  });

  it('坏表（回表抛错）⇒ resolve 不抛、详情留空', () => {
    const bomb: KojoInstructionTable = {
      hasTable: true,
      lookupByName: () => {
        throw new Error('表坏了');
      },
      lookupByNo: () => undefined,
      names: () => ['摸屁股'],
    };
    const item = mkItem('摸屁股', undefined, { detail: '指令名 → 编号 310' });
    const provenance: CompletionProvenance = { sourceId: 'kojo-instruction', label: '摸屁股', tables: { instructionTable: bomb } };
    expect(resolveCompletionDetail(item, provenance)).toBeUndefined();
    expect(item.documentation).toBeUndefined();
  });

  it('resolveCompletionDetail 不认的 sourceId ⇒ undefined（后来追加的 source 自己声明详情）', () => {
    const provenance: CompletionProvenance = { sourceId: 'someone-elses-source', label: 'X', tables: FULL };
    expect(resolveCompletionDetail(mkItem('X'), provenance)).toBeUndefined();
  });
});

/* ============================== (d) snippet ============================== */

describe('C-2 · 函数候选插成带 tabstop 的 snippet', () => {
  const withProtocol = (): { provider: Monaco.languages.CompletionItemProvider; monaco: typeof Monaco } => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => FULL);
    return { provider: registered[0]!.provider, monaco };
  };

  it(`协议认得 ⇒ \`${LIB_CN}(\` 改写成 \`${LIB_CN}(\${1:ARG:0 事件子参数}, \${2:ARGS:1 文本})\` + InsertAsSnippet`, () => {
    const { provider } = withProtocol();
    const item = pick(provide(provider, LIB_CN, 5), LIB_CN);
    expect(item.insertText).toBe(`${LIB_CN}(\${1:ARG:0 事件子参数}, \${2:ARGS:1 文本})`);
    expect(item.insertTextRules).toBe(4);
  });

  it('协议声明"零槽"（空数组）⇒ `名字()`：这是事实，不是猜', () => {
    const { provider } = withProtocol();
    const item = pick(provide(provider, '无槽', 3), '无槽');
    expect(item.insertText).toBe('无槽()');
    expect(item.insertTextRules).toBe(4);
  });

  it('退化一：callProtocol 缺席 ⇒ 纯文本 `名字(`、不带 insertTextRules', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => ({ ...FULL, callProtocol: undefined }));
    const item = pick(provide(registered[0]!.provider, LIB_CN, 5), LIB_CN);
    expect(item.insertText).toBe(`${LIB_CN}(`);
    expect(item.insertTextRules).toBeUndefined();
  });

  it('退化二：协议不认这个函数（slotsFor → null）⇒ 纯文本', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => ({ ...FULL, callProtocol: { slotsFor: () => null } }));
    const item = pick(provide(registered[0]!.provider, LIB_CN, 5), LIB_CN);
    expect(item.insertText).toBe(`${LIB_CN}(`);
    expect(item.insertTextRules).toBeUndefined();
  });

  it('退化三：协议求槽抛错 ⇒ 纯文本且不崩（整轮候选照常出货）', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => FULL);
    const items = provide(registered[0]!.provider, '坏表', 3);
    const item = pick(items, '坏表');
    expect(item.insertText).toBe('坏表(');
    expect(item.insertTextRules).toBeUndefined();
    expect(items.length).toBeGreaterThan(0);
  });

  it('退化四：桩 monaco 拿不到 InsertAsSnippet 枚举 ⇒ 不改写（不硬编码数字）', () => {
    const { monaco, registered } = stubMonaco({ insertTextRule: false });
    installKojoCompletion(monaco, () => FULL);
    const item = pick(provide(registered[0]!.provider, LIB_CN, 5), LIB_CN);
    expect(item.insertText).toBe(`${LIB_CN}(`);
    expect(item.insertTextRules).toBeUndefined();
  });

  it('作者已经自己写了左括号 ⇒ 不再插片段（免得给他多一对括号）', () => {
    const { provider } = withProtocol();
    // 光标停在名字与作者已写的 `(` **之间**：候选替换区间右端紧邻的就是那个 `(`
    const item = pick(provide(provider, `${LIB_CN}(`, 5), LIB_CN);
    expect(item.insertText).toBe(`${LIB_CN}(`);
    expect(item.insertTextRules).toBeUndefined();
  });

  it('非调用形态候选（变量 / 指令名）即使协议认得也保持纯文本', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => ({
      ...FULL,
      callProtocol: { slotsFor: (name) => (name === '甲旗' || name === '摸屁股' ? SLOTS.get('HPH_PRINT') ?? null : null) },
    }));
    const items = provide(registered[0]!.provider, '{她的', 4);
    const v = pick(items, '甲旗');
    expect(v.insertText).toBe('甲旗');
    expect(v.insertTextRules).toBeUndefined();

    const heads = provide(registered[0]!.provider, '时机 指令 摸', 8);
    const com = pick(heads, '摸屁股');
    expect(com.insertText).toBe('摸屁股');
    expect(com.insertTextRules).toBeUndefined();
  });

  it('applyCallSnippet 直接可测：调用形态 + 原生名回表命中', () => {
    const { monaco } = stubMonaco();
    const item = mkItem(LIB_CN, `${LIB_CN}(`, {
      range: { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 5 },
    });
    const provenance: CompletionProvenance = { sourceId: 'kojo-library', label: LIB_CN, tables: FULL };
    expect(applyCallSnippet(monaco, item, provenance, undefined)).toBe(true);
    expect(item.insertText).toBe(`${LIB_CN}(\${1:ARG:0 事件子参数}, \${2:ARGS:1 文本})`);
  });
});

/* ============================== (e) 纯 helper ============================== */

describe('C-2 · snippet / 取槽纯 helper', () => {
  it('escapeSnippetText 只转义 snippet 控制字符（`\\` / `$` / `}`）', () => {
    expect(escapeSnippetText('普通槽名')).toBe('普通槽名');
    expect(escapeSnippetText('a$b}c\\d')).toBe('a\\$b\\}c\\\\d');
    expect(escapeSnippetText('带: 冒号')).toBe('带: 冒号');
  });

  it('buildCallSnippetText：槽序 = tabstop 序；kind 前缀照抄协议（ARG / ARGS）', () => {
    expect(buildCallSnippetText('F', SLOTS.get('HPH_PRINT'))).toBe('F(${1:ARG:0 事件子参数}, ${2:ARGS:1 文本})');
    expect(buildCallSnippetText('F', undefined)).toBeUndefined();
    expect(buildCallSnippetText('F', [])).toBe('F()');
  });

  it('buildCallSnippetText 把槽文本里的控制字符转义掉（协议给的标签不受我们管）', () => {
    const slots: readonly KojoCallSlot[] = [{ index: 3, kind: 'str', label: '含 $ 与 } 的槽' }];
    expect(buildCallSnippetText('F', slots)).toBe('F(${1:ARGS:3 含 \\$ 与 \\} 的槽})');
  });

  it('slotsForCallee：表缺席 / 全不认 / 抛错 ⇒ undefined；命中即返回（空数组也算命中）', () => {
    expect(slotsForCallee(undefined, ['HPH_PRINT'])).toBeUndefined();
    expect(slotsForCallee(protocol, ['没这个函数'])).toBeUndefined();
    expect(slotsForCallee(protocol, [undefined, '', 'HPH_PRINT'])).toBe(SLOTS.get('HPH_PRINT'));
    expect(slotsForCallee(protocol, ['NO_SLOT_FN'])).toEqual([]);
    expect(slotsForCallee(protocol, ['BAD_FN', 'HPH_PRINT'])).toBe(SLOTS.get('HPH_PRINT'));
  });

  it('candidateRange / charAfterRange：吃 IRange 与 {insert,replace} 双区间两种形态', () => {
    const lineText = '心形(1)';
    const box = { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 3 };
    expect(charAfterRange(lineText, candidateRange(box))).toBe('(');
    expect(
      charAfterRange(
        lineText,
        candidateRange({
          insert: box,
          replace: { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 4 },
        }),
      ),
    ).toBe('1');
    expect(charAfterRange(lineText, candidateRange(undefined))).toBeUndefined();
  });
});
