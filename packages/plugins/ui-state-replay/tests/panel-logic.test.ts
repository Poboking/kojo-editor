/**
 * 回放面板纯逻辑单测（v0.2 第八批；零 React）。
 *
 * 覆盖：调用上下文文本解析（数值槽 / 字符串槽 / 重复 / 非法语法 / 空输入），
 * ReplayCallContext 组装（空槽位表 → undefined），未知原因分组，函数名提示，
 * 以及假设值链路（v1.0 收口 C9：槽位来源三态 / 假设计数 / AST 槽位引用扫描）。
 */
import { describe, expect, it } from 'vitest';
import type { ConditionExpr, FunctionReplay } from '@kojo/plugin-api';
import {
  classifySlotValue,
  collectAssumedSlots,
  defaultSlotText,
  exprArgSlots,
  groupUnknowns,
  parseCallContextText,
  slotKey,
  suggestFunctions,
  summarizeAssumptions,
  toCallContext,
} from '../src/panel-logic';

describe('parseCallContextText', () => {
  it('数值槽（逗号/空格分隔；缺省槽位保持 undefined）', () => {
    const r = parseCallContextText('0=36, 1=15');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ints).toEqual([36, 15]);
      expect(r.strs).toEqual([]);
    }
  });

  it('乱序槽位 + 中间空洞补 undefined', () => {
    const r = parseCallContextText('2=7, 0=1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ints).toEqual([1, undefined, 7]);
  });

  it('带引号值 → ARGS 字符串槽', () => {
    const r = parseCallContextText('1="约会", 0=36');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ints).toEqual([36]);
      expect(r.strs).toEqual([undefined, '约会']);
    }
  });

  it('负数与中文逗号', () => {
    const r = parseCallContextText('0=-5，1=3');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ints).toEqual([-5, 3]);
  });

  it('空输入 → 空槽位表（= 未提供上下文）', () => {
    const r = parseCallContextText('  ');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ints).toEqual([]);
      expect(r.strs).toEqual([]);
      expect(toCallContext(r)).toBeUndefined();
    }
  });

  it('非法语法 / 非法槽位 / 非法值 / 重复槽位', () => {
    expect(parseCallContextText('36')).toMatchObject({ ok: false, error: 'bad-syntax' });
    expect(parseCallContextText('x=36')).toMatchObject({ ok: false, error: 'bad-syntax' });
    expect(parseCallContextText('1000=36')).toMatchObject({ ok: false, error: 'bad-slot' });
    expect(parseCallContextText('0=abc')).toMatchObject({ ok: false, error: 'bad-value' });
    expect(parseCallContextText('0=36, 0=15')).toMatchObject({ ok: false, error: 'dup-slot' });
    expect(parseCallContextText('1="a", 1="b"')).toMatchObject({ ok: false, error: 'dup-slot' });
  });
});

describe('toCallContext', () => {
  it('有值 → 对象；全 undefined → undefined', () => {
    expect(toCallContext({ ok: true, ints: [36], strs: [] })).toEqual({ ints: [36] });
    expect(toCallContext({ ok: true, ints: [], strs: ['x'] })).toEqual({ strs: ['x'] });
    expect(toCallContext({ ok: true, ints: [], strs: [] })).toBeUndefined();
    expect(toCallContext({ ok: true, ints: [undefined], strs: [] })).toBeUndefined();
  });
});

describe('groupUnknowns', () => {
  it('按数量降序分组；无未知 → 空数组', () => {
    const mk = (outcomes: ('true' | 'false' | 'unknown')[], codes: string[] = []): FunctionReplay =>
      ({
        normalizedName: 'F',
        filePath: 'a.erb',
        startLine: 1,
        stats: { total: outcomes.length, hit: 0, miss: 0, unknown: 0 },
        confidence: 'partial',
        predicates: outcomes.map((o, i) => ({
          kind: 'IF' as const,
          text: `p${i}`,
          line: i + 2,
          expr: { kind: 'opaque', text: 'x' },
          outcome:
            o === 'unknown'
              ? { kind: 'unknown', unknown: { code: codes[i] as never, message: '' } }
              : o === 'true'
                ? ({ kind: 'true' } as const)
                : ({ kind: 'false' } as const),
        })),
      }) as FunctionReplay;

    const g = groupUnknowns(mk(['unknown', 'true', 'unknown', 'unknown'], ['pseudo', '', 'call', 'pseudo']));
    expect(g).toEqual([
      { code: 'pseudo', count: 2 },
      { code: 'call', count: 1 },
    ]);
    expect(groupUnknowns(mk(['true', 'false']))).toEqual([]);
  });
});

describe('suggestFunctions', () => {
  const names = ['M_KOJO_ORTHODOX_EVENT_K49_1', 'M_KOJO_K49_事件', 'M_KOJO_K50_X', 'LOCAL_CHECK'];
  it('子串过滤（大小写不敏感）+ 上限', () => {
    expect(suggestFunctions(names, 'K49')).toEqual(['M_KOJO_ORTHODOX_EVENT_K49_1', 'M_KOJO_K49_事件']);
    expect(suggestFunctions(names, 'k49')).toEqual(['M_KOJO_ORTHODOX_EVENT_K49_1', 'M_KOJO_K49_事件']);
  });
  it('短查询 / 无匹配 → 空', () => {
    expect(suggestFunctions(names, 'K')).toEqual([]);
    expect(suggestFunctions(names, '')).toEqual([]);
    expect(suggestFunctions(names, 'ZZZZ')).toEqual([]);
  });
  it('limit 截断', () => {
    const many = Array.from({ length: 80 }, (_, i) => `FN_A_${i}`);
    expect(suggestFunctions(many, 'FN_A', 50)).toHaveLength(50);
  });
});

/* ------------------------- 假设值链路（v1.0 收口 C9） ------------------------- */

describe('slotKey / defaultSlotText / classifySlotValue', () => {
  it('slotKey 区分 int 与 str 同号槽（签名可同时含 ARG:0 与 ARGS:0）', () => {
    expect(slotKey('int', 0)).toBe('int:0');
    expect(slotKey('str', 0)).toBe('str:0');
    expect(slotKey('int', 0)).not.toBe(slotKey('str', 0));
  });

  it('默认场景预填值：int=0；str=空（未提供，非假设）', () => {
    expect(defaultSlotText('int')).toBe('0');
    expect(defaultSlotText('str')).toBe('');
  });

  it('来源三态：未手改的预填 0 = 假设；手输 = 确定；空 = 未提供', () => {
    expect(classifySlotValue('int', '0', false)).toBe('assumption');
    expect(classifySlotValue('int', ' 0 ', false)).toBe('assumption'); // 容忍空白
    expect(classifySlotValue('int', '0', true)).toBe('manual'); // 把预填 0 显式改写 → 确定值
    expect(classifySlotValue('int', '36', false)).toBe('manual');
    expect(classifySlotValue('int', '', false)).toBe('unset');
    expect(classifySlotValue('int', '   ', true)).toBe('unset'); // 清空 = 未提供（unknown 语义不变）
    expect(classifySlotValue('str', '', false)).toBe('unset'); // str 预填空不是假设
    expect(classifySlotValue('str', '约会', false)).toBe('manual');
  });
});

describe('collectAssumedSlots（全默认 / 全手输 / 混合）', () => {
  const slots = [
    { kind: 'int' as const, index: 0 },
    { kind: 'int' as const, index: 1 },
    { kind: 'str' as const, index: 0 },
  ];

  it('全默认（全部未手改）→ 全部 int 槽计入假设；str 预填空不算', () => {
    const texts = { 'int:0': '0', 'int:1': '0', 'str:0': '' };
    expect(collectAssumedSlots(slots, texts, {})).toEqual([
      { kind: 'int', index: 0 },
      { kind: 'int', index: 1 },
    ]);
  });

  it('全手输 → 无假设', () => {
    const texts = { 'int:0': '36', 'int:1': '15', 'str:0': '约会' };
    const edited = { 'int:0': true, 'int:1': true, 'str:0': true };
    expect(collectAssumedSlots(slots, texts, edited)).toEqual([]);
  });

  it('混合 → 只计未手改的预填 0', () => {
    const texts = { 'int:0': '36', 'int:1': '0', 'str:0': '' };
    const edited = { 'int:0': true };
    expect(collectAssumedSlots(slots, texts, edited)).toEqual([{ kind: 'int', index: 1 }]);
  });

  it('清空槽 = 未提供（不计假设）', () => {
    const texts = { 'int:0': '', 'int:1': '0', 'str:0': '' };
    expect(collectAssumedSlots(slots, texts, {})).toEqual([{ kind: 'int', index: 1 }]);
  });
});

describe('exprArgSlots（AST 槽位引用扫描）', () => {
  const ref = (name: string, indices: string[] = []): ConditionExpr => ({ kind: 'ref', name, indices, text: name });

  it('裸 ARG ≡ ARG:0；ARG:n / ARGS:n 归类', () => {
    const e: ConditionExpr = { kind: 'binary', op: '&&', left: ref('ARG'), right: ref('ARGS', ['2']) };
    expect(exprArgSlots(e)).toEqual({ ints: [0], strs: [2] });
  });

  it('递归进 call 参数 / 一元 / 三元', () => {
    const e: ConditionExpr = {
      kind: 'call',
      name: 'GETBIT',
      args: [
        { kind: 'binary', op: '+', left: ref('ARG', ['1']), right: { kind: 'literal', value: 1, text: '1' } },
        { kind: 'ternary', cond: ref('ARG', ['2']), then: ref('ARGS', ['0']), else: { kind: 'opaque', text: 'x' } },
      ],
    };
    expect(exprArgSlots(e)).toEqual({ ints: [1, 2], strs: [0] });
  });

  it('非 ARG 引用 / 动态索引 / opaque 不计（不猜）', () => {
    expect(exprArgSlots(ref('CFLAG', ['2']))).toEqual({ ints: [], strs: [] });
    expect(exprArgSlots(ref('ARG', ['ARG']))).toEqual({ ints: [], strs: [] });
    expect(exprArgSlots({ kind: 'opaque', text: 'ARG == 1' })).toEqual({ ints: [], strs: [] });
  });
});

describe('summarizeAssumptions（基于假设标注 + 假设计数）', () => {
  const mkReplay = (exprs: ConditionExpr[]): FunctionReplay =>
    ({
      normalizedName: 'F',
      filePath: 'a.erb',
      startLine: 1,
      branches: [],
      stats: { total: exprs.length, hit: 0, miss: 0, unknown: 0 },
      confidence: 'exact',
      predicates: exprs.map((expr, i) => ({
        kind: 'IF' as const,
        text: `p${i}`,
        line: i + 2,
        expr,
        outcome: { kind: 'true' } as const,
      })),
    }) as FunctionReplay;

  const arg0: ConditionExpr = { kind: 'ref', name: 'ARG', indices: [], text: 'ARG' };
  const cflag: ConditionExpr = { kind: 'ref', name: 'CFLAG', indices: ['2'], text: 'CFLAG:2' };

  it('无假设槽 → 全 false / 空 consumed', () => {
    const r = summarizeAssumptions(mkReplay([arg0]), []);
    expect(r.affected).toEqual([false]);
    expect(r.consumed).toEqual([]);
  });

  it('命中假设槽的谓词被标注 + 消费计数去重', () => {
    const r = summarizeAssumptions(mkReplay([arg0, cflag, arg0]), [{ kind: 'int', index: 0 }]);
    expect(r.affected).toEqual([true, false, true]);
    expect(r.consumed).toEqual([{ kind: 'int', index: 0 }]);
  });

  it('假设槽未被任何谓词读取 → consumed 为空（不影响可信度）', () => {
    const r = summarizeAssumptions(mkReplay([cflag]), [{ kind: 'int', index: 0 }]);
    expect(r.affected).toEqual([false]);
    expect(r.consumed).toEqual([]);
  });

  it('int / str 槽不串味（ARG:1 假设不命中 ARGS:1 引用）', () => {
    const args1: ConditionExpr = { kind: 'ref', name: 'ARGS', indices: ['1'], text: 'ARGS:1' };
    const r = summarizeAssumptions(mkReplay([args1]), [{ kind: 'int', index: 1 }]);
    expect(r.affected).toEqual([false]);
    expect(r.consumed).toEqual([]);
  });
});
