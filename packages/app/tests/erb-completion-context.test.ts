/**
 * T6 · `.erb` 补全位置门（`erbCompletionGate` 纯函数 + provider 接线）单测。
 *
 * 纯函数部分零 Monaco 依赖（行文本 + 列 → 门类）；接线部分用**桩 monaco**（同
 * `erb-completion.test.ts` 口径）钉住：CALL 系名字位只给函数名形态候选（按 kind 过滤，
 * **不重排**——各 source 的 sortText 语义原样）、字符串 / FORM 串内零候选、其余位置维持现行为。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import {
  ERB_CALL_SLOT_BY_KEYWORD,
  ERB_CALL_STATEMENTS,
  erbCallKeywords,
  erbCompletionGate,
} from '../src/monaco/erb-completion-context';
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

/* ============================== 缺陷 1 · 代码视野扫描（串内 / `;` 注释按状态推进） ============================== */

describe('缺陷 1 · 代码视野扫描（一次线性扫描按状态推进，不是先数引号再看分号）', () => {
  /** 用 `|` 标记光标处（1 基列 = 标记前的字符数 + 1） */
  const gate = (marked: string) => erbCompletionGate(marked.replace('|', ''), marked.indexOf('|') + 1);

  it('`;` 行注释里的孤立半角引号不再吃掉**同行代码位**（旧口径一票否决整轮）', () => {
    expect(gate('CALL M_K| ; 注："未闭合')).toBe('call-target');
    expect(gate('IF A| ; 注："未闭合')).toBe('default');
    expect(gate('CALL M_K| ; PRINT "a;b"')).toBe('call-target');
  });

  it('注释态本身 = 不给代码补全（复用 `in-string` 门态，不新增第四态）；无论注释里引号配平与否', () => {
    expect(gate('; 注："未闭合|')).toBe('in-string');
    expect(gate('; 引号倒是配平了""|')).toBe('in-string'); // 旧口径：偶数引号 ⇒ 误判成代码位、照样弹
    expect(gate('PRINTL 台词 ; 尾注：引号"没配对|')).toBe('in-string');
  });

  it('注释起点之前的一切照旧：`;` 只在普通态才算注释（串内的 `;` 只是一个字符）', () => {
    expect(gate('CALL FOO |;')).toBe('call-target'); // 光标还在代码位，`;` 在其后
    expect(gate('PRINT "a;b" |')).toBe('default'); // 串里的 `;` 不开注释（"先看分号"会误判 in-string）
    expect(gate('PRINT "a;b|')).toBe('in-string'); // 未闭合：到行尾都是串
  });

  it('Emuera `""` 转义 = 一个字面引号，消费两字符且不改串内/串外状态', () => {
    // 光标停在成对引号**中间**：旧口径数出偶数 ⇒ 误判「串外」并弹出代码补全
    expect(erbCompletionGate('PRINT "a""b"', 10)).toBe('in-string');
    expect(erbCompletionGate('PRINT "a""b"', 13)).toBe('default'); // 串已闭合，光标在串尾之后
    expect(gate('PRINT ""|')).toBe('default'); // 空串闭合 = 代码位
    expect(gate('PRINT "" |')).toBe('default');
  });

  it('Emuera `""` 转义（FORM 串形态）：串内仍 in-string、闭合引号之后 default', () => {
    expect(gate('PRINTFORMW "含"|""转义"的文字')).toBe('in-string');
    expect(gate('PRINTFORMW "含""转义|"的文字')).toBe('in-string');
    expect(gate('PRINTFORMW "含""转义"|的文字')).toBe('default'); // 第三个引号是闭合引号
  });
});

/* ============================== 缺陷 2 · 门与候选源共用同一张语句表 ============================== */

describe('缺陷 2 · 调用位单源（ERB_CALL_STATEMENTS 一张表；门只放行 `func` 槽）', () => {
  /** 用 `|` 标记光标处（1 基列 = 标记前的字符数 + 1） */
  const gate = (marked: string) => erbCompletionGate(marked.replace('|', ''), marked.indexOf('|') + 1);

  it('`TRYCALL` 是直系调用 ⇒ 进门（旧口径门给 default、源出函数名 ⇒ 整张关键字表混进来）', () => {
    expect(gate('TRYCALL |')).toBe('call-target');
    expect(gate('TRYCALL M_KOJ|')).toBe('call-target');
    expect(gate('  TRYCALL M_KOJO, |')).toBe('default'); // 顶层逗号规则同样适用
    expect(gate('　TRYCALL M_K|')).toBe('call-target'); // 全角缩进走 BLANK_CLASS_STR 单源
  });

  it('`*FORM*` 全族与 `JUMP` 系**不进门**（参数是表达式 / 标签，不是函数名槽）', () => {
    expect(gate('TRYCALLFORM |')).toBe('default');
    expect(gate('TRYCALLFORMF |')).toBe('default');
    expect(gate('TRYCCALLFORM |')).toBe('default');
    expect(gate('TRYJUMP |')).toBe('default');
  });

  it('清单本身：`func` 槽集合 + 关键字→槽种类查得到（候选源复用同一份，不留第二张表）', () => {
    expect(erbCallKeywords(['func'])).toEqual(['TRYCALL', 'CALLF', 'CALLL', 'CALL']);
    expect(ERB_CALL_STATEMENTS.every((s) => ERB_CALL_SLOT_BY_KEYWORD.get(s.kw) === s.slot)).toBe(true);
    for (const s of ERB_CALL_STATEMENTS) {
      expect(gate(`${s.kw} |`)).toBe(s.slot === 'func' ? 'call-target' : 'default');
    }
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

  it('缺陷 2 端到端：`TRYCALL` 名字段同样只给函数名候选（门与源同一张表 ⇒ 关键字表不再混进来）', () => {
    const items = provide(provider, 'TRYCALL M_K', 11);
    expect(items.some((i) => labelText(i.label) === 'M_KOJO_A')).toBe(true);
    expect(items.some((i) => i.kind === kind.Keyword)).toBe(false);
    for (const item of items) expect([kind.Function, kind.Method]).toContain(item.kind);
  });

  it('缺陷 1 端到端：注释位零候选，同行（注释之前）的代码位照常进门', () => {
    expect(provide(provider, '; 注："未闭合', 10)).toEqual([]); // 旧口径：孤立引号把整轮杀掉，方向却对不上理由
    const items = provide(provider, 'CALL M_K ; 注："未闭合', 9);
    expect(items.some((i) => labelText(i.label) === 'M_KOJO_A')).toBe(true);
    expect(items.some((i) => i.kind === kind.Keyword)).toBe(false);
  });
});
