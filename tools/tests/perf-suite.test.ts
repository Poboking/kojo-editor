/**
 * PERF-POOL · 墙钟计时用例**分池机制**的守门（纯逻辑 + 纯扫盘，不测任何毫秒数）。
 *
 * 本文件自己**不含 `performance.now(`** —— 否则会被自己的谓词分进串行池，机制就自噬了。
 *
 * 钉四件事：
 *   ① 已知计时文件全部在串行池（漏一个 = CI 那一条仍会随机红）；
 *   ② 假时钟用例（`cascade-watermarks`）与「不含 performance.now( 的文件」绝不进串行池
 *      （进去了就是白付串行开销，且掩盖判据错误）；
 *   ③ 两池不相交、并起来等于全集（不重叠 ⇒ 不重复计数，不丢 ⇒ 不漏跑）；
 *   ④ 主配置的 `exclude` 与计时配置的 `include` 出自**同一次扫描**（真比对配置对象）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isTimingBudgetSource, mainExclude, perfInclude, scanPerfTestFiles, VITEST_DEFAULT_EXCLUDE } from '../perf-suite.mjs';
// ④ 要真读两份配置对象（它们 import perf-suite，扫描结果就是配置里实际生效的那一份）
import mainConfig from '../../vitest.config';
import perfConfig from '../../vitest.perf.config';

const root = fileURLToPath(new URL('../..', import.meta.url));
const pools = scanPerfTestFiles(root);

/** 必须进串行池的既有计时文件（①：CI 红过的那些 + 全部 `*.perf.test.ts`） */
const KNOWN_PERF = [
  'packages/app/tests/marker-hotpath.test.ts',
  'packages/app/tests/completion-perf.test.ts',
  'packages/app/tests/semantic-tokens.perf.test.ts',
  'packages/app/tests/erb-completion-functions.test.ts',
  'packages/app/tests/file-tree.test.ts',
  'packages/app/tests/workspace-symbols.test.ts',
  'packages/kernel/tests/rescan-scale.perf.test.ts',
  'packages/plugins/ui-kojo-navigator/tests/search-perf.test.ts',
  'packages/plugins/kojo-sugar/tests/hotpath-bench.test.ts',
  'packages/plugins/kojo-sugar/tests/semantic-tokens.perf.test.ts',
  'packages/plugins/kojo-sugar/tests/sugar-autoidx.perf.test.ts',
  'packages/plugins/erb-parser/tests/workspace-symbols.test.ts',
  'packages/plugins/erb-parser/tests/semantic-tokens.perf.test.ts',
  'packages/plugins/erb-parser/tests/snapshot-hot-load.perf.test.ts',
  'packages/plugins/condition-extractor/tests/snapshot-hot-load.perf.test.ts',
  // 2026-10-29 条件矩阵性能批：文件级增量索引的闸门（判据是比值，必须在静默池里量）
  'packages/plugins/ui-condition-matrix/tests/matrix-scale.perf.test.ts',
];

describe('PERF-POOL · 分池判据', () => {
  it('① 已知计时文件全部在串行池，且全部 *.perf.test.ts 无一遗漏', () => {
    const missing = KNOWN_PERF.filter((f) => !pools.perf.includes(f));
    expect(missing, `这些计时文件没进串行池：${missing.join(', ')}`).toEqual([]);
    const perfNamed = pools.all.filter((f) => /\.perf\.test\.ts$/.test(f));
    expect(perfNamed.filter((f) => !pools.perf.includes(f))).toEqual([]);
    expect(perfNamed.length).toBeGreaterThanOrEqual(5);
  });

  it('② 假时钟用例与不含 performance.now( 的文件不在串行池', () => {
    expect(pools.perf).not.toContain('packages/app/tests/cascade-watermarks.test.ts');
    // cascade-watermarks 自己声明了假时钟（注释口径），谓词必须认这个口径
    const src = readFileSync(new URL('../../packages/app/tests/cascade-watermarks.test.ts', import.meta.url), 'utf8');
    expect(src.includes('performance.now(')).toBe(false);
    expect(isTimingBudgetSource(src)).toBe(false);
    // 池里每一条都必须有凭据：文件名 `*.perf.test.ts`，或源码真有 performance.now(
    const baseless = pools.perf.filter((f) => {
      if (/\.perf\.test\.ts$/.test(f)) return false;
      return !readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').includes('performance.now(');
    });
    expect(baseless, `串行池里这些文件没有墙钟凭据：${baseless.join(', ')}`).toEqual([]);
    // 反例护栏：非计时源一律判 false（谓词不许退化成"文件里出现 expect 就算"）
    expect(isTimingBudgetSource('const x = 1; expect(x.length).toBeLessThan(3);')).toBe(false);
    expect(isTimingBudgetSource('let steps = 0; expect(++steps).toBeLessThan(50);')).toBe(false);
    expect(isTimingBudgetSource('expect(items.length).toBeLessThanOrEqual(4);')).toBe(false);
    // 有 performance.now( 但只做展示、不参与判绿 ⇒ 仍不算计时预算用例
    expect(isTimingBudgetSource('const t0 = performance.now(); use(t0); expect(items.length).toBeLessThan(4);')).toBe(
      false,
    );
  });

  it('③ 两池不相交、并起来等于全集，且各自升序、posix 相对路径', () => {
    const overlap = pools.perf.filter((f) => pools.normal.includes(f));
    expect(overlap, `两池重叠：${overlap.join(', ')}`).toEqual([]);
    expect([...pools.perf, ...pools.normal].sort()).toEqual(pools.all);
    expect(pools.all).toHaveLength(pools.perf.length + pools.normal.length);
    for (const list of [pools.perf, pools.normal, pools.all]) expect([...list].sort()).toEqual(list);
    expect(pools.all.filter((f) => f.includes('\\'))).toEqual([]);
    expect(pools.perf.filter((f) => f.startsWith('/'))).toEqual([]);
  });

  it('④ 主配置 exclude 与计时配置 include 用的是同一次扫描结果', () => {
    const exclude = mainConfig.test?.exclude ?? [];
    const include = perfConfig.test?.include ?? [];
    expect([...exclude].filter((f) => !VITEST_DEFAULT_EXCLUDE.includes(f))).toEqual(pools.perf);
    expect(include).toEqual(pools.perf);
    expect(perfInclude(root)).toEqual(pools.perf);
    expect(mainExclude(root)).toEqual([...VITEST_DEFAULT_EXCLUDE, ...pools.perf]);
    // 排除集必须真的落在主配置 include 的口径之内（否则"排除"是空转）
    expect(pools.perf.every((f) => pools.all.includes(f))).toBe(true);
    expect(mainConfig.test?.include).toEqual(['packages/**/tests/**/*.test.ts', 'tools/tests/**/*.test.ts']);
    // 计时池的串行口径（一个时刻一个文件一条线程）
    expect(perfConfig.test?.fileParallelism).toBe(false);
    expect(perfConfig.test?.maxWorkers).toBe(1);
    expect(perfConfig.test?.testTimeout).toBe(60000);
    expect(perfConfig.test?.hookTimeout).toBe(120000);
    // alias 只有一份：计时池直接复用主配置的 resolve
    expect(perfConfig.resolve).toBe(mainConfig.resolve);
  });
});
