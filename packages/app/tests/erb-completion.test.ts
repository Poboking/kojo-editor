/**
 * EC-1 · `.erb` 方言补全**装配 seam**（`installErbCompletion` + `ERB_COMPLETION_SOURCES`）单测。
 *
 * Monaco 绑定刻意薄：本文件用**桩 monaco**（只记录注册调用与 `CompletionItemKind`）喂 provider，
 * 不引入真实 monaco-editor 运行时；候选来自静态词表 source（纯数据），不依赖语料。
 * 覆盖：(a) provider 确为 **ERB 语言**注册（kojo 语言不得被本模块注册）、且只注册一个；
 * (b) `erb-directives` source 行首给 `#DIM` 之类、行中不给（判定经 `isLineHeadContext` 可单测）；
 * (c) 空 tables 不崩且无非表候选；`memoizedErbFunctionNames` 按指纹失效。
 * 本批扩：门白名单终态（名字位只出本路候选）、行中跳转词单源、adapter 指令词并入、
 * `erb-families` / `erb-declared` 两个新源的端到端出货；G 批把 `erb-declared` 的取数改成
 * **两态**（索引有意见 ⇒ 以索引为准、不与缓冲区合并；未索引 / 通道缺席 ⇒ 回退缓冲区扫描）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { ErbFunctionRef, ErbIndex, KojoInstructionTable, VariableSchema } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  ERB_COMPLETION_SOURCES,
  erbTokenRange,
  installErbCompletion,
  isLineHeadContext,
  memoizedErbFunctionNames,
  type ErbCompletionDegrade,
  type ErbCompletionTables,
} from '../src/monaco/erb-completion';
import type { ErbFileFactsProvider } from '../src/monaco/completion-core';
import { dimNamesOfBuffer, erbDimNamesOf, erbFactsPathOf } from '../src/monaco/erb-completion-declared';

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

/** 桩 monaco：只实现补全注册链所需的最薄面 */
function stubMonaco(): { monaco: typeof Monaco; registered: Registered[] } {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: { Variable: 1, Keyword: 2, Operator: 3, Function: 4, Field: 5, Reference: 6, EnumMember: 7 },
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
 * 桩 model：`getLineContent` / `getValue` / `getWordUntilPosition`。
 * `getWordUntilPosition` 复刻 Monaco 默认词法（`#` / `[` / `]` 都是词分隔符，只给字母数字下划线）。
 */
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

/** 走 provider 取一轮候选（同步实现 → 桩里直接读建议数组）；`lineNumber` 缺省 = 第 1 行 */
function provide(
  provider: Monaco.languages.CompletionItemProvider,
  text: string,
  column: number,
  lineNumber = 1,
): Monaco.languages.CompletionItem[] {
  const out = provider.provideCompletionItems(
    modelOf(text),
    { lineNumber, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions;
}

/** 最小 VariableSchema 桩：`names(族)` 只认 `CFLAG`；其余族返回空（不猜） */
function fakeSchema(): VariableSchema {
  return {
    version: 'test',
    lookup: () => undefined,
    names: (family: string) =>
      family === 'CFLAG' ? [{ name: '好感度', index: 1088, description: '角色好感度' }] : [],
  } as unknown as VariableSchema;
}

/** 内容不同的第二张变量 schema（切表可辨；族 `CFLAG` 出另一名字） */
function fakeSchemaY(): VariableSchema {
  return {
    version: 'testY',
    lookup: () => undefined,
    names: (family: string) => (family === 'CFLAG' ? [{ name: '恶意', index: 999 }] : []),
  } as unknown as VariableSchema;
}

/** 项目函数名（同一数组引用：EC-3 前缀索引按数组身份记忆化） */
const PROJECT_FNS: readonly string[] = ['M_KOJO_A', 'M_KOJO_B'];

function fnRef(name: string): ErbFunctionRef {
  return { name, normalizedName: name, filePath: 'x.ERB', startLine: 1, endLine: 1 };
}

function fakeIndex(fingerprint: string | null, names: string[]): ErbIndex {
  const byName = new Map<string, ErbFunctionRef[]>();
  // 与解析器同口径：byName 的键是归一化大写名，ref 里保留定义处原拼写
  for (const n of names) byName.set(n.toUpperCase(), [fnRef(n)]);
  return { files: new Map(), byName, fingerprint } as unknown as ErbIndex;
}

const HEAD = '#D'; // 行首：光标在 `#D` 之后（列 3）
const MID = 'IF A'; // 行中：光标在 `IF A` 之后（列 5）

describe('EC-1 · .erb 补全装配（provider 注册）', () => {
  it('只注册一个 provider，且落在 ERB 语言上（kojo 语言不得被本模块注册）', () => {
    const { monaco, registered } = stubMonaco();
    const dispose = installErbCompletion(monaco, () => ({}));
    expect(registered).toHaveLength(1);
    expect(registered[0]!.languageId).toBe(ERB_LANGUAGE_ID);
    expect(registered[0]!.languageId).not.toBe(KOJO_LANGUAGE_ID);
    dispose.dispose();
  });

  it('触发字符含 `@`（函数定义头）与 `$`（标签目标）——它们不在 Monaco 默认词法里', () => {
    const { monaco, registered } = stubMonaco();
    const dispose = installErbCompletion(monaco, () => ({}));
    // ERB-COMPLETE-MEMBER：`.` 追加在既有四枚之后（点号成员位 `y.` 由 `erb-members` 出货）
    expect(registered[0]!.provider.triggerCharacters).toEqual(['#', '[', '@', '$', '.']);
    dispose.dispose();
  });

  it('扩展点稳定：ERB_COMPLETION_SOURCES 是可追加数组，骨架最前 + 十一个 source 全在册（词源 / 成员源追加末尾）', () => {
    expect(Array.isArray(ERB_COMPLETION_SOURCES)).toBe(true);
    expect(ERB_COMPLETION_SOURCES.map((s) => s.id)).toEqual([
      'erb-snippet',
      'erb-directives',
      'erb-variables',
      'erb-functions',
      'erb-labels',
      'erb-system-functions',
      'erb-bits',
      'erb-families',
      'erb-declared',
      'erb-words',
      'erb-members',
    ]);
  });
});

describe('EC-1 · 行首 / 行中判定（纯函数）', () => {
  it('行首：`#D`（列 3）→ token 区间含 `#`，前缀为空 ⇒ 行首', () => {
    expect(erbTokenRange(modelOf('#D'), { lineNumber: 1, column: 3 } as Monaco.Position)).toEqual({
      startLineNumber: 1,
      endLineNumber: 1,
      startColumn: 1,
      endColumn: 3,
    });
    expect(isLineHeadContext(modelOf('#D'), { lineNumber: 1, column: 3 } as Monaco.Position)).toBe(true);
  });

  it('行首：只有空白 / 空行 ⇒ 行首', () => {
    expect(isLineHeadContext(modelOf('   '), { lineNumber: 1, column: 4 } as Monaco.Position)).toBe(true);
    expect(isLineHeadContext(modelOf(''), { lineNumber: 1, column: 1 } as Monaco.Position)).toBe(true);
  });

  it('行中：`IF A`（列 5）→ 之前有实义字符 ⇒ 非行首', () => {
    expect(erbTokenRange(modelOf(MID), { lineNumber: 1, column: 5 } as Monaco.Position).startColumn).toBe(4);
    expect(isLineHeadContext(modelOf(MID), { lineNumber: 1, column: 5 } as Monaco.Position)).toBe(false);
  });

  it('行首：全角空格 U+3000 缩进算空白（口径 = 空白单源 isAllBlank，与 lexer `[ \\t\\u3000]` 一致）', () => {
    expect(isLineHeadContext(modelOf('\u3000#D'), { lineNumber: 1, column: 4 } as Monaco.Position)).toBe(true);
    expect(isLineHeadContext(modelOf('\u3000\u3000'), { lineNumber: 1, column: 3 } as Monaco.Position)).toBe(true);
  });

  it('行中：NBSP U+00A0 不算缩进空白（语料零命中 ⇒ 统一走单源严口径，不再特判 `\s` 的宽集）', () => {
    expect(isLineHeadContext(modelOf('\u00a0#D'), { lineNumber: 1, column: 4 } as Monaco.Position)).toBe(false);
  });
});

describe('EC-1 · 全角缩进行的行首候选（端到端）', () => {
  it('`　#DIM`（U+3000 缩进）仍出 `#DIM` 行首候选（`#` 记号位按全记号前缀收窄）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({}));
    const items = provide(registered[0]!.provider, '\u3000#DIM', 6);
    expect(items.find((i) => labelText(i.label) === '#DIM')!.detail).toBe('预处理指令');
  });
});

describe('EC-1 · erb-directives source 出货', () => {
  const { monaco, registered } = stubMonaco();
  installErbCompletion(monaco, () => ({}));
  const provider = registered[0]!.provider;
  const labels = (items: readonly Monaco.languages.CompletionItem[]): string[] => items.map((i) => labelText(i.label));

  it('`#D` 记号位：按**全记号前缀**收窄 ⇒ 只出 `#DIM` 系（`PRINTFORM` / `[SKIPSTART]` / `GETBIT` 不在 `#` 位抢候选）', () => {
    const items = provide(provider, HEAD, 3);
    expect(items.find((i) => labelText(i.label) === '#DIM')!.detail).toBe('预处理指令');
    const ls = items.map((i) => labelText(i.label));
    expect(ls).not.toContain('PRINTFORM');
    expect(ls).not.toContain('[SKIPSTART]');
    expect(ls).not.toContain('GETBIT');
  });

  it('各行首形态在各自记号位出货：`PR` ⇒ `PRINTFORM`（指令）/ `[SKIP` ⇒ `[SKIPSTART]`（指令行）/ `I` ⇒ `IF` 骨架先注册者胜', () => {
    expect(provide(provider, 'PR', 3).find((i) => labelText(i.label) === 'PRINTFORM')!.detail).toBe('指令');
    expect(provide(provider, '[SKIP', 6).find((i) => labelText(i.label) === '[SKIPSTART]')!.detail).toBe('指令行');
    // 裸行首 `IF` 与 erb-snippet 骨架同 label，去重先注册者胜 ⇒ 只留骨架（R4 设计意图）
    expect(provide(provider, 'I', 2).find((i) => labelText(i.label) === 'IF')!.detail).toBe('条件块骨架');
  });

  it('行首：`#DIM` 前缀精确命中置顶（替换区间覆盖 `#`，插入即补全）', () => {
    const items = provide(provider, '#DIM', 5);
    expect(labelText(items[0]!.label)).toBe('#DIM');
    expect(items[0]!.insertText).toBe('#DIM');
  });

  it('行首：`#DI` 部分前缀命中，`#DIM` 在候选内（大小写兄弟 `#DIMCHAR` 同档）', () => {
    const items = provide(provider, '#DI', 4);
    expect(items.map((i) => labelText(i.label))).toContain('#DIM');
    expect(items.find((i) => labelText(i.label) === '#DIM')!.detail).toBe('预处理指令');
  });

  it('行中：不给 `#DIM` / `[SKIPSTART]`，只给表达式 / 实参关键字（`ELSE` / `PRINTFORM`）', () => {
    const mid = provide(provider, MID, 5);
    const midLabels = labels(mid);
    expect(midLabels).not.toContain('#DIM');
    expect(midLabels).not.toContain('[SKIPSTART]');
    expect(mid.find((i) => labelText(i.label) === 'ELSE')!.detail).toBe('关键字');
    expect(midLabels).toContain('PRINTFORM'); // PRINT* 家族从 ERB_DIRECTIVES 派生
    expect(midLabels).toContain('CALL');
  });
});

describe('EC-1 · tables 缺席（fail-visible，不崩不猜）', () => {
  it('空 tables：语言层候选照常出货，依赖 adapter 表的 EC-2/EC-3 零候选', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({}));
    const provider = registered[0]!.provider;
    expect(() => provide(provider, HEAD, 3)).not.toThrow();
    const items = provide(provider, HEAD, 3);
    expect(items.length).toBeGreaterThan(0);
    // 语言层（静态词表 + EC-5 单一真源系统函数表 + R4 行首骨架）不受 adapter 表缺席影响
    const details = new Set(items.map((i) => i.detail));
    for (const d of details) {
      expect(
        ['指令', '预处理指令', '指令行', '关键字', '系统函数'].includes(d as string) || /骨架|分支|循环|分派/.test(d as string),
      ).toBe(true);
    }
    // 依赖 adapter 表 / 项目索引的两路：表缺席 ⇒ 零候选（不猜）
    const vars = provide(provider, 'CFLAG:', 7);
    expect(vars.some((i) => i.kind === monaco.languages.CompletionItemKind.Variable)).toBe(false);
    const fns = provide(provider, 'CALL M_KOJO', 11);
    expect(fns.some((i) => labelText(i.label) === 'M_KOJO_A')).toBe(false);
  });
});

describe('EC-2..EC-5 · 四个 source 经 provider 端到端出货（装配接线验证）', () => {
  const { monaco, registered } = stubMonaco();
  installErbCompletion(monaco, () => ({ variableSchema: fakeSchema(), erbFunctionNames: () => PROJECT_FNS }));
  const provider = registered[0]!.provider;

  it('EC-2：`CFLAG:` 二段式弹名字表（kind=Variable，detail=族:编号）', () => {
    const hit = provide(provider, 'CFLAG:', 7).find((i) => labelText(i.label) === '好感度');
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe(monaco.languages.CompletionItemKind.Variable);
    expect(hit!.detail).toBe('CFLAG:1088');
    expect(hit!.documentation).toBe('角色好感度');
  });

  it('EC-2：`CFLAG:TARGET:` 三段式弹名字（kind=Field，替换范围只覆盖末段）', () => {
    const hit = provide(provider, 'CFLAG:TARGET:', 14).find((i) => labelText(i.label) === '好感度');
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe(monaco.languages.CompletionItemKind.Field);
    expect(hit!.range).toMatchObject({ startColumn: 14, endColumn: 14 });
  });

  it('EC-3：`CALL M_K` 调用位弹项目函数名（kind=Function，不额外插 `@`）', () => {
    const hit = provide(provider, 'CALL M_KOJO', 11).find((i) => labelText(i.label) === 'M_KOJO_A');
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe(monaco.languages.CompletionItemKind.Function);
    expect(hit!.insertText).toBe('M_KOJO_A');
  });

  it('EC-3：`@` 定义位弹项目函数名（行首定义形态）', () => {
    const hit = provide(provider, '@M_KOJO', 8).find((i) => labelText(i.label) === 'M_KOJO_A');
    expect(hit).toBeDefined();
    expect(hit!.insertText).toBe('M_KOJO_A');
  });

  it('EC-4：`GOTO $TA` 弹本文件标签（kind=Reference，不重复补 `$`）', () => {
    const hit = provide(provider, '@F\n$TARGET_ONE\n\tGOTO $TA', 10, 3).find(
      (i) => labelText(i.label) === 'TARGET_ONE',
    );
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe(monaco.languages.CompletionItemKind.Reference);
    expect(hit!.insertText).toBe('TARGET_ONE');
    expect(hit!.detail).toBe('标签（本文件）');
  });

  it('EC-5：行中表达式位弹系统函数英文名（insertText 带 `(`，中文名进 documentation）', () => {
    const hit = provide(provider, 'IF A', 5).find((i) => labelText(i.label) === 'GETBIT');
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe(monaco.languages.CompletionItemKind.Function);
    expect(hit!.insertText).toBe('GETBIT(');
    expect(hit!.detail).toBe('系统函数');
  });
});

describe('EC-1 · memoizedErbFunctionNames（按指纹失效）', () => {
  it('指纹不变 ⇒ 复用上次排好序的同一数组；名字已排序', () => {
    const fn = memoizedErbFunctionNames(() => fakeIndex('fp1', ['B', 'A', 'C']));
    const a = fn();
    expect(a).toEqual(['A', 'B', 'C']);
    expect(fn()).toBe(a); // 同一引用：未重排
  });

  it('指纹变化 ⇒ 重算（新内容）', () => {
    let idx = fakeIndex('fp1', ['A']);
    const fn = memoizedErbFunctionNames(() => idx);
    const a = fn();
    idx = fakeIndex('fp2', ['A', 'D']);
    const b = fn();
    expect(b).toEqual(['A', 'D']);
    expect(b).not.toBe(a);
  });

  it('指纹 null（保守失效）⇒ 每次重算（不复用）', () => {
    const fn = memoizedErbFunctionNames(() => fakeIndex(null, ['A']));
    expect(fn()).not.toBe(fn());
  });

  it('索引缺席 / getIndex 抛错 ⇒ 空数组（不崩，不猜）', () => {
    expect(memoizedErbFunctionNames(() => null)()).toEqual([]);
    expect(memoizedErbFunctionNames(() => undefined)()).toEqual([]);
    expect(
      memoizedErbFunctionNames(() => {
        throw new Error('parser absent');
      })(),
    ).toEqual([]);
  });

  it('展示名取定义处原拼写（byName 键是归一化大写），排序仍按归一化键', () => {
    // 键：FOO / M_KOJO_A；展示：foo / M_Kojo_A
    const fn = memoizedErbFunctionNames(() => fakeIndex('fp1', ['M_Kojo_A', 'foo']));
    expect(fn()).toEqual(['foo', 'M_Kojo_A']);
  });

  it('定义列表为空 ⇒ 回退归一化键（不产出空串，不崩）', () => {
    const byName = new Map<string, ErbFunctionRef[]>([['EMPTY', []]]);
    const index = { files: new Map(), byName, fingerprint: 'fp1' } as unknown as ErbIndex;
    expect(memoizedErbFunctionNames(() => index)()).toEqual(['EMPTY']);
  });
});

/* ============================== SH-4 · 失效与不静默（三态可复跑） ============================== */

/**
 * 在同一**已装配句柄**上连续跑三态（满分 → 缺表 → 切表 → 再缺），断言：
 * - 态 A 满表：`erb-variables` / `erb-functions` 各路出货，零降级；
 * - 态 B 缺表（`tables = {}`）：该路**零候选** + 降级信号可见；
 * - 态 C 切表：候选**随新表变化**（证明现取、无缓存旧表）；再切空 ⇒ 零候选；
 *   去重语义 = **一轮装配**内同一 `(来源, 缺键)` 只报一次 ⇒ 单轮不重复刷屏，
 *   跨轮**每轮各报一次**（句柄级去重会让首轮之后这条降级永久无声）。
 */
function threeStatesErb(
  provider: Monaco.languages.CompletionItemProvider,
  setTables: (t: ErbCompletionTables) => void,
  degrades: ErbCompletionDegrade[],
): void {
  const has = (text: string, col: number, label: string): boolean =>
    provide(provider, text, col).some((i) => labelText(i.label) === label);
  const countOf = (id: string, key: string): number =>
    degrades.filter((d) => d.sourceId === id && d.missing === key).length;

  // 态 A：满表 ⇒ 变量 / 函数名各路出货，零降级信号
  setTables({
    variableSchema: fakeSchema(),
    erbFunctionNames: () => PROJECT_FNS,
  });
  expect(has('CFLAG:', 7, '好感度')).toBe(true);
  expect(has('CALL M_KOJO', 11, 'M_KOJO_A')).toBe(true);
  expect(degrades).toEqual([]);

  // 态 B：缺表 ⇒ 该路零候选 + 信号可见（单轮内不重复，跨轮每轮各一次）
  setTables({});
  expect(has('CFLAG:', 7, '好感度')).toBe(false);
  expect(has('CALL M_KOJO', 11, 'M_KOJO_A')).toBe(false);
  // ↑ 两轮 provide ⇒ 同一 (来源, 缺键) 各报两次（单轮内仍只报一次）
  expect(countOf('erb-variables', 'variableSchema')).toBe(2);
  expect(countOf('erb-functions', 'erbFunctionNames')).toBe(2);
  provide(provider, 'CFLAG:', 7);
  provide(provider, 'CALL M_KOJO', 11);
  expect(countOf('erb-variables', 'variableSchema')).toBe(4);
  expect(countOf('erb-functions', 'erbFunctionNames')).toBe(4);

  // 态 C：切表 ⇒ 候选随新表变化（无缓存旧表）
  setTables({ variableSchema: fakeSchemaY(), erbFunctionNames: () => PROJECT_FNS });
  expect(has('CFLAG:', 7, '恶意')).toBe(true);
  expect(has('CFLAG:', 7, '好感度')).toBe(false);
  setTables({ variableSchema: fakeSchema(), erbFunctionNames: () => PROJECT_FNS });
  expect(has('CFLAG:', 7, '好感度')).toBe(true);
  expect(has('CFLAG:', 7, '恶意')).toBe(false);
  // 再切空 ⇒ 零候选；单轮内只报一次 ⇒ 这一轮计数 +1（不是不增）
  setTables({});
  expect(has('CFLAG:', 7, '好感度')).toBe(false);
  expect(countOf('erb-variables', 'variableSchema')).toBe(5);
}

describe('SH-4 · 依赖表 / 提供者缺席 = 降级不静默（三态可复跑）', () => {
  it('同一装配句柄内连续跑：满分 → 缺表 → 切表 → 再缺', () => {
    let tables: ErbCompletionTables = {};
    const degrades: ErbCompletionDegrade[] = [];
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => tables, (d) => degrades.push(d));
    threeStatesErb(registered[0]!.provider, (t) => (tables = t), degrades);
  });

  it('重新 install 一遍 → 同一结论（去重表随装配句柄创建，无跨 install 泄漏也不吞信号）', () => {
    let tables: ErbCompletionTables = {};
    const degrades: ErbCompletionDegrade[] = [];
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => tables, (d) => degrades.push(d));
    threeStatesErb(registered[0]!.provider, (t) => (tables = t), degrades);
  });

  it('erbFunctionNames 求值抛错 ⇒ 该路零候选 + 每轮各报一次降级（抛错即视为缺）', () => {
    const degrades: ErbCompletionDegrade[] = [];
    const { monaco, registered } = stubMonaco();
    installErbCompletion(
      monaco,
      () => ({
        variableSchema: fakeSchema(),
        erbFunctionNames: () => {
          throw new Error('parser absent');
        },
      }),
      (d) => degrades.push(d),
    );
    const provider = registered[0]!.provider;
    expect(provide(provider, 'CALL M_KOJO', 11).some((i) => labelText(i.label) === 'M_KOJO_A')).toBe(false);
    expect(degrades.filter((d) => d.sourceId === 'erb-functions' && d.missing === 'erbFunctionNames')).toHaveLength(1);
    provide(provider, 'CALL M_KOJO', 11);
    expect(degrades.filter((d) => d.sourceId === 'erb-functions' && d.missing === 'erbFunctionNames')).toHaveLength(2);
  });

  it('requires 声明在册：erb-variables→variableSchema、erb-functions→erbFunctionNames（additive 可选字段）', () => {
    const byId = new Map(ERB_COMPLETION_SOURCES.map((s) => [s.id, s.requires]));
    expect(byId.get('erb-variables')).toBe('variableSchema');
    expect(byId.get('erb-functions')).toBe('erbFunctionNames');
    expect(byId.get('erb-directives')).toBeUndefined();
    expect(byId.get('erb-labels')).toBeUndefined();
    expect(byId.get('erb-system-functions')).toBeUndefined();
    // 两名位新源刻意无 requires：erbFileFacts 缺席是"宿主未注入通道"的正常态，零候选即正确语义
    expect(byId.get('erb-families')).toBeUndefined();
    expect(byId.get('erb-declared')).toBeUndefined();
    // 成员源同样无 requires：名录缺席时族头候选照常出货（只有成员位退化为零候选）
    expect(byId.get('erb-members')).toBeUndefined();
  });
});

/* ============================== 装配收口（门白名单终态 / 行中跳转词 / adapter 指令词 / 两个新源） ============================== */

/** 位表桩：裸族头 `HOLD` 有位表（`8 处女`）——`fakeSchema`（lookup 恒 undefined）即"无位表"负例 */
function fakeBitsSchema(): VariableSchema {
  return {
    version: 'bits',
    lookup: (name: string, index?: string) =>
      name === 'HOLD' && index === undefined ? { bits: [{ bit: 8, label: '处女' }] } : undefined,
    names: () => [],
  } as unknown as VariableSchema;
}

/** 事实通道桩：只有 `path` 这个文件已索引（其余路径 `undefined` = 未索引，零候选不回退） */
function fakeFacts(dims: readonly string[] | undefined, path: string): ErbFileFactsProvider {
  return {
    dimsOf: (p: string) => (p === path ? dims : undefined),
    labelsAt: () => undefined,
  };
}

/** 带 `uri` 的 model（`erbFactsPathOf` 的取路径面；其余口径同 `modelOf`） */
function modelOfPath(text: string, fsPath: string): Monaco.editor.ITextModel {
  return { ...(modelOf(text) as unknown as Record<string, unknown>), uri: { fsPath } } as unknown as Monaco.editor.ITextModel;
}

/** 走 provider 取一轮候选（指定 model；与 `provide` 同口径；`lineNumber` 缺省 = 第 1 行） */
function provideOn(
  provider: Monaco.languages.CompletionItemProvider,
  model: Monaco.editor.ITextModel,
  column: number,
  lineNumber = 1,
): Monaco.languages.CompletionItem[] {
  const out = provider.provideCompletionItems(
    model,
    { lineNumber, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions;
}

describe('装配收口 · 门白名单终态（名字位只出本路候选）', () => {
  const FNS: readonly string[] = ['GET_ITEM', 'OTHER_FN'];

  it('`CALL GET|` / `CALL |`：只出 erb-functions（系统函数 `GETBIT` / `RAND` 被门滤掉）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({ erbFunctionNames: () => FNS }));
    const provider = registered[0]!.provider;
    const get = provide(provider, 'CALL GET', 9);
    expect(get.map((i) => labelText(i.label))).toEqual(['GET_ITEM']);
    expect(get[0]!.kind).toBe(monaco.languages.CompletionItemKind.Function);
    const all = provide(provider, 'CALL ', 6);
    expect(all.map((i) => labelText(i.label)).sort()).toEqual([...FNS].sort());
    expect(all.some((i) => ['GETBIT', 'RAND'].includes(labelText(i.label)))).toBe(false);
  });

  it('`@foo|`：只出 erb-functions（行中关键字 / 系统函数不得混入）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({ erbFunctionNames: () => FNS }));
    expect(provide(registered[0]!.provider, '@GET', 5).map((i) => labelText(i.label))).toEqual(['GET_ITEM']);
  });

  it('`JUMP |` / `GOTO $LO|`：只出 Reference 标签（函数名 / 系统函数 / 关键字全被门滤掉）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({ erbFunctionNames: () => FNS }));
    const provider = registered[0]!.provider;
    const jump = provide(provider, 'JUMP \n$LOOP_TOP\n\tGOTO $LO', 6, 1);
    expect(jump.map((i) => labelText(i.label))).toEqual(['LOOP_TOP']);
    for (const item of jump) expect(item.kind).toBe(monaco.languages.CompletionItemKind.Reference);
    const goto = provide(provider, 'JUMP \n$LOOP_TOP\n\tGOTO $LO', 10, 3);
    expect(goto.map((i) => labelText(i.label))).toEqual(['LOOP_TOP']);
  });

  it('`#DI|` / `[SKIP|`：只出指令类候选（`GETBIT` 不在 `#` / `[` 记号位出现）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({}));
    const provider = registered[0]!.provider;
    const hash = provide(provider, '#DI', 4);
    expect(hash.map((i) => labelText(i.label))).toContain('#DIM');
    expect(hash.some((i) => labelText(i.label) === 'GETBIT')).toBe(false);
    expect(hash.every((i) => i.kind === monaco.languages.CompletionItemKind.Keyword)).toBe(true);
    expect(hash.every((i) => i.detail === '预处理指令')).toBe(true);
    const bracket = provide(provider, '[SKIP', 6);
    expect(bracket.map((i) => labelText(i.label))).toContain('[SKIPSTART]');
    expect(bracket.every((i) => i.detail === '指令行')).toBe(true);
    expect(bracket.some((i) => labelText(i.label) === 'GETBIT')).toBe(false);
  });

  it('`CFLAG:TARGET:好|`：只出 erb-variables（kind Field，其余源全被门滤掉）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({ variableSchema: fakeSchema() }));
    const items = provide(registered[0]!.provider, 'CFLAG:TARGET:好', 15);
    expect(items.map((i) => labelText(i.label))).toEqual(['好感度']);
    expect(items[0]!.kind).toBe(monaco.languages.CompletionItemKind.Field);
  });

  it('`GETBIT(HOLD, |)`：带位表 ⇒ 只出 erb-bits；无位表 ⇒ 该位零候选', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({ variableSchema: fakeBitsSchema() }));
    // 光标在第二实参坑内（`'GETBIT(HOLD, )'` 列 13 = 逗号后空白之后、`(` 之前）
    const items = provide(registered[0]!.provider, 'GETBIT(HOLD, )', 13);
    expect(items.map((i) => labelText(i.label))).toEqual(['8 处女']);
    expect(items[0]!.kind).toBe(monaco.languages.CompletionItemKind.EnumMember);
    expect(items[0]!.insertText).toBe('8');

    const { monaco: m2, registered: r2 } = stubMonaco();
    installErbCompletion(m2, () => ({ variableSchema: fakeSchema() }));
    expect(provide(r2[0]!.provider, 'GETBIT(HOLD, )', 13)).toEqual([]);
  });

  it('行中 `SIF X : G|`：行中关键字含 `GOTO` / `TRYGOTO`（跳转词从 ERB_JUMP_KEYWORDS 单源展开的净效果）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({}));
    const labels = provide(registered[0]!.provider, 'SIF X : G', 10).map((i) => labelText(i.label));
    expect(labels).toContain('GOTO');
    expect(labels).toContain('TRYGOTO');
  });

  it('行中 `PRINTFORML CF|`：erb-families 出 `CFLAG`（族头源接入装配）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({}));
    const hit = provide(registered[0]!.provider, 'PRINTFORML CF', 14).find((i) => labelText(i.label) === 'CFLAG');
    expect(hit).toBeDefined();
    expect(hit!.detail).toBe('引擎族头');
    expect(hit!.kind).toBe(monaco.languages.CompletionItemKind.Variable);
  });

  it('行首桩 instructionTable.names() 增词：候选出现该词（detail=指令）；大小写异写不产重复项', () => {
    const { monaco, registered } = stubMonaco();
    const instructionTable = { names: () => ['自定指令甲', 'printform'] } as unknown as KojoInstructionTable;
    installErbCompletion(monaco, () => ({ instructionTable }));
    const items = provide(registered[0]!.provider, '', 1);
    const hit = items.find((i) => labelText(i.label) === '自定指令甲');
    expect(hit).toBeDefined();
    expect(hit!.detail).toBe('指令');
    expect(items.filter((i) => labelText(i.label).toUpperCase() === 'PRINTFORM')).toHaveLength(1);
  });

  it('adapter 指令表缺席 / `names` 抛错：只用静态表，seam 不崩', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({
      instructionTable: {
        names: () => {
          throw new Error('instruction table absent');
        },
      } as unknown as KojoInstructionTable,
    }));
    expect(provide(registered[0]!.provider, '#DI', 4).map((i) => labelText(i.label))).toContain('#DIM');
  });
});

describe('装配收口 · erb-declared（`#DIM` 声明名，解析器事实通道）', () => {
  const PATH = 'C:/proj/x.ERB';

  it('桩 facts 出 `#DIM` 名：行中 `IF CNT|` 弹声明名（前缀命中档置顶，detail 中文、kind Variable）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({ erbFileFacts: fakeFacts(['CNT_A', 'CNT_B'], PATH) }));
    const items = provideOn(registered[0]!.provider, modelOfPath('IF CNT', PATH), 7);
    expect(items.slice(0, 2).map((i) => labelText(i.label))).toEqual(['CNT_A', 'CNT_B']);
    const hit = items.find((i) => labelText(i.label) === 'CNT_A')!;
    expect(hit.detail).toBe('#DIM 声明（本文件）');
    expect(hit.kind).toBe(monaco.languages.CompletionItemKind.Variable);
  });

  it('未索引（dimsOf → undefined）⇒ 回退缓冲区声明名；缓冲区也没有 ⇒ 零候选（不猜）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({ erbFileFacts: fakeFacts(['CNT_A'], PATH) }));
    const provider = registered[0]!.provider;
    // 缓冲区里没有 `#DIM` 声明 ⇒ 回退也拿不出名字（回退 ≠ 猜）
    const other = provideOn(provider, modelOfPath('IF CNT', 'C:/proj/other.ERB'), 7);
    expect(other.some((i) => labelText(i.label) === 'CNT_A')).toBe(false);
    // 同一条未索引路径，缓冲区里声明过 ⇒ 声明名出货（G 批补的缺腿：索引此刻对这个文件没有意见）
    const dirty = provideOn(provider, modelOfPath('#DIM CNT_B\nIF CNT', 'C:/proj/other.ERB'), 7, 2);
    expect(labelText(dirty[0]!.label)).toBe('CNT_B');
    expect(dirty[0]!.detail).toBe('#DIM 声明（本文件）');
    // `'IF CNT_A'` 列 9 = 名尾之后（前缀 `CNT_A` 精确命中 ⇒ 排名档 0 置顶）
    expect(labelText(provideOn(provider, modelOfPath('IF CNT_A', PATH), 9)[0]!.label)).toBe('CNT_A');
  });

  it('索引有意见时**不与缓冲区合并**：`[]`（已索引确无）不回退、数组以索引为准', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({ erbFileFacts: fakeFacts([], PATH) }));
    const empty = provideOn(registered[0]!.provider, modelOfPath('#DIM CNT_A\nIF CNT', PATH), 7, 2);
    // 索引答 `[]` = "这文件确实没声明" ⇒ 一条声明名候选都不出（回退会拿出与索引不一致的第二份事实）
    expect(empty.every((i) => i.detail !== '#DIM 声明（本文件）')).toBe(true);
    const { monaco: m2, registered: r2 } = stubMonaco();
    installErbCompletion(m2, () => ({ erbFileFacts: fakeFacts(['IDX_ONLY'], PATH) }));
    const both = provideOn(r2[0]!.provider, modelOfPath('#DIM BUF_ONLY\nIF IDX', PATH), 8, 2);
    expect(both.some((i) => labelText(i.label) === 'IDX_ONLY')).toBe(true);
    expect(both.some((i) => labelText(i.label) === 'BUF_ONLY')).toBe(false); // 缓冲区名不并入
  });

  it('通道缺席（宿主未注入 erbFileFacts）⇒ 缓冲区就是唯一在手事实，声明名照出', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({}));
    const items = provideOn(registered[0]!.provider, modelOfPath('#DIM LOCAL_CNT\nIF LOCAL', ''), 10, 2);
    expect(labelText(items[0]!.label)).toBe('LOCAL_CNT');
  });

  it('缓冲区声明名扫描（纯函数）：修饰形 / 数组后缀 / `[SKIPSTART]` 区间 / 注释行 / 大小写去重', () => {
    expect(
      dimNamesOfBuffer(
        [
          '#DIM CONST 常量名',
          '#DIM 数组名[10]',
          '#DIMS 串名',
          '[SKIPSTART]',
          '#DIM 跳过名',
          '[SKIPEND]',
          '#DIM 混ABC',
          ';#DIM 注释名',
          'IF 常量名',
        ].join('\n'),
      ),
    ).toEqual(['常量名', '数组名', '串名', '混ABC']);
    // 大小写异写只留首个原形（与候选侧的去重同一口径；ERB 方言大小写不敏感）
    expect(dimNamesOfBuffer('#DIM flag_a\n#DIM FLAG_A\n#dim FLAG_b')).toEqual(['flag_a', 'FLAG_b']);
    // 桩 model / 无 getValue ⇒ 回退路自然落空，不抛
    expect(erbDimNamesOf({} as Monaco.editor.ITextModel, undefined)).toEqual([]);
  });

  it('erbFactsPathOf：fsPath 回落 path 回落空串（桩 model 防御）', () => {
    expect(erbFactsPathOf({} as Monaco.editor.ITextModel)).toBe('');
    expect(erbFactsPathOf({ uri: { fsPath: 'C:/a.ERB' } } as unknown as Monaco.editor.ITextModel)).toBe('C:/a.ERB');
    expect(erbFactsPathOf({ uri: { path: '/p/b' } } as unknown as Monaco.editor.ITextModel)).toBe('/p/b');
    expect(erbFactsPathOf({ uri: { fsPath: '', path: '/p/c' } } as unknown as Monaco.editor.ITextModel)).toBe('/p/c');
  });
});
