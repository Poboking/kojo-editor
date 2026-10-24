/**
 * 语料缺席（SKIP）那一行的唯一实现。
 *
 * 为什么单开一枚叶子（视觉批十二 · PITFALLS 187 的第二段账）：`tools/kojo-conformance.mjs`
 * 的 `corpus` 子命令在"语料不在位"时只需要**造报告与渲染文本**这两件事，可它原先要把
 * `corpus.ts` 整枚载进来——那枚模块静态 import `./migration.js`，后者又吃 `@kojo/kojo-core`
 * 的桶入口。本机逐枚计时：core 桶单体 SSR 冷载 **63.6s**（叶子 `migrate/indent.ts` 只要 2.5s），
 * 于是缺席路径的空闲实测 38.0s、在全量池里能顶穿用例自己的 240s 预算，读数退化成
 * `status:null`（进程被掐，不是判据不对）。
 *
 * 这一枚叶子**零运行时依赖**：只 `import type`（被转译层擦掉），所以载入它只要 vite 起服的时间。
 * 判据一条没动：缺席仍是 rc=2、stderr、`verdict: 'skip'`、文本逐字与 `corpus.ts` 那条路径同形
 * ——因为同形不是"抄两份"，`runCorpusCli` 与工具外壳调用的**就是这里的同一枚函数**，
 * 相等性由 `packages/kojo-conformance/tests/corpus.test.ts` 钉住。
 */

import type { CorpusCliReport, CorpusRateReport, CorpusSummary, CorpusVerdict } from './corpus.js';

/** 缺席的退出码（2 = SKIP，明确不是绿） */
export const SKIP_EXIT_CODE = 2;

/** 空摘要（字段序即 JSON 的键序，动了它等于动报告格式） */
export function emptySummaryReport(): CorpusSummary {
  return { cases: 0, identical: 0, normalizedEqual: 0, differs: 0, blocked: 0, blockedByReason: Object.freeze([]) };
}

export function emptyRateReport(): CorpusRateReport {
  return { total: 0, migratable: 0, rate: 0, unmigratable: 0, unsupportedCases: 0, byReason: Object.freeze([]) };
}

/** 报告骨架（`usage` 非 null 时才是用法文本档） */
export function emptyReport(verdict: CorpusVerdict, dir: string): CorpusCliReport {
  return {
    verdict,
    dir,
    discovery: null,
    summary: emptySummaryReport(),
    rate: emptyRateReport(),
    cases: Object.freeze([]),
    problems: Object.freeze([]),
    manifest: null,
    usage: null,
  };
}

/** 语料不在位 = 一条 `kind: 'corpus'` 的问题 + 零读数，绝不当"0 cases 通过" */
export function skipReport(dir: string, reason: string): CorpusCliReport {
  return {
    ...emptyReport('skip', dir),
    problems: Object.freeze([{ id: '(corpus)', kind: 'corpus' as const, message: reason }]),
  };
}

/**
 * SKIP 报告的文本（人话档与 `--json` 档都在这里，别处不再写第二份）。
 *
 * `report.usage` 在本函数关心的形态里恒为 null（用法错误走 `formatCorpusReport` 的另一条分支）；
 * 真带上了 usage 就原样吐出去，与整份格式化器的口径一致。
 */
export function renderCorpusSkipText(report: CorpusCliReport, json: boolean): string {
  if (report.usage !== null) return `${report.usage}\n`;
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  const lines: string[] = [];
  lines.push(`kojo-conformance corpus · SKIP（语料不在位）· dir=${report.dir || '(未解析)'}`);
  for (const problem of report.problems) lines.push(`  原因：${problem.message}`);
  lines.push('这是 SKIP，不是绿：语料缺席不会被记成 0 cases 通过。');
  lines.push('用法：node tools/kojo-conformance.mjs corpus --dir <语料根> [--limit N] [--json]');
  return `${lines.join('\n')}\n`;
}
