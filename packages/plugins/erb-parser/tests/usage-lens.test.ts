/**
 * 行上内联注解 · 纯逻辑单测（B8）。
 *
 * 覆盖四条口径（真语料的统计证据在 `./usage-lens.corpus.test.ts`，这里只管判据本身）：
 * ①证明不了就闭嘴（不编造「没人调用」）；②重名不计数；③数的是「处」（文件+行 去重）；
 * ④大数改报 `1000+` 且**早停**（不为无意义的精确数走完整张引用表）。
 */
import { describe, expect, it } from 'vitest';
import type { ErbFunction, ErbReference } from '@kojo/plugin-api';
import { USAGE_LENS_BIG_COUNT, usageLenses, type UsageLensSource } from '../src/symbols';

const fn = (name: string, line: number): ErbFunction =>
  ({
    name,
    normalizedName: name.toUpperCase(),
    startLine: line,
    endLine: line + 1,
    filePath: '/t/A.ERB',
    params: [],
  }) as ErbFunction;

const def = (name: string, line = 1, filePath = '/t/A.ERB'): ErbReference => ({
  filePath,
  line,
  column: 2,
  endColumn: 2 + name.length,
  kind: 'definition',
});

const call = (name: string, filePath: string, line: number, column = 7): ErbReference => ({
  filePath,
  line,
  column,
  endColumn: column + name.length,
  kind: 'call',
});

/** 只给名录里的名字作答（其余名 = 索引里查无此名） */
function sourceFor(entries: Record<string, { defs: number; refs: ErbReference[] }>): UsageLensSource {
  return {
    definitionsOf: (norm) => entries[norm]?.defs ?? 0,
    referencesOf: (norm) => entries[norm.toUpperCase()]?.refs ?? [],
  };
}

/** n 处使用（各处不同文件，互不去重） */
const sites = (n: number): ErbReference[] => Array.from({ length: n }, (_, i) => call('BIG', `/t/${i}.ERB`, 1));

describe('usageLenses · 开不开口', () => {
  it('有可证明的用处 ⇒ 一句话；落点 = 第一条使用处（不是定义行）', () => {
    const got = usageLenses(
      [fn('ALPHA', 10)],
      sourceFor({ ALPHA: { defs: 1, refs: [def('ALPHA'), call('ALPHA', '/t/B.ERB', 3)] } }),
    );
    expect(got).toEqual([{ line: 10, label: '被 1 处用到', target: { filePath: '/t/B.ERB', line: 3, column: 7 } }]);
  });

  it('只有定义行自身（证明不了有人用）⇒ 这一行闭嘴，**不**编造「没人调用」', () => {
    expect(usageLenses([fn('ORPHAN', 4)], sourceFor({ ORPHAN: { defs: 1, refs: [def('ORPHAN')] } }))).toEqual([]);
  });

  it('索引里查无此名（缓冲区刚写出来的新函数）⇒ 同样闭嘴，不猜', () => {
    expect(usageLenses([fn('NEW', 1)], sourceFor({}))).toEqual([]);
  });

  it('重名（多处定义）不计数：反向边按名字聚合，两处定义无从分账', () => {
    const refs = [def('DUP'), def('DUP', 5, '/t/C.ERB'), call('DUP', '/t/B.ERB', 2)];
    expect(usageLenses([fn('DUP', 7)], sourceFor({ DUP: { defs: 2, refs } }))).toEqual([]);
  });

  it('按行升序输出（宿主只做协议翻译，不替贡献方排序）', () => {
    const src = sourceFor({
      A: { defs: 1, refs: [def('A'), call('A', '/t/B.ERB', 4)] },
      B: { defs: 1, refs: [def('B'), call('B', '/t/B.ERB', 9)] },
    });
    const got = usageLenses([fn('B', 20), fn('A', 3)], src);
    expect(got.map((l) => l.line)).toEqual([3, 20]);
  });
});

describe('usageLenses · 数的是「处」', () => {
  it('同一文件同一行写两遍只算一处', () => {
    const refs = [def('A'), call('A', '/t/B.ERB', 9, 2), call('A', '/t/B.ERB', 9, 20)];
    expect(usageLenses([fn('A', 1)], sourceFor({ A: { defs: 1, refs } }))[0]!.label).toBe('被 1 处用到');
  });

  it('跨文件、跨行各算一处；定义行自身不计数', () => {
    const refs = [def('A'), def('A', 6), call('A', '/t/B.ERB', 2), call('A', '/t/C.ERB', 5), call('A', '/t/B.ERB', 8)];
    expect(usageLenses([fn('A', 1)], sourceFor({ A: { defs: 1, refs } }))[0]!.label).toBe('被 3 处用到');
  });

  it('恰好到界线报精确数，越界一个才改报 1000+', () => {
    const exact = { defs: 1, refs: [def('BIG'), ...sites(USAGE_LENS_BIG_COUNT)] };
    expect(usageLenses([fn('BIG', 1)], sourceFor({ BIG: exact }))[0]!.label).toBe(`被 ${USAGE_LENS_BIG_COUNT} 处用到`);
    const over = { defs: 1, refs: [def('BIG'), ...sites(USAGE_LENS_BIG_COUNT + 1)] };
    expect(usageLenses([fn('BIG', 1)], sourceFor({ BIG: over }))[0]!.label).toBe(`被 ${USAGE_LENS_BIG_COUNT}+ 处用到`);
  });

  it('过了界线就**早停**：不为一串没有动作含义的精确数走完整张引用表', () => {
    let readsAfterLimit = 0;
    const head = [def('BIG'), ...sites(USAGE_LENS_BIG_COUNT + 1)];
    const tail = Array.from({ length: 50_000 }, (_, i) => {
      const ref = call('BIG', `/t/tail-${i}.ERB`, 1);
      return new Proxy(ref, {
        get(target, prop) {
          if (prop === 'kind') readsAfterLimit++;
          return Reflect.get(target, prop);
        },
      });
    });
    const many = [...head, ...tail] as ErbReference[];
    const got = usageLenses([fn('BIG', 1)], { definitionsOf: () => 1, referencesOf: () => many });
    expect(got[0]!.label).toBe(`被 ${USAGE_LENS_BIG_COUNT}+ 处用到`);
    expect(readsAfterLimit, '早停之后不许再读任何引用点').toBe(0);
  });
});
