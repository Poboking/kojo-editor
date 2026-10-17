/**
 * EC-3 · `.erb` 函数名补全（`erbFunctionCompletionItems`）单测。
 *
 * 合成名字表（无需语料）：覆盖定义位 / 调用位命中、非该位置与名字表缺省一律 `[]`（不抛）、
 * 前缀过滤（大小写不敏感）、排序（前缀精确优先）、替换范围只覆盖名字段、`detail` 带来源文件，
 * 以及 **10 万条合成名字的基准**（冷建索引 + 热调用各量一次，热调用断言上限）。
 *
 * 本批口径：跳转家族（`JUMP` / `GOTO` / `TRYJUMP` / `TRYGOTO`）的目标位是**标签位**——本源
 * 零候选（归 `erb-labels` + 门 `label-target`）；旧 pin「JUMP 位出函数名」有意变更。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { erbFunctionCompletionItems } from '../src/monaco/erb-completion-functions';
import { ERB_CALL_STATEMENTS, ERB_JUMP_KEYWORDS } from '../src/monaco/erb-completion-context';

/** 合成 Monaco：本纯函数只用到 CompletionItemKind.Function */
const monaco = { languages: { CompletionItemKind: { Function: 1 } } } as unknown as typeof Monaco;

const modelOf = (line: string) => ({ getLineContent: () => line }) as unknown as Monaco.editor.ITextModel;

type Names = readonly (string | { name: string; file?: string })[];

/** 用 `|` 标记光标（1 基列 = 标记前字符数 + 1）；无标记 = 光标在行尾。`undefined` = 名字表缺省 */
function at(marked: string, names: Names | undefined): Monaco.languages.CompletionItem[] {
  const marker = marked.indexOf('|');
  const line = marked.replace('|', '');
  const column = (marker >= 0 ? marker : line.length) + 1;
  return erbFunctionCompletionItems(
    monaco,
    modelOf(line),
    { lineNumber: 1, column } as Monaco.Position,
    names,
  );
}

const labels = (items: readonly Monaco.languages.CompletionItem[]): string[] =>
  items.map((i) => i.label as string);

/** 前缀命中 fixture：`M_KOJO_MESSAGE_` 下两条 */
const NAMES: Names = [
  'CALL_HELPER',
  'M_KOJO_MESSAGE_COM_K1_30',
  'M_KOJO_MESSAGE_SP',
  'M_KOJO_EVENT_K1',
  '潜伏モード終了処理',
];

describe('EC-3 函数名补全 · 定义位（行首 @<前缀>）', () => {
  it('`@M_KOJO_MESSAGE_` → 只留该前缀的函数名', () => {
    expect(labels(at('@M_KOJO_MESSAGE_', NAMES))).toEqual([
      'M_KOJO_MESSAGE_COM_K1_30',
      'M_KOJO_MESSAGE_SP',
    ]);
  });

  it('`insertText` = 名字（不再插 `@`）；`kind` = Function', () => {
    const items = at('@M_KOJO_EVENT', NAMES);
    expect(items).toHaveLength(1);
    expect(items[0]?.insertText).toBe('M_KOJO_EVENT_K1');
    expect(items[0]?.insertText).not.toContain('@');
    expect(items[0]?.kind).toBe(1);
  });

  it('替换范围只覆盖名字那一段（`@` 不动）', () => {
    const items = at('@M_KOJO_MESSAGE_', NAMES);
    for (const item of items) {
      expect(item.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 2, endColumn: 17 });
    }
  });

  it('光标在名字中间（`@M_KOJO_MESSAGE_CO|M_K1_30`）→ 替换整段名字', () => {
    const items = at('@M_KOJO_MESSAGE_CO|M_K1_30', NAMES);
    expect(items).toHaveLength(1);
    expect(items[0]?.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 2, endColumn: 26 });
  });

  it('日文全角名照样命中（`@潜伏`）', () => {
    expect(labels(at('@潜伏', NAMES))).toEqual(['潜伏モード終了処理']);
  });
});

describe('EC-3 函数名补全 · 调用位（CALL / FORM）', () => {
  it('`CALL <前缀>` → 命中；替换范围覆盖名字段', () => {
    const items = at('CALL M_KOJO_MESSAGE_', NAMES);
    expect(labels(items)).toEqual(['M_KOJO_MESSAGE_COM_K1_30', 'M_KOJO_MESSAGE_SP']);
    expect(items[0]?.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 6, endColumn: 21 });
  });

  it('`TRYCALLFORM` / `CALLFORM` 之后的命名槽同样弹候选', () => {
    expect(labels(at('TRYCALLFORM M_KOJO_EVENT', NAMES))).toEqual(['M_KOJO_EVENT_K1']);
    expect(labels(at('CALLFORM M_KOJO_MESSAGE_', NAMES))).toEqual([
      'M_KOJO_MESSAGE_COM_K1_30',
      'M_KOJO_MESSAGE_SP',
    ]);
  });

  it('`JUMP` / `GOTO` 家族位**不出**函数名（标签位归 `erb-labels` + 门 `label-target`）', () => {
    expect(at('JUMP CALL_', NAMES)).toEqual([]);
    expect(at('GOTO CALL_', NAMES)).toEqual([]);
    expect(at('TRYJUMP CALL_', NAMES)).toEqual([]);
    expect(at('TRYGOTO CALL_', NAMES)).toEqual([]);
  });

  it('FORM 关键字的名字槽可含 `%…%` 段：刚越过插值仍给候选（空前缀 = 全量）', () => {
    expect(labels(at('TRYCCALLFORM %X%|', NAMES))).toEqual(labels(at('@', NAMES)));
    expect(labels(at('@', NAMES))).toHaveLength(NAMES.length);
  });

  it('非 FORM 关键字的槽里混入 `%` → []（不猜）', () => {
    expect(at('CALL M_KO%JO', NAMES)).toEqual([]);
  });

  it('FORM 槽里光标严格停在未闭合插值内 → []（不猜）', () => {
    expect(at('TRYCALLFORM M_KOJO%X|%_M', NAMES)).toEqual([]);
  });

  it('调用位清单 = 位置门的**同一张表**：`func` / `form` 槽出货，`label` 槽归标签源（本源零候选）', () => {
    expect(ERB_CALL_STATEMENTS.length).toBeGreaterThan(0);
    for (const s of ERB_CALL_STATEMENTS) {
      const items = at(`${s.kw} M_KOJO_EVENT`, NAMES);
      if (s.slot === 'label') expect(items).toEqual([]);
      else expect(labels(items)).toEqual(['M_KOJO_EVENT_K1']);
    }
    // 标签家族与解析器实名对齐（JUMP_FAMILY）：清单 `label` 槽集合 = ERB_JUMP_KEYWORDS
    const labelKws = ERB_CALL_STATEMENTS.filter((s) => s.slot === 'label').map((s) => s.kw);
    expect([...labelKws].sort()).toEqual([...ERB_JUMP_KEYWORDS].sort());
  });

  it('空白类走 `BLANK_CLASS_STR` 单源：全角缩进 + 全角分隔的调用位照样认（旧 `[ \t]` 不认）', () => {
    expect(labels(at('\u3000CALL M_KOJO_EVENT', NAMES))).toEqual(['M_KOJO_EVENT_K1']);
    expect(labels(at('\u3000@M_KOJO_EVENT', NAMES))).toEqual(['M_KOJO_EVENT_K1']);
    expect(labels(at('CALL\u3000M_KOJO_EVENT', NAMES))).toEqual(['M_KOJO_EVENT_K1']);
  });
});

describe('EC-3 函数名补全 · 前缀过滤与排序', () => {
  it('前缀过滤**大小写不敏感**（Emuera 口径）', () => {
    expect(labels(at('@m_kojo_event', NAMES))).toEqual(['M_KOJO_EVENT_K1']);
  });

  it('排序受控：前缀精确优先，其次按名（归一化升序）', () => {
    const exact: Names = ['M_KOJO_MESSAGE', 'M_KOJO_MESSAGE_SP', 'M_KOJO_MESSAGE_COM'];
    const items = at('@M_KOJO_MESSAGE', exact);
    expect(labels(items)).toEqual(['M_KOJO_MESSAGE', 'M_KOJO_MESSAGE_COM', 'M_KOJO_MESSAGE_SP']);
    expect(items[0]?.sortText).toBe('0_M_KOJO_MESSAGE');
    expect(items[1]?.sortText).toBe('1_M_KOJO_MESSAGE_COM');
  });

  it('候选带 file 时 `detail` = 来源文件；裸名字无 detail', () => {
    const withFile: Names = [{ name: 'M_KOJO_MESSAGE_SP', file: 'C:/game/ERB/A.ERB' }];
    const items = at('@M_KOJO_MESSAGE_', withFile);
    expect(items[0]?.detail).toBe('C:/game/ERB/A.ERB');
    expect(at('@M_KOJO_MESSAGE_', NAMES)[0]?.detail).toBeUndefined();
  });
});

describe('EC-3 函数名补全 · fail-visible 负例（绝不猜、绝不抛）', () => {
  it('非定义 / 调用位 → []', () => {
    expect(at('PRINT M_KOJO', NAMES)).toEqual([]);
    expect(at('IF M_KOJO_MESSAGE', NAMES)).toEqual([]);
    expect(at('X = M_KOJO', NAMES)).toEqual([]);
    expect(at(';CALL M_KOJO', NAMES)).toEqual([]); // 注释行
  });

  it('`@` 之后非名字位置（进了实参）→ []', () => {
    expect(at('@M_KOJO_MESSAGE(ARGS', NAMES)).toEqual([]);
  });

  it('functionNames 缺省 / 空表 → [] 且不抛', () => {
    expect(at('@M_KOJO', undefined)).toEqual([]);
    expect(at('CALL M_KOJO', undefined)).toEqual([]);
    expect(at('@M_KOJO', [])).toEqual([]);
  });

  it('前缀无命中 → []', () => {
    expect(at('@ZZZ_', NAMES)).toEqual([]);
    expect(at('CALL ZZZ_', NAMES)).toEqual([]);
  });
});

describe('EC-3 函数名补全 · 10 万条基准', () => {
  it('合成 10 万条名字：热调用（前缀过滤）≤ 上限，且命中集有护栏上限', () => {
    const big: string[] = Array.from({ length: 100_000 }, (_, i) => `FUNC_${String(i).padStart(6, '0')}`);
    const line = '@FUNC_0999';
    const model = modelOf(line);
    const pos = { lineNumber: 1, column: line.length + 1 } as Monaco.Position;

    const t0 = performance.now();
    const cold = erbFunctionCompletionItems(monaco, model, pos, big);
    const t1 = performance.now();
    const warm = erbFunctionCompletionItems(monaco, model, pos, big);
    const t2 = performance.now();

    // 热调用**best-of-N 取 min**：min 是地板量——负载只会把单次读数抬高、抬不低，
    // 而单样本（原来那条 `t2 - t1`）在 CI 上就是抛硬币（红过一次 11.54 ms vs 预算 10 ms）。
    const RUNS = 5;
    let bestMs = Number.POSITIVE_INFINITY;
    for (let i = 0; i < RUNS; i++) {
      const a = performance.now();
      erbFunctionCompletionItems(monaco, model, pos, big);
      const d = performance.now() - a;
      if (d < bestMs) bestMs = d;
    }

    console.log(
      `[EC-3] 10 万条：冷启动(建索引+过滤) ${(t1 - t0).toFixed(1)} ms（仅展示，不参与判绿）；` +
        `热调用 best-of-${RUNS} min ${bestMs.toFixed(3)} ms（首轮单次读数 ${(t2 - t1).toFixed(3)} ms）；` +
        `命中 ${warm.length} 条`,
    );

    expect(cold).toEqual(warm);
    expect(warm).toHaveLength(100); // FUNC_099900..FUNC_099999
    expect(bestMs).toBeLessThan(10); // 纯过滤（二分 + 命中区间）远低于可感阈值

    // 极短前缀命中全表 → 护栏上限（原子表 1000 条），避免造 10 万个对象
    const broad = erbFunctionCompletionItems(monaco, modelOf('@FUNC_'), { lineNumber: 1, column: 7 } as Monaco.Position, big);
    expect(broad).toHaveLength(1000);
  });
});
