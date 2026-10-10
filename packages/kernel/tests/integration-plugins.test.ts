import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConventionLinterService, ErbParserService } from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKernel } from '../src/kernel';
import { NodeBridge } from './helpers/node-bridge';
import { MemoryStorageBackend } from './helpers/memory-storage';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createConventionLinterPlugin } from '@kojo/plugin-convention-linter';

/**
 * 真实工程集成冒烟 —— 直接检验各阶段验收标准：
 * - v0.1：「选定有效 eraTW 目录后：CHARA CSV 映射解析成功，能列出 kojoPaths 下全部文件与函数清单」；
 * - v0.2：「按角色/家族浏览 99k 函数」的前提（家族识别覆盖）+ 约定校验器在真实数据上产出问题。
 *
 * 真实游戏数据不入库：通过环境变量 `KOJO_SMOKE_PROJECT` 指定本地游戏目录；
 * 未设置时整组跳过（CI 安全）。
 */
const SMOKE_DIR = process.env.KOJO_SMOKE_PROJECT;

describe.skipIf(!SMOKE_DIR)('真实 eraTW 工程集成冒烟', () => {
  it(
    'onboarding → CHARA 映射 → 口上域全量函数索引 → 约定校验',
    async () => {
      const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-smoke-'));
      const kernel = await createKernel({
        platform: new NodeBridge(appData),
        plugins: [createErbParserPlugin(), createEratwAdapterPlugin(), createConventionLinterPlugin()],
        storageBackend: new MemoryStorageBackend(),
      });
      await kernel.start();

      // 1. 插件接线
      const states = new Map(kernel.plugins.list().map((s) => [s.id, s]));
      expect(states.get('erb-parser')?.status).toBe('active');
      expect(states.get('eratw-adapter')?.status).toBe('active');
      expect(states.get('convention-linter')?.status).toBe('active');

      // 2. onboarding（内核对全部 adapter 候选轮询 detect）
      const project = await kernel.project.open(SMOKE_DIR!);
      expect(project.adapterId).toBe('eratw');
      expect(project.charaIndex.size).toBeGreaterThan(100);
      expect(project.charaIndex.get(1)?.kojoDir).toBeTruthy();
      expect(project.savDir).toBeTruthy();

      // 3. 口上域全量索引（解析器在 project.opened 已自动构建，此处取用）
      const parser = kernel.services.get<ErbParserService>('erb.parser');
      const index = await parser.ensureIndex();
      expect(parser.currentIndex()).toBe(index);

      let totalFunctions = 0;
      let expressionFuncs = 0;
      for (const f of index.files.values()) {
        totalFunctions += f.functions.length;
        expressionFuncs += f.functions.filter((x) => x.isExpressionFunction).length;
      }

      // 实测规模（2026-10-09 逆向普查）：155 角色目录 / 2,285 ERB / 99,028 函数
      expect(index.files.size).toBeGreaterThan(1000);
      expect(totalFunctions).toBeGreaterThan(50000);

      // 抽样：灵梦的初始剧本函数应存在（K1 家族）
      const k1 = [...index.byName.keys()].filter((n) => n.includes('M_KOJO') && n.includes('_K1'));
      expect(k1.length).toBeGreaterThan(50);

      // 4. 家族识别覆盖率（FamilyIndexRule 对全量函数名）
      const adapterRule = kernel.slots.query('game.adapter')[0]?.adapter.functionFamilyIndex;
      expect(adapterRule).toBeTruthy();
      let matched = 0;
      let unmatched = 0;
      let placeholders = 0;
      const families = new Set<string>();
      // 导航地基（v0.2 第二批）：角色 → 家族 → 面 三维在真实数据上非平凡
      const byChara = new Map<number, { families: Set<string>; faces: Set<string>; count: number }>();
      for (const refs of index.byName.values()) {
        for (const ref of refs) {
          const m = adapterRule!.match(ref.name);
          if (m) {
            matched++;
            if (m.isPlaceholder) placeholders++;
            if (m.family) families.add(m.family);
            if (m.characterNo !== null) {
              let entry = byChara.get(m.characterNo);
              if (!entry) {
                entry = { families: new Set(), faces: new Set(), count: 0 };
                byChara.set(m.characterNo, entry);
              }
              entry.count++;
              entry.families.add(m.family);
              if (m.face) entry.faces.add(m.face);
            }
          } else {
            unmatched++;
          }
        }
      }
      const familyRate = matched / (matched + unmatched);
      expect(familyRate).toBeGreaterThan(0.95);

      // 三维导航前提：多数角色可归属；家族聚合与面聚合都非退化为单点
      expect(byChara.size).toBeGreaterThan(100);
      const multiFamilyCharas = [...byChara.values()].filter((e) => e.families.size > 1).length;
      expect(multiFamilyCharas).toBeGreaterThan(0);
      const multiFaceCharas = [...byChara.values()].filter((e) => e.faces.size > 3).length;
      expect(multiFaceCharas).toBeGreaterThan(50);
      const busiest = [...byChara.entries()].sort((a, b) => b[1].count - a[1].count)[0];

      // 5. 约定校验（v0.2 验收：真实数据上产出可操作问题清单）
      const linter = kernel.services.get<ConventionLinterService>(WellKnownServices.ConventionLinter);
      const report = await linter.run();
      expect(report.failedRules).toEqual([]); // 规则不得静默失败
      expect(report.ruleCount).toBe(5); // 引擎内置 1 + adapter 4
      expect(report.issues.length).toBeGreaterThan(0);

      const byRule = new Map<string, number>();
      for (const issue of report.issues) byRule.set(issue.ruleId, (byRule.get(issue.ruleId) ?? 0) + 1);

      // KX 占位符：实测千级（按去重函数名计，2026-10-09 普查=603）
      expect(byRule.get('eratw.kx-placeholder') ?? 0).toBeGreaterThan(100);
      // FORM 三连符号：收窄后只留真实事故（排除 `+++` 的有意主人名占位），实测个位数
      const formHits = byRule.get('eratw.form-triple-symbol') ?? 0;
      expect(formHits).toBeGreaterThan(0);
      expect(formHits).toBeLessThan(100);

      // eslint-disable-next-line no-console
      console.log(
        `[smoke] 角色 ${project.charaIndex.size} | ERB 文件 ${index.files.size} | ` +
          `函数 ${totalFunctions}（含表达式函数 ${expressionFuncs}）| 去重名 ${index.byName.size}\n` +
          `[smoke] 家族识别 ${matched}/${matched + unmatched} = ${(familyRate * 100).toFixed(2)}% | ` +
          `家族数 ${families.size} | KX 占位符残留（去重名）${placeholders}\n` +
          `[smoke] 导航地基：可归属角色 ${byChara.size} | 多家族角色 ${multiFamilyCharas} | ` +
          `多面（>3）角色 ${multiFaceCharas} | ` +
          `最重角色 K${busiest?.[0]}（${busiest?.[1].count} 函数 / ${busiest?.[1].families.size} 家族）\n` +
          `[smoke] 约定校验 ${report.issues.length} 项 ` +
          `(error ${report.counts.error} / warning ${report.counts.warning} / info ${report.counts.info}) ` +
          `in ${report.durationMs}ms\n` +
          `[smoke] 分规则：${[...byRule.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`,
      );

      await kernel.stop();
    },
    180_000,
  );
});
