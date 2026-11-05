/**
 * `predicate-filter` 纯逻辑的判据（筛选 / 计数 / 档位可见性）。
 *
 * 只测纯函数：不挂 React、不碰 DOM、不读 IO。语料形状按 `plugin-api` 的
 * `PredicateReplay` 最小构造（`expr` 恒 opaque——筛选根本不看 AST）。
 */
import { describe, expect, it } from 'vitest';
import type { PredicateReplay, ReplayUnknown } from '@kojo/plugin-api';
import {
  PREDICATE_FILTER_LABEL,
  availableFilters,
  countPredicates,
  filterPredicates,
  type PredicateFilter,
} from '../src/predicate-filter';

type OutcomeKind = PredicateReplay['outcome']['kind'];

/** 最小谓词（行号 / 原文 / 三值结果；unknown 可带码与文案） */
function predicate(
  line: number,
  text: string,
  outcome: OutcomeKind,
  unknown?: ReplayUnknown,
): PredicateReplay {
  return {
    kind: 'IF',
    text,
    line,
    outcome:
      outcome === 'unknown'
        ? { kind: 'unknown', unknown: unknown ?? { code: 'opaque', message: '表达式未被解析' } }
        : { kind: outcome },
    expr: { kind: 'opaque', text },
  };
}

const UNKNOWN_CALL: ReplayUnknown = {
  code: 'call-context',
  message: 'ARG 需要调用上下文，未注入',
};

/** 6 条：2 真、1 假、3 未判定（其中 1 条 call-context）；行号故意不连号 */
const FIXTURE: readonly PredicateReplay[] = [
  predicate(10, 'TARGET:HP > 0', 'true'),
  predicate(11, 'CFLAG:1 == 1', 'false'),
  predicate(12, 'RAND:1 > 3', 'unknown', {
    code: 'pseudo',
    message: '伪变量（运行期计算值）：RAND',
  }),
  predicate(13, 'ARG:0 == 1', 'unknown', UNKNOWN_CALL),
  predicate(1234, 'FLAG:2 == 1', 'true'),
  predicate(20, 'ABL:0 >= CFLAG:1', 'unknown', {
    code: 'opaque',
    message: '表达式含未解析片段',
  }),
];

const lines = (list: readonly PredicateReplay[]): number[] => list.map((p) => p.line);

const ALL: PredicateFilter = { kind: 'all', query: '' };

describe('filterPredicates —— 档位', () => {
  it('all 原样全给，顺序不动', () => {
    expect(lines(filterPredicates(FIXTURE, ALL))).toEqual([10, 11, 12, 13, 1234, 20]);
  });

  it('unjudged / true / false 各取各的', () => {
    expect(lines(filterPredicates(FIXTURE, { kind: 'unjudged', query: '' }))).toEqual([
      12, 13, 20,
    ]);
    expect(lines(filterPredicates(FIXTURE, { kind: 'true', query: '' }))).toEqual([10, 1234]);
    expect(lines(filterPredicates(FIXTURE, { kind: 'false', query: '' }))).toEqual([11]);
  });

  it('保持入参顺序：倒序输入 → 倒序输出，且不改入参、返回新数组', () => {
    const reversed = [...FIXTURE].reverse();
    const snapshot = lines(reversed);
    const got = filterPredicates(reversed, { kind: 'true', query: '' });

    expect(lines(got)).toEqual([1234, 10]);
    expect(lines(reversed)).toEqual(snapshot);
    expect(got).not.toBe(reversed);
    // 同对象引用透传（不克隆谓词），面板拿到的仍是原记录
    expect(got[0]).toBe(reversed.find((p) => p.line === 1234));
  });
});

describe('filterPredicates —— unknownCode 子筛', () => {
  it('按码逐字相等筛（unjudged 内）', () => {
    expect(
      lines(filterPredicates(FIXTURE, { kind: 'unjudged', query: '', unknownCode: 'call-context' })),
    ).toEqual([13]);
    expect(
      lines(filterPredicates(FIXTURE, { kind: 'unjudged', query: '', unknownCode: 'pseudo' })),
    ).toEqual([12]);
  });

  it('不给码 = 纯 unjudged；空串等价于不给', () => {
    const withoutCode = lines(filterPredicates(FIXTURE, { kind: 'unjudged', query: '' }));
    const emptyCode = lines(
      filterPredicates(FIXTURE, { kind: 'unjudged', query: '', unknownCode: '' }),
    );
    expect(emptyCode).toEqual(withoutCode);
    expect(withoutCode).toEqual([12, 13, 20]);
  });

  it('是逐字相等而非子串：call 不命中 call-context', () => {
    expect(
      lines(filterPredicates(FIXTURE, { kind: 'unjudged', query: '', unknownCode: 'call' })),
    ).toEqual([]);
  });

  it('非 unjudged 档忽略 unknownCode（否则点回「全部」只剩一小撮）', () => {
    expect(
      lines(filterPredicates(FIXTURE, { kind: 'all', query: '', unknownCode: 'call-context' })),
    ).toEqual([10, 11, 12, 13, 1234, 20]);
    expect(
      lines(filterPredicates(FIXTURE, { kind: 'true', query: '', unknownCode: 'call-context' })),
    ).toEqual([10, 1234]);
  });
});

describe('filterPredicates —— query', () => {
  it('匹配原文，大小写不敏感', () => {
    expect(lines(filterPredicates(FIXTURE, { kind: 'all', query: 'target:hp' }))).toEqual([10]);
    expect(lines(filterPredicates(FIXTURE, { kind: 'all', query: 'Target:HP' }))).toEqual([10]);
  });

  it('匹配未知文案（不在原文里的词也能搜到）', () => {
    expect(lines(filterPredicates(FIXTURE, { kind: 'all', query: '调用上下文' }))).toEqual([13]);
    expect(lines(filterPredicates(FIXTURE, { kind: 'all', query: '未解析片段' }))).toEqual([20]);
  });

  it('匹配行号字符串（子串，整数号也能定位）', () => {
    expect(lines(filterPredicates(FIXTURE, { kind: 'all', query: '1234' }))).toEqual([1234]);
    expect(lines(filterPredicates(FIXTURE, { kind: 'all', query: '2' }))).toEqual([12, 1234, 20]);
  });

  it('kind + query 组合：先档位后子串，两头都生效', () => {
    // FLAG 只出现在 true 的那条；LINE 1234 上若档位是 unjudged 则一条都不该给
    expect(lines(filterPredicates(FIXTURE, { kind: 'true', query: 'flag' }))).toEqual([1234]);
    expect(lines(filterPredicates(FIXTURE, { kind: 'unjudged', query: '1234' }))).toEqual([]);
    expect(
      lines(filterPredicates(FIXTURE, { kind: 'unjudged', query: 'arg', unknownCode: 'call-context' })),
    ).toEqual([13]);
  });

  it('空串不筛；无匹配给空数组；空输入不抛', () => {
    expect(lines(filterPredicates(FIXTURE, { kind: 'all', query: '' }))).toEqual(
      lines(FIXTURE),
    );
    expect(filterPredicates(FIXTURE, { kind: 'all', query: '没有这个词' })).toEqual([]);
    expect(filterPredicates([], { kind: 'unjudged', query: 'x' })).toEqual([]);
  });
});

describe('countPredicates', () => {
  it('四档计数：all 恒等于长度，unjudged 恒等于总量减判定出的', () => {
    expect(countPredicates(FIXTURE)).toEqual({ all: 6, unjudged: 3, true: 2, false: 1 });
  });

  it('空输入全零', () => {
    expect(countPredicates([])).toEqual({ all: 0, unjudged: 0, true: 0, false: 0 });
  });
});

describe('availableFilters', () => {
  it('全档都有 → 固定顺序 all/unjudged/true/false', () => {
    expect(availableFilters(countPredicates(FIXTURE))).toEqual([
      'all',
      'unjudged',
      'true',
      'false',
    ]);
  });

  it('零计数只剔非 all 档，all 恒在', () => {
    expect(availableFilters({ all: 4, unjudged: 2, true: 0, false: 2 })).toEqual([
      'all',
      'unjudged',
      'false',
    ]);
    expect(availableFilters({ all: 0, unjudged: 0, true: 0, false: 0 })).toEqual(['all']);
  });
});

describe('PREDICATE_FILTER_LABEL', () => {
  it('四档齐备、中文标签、all → 全部', () => {
    expect(Object.keys(PREDICATE_FILTER_LABEL).sort()).toEqual([
      'all',
      'false',
      'true',
      'unjudged',
    ]);
    expect(PREDICATE_FILTER_LABEL.all).toBe('全部');
    for (const label of Object.values(PREDICATE_FILTER_LABEL)) {
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
