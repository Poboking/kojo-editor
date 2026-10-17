import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_BUDGETS,
  SCOPED_QUERY_FACTOR,
  candidateBudget,
  candidateRank,
  enclosingAt,
  enclosingChainAt,
  filterByScope,
  pathInScope,
  pickEnclosing,
  type LineSpan,
} from '../src/index';

/**
 * W7 NAV-SCOPE · 契约层判据单测（2026-10-18 接力批）。
 *
 * 钉的是**尺子本身**：四消费方的对拍在 `packages/app/tests/nav-scope-p0.test.ts`，
 * 四通道的候选集合一致在 `packages/app/tests/nav-scope-p1.test.ts`——这里只锁
 * `semantic-locate.ts` / `erb.ts` 的口径定义，消费者漂移不该靠改这里来掩盖。
 */

const span = (startLine: number, endLine: number, tag = ''): LineSpan & { tag: string } => ({
  startLine,
  endLine,
  tag,
});

describe('enclosingChainAt — 行 → 归属链（外→内）', () => {
  it('平铺区间（ERB 索引形态）：链只剩包围该行的那一条', () => {
    const list = [span(10, 20, 'A'), span(21, 30, 'B')];
    expect(enclosingChainAt(list, 15).map((s) => s.tag)).toEqual(['A']);
    expect(enclosingChainAt(list, 25).map((s) => s.tag)).toEqual(['B']);
  });

  it('平铺大纲里 `#DIM` 单行声明**不许**淘汰外层函数（跳状态那批的实证坑）', () => {
    // 旧面包屑判据"每层只留区间最小的一枚"会在这里把外层函数判没 ⇒
    // 假答案"这一行不在任何函数里"。全树下行 + 链上取层必须让函数活着。
    const fn = span(10, 40, 'M_A');
    const dim = span(20, 20, 'CFLAG');
    const chain = enclosingChainAt([fn, dim], 20);
    expect(chain.map((s) => s.tag)).toEqual(['M_A', 'CFLAG']);
    expect(pickEnclosing(chain, 'innermost')?.tag).toBe('CFLAG');
    expect(pickEnclosing(chain, 'outermost')?.tag).toBe('M_A');
    expect(enclosingAt([fn, dim], 20, 'outermost')?.tag).toBe('M_A');
  });

  it('嵌套 children 与平铺同一条判据；同宽不同起点时靠后者更内', () => {
    const outer = span(1, 100, 'OUT') as LineSpan & { tag: string; children?: unknown[] };
    const inner = span(40, 60, 'IN');
    outer.children = [inner];
    expect(enclosingChainAt([outer], 50).map((s) => (s as { tag: string }).tag)).toEqual(['OUT', 'IN']);
    const twinWidthA = span(10, 19, 'W-A');
    const twinWidthB = span(12, 21, 'W-B');
    expect(enclosingChainAt([twinWidthA, twinWidthB], 15).map((s) => s.tag)).toEqual(['W-A', 'W-B']);
  });

  it('同区间双胞胎只留文档序第一枚（确定性）', () => {
    const chain = enclosingChainAt([span(10, 20, 'FIRST'), span(10, 20, 'SECOND')], 15);
    expect(chain.map((s) => s.tag)).toEqual(['FIRST']);
  });

  it('行号非法 ⇒ 空链，**不夹取**（把过期行号夹到附近 = 把位置失效伪装成命中旁边函数）', () => {
    const list = [span(10, 20, 'A')];
    expect(enclosingChainAt(list, 0)).toEqual([]);
    expect(enclosingChainAt(list, -5)).toEqual([]);
    expect(enclosingChainAt(list, Number.NaN)).toEqual([]);
    expect(enclosingChainAt(list, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(enclosingChainAt(list, 999)).toEqual([]);
    expect(enclosingChainAt(null as unknown as LineSpan[], 15)).toEqual([]);
    expect(enclosingChainAt(undefined, 15)).toEqual([]);
  });

  it('畸形区间（端点非有限 / startLine > endLine）不参与判定，也不抛', () => {
    const list = [
      span(Number.NaN, 20, 'BAD-A'),
      span(10, Number.POSITIVE_INFINITY, 'BAD-B'),
      span(20, 10, 'INVERTED'),
      span(10, 20, 'GOOD'),
    ];
    expect(enclosingChainAt(list, 15).map((s) => s.tag)).toEqual(['GOOD']);
  });

  it('1 基闭区间：端点行也算包围', () => {
    const list = [span(10, 20, 'A')];
    expect(enclosingAt(list, 10)?.tag).toBe('A');
    expect(enclosingAt(list, 20)?.tag).toBe('A');
  });
});

describe('pathInScope / filterByScope — 「文件 → 是否只看内」唯一谓词', () => {
  const ROOT = 'C:\\game\\kojo\\chara12';
  it('空 roots / 非数组 ⇒ **全量**（空范围读起来绝不能像"项目是空的"）', () => {
    expect(pathInScope('Anything/else.ERB', [])).toBe(true);
    expect(pathInScope('Anything/else.ERB', null)).toBe(true);
    expect(pathInScope('Anything/else.ERB', undefined)).toBe(true);
    expect(filterByScope([1, 2], () => 'x', []).length).toBe(2);
  });

  it('目录前缀判定认分隔符与大小写折叠，不认"文件名里恰好有目录名"的假命中', () => {
    expect(pathInScope(`${ROOT}\\MESSAGE.ERB`, [ROOT])).toBe(true);
    expect(pathInScope(`${ROOT}\\sub\\X.ERB`, [ROOT])).toBe(true);
    expect(pathInScope(`${ROOT}X\\Y.ERB`, [ROOT])).toBe(false);
    expect(pathInScope('', [ROOT])).toBe(false);
  });

  it('多根取任一命中；坏根条目跳过不炸', () => {
    expect(pathInScope('D:/a/x.erb', ['D:/b', 'D:/a'])).toBe(true);
    expect(pathInScope('D:/a/x.erb', ['', 'D:/a'])).toBe(true);
    expect(pathInScope('D:/c/x.erb', ['D:/b', 'D:/a'])).toBe(false);
  });
});

describe('candidateRank — 四通道唯一比较器', () => {
  it('桶序：精确名 → 前缀 → 名含子串 → 仅路径含子串 → 认不出（0..4）', () => {
    expect(candidateRank('MESSAGE', 'C:/a/MESSAGE.ERB', 'message')).toBe(0);
    expect(candidateRank('MESSAGE_DONE', 'C:/a/MESSAGE_DONE.ERB', 'message')).toBe(1);
    expect(candidateRank('XMESSAGEY', 'C:/a/XMESSAGEY.ERB', 'message')).toBe(2);
    expect(candidateRank('UNRELATED', 'C:/message/UNRELATED.ERB', 'message')).toBe(3);
    expect(candidateRank('UNRELATED', 'C:/other/UNRELATED.ERB', 'zzz')).toBe(4);
  });

  it('中文与 ASCII 同一条路；空查询/脏输入一律 unmatched（不许把任何一条判成命中）', () => {
    expect(candidateRank('训练度检查', 'C:/k/训练.ERB', '度检查')).toBe(2); // 名含子串（非前缀）
    expect(candidateRank('训练度检查', 'C:/k/训练.ERB', '训练')).toBe(1); // 前缀桶优先于子串桶
    expect(candidateRank('训练度检查', 'C:/k/训练.ERB', '   ')).toBe(4);
    expect(candidateRank(5 as unknown as string, 'x', 'q')).toBe(4);
  });
});

describe('candidateBudget — 档位表唯一兜底处', () => {
  it('档位关系钉死：providerQuery ≥ render ≥ quickOpen，且全部 ≤ ceiling', () => {
    expect(CANDIDATE_BUDGETS.providerQuery).toBeGreaterThanOrEqual(CANDIDATE_BUDGETS.render);
    expect(CANDIDATE_BUDGETS.render).toBeGreaterThanOrEqual(CANDIDATE_BUDGETS.quickOpen);
    for (const v of Object.values(CANDIDATE_BUDGETS)) expect(v).toBeLessThanOrEqual(CANDIDATE_BUDGETS.ceiling);
    expect(SCOPED_QUERY_FACTOR).toBeGreaterThan(1);
  });

  it('脏请求落回档位值；超 ceiling 收到上限而不是放行"我全都想要"', () => {
    expect(candidateBudget('render')).toBe(CANDIDATE_BUDGETS.render);
    expect(candidateBudget('render', 0)).toBe(CANDIDATE_BUDGETS.render);
    expect(candidateBudget('render', -3)).toBe(CANDIDATE_BUDGETS.render);
    expect(candidateBudget('render', Number.NaN)).toBe(CANDIDATE_BUDGETS.render);
    expect(candidateBudget('render', 999999)).toBe(CANDIDATE_BUDGETS.ceiling);
    expect(candidateBudget('render', 30)).toBe(30);
  });
});
