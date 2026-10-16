/**
 * PERF-12b 对拍（糖侧内置规则）：`sugar.static-conventions` 的分区路径
 * （逐文件 `fileUnit` ⇒ `combine`）与全量 `check` 在同输入下**逐条同产出**，
 * 含读盘失败文件的"跳过"口径（两边都只 warn 跳过、不产结论、不算失败）。
 */
import { describe, expect, it } from 'vitest';
import type { ConventionCheckContext, ConventionProjectUnitEntry, ErbFile, Logger } from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { sugarStaticConventionsRule } from '../src/rules/sugar-conventions';

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
  '基准 = 600\n';

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

async function viaPartition(ctx: ConventionCheckContext): Promise<ConventionProjectUnitEntry[]> {
  const entries: ConventionProjectUnitEntry[] = [];
  for (const file of ctx.index.files.values()) {
    entries.push({ file, unit: await sugarStaticConventionsRule.partition!.fileUnit(ctx, file) });
  }
  return entries;
}

describe('sugar.static-conventions 分区×全量对拍', () => {
  it('两棵 .kojo 各含多项违规 + 一棵 .ERB ⇒ 逐条相同（顺序也同）', async () => {
    const files = { [KOJO1]: KOJO_SRC_1, [KOJO2]: KOJO_SRC_2, [ERB]: '@A\nPRINTL 1\n' };
    const ctx = ctxFor(files, [KOJO1, KOJO2, ERB]);
    const full = await sugarStaticConventionsRule.check!(ctx);
    expect(full.length).toBe(4); // §3.3 续入引号 + §3.5 缺否则 + §3.7 双选项 + §5.0 只读别名（夹具自证）
    const entries = await viaPartition(ctx);
    expect(await sugarStaticConventionsRule.partition!.combine(ctx, entries)).toEqual(full);
  });

  it('文件顺序颠倒 ⇒ 产出顺序随 walk 序（两路一致）', async () => {
    const files = { [KOJO1]: KOJO_SRC_1, [KOJO2]: KOJO_SRC_2 };
    const a = ctxFor(files, [KOJO1, KOJO2]);
    const b = ctxFor(files, [KOJO2, KOJO1]);
    const fullA = await sugarStaticConventionsRule.check!(a);
    const fullB = await sugarStaticConventionsRule.check!(b);
    const partA = await sugarStaticConventionsRule.partition!.combine(a, await viaPartition(a));
    const partB = await sugarStaticConventionsRule.partition!.combine(b, await viaPartition(b));
    expect(partA).toEqual(fullA);
    expect(partB).toEqual(fullB);
    expect(fullA.map((i) => i.filePath)).toEqual([KOJO1, KOJO1, KOJO2, KOJO2]);
    expect(fullB.map((i) => i.filePath)).toEqual([KOJO2, KOJO2, KOJO1, KOJO1]);
  });

  it('读盘失败的文件：两路都只 warn 跳过，其余文件照常产出，且分区不缓存该结论', async () => {
    const files = { [KOJO1]: KOJO_SRC_1 }; // KOJO2 缺席 ⇒ readFile 必抛
    const ctx = ctxFor(files, [KOJO1, KOJO2]);
    const full = await sugarStaticConventionsRule.check!(ctx);
    const entries = await viaPartition(ctx);
    const partitioned = await sugarStaticConventionsRule.partition!.combine(ctx, entries);
    expect(partitioned).toEqual(full);
    expect(full.every((i) => i.filePath === KOJO1)).toBe(true);
    expect(full.length).toBe(2);
    // KOJO2 的单元 = undefined（无结论 ⇒ 引擎不入缓存）；KOJO1 = 结论数组
    expect(entries.find((e) => e.file.path === KOJO2)!.unit).toBeUndefined();
    expect(Array.isArray(entries.find((e) => e.file.path === KOJO1)!.unit)).toBe(true);
  });

  it('isUnit：null（非糖文件）与结论数组可还原，乱结构判死', () => {
    const isUnit = sugarStaticConventionsRule.partition!.isUnit!;
    expect(isUnit(null)).toBe(true);
    expect(isUnit([])).toBe(true);
    expect(isUnit([{ ruleId: 'x', severity: 'error', message: 'm' }])).toBe(true);
    expect(isUnit({ nope: true })).toBe(false);
    expect(isUnit(['not-an-issue'])).toBe(false);
  });
});
