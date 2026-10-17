/**
 * PERF-12b 对拍（糖侧内置规则）× RULE-DEDUP（W2）：
 * `sugar.static-conventions` 的分区路径（逐文件 `fileUnit` ⇒ `combine`）与全量 `check`
 * 在同输入下**逐条同产出**，含读盘失败文件的"跳过"口径（两边都只 warn 跳过、不产结论、
 * 不算失败）。
 *
 * 判据本体已交给转译器（`sugar.transpile`）——这里的对拍对象是**投影 + 分区**这条管线，
 * 服务用真转译器（`@kojo/plugin-kojo-sugar`，测试文件豁免插件交叉 import 纪律）。
 */
import { describe, expect, it } from 'vitest';
import type { ConventionCheckContext, ConventionProjectUnitEntry, ErbFile, Logger, SugarTranspileService } from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import {
  SUGAR_LINT_DIAGNOSTIC_CODES,
  createSugarStaticConventionsRule,
  sugarLintIssuesFrom,
} from '../src/rules/sugar-conventions';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const KOJO1 = '/p/kojo/a.kojo';
const KOJO2 = '/p/kojo/b.kojo';
const ERB = '/p/kojo/c.ERB';

const KOJO_SRC_1 =
  '角色: 12\n' +
  '时机 指令 310：\n' +
  '    「……续」\n' +
  '    她的心情 = 如果 她的好感度 >= 500：\n' +
  '        "热情"\n';

const KOJO_SRC_2 =
  '角色: 13\n' +
  '别名 基准 = 500\n' +
  '时机 指令 311：\n' +
  '    选项：\n' +
  '        「甲」：\n' +
  '            「……」\n' +
  '    选项：\n' +
  '        「乙」：\n' +
  '            「……」\n' +
  '    基准 = 600\n';

const SERVICE: SugarTranspileService = createSugarTranspileService({ faceTable: createEratwFaceTable() });

/** 转译器对这棵源文件认领的码（期望条数由它给出，本文件不写死数字） */
function adoptedCount(src: string, path: string): number {
  const codes = SUGAR_LINT_DIAGNOSTIC_CODES as readonly string[];
  return sugarLintIssuesFrom(
    SERVICE.transpile(src, { filePath: path }).diagnostics.filter((d) => codes.includes(d.code)),
    path,
  ).length;
}

function ctxFor(files: Record<string, string>, order: string[]): ConventionCheckContext {
  const map = new Map<string, ErbFile>();
  for (const p of order) map.set(p, parseErbText('', p));
  return {
    project: { rootDir: '/p', adapterId: 'test', kojoPaths: ['/p/kojo'], writablePaths: [], charaIndex: new Map() },
    index: { files: map, byName: new Map() },
    readFile: async (path: string) => {
      const t = files[path];
      if (t === undefined) throw new Error(`not found: ${path}`);
      return t;
    },
    log: silentLog,
  };
}

const rule = createSugarStaticConventionsRule(() => SERVICE);

async function viaPartition(ctx: ConventionCheckContext): Promise<ConventionProjectUnitEntry[]> {
  const entries: ConventionProjectUnitEntry[] = [];
  for (const file of ctx.index.files.values()) {
    entries.push({ file, unit: await rule.partition!.fileUnit(ctx, file) });
  }
  return entries;
}

describe('sugar.static-conventions 分区×全量对拍（判据来自转译器）', () => {
  it('两棵 .kojo 各含多项违规 + 一棵 .ERB ⇒ 逐条相同（顺序也同）', async () => {
    const files = { [KOJO1]: KOJO_SRC_1, [KOJO2]: KOJO_SRC_2, [ERB]: '@A\nPRINTL 1\n' };
    const ctx = ctxFor(files, [KOJO1, KOJO2, ERB]);
    const full = await rule.check!(ctx);
    // 条数由转译器当场给出（续入引号 + 缺否则 + 双选项 + 只读别名）；本文件不写死数字
    expect(full.length).toBe(adoptedCount(KOJO_SRC_1, KOJO1) + adoptedCount(KOJO_SRC_2, KOJO2));
    expect(full.length).toBe(4); // 四条码各一条 ⇒ 夹具确实命中全部四项判据（防对拍空转）
    const entries = await viaPartition(ctx);
    expect(await rule.partition!.combine(ctx, entries)).toEqual(full);
  });

  it('文件顺序颠倒 ⇒ 产出顺序随 walk 序（两路一致）', async () => {
    const files = { [KOJO1]: KOJO_SRC_1, [KOJO2]: KOJO_SRC_2 };
    const a = ctxFor(files, [KOJO1, KOJO2]);
    const b = ctxFor(files, [KOJO2, KOJO1]);
    const fullA = await rule.check!(a);
    const fullB = await rule.check!(b);
    const partA = await rule.partition!.combine(a, await viaPartition(a));
    const partB = await rule.partition!.combine(b, await viaPartition(b));
    expect(partA).toEqual(fullA);
    expect(partB).toEqual(fullB);
    const n1 = adoptedCount(KOJO_SRC_1, KOJO1);
    const n2 = adoptedCount(KOJO_SRC_2, KOJO2);
    expect(fullA.map((i) => i.filePath)).toEqual([...Array(n1).fill(KOJO1), ...Array(n2).fill(KOJO2)]);
    expect(fullB.map((i) => i.filePath)).toEqual([...Array(n2).fill(KOJO2), ...Array(n1).fill(KOJO1)]);
  });

  it('读盘失败的文件：两路都只 warn 跳过，其余文件照常产出，且分区不缓存该结论', async () => {
    const files = { [KOJO1]: KOJO_SRC_1 }; // KOJO2 缺席 ⇒ readFile 必抛
    const ctx = ctxFor(files, [KOJO1, KOJO2]);
    const full = await rule.check!(ctx);
    const entries = await viaPartition(ctx);
    const partitioned = await rule.partition!.combine(ctx, entries);
    expect(partitioned).toEqual(full);
    expect(full.every((i) => i.filePath === KOJO1)).toBe(true);
    expect(full.length).toBe(adoptedCount(KOJO_SRC_1, KOJO1));
    expect(full.length).toBeGreaterThan(0);
    // KOJO2 的单元 = undefined（无结论 ⇒ 引擎不入缓存）；KOJO1 = 结论数组
    expect(entries.find((e) => e.file.path === KOJO2)!.unit).toBeUndefined();
    expect(Array.isArray(entries.find((e) => e.file.path === KOJO1)!.unit)).toBe(true);
  });

  it('非 `.kojo` ⇒ 单元 null（不适用，可缓存）', async () => {
    const ctx = ctxFor({ [ERB]: '@A\nPRINTL 1\n' }, [ERB]);
    expect(await rule.partition!.fileUnit(ctx, { path: ERB } as ErbFile)).toBeNull();
  });

  it('isUnit：null 与"转译器码投影"的数组可还原，其余判死（含旧扫描产物形态）', () => {
    const isUnit = rule.partition!.isUnit!;
    expect(isUnit(null)).toBe(true);
    expect(isUnit([])).toBe(true);
    expect(isUnit([{ ruleId: 'sugar.cont-inside-quotes', severity: 'error', message: 'm' }])).toBe(true);
    expect(isUnit([{ ruleId: 'sugar.multiple-choice-blocks', severity: 'error', message: 'm' }])).toBe(false);
    expect(isUnit({ nope: true })).toBe(false);
    expect(isUnit(['not-an-issue'])).toBe(false);
  });
});
