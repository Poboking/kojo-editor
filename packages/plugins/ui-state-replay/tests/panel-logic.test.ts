/**
 * 回放面板纯逻辑单测（v0.2 第八批；零 React）。
 *
 * 覆盖：调用上下文文本解析（数值槽 / 字符串槽 / 重复 / 非法语法 / 空输入），
 * ReplayCallContext 组装（空槽位表 → undefined），未知原因分组，函数名提示。
 */
import { describe, expect, it } from 'vitest';
import type { FunctionReplay } from '@kojo/plugin-api';
import { groupUnknowns, parseCallContextText, suggestFunctions, toCallContext } from '../src/panel-logic';

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
