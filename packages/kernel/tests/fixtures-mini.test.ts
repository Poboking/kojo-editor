import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ConditionExtractorService, ConventionLinterService, ErbParserService } from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKernel } from '../src/kernel';
import { NodeBridge } from './helpers/node-bridge';
import { MemoryStorageBackend } from './helpers/memory-storage';
import { createErbParserPlugin, scanControlFlow } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createConventionLinterPlugin } from '@kojo/plugin-convention-linter';
import { createConditionExtractorPlugin, conditionExtractorTasks } from '@kojo/plugin-condition-extractor';

/**
 * 「迷你模式」集成冒烟 —— 用**合成 fixtures**（`fixtures/mini-game/`）验证整条只读管线，
 * 让没有真实 eraTW 目录的贡献者也能跑通：detect → CHARA 映射 → 口上索引 → 家族识别
 * → 约定校验 → 条件抽取（含 adapter 变量字典标注）。
 *
 * fixtures 由 `node tools/gen-fixtures.mjs` 生成（已入库）；缺失时整组跳过。
 * 真实游戏全量冒烟见 `integration-plugins.test.ts`（需 KOJO_SMOKE_PROJECT）。
 */
const MINI_DIR = fileURLToPath(new URL('../../../fixtures/mini-game/', import.meta.url));

describe.skipIf(!existsSync(MINI_DIR))('迷你模式集成冒烟（合成 fixtures）', () => {
  it('detect → 角色映射 → 索引 → 家族识别 → 校验 → 条件抽取', async () => {
    const kernel = await createKernel({
      platform: new NodeBridge(mkdtempSync(nodeJoin(tmpdir(), 'kojo-mini-'))),
      plugins: [
        createErbParserPlugin(),
        createEratwAdapterPlugin(),
        createConventionLinterPlugin(),
        createConditionExtractorPlugin(),
      ],
      storageBackend: new MemoryStorageBackend(),
    });
    // 宿主装配（与 app/bootstrap 同构）：本测试不走 app 装配层，而条件抽取的
    // compute 任务需要跨插件合成（扫描器来自 erb-parser），插件不会自己注册——
    // 不注册则无 worker 通道时 offload 抛 "No local implementation"。
    for (const [kind, impl] of Object.entries(conditionExtractorTasks(scanControlFlow))) {
      kernel.compute.registerTask(kind, impl as never);
    }
    await kernel.start();

    const project = await kernel.project.open(MINI_DIR);
    expect(project.adapterId).toBe('eratw');
    expect(project.charaIndex.size).toBe(2);
    expect(project.charaIndex.get(1)?.kojoDir).toBeTruthy();
    expect(project.charaIndex.get(1)?.name).toBe('测试角色');

    // 索引：kojoPaths 下 2 个 ERB（001/002）
    const parser = kernel.services.get<ErbParserService>('erb.parser');
    const index = await parser.ensureIndex();
    expect(index.files.size).toBe(2);
    let totalFunctions = 0;
    for (const f of index.files.values()) totalFunctions += f.functions.length;
    expect(totalFunctions).toBeGreaterThan(0);

    // 家族识别（adapter 规则）：家族名 REMU，面 MESSAGE_COM
    const rule = kernel.slots.query('game.adapter')[0]?.adapter.functionFamilyIndex;
    const m = rule!.match('M_KOJO_REMU_MESSAGE_COM_K1_1');
    expect(m?.characterNo).toBe(1);
    expect(m?.family).toBe('REMU');
    expect(m?.face).toBe('MESSAGE_COM');

    // 口上调用协议（路由表 → 槽位）：%KOJO_NAME% 家族模板命中 1 个数值槽
    const protocol = kernel.slots.query('game.adapter')[0]?.adapter.kojoCallProtocol;
    expect(protocol?.slotsFor('M_KOJO_REMU_MESSAGE_COM_K1_1')).toHaveLength(1);

    // 约定校验：规则不得静默失败
    const linter = kernel.services.get<ConventionLinterService>(WellKnownServices.ConventionLinter);
    const report = await linter.run();
    expect(report.failedRules).toEqual([]);
    expect(report.ruleCount).toBe(7); // 内置 2 + adapter 5

    // 条件抽取 + adapter 变量字典标注（CFLAG:2 → 好感度）
    const extractor = kernel.services.get<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
    const condIndex = await extractor.ensureIndex();
    expect(condIndex.stats.predicates).toBeGreaterThan(0);
    expect(condIndex.stats.unparsed).toBe(0);
    const favor = [...condIndex.byFunction.values()]
      .flatMap((fc) => fc.dependencies)
      .find((d) => d.key === 'CFLAG:2');
    expect(favor?.schema?.description).toBe('好感度');

    await kernel.stop();
  }, 60_000);
});