/**
 * `perf-suite.mjs` 的手写声明（root `tsconfig.json` 的 include 里有 `vitest.config.ts`，
 * 它 import 本模块；strict + verbatimModuleSyntax 下没有 .d.mts 就会 TS7016）。
 * 真源实现是 JSDoc 标注的 .mjs，这里只补类型口径。
 */

export interface PerfTestPools {
  /** 计时用例（串行静默池）：posix 风格、相对仓库根，升序 */
  readonly perf: string[];
  /** 功能用例（并行池）：同上口径，升序 */
  readonly normal: string[];
  /** `perf + normal` 的全集，升序 */
  readonly all: string[];
}

/** 源码是否「含 performance.now( 且含一条对墙钟量的比较断言」 */
export declare function isTimingBudgetSource(src: string): boolean;

/** 按主配置 include 口径扫两张池 */
export declare function scanPerfTestFiles(rootDir?: string): PerfTestPools;

/** 主配置的 `test.exclude`（vitest 默认三项 + 计时文件；显式写 exclude 会覆盖默认值，故默认值要自己列全） */
export declare function mainExclude(rootDir?: string): string[];

/** 计时配置的 `test.include`（与 `mainExclude()` 出自同一次扫描） */
export declare function perfInclude(rootDir?: string): string[];

/** vitest 默认 exclude 的等价物 */
export declare const VITEST_DEFAULT_EXCLUDE: readonly string[];
