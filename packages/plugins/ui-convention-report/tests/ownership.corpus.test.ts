/**
 * 修法条目的角色/家族归属 —— **真实语料分布基线**（无游戏目录自动跳过，不失败）。
 *
 * 这批的价值主张是「作者看到的是『某角色有 4 条要改』，不是『某规则 137 条』」，
 * 而这句话成不成立**只能由真实语料回答**：三级判据各接住多少、分几组、未归属那一档多大，
 * 是设计判据，不是实现细节 —— 所以它进测试、不进文档。
 *
 * 阈值口径（本机基线语料实测，逐字读数见提交信息）：
 * - 只断言**下限/上限**，不钉死条数 —— 语料会换版（本机已换过三次），而"三级判据
 *   各接住多少"这个结构事实与版无关；
 * - 不变量（各分组之和 === 总条数、未归属组恒在最后且条数逐字相等）一律**相等**判据：
 *   这是总账，差一条就是静默。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConventionIssue, ConventionLinterService, ConventionReport, ErbParserService, GameProject } from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKernel, type Kernel } from '../../../kernel/src/kernel';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { MemoryStorageBackend } from '../../../kernel/tests/helpers/memory-storage';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createConventionLinterPlugin } from '@kojo/plugin-convention-linter';
import { attributeIssue, characterLabel, charaDirOwners, rollupByCharacter, rollupByFamily, type OwnershipDeps } from '../src/ownership';
import { buildGroupView } from '../src/view';

const SMOKE = process.env.KOJO_SMOKE_PROJECT;

describe.skipIf(!SMOKE)('修法条目归属 · 真实语料基线', () => {
  let kernel: Kernel;
  let project: GameProject;
  let report: ConventionReport;
  let ownership: OwnershipDeps;

  beforeAll(async () => {
    const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-ownership-corpus-'));
    kernel = await createKernel({
      platform: new NodeBridge(appData),
      plugins: [createErbParserPlugin(), createEratwAdapterPlugin(), createConventionLinterPlugin()],
      storageBackend: new MemoryStorageBackend(),
    });
    await kernel.start();
    project = await kernel.project.open(SMOKE!);
    const parser = kernel.services.get<ErbParserService>('erb.parser');
    await parser.ensureIndex();
    report = await kernel.services.get<ConventionLinterService>(WellKnownServices.ConventionLinter).run();
    // 与面板取法逐字一致（这条基线测的就是面板真正会算出来的那个东西）
    ownership = {
      familyIndex: kernel.slots.query('game.adapter')[0]?.adapter.functionFamilyIndex ?? null,
      functionAt: parser.functionAt ? (p: string, l: number) => parser.functionAt!(p, l) : undefined,
      dirOwners: charaDirOwners(project.charaIndex),
    };
    expect(report.failedRules).toEqual([]); // 规则不得静默失败，否则下面的分布是残缺数据
  }, 300_000);

  afterAll(async () => {
    if (kernel) await kernel.stop();
  }, 120_000);

  it('三级判据的真实接住率 + 总账不变量 + 聚合耗时', () => {
    const issues: readonly ConventionIssue[] = report.issues;
    const labelOf = (no: number): string => characterLabel(no, project.charaIndex);

    const t0 = Date.now();
    const chars = rollupByCharacter(issues, ownership, labelOf);
    const fams = rollupByFamily(issues, ownership, labelOf);
    const ms = Date.now() - t0;

    const s = chars.sourceCounts;
    const total = chars.total;
    expect(total).toBe(issues.length);
    expect(total).toBeGreaterThan(300); // 真实语料必然产出可观条目；掉了说明规则静默了
    const rate = (n: number): string => `${((n / total) * 100).toFixed(2)}%`;

    // —— 不变量：各分组之和 === 总条数；未归属最多一组、恒在最后、条数与"判据全部落空"逐字相等
    expect(chars.groups.reduce((x, g) => x + g.count, 0)).toBe(total);
    expect(fams.groups.reduce((x, g) => x + g.count, 0)).toBe(total);
    expect(chars.groups.filter((g) => g.residual).length).toBeLessThanOrEqual(1);
    const last = chars.groups.at(-1)!;
    if (s.none > 0) {
      expect(last.residual).toBe(true);
      expect(last.label).toBe('未归属角色');
      expect(last.count).toBe(s.none);
    } else {
      expect(last.residual).toBe(false);
    }
    expect(s.rule + s.function + s.dir + s.none).toBe(total);

    // —— 未归属那一档在真实数据上也必须"账对得上"：把后两级判据拔掉（无适配器家族规则、无目录表），
    //    剩下的就是只剩规则声明的那份分布 —— 这一档在本机基线上是空集，所以必须这样制造出来才测得到。
    const degraded = rollupByCharacter(issues, { familyIndex: null }, labelOf);
    expect(degraded.sourceCounts.function).toBe(0);
    expect(degraded.sourceCounts.dir).toBe(0);
    expect(degraded.groups.filter((g) => g.residual).reduce((x, g) => x + g.count, 0)).toBe(degraded.sourceCounts.none);
    expect(degraded.groups.reduce((x, g) => x + g.count, 0)).toBe(total);
    expect(degraded.sourceCounts.rule).toBe(s.rule); // 规则声明那一档与判据多少无关（不该被降级牵连）

    // —— 三级判据的下限（本机基线：注明 22.32% → +所在函数 84.87% → +所在目录 100%）
    expect(s.rule / total).toBeGreaterThan(0.15);
    expect((s.rule + s.function) / total).toBeGreaterThan(0.75); // 位置还原必须是主力，不是点缀
    expect((s.rule + s.function + s.dir) / total).toBeGreaterThan(0.95);

    // —— 家族侧：`''`（初始家族）与 null（无从判定）必须是两个数，合并就会把前者吞掉
    const owned = issues.map((i) => attributeIssue(i, ownership));
    const famNamed = owned.filter((o) => o.family && o.family !== '').length;
    const famInitial = owned.filter((o) => o.family === '').length;
    const famUnknown = total - famNamed - famInitial;
    expect(famNamed).toBeGreaterThan(0);
    expect(famInitial).toBeGreaterThan(0);
    expect(famUnknown / total).toBeLessThan(0.1);

    // —— 面板真拿到的那三个视角：分组数一致、总账那句话里的数字对得上
    const view = buildGroupView('character', issues, { ruleDescription: (id) => id, ownership, charaIndex: project.charaIndex });
    expect(view.groups.length).toBe(chars.groups.length);
    expect(view.summary).toContain(`按角色：${chars.groups.length} 组 · 合计 ${total} 处`);
    expect(chars.groups.length).toBeGreaterThan(50);

    const unownedRules = [...new Set(degraded.groups.at(-1)!.issues.map((i) => i.ruleId))];

    // —— 「要不要把约定条目接成波浪线」的代价读数（本批**没做**那一条，理由就在这两个数上）：
    //    单文件条目密度决定噪声量级，触及文件数决定 E3「全部修复」会把多少条数进"没有改法"。
    const perFile = new Map<string, number>();
    for (const i of issues) if (i.filePath) perFile.set(i.filePath, (perFile.get(i.filePath) ?? 0) + 1);
    const density = [...perFile.values()].sort((a, b) => b - a);
    const p90 = density[Math.floor(density.length * 0.1)] ?? 0;
    expect(p90).toBeLessThanOrEqual(10); // 九成文件 ≤10 条 ⇒ 噪声不是拦路石，缺逐条快修供方才是

    // eslint-disable-next-line no-console
    console.log(
      `[归属基线] 条目 ${total} 分布于 ${new Set(issues.map((i) => i.ruleId)).size} 条规则\n` +
        `  角色归属：规则注明 ${s.rule}(${rate(s.rule)}) + 所在函数 ${s.function}(${rate(s.function)}) = ${s.rule + s.function}(${rate(s.rule + s.function)})` +
        ` + 所在目录 ${s.dir}(${rate(s.dir)}) ⇒ 合计 ${total - s.none}(${rate(total - s.none)})，未归属 ${s.none}(${rate(s.none)})\n` +
        `  未归属那一档（拔掉后两级判据后 ${degraded.sourceCounts.none} 条）来自 ${unownedRules.length} 条规则：${unownedRules.join(' / ') || '（无）'}\n` +
        `  家族：具名 ${famNamed}(${rate(famNamed)}) / 初始家族 ${famInitial}(${rate(famInitial)}) / 无从判定 ${famUnknown}(${rate(famUnknown)})\n` +
        `  分组：角色 ${chars.groups.length} 组（最大 ${chars.groups[0]?.label}=${chars.groups[0]?.count}｜第二 ${chars.groups[1]?.count}｜中位 ${chars.groups[Math.floor(chars.groups.length / 2)]?.count}）` +
        `· 家族 ${fams.groups.length} 组（最大 ${fams.groups[0]?.label}=${fams.groups[0]?.count}）\n` +
        `  波浪线代价读数：触及 ${perFile.size} 份文件，单文件条目 max ${density[0]} / p90 ${p90} / 中位 ${density[Math.floor(density.length / 2)]}` +
        `（本批只接「跳到那一处」，未接装饰槽）\n` +
        `  聚合耗时 ${ms}ms（${total} 条 × 三级判据，纯函数，不在渲染路径上）；角色表 ${project.charaIndex.size} · 目录表 ${ownership.dirOwners?.length ?? 0} · 索引未变 ⇒ 与面板同一次计算`,
    );
  }, 300_000);
});
