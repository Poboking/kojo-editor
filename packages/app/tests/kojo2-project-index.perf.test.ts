/**
 * 项目级符号索引的**计时预算**用例（K2-INDEX-REFS）。
 *
 * 为什么单独一枚 `.perf.test.ts`：这枚用例断言的是墙钟预算（5k 行整篇更新 < 8ms），
 * 放在并行主池里会被同池 worker 饿红（`docs/PITFALLS.md` §72）。文件名即意图，
 * `tools/perf-suite.mjs` 按 `*.perf.test.ts` 把它排除出主池、收进串行静默池
 * （`pnpm test:perf` / `vitest.perf.config.ts`）——主池里只留算法性质类断言。
 *
 * 口径：只测**索引自己**（解析 + 两趟扫描 + 缓存），不含宿主 IO；取暖机后三次最快一次。
 */
import { describe, expect, it } from 'vitest';
import { createKojo2ProjectIndex } from '../src/monaco/kojo2-project-index';

const LINES = 5000;

function bigSource(lines: number): string {
  const rows = [
    '# 机 指令 310',
    '# 视 旅人',
    '# 变量 亲近线 整数 = 0 存档',
    '# 常量 亲近线 整数 = 500',
    '# 变量 今天已触发 整数 = 0 存档',
    '# 表 心情 由 亲近线',
    '    0..99 疏远',
    '    否 未知',
    '@函 增加羁绊(目标, 数值=10)',
    '    @返 目标 + 亲近线',
  ];
  while (rows.length < lines - 3) rows.push('// 注释：把 5k 行文件撑到量级，不产生引用位');
  rows.push('> 晨光透过鸟居，{今天已触发} 次。');
  rows.push('旅人：「{心情}今天来得挺早嘛。」');
  rows.push('! 增加羁绊(目标, 12)');
  return rows.join('\n');
}

describe('kojo2 项目索引 · 5k 行整篇更新预算', () => {
  it('暖机后三次取最快一次 < 8ms（索引自己：解析 + 扫描 + 缓存）', () => {
    const source = bigSource(LINES);
    expect(source.split('\n')).toHaveLength(LINES);
    const index = createKojo2ProjectIndex();
    // 暖机：同一量级的整篇更新（含 lex / parse / 两趟扫描的 JIT），不计入护栏。
    index.updateFile({ path: 'D:/proj/big.kojo2', text: source });

    const samples: number[] = [];
    for (let round = 0; round < 3; round++) {
      const text = `${source}\n// 第 ${round} 版`;
      // 取几次中的**最快一次**：调度抖动只会让某次变慢，不会把真实超预算读成达标。
      const startedAt = performance.now();
      const entry = index.updateFile({ path: 'D:/proj/big.kojo2', text });
      samples.push(performance.now() - startedAt);
      expect(entry).toBeDefined();
    }
    expect(index.getFile('D:/proj/big.kojo2')?.document.lines.length).toBeGreaterThanOrEqual(LINES);
    expect(Math.min(...samples)).toBeLessThan(8);
  });

  it('同文本重复更新走缓存（< 1ms，不重解析）', () => {
    const source = bigSource(LINES);
    const index = createKojo2ProjectIndex();
    index.updateFile({ path: 'D:/proj/big.kojo2', text: source });
    const startedAt = performance.now();
    index.updateFile({ path: 'D:/proj/big.kojo2', text: source });
    expect(performance.now() - startedAt).toBeLessThan(1);
  });
});
