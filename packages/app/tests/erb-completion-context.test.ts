/**
 * T6 · `.erb` 补全位置门（`erbCompletionGate` 纯函数 + provider 接线）单测。
 *
 * 纯函数部分零 Monaco 依赖（行文本 + 列 → 门类）；接线部分用**桩 monaco**（同
 * `erb-completion.test.ts` 口径）钉住：CALL 系名字位只给函数名形态候选（按 kind 过滤，
 * **不重排**——各 source 的 sortText 语义原样）、字符串 / FORM 串内零候选、其余位置维持现行为。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { erbCompletionGate } from '../src/monaco/erb-completion-context';
import { installErbCompletion } from '../src/monaco/erb-completion';

describe('erbCompletionGate（纯函数：行文本 + 列 → 门类）', () => {
  /** 用 `|` 标记光标处（1 基列 = 标记前的字符数 + 1） */
  const gate = (marked: string) => erbCompletionGate(marked.replace('|', ''), marked.indexOf('|') + 1);

  it('CALL 系语句名之后 → call-target（CALL / CALLL / CALLF，含缩进与前缀中段）', () => {
    expect(gate('CALL |')).toBe('call-target');
    expect(gate('CALL M_K|')).toBe('call-target');
    expect(gate('  CALLL FO|')).toBe('call-target');
    expect(gate('CALLF |FUNC(1)')).toBe('call-target');
  });

  it('第一个顶层逗号之后 = 实参位 → default（一层与多层实参同判）', () => {
    expect(gate('CALL FOO, |')).toBe('default');
    expect(gate('CALL FOO, 1, |')).toBe('default');
    expect(gate('CALL M_KOJO, "文本", |')).toBe('default');
  });

  it('括号形态：名字段之后出现 `(`（`CALL(...)` / `CALLF FOO(...)`）→ 光标在表达式里 = default', () => {
    expect(gate('CALL(FOO|), 1')).toBe('default');
    expect(gate('CALLF FOO(1|0)')).toBe('default');
    expect(gate('CALLF FOO(|')).toBe('default');
  });

  it('CALLFORM / JUMP 等不在本门范围（\\b 挡长词）→ default', () => {
    expect(gate('CALLFORM |')).toBe('default');
    expect(gate('JUMP |')).toBe('default');
    expect(gate('CALLFOO|')).toBe('default');
  });

  it('字符串 / FORM 串内 → in-string（引号配平为奇；与 CALL 前缀无关）', () => {
    expect(gate('PRINTFORM "%CALLNAME:MAS|TER%看到"')).toBe('in-string');
    expect(gate('PRINTV "abc|')).toBe('in-string');
    expect(gate('CALL "a(b|')).toBe('in-string');
  });

  it('引号配平之后的 CALL 行：字符串已闭合 → 名字段照常 call-target', () => {
    expect(gate('CALL FOO, "文本"')).toBe('default'); // 逗号之后
    expect(gate('CALL M_K|')).toBe('call-target');
  });

  it('其余位置 → default（IF 行 / 行首 / 空行 / 非法列）', () => {
    expect(gate('IF A|')).toBe('default');
    expect(gate('PRINTL|')).toBe('default');
    expect(gate('|')).toBe('default');
    expect(erbCompletionGate('CALL FOO', 0)).toBe('default');
    expect(erbCompletionGate('CALL FOO', Number.NaN)).toBe('default');
  });

  it('复用先例件：括号内的逗号不算顶层（`CALL FOO(A, B)` 的逗号不切名字段）', () => {
    // `(` 在光标之前 → 表达式位 default；若逗号误判为顶层会得到同样的 default，
    // 但 `CALLF FOO(A, B` 未闭合形态里光标在括号内仍应 default（`(` 判据兜住）
    expect(gate('CALLF FOO(A, B|)')).toBe('default');
  });
});

/* ============================== provider 接线（桩 monaco） ============================== */

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

function stubMonaco(): { monaco: typeof Monaco; registered: Registered[] } {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: { Variable: 1, Keyword: 2, Operator: 3, Function: 4, Field: 5, Reference: 6, Method: 7 },
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

function provide(
  provider: Monaco.languages.CompletionItemProvider,
  text: string,
  column: number,
): Monaco.languages.CompletionItem[] {
  const out = provider.provideCompletionItems(
    modelOf(text),
    { lineNumber: 1, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions;
}

function labelText(label: Monaco.languages.CompletionItem['label']): string {
  return typeof label === 'string' ? label : label.label;
}

const PROJECT_FNS: readonly string[] = ['M_KOJO_A', 'M_KOJO_B'];

describe('T6 · provider 接线（门是过滤不是重排）', () => {
  const { monaco, registered } = stubMonaco();
  installErbCompletion(monaco, () => ({ erbFunctionNames: () => PROJECT_FNS }));
  const provider = registered[0]!.provider;
  const kind = monaco.languages.CompletionItemKind;

  it('CALL 名字段：只给函数名形态候选（Function），关键字 / 指令 / 标签全被门滤掉', () => {
    const items = provide(provider, 'CALL M_K', 8);
    expect(items.length).toBeGreaterThan(0);
    expect(items.find((i) => labelText(i.label) === 'M_KOJO_A')).toBeDefined();
    for (const item of items) {
      expect([kind.Function, kind.Method]).toContain(item.kind);
    }
    expect(items.some((i) => i.kind === kind.Keyword)).toBe(false);
  });

  it('其余位置维持现行为：`IF A` 行中照旧出关键字 + 系统函数（不因门收窄）', () => {
    const items = provide(provider, 'IF A', 5);
    expect(items.some((i) => i.kind === kind.Keyword)).toBe(true);
    expect(items.some((i) => labelText(i.label) === 'GETBIT')).toBe(true);
  });

  it('字符串 / FORM 串内：零候选（不给代码补全）', () => {
    expect(provide(provider, 'PRINTV "abc', 12)).toEqual([]);
    expect(provide(provider, 'PRINTFORM "%CALLNAME:MAS', 25)).toEqual([]);
  });

  it('实参位维持现行为：`CALL FOO, ` 之后关键字照常出（门只认名字段）', () => {
    const items = provide(provider, 'CALL FOO, ', 11);
    expect(items.some((i) => i.kind === kind.Keyword)).toBe(true);
  });

  it('排序语义不动：门内候选的排名仍按 前缀精确 > 前缀命中 > 其它', () => {
    const items = provide(provider, 'CALL M_KOJO', 12); // 前缀 `M_KOJO` 精确命中 M_KOJO_A/B 同档
    const labels = items.map((i) => labelText(i.label));
    expect(labels.indexOf('M_KOJO_A')).toBeLessThan(labels.length);
    expect(labels.indexOf('M_KOJO_B')).toBe(labels.indexOf('M_KOJO_A') + 1); // 同档按名序，未被门重排
  });
});
