/**
 * EC-1 · `.erb` 方言补全**装配 seam**（`installErbCompletion` + `ERB_COMPLETION_SOURCES`）单测。
 *
 * Monaco 绑定刻意薄：本文件用**桩 monaco**（只记录注册调用与 `CompletionItemKind`）喂 provider，
 * 不引入真实 monaco-editor 运行时；候选来自静态词表 source（纯数据），不依赖语料。
 * 覆盖：(a) provider 确为 **ERB 语言**注册（kojo 语言不得被本模块注册）、且只注册一个；
 * (b) `erb-directives` source 行首给 `#DIM` 之类、行中不给（判定经 `isLineHeadContext` 可单测）；
 * (c) 空 tables 不崩且无非表候选；`memoizedErbFunctionNames` 按指纹失效。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { ErbFunctionRef, ErbIndex, VariableSchema } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  ERB_COMPLETION_SOURCES,
  erbTokenRange,
  installErbCompletion,
  isLineHeadContext,
  memoizedErbFunctionNames,
} from '../src/monaco/erb-completion';

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

/** 桩 monaco：只实现补全注册链所需的最薄面 */
function stubMonaco(): { monaco: typeof Monaco; registered: Registered[] } {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: { Variable: 1, Keyword: 2, Operator: 3, Function: 4, Field: 5, Reference: 6 },
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

/** 项目函数名（同一数组引用：EC-3 前缀索引按数组身份记忆化） */
const PROJECT_FNS: readonly string[] = ['M_KOJO_A', 'M_KOJO_B'];

function fnRef(name: string): ErbFunctionRef {
  return { name, normalizedName: name, filePath: 'x.ERB', startLine: 1, endLine: 1 };
}

function fakeIndex(fingerprint: string | null, names: string[]): ErbIndex {
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const n of names) byName.set(n, [fnRef(n)]);
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

  it('扩展点稳定：ERB_COMPLETION_SOURCES 是可追加数组，EC-1..EC-5 五个 source 全在册', () => {
    expect(Array.isArray(ERB_COMPLETION_SOURCES)).toBe(true);
    expect(ERB_COMPLETION_SOURCES.map((s) => s.id)).toEqual([
      'erb-directives',
      'erb-variables',
      'erb-functions',
      'erb-labels',
      'erb-system-functions',
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
});

describe('EC-1 · erb-directives source 出货', () => {
  const { monaco, registered } = stubMonaco();
  installErbCompletion(monaco, () => ({}));
  const provider = registered[0]!.provider;
  const labels = (items: readonly Monaco.languages.CompletionItem[]): string[] => items.map((i) => labelText(i.label));

  it('行首：给 `#DIM`（预处理指令）、`[SKIPSTART]`（指令行）、`PRINTFORM` / `IF`（指令表）', () => {
    const items = provide(provider, HEAD, 3);
    expect(items.find((i) => labelText(i.label) === '#DIM')!.detail).toBe('预处理指令');
    expect(items.find((i) => labelText(i.label) === '[SKIPSTART]')!.detail).toBe('指令行');
    expect(items.find((i) => labelText(i.label) === 'PRINTFORM')!.detail).toBe('指令');
    expect(items.find((i) => labelText(i.label) === 'IF')!.detail).toBe('指令');
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
    // 语言层（静态词表 + EC-5 单一真源系统函数表）不受 adapter 表缺席影响
    const details = new Set(items.map((i) => i.detail));
    for (const d of details) {
      expect(['指令', '预处理指令', '指令行', '关键字', '系统函数']).toContain(d);
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
});
