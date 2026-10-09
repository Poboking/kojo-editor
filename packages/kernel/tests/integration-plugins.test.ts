import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErbParserService } from '@kojo/plugin-api';
import { createKernel } from '../src/kernel';
import { NodeBridge } from './helpers/node-bridge';
import { MemoryStorageBackend } from './helpers/memory-storage';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';

/**
 * 真实工程集成冒烟 —— v0.1 验收标准的直接检验：
 * 「选定有效 eraTW 目录后：CHARA CSV 映射解析成功，能列出 kojoPaths 下全部文件与函数清单」。
 *
 * 真实游戏数据不入库：通过环境变量 `KOJO_SMOKE_PROJECT` 指定本地游戏目录；
 * 未设置时整组跳过（CI 安全）。
 */
const SMOKE_DIR = process.env.KOJO_SMOKE_PROJECT;

describe.skipIf(!SMOKE_DIR)('真实 eraTW 工程集成冒烟', () => {
  it(
    'onboarding → CHARA 映射 → 口上域全量函数索引',
    async () => {
      const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-smoke-'));
      const kernel = await createKernel({
        platform: new NodeBridge(appData),
        plugins: [createErbParserPlugin(), createEratwAdapterPlugin()],
        storageBackend: new MemoryStorageBackend(),
      });
      await kernel.start();

      // 1. 插件接线
      const states = new Map(kernel.plugins.list().map((s) => [s.id, s]));
      expect(states.get('erb-parser')?.status).toBe('active');
      expect(states.get('eratw-adapter')?.status).toBe('active');

      // 2. onboarding（内核对全部 adapter 候选轮询 detect）
      const project = await kernel.project.open(SMOKE_DIR!);
      expect(project.adapterId).toBe('eratw');
      expect(project.charaIndex.size).toBeGreaterThan(100);
      expect(project.charaIndex.get(1)?.kojoDir).toBeTruthy();
      expect(project.savDir).toBeTruthy();

      // 3. 口上域全量索引
      const parser = kernel.services.get<ErbParserService>('erb.parser');
      const index = await parser.buildIndex(project.kojoPaths);

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
      for (const refs of index.byName.values()) {
        for (const ref of refs) {
          const m = adapterRule!.match(ref.name);
          if (m) {
            matched++;
            if (m.isPlaceholder) placeholders++;
            if (m.family) families.add(m.family);
          } else {
            unmatched++;
          }
        }
      }
      const familyRate = matched / (matched + unmatched);
      expect(familyRate).toBeGreaterThan(0.95);

      // eslint-disable-next-line no-console
      console.log(
        `[smoke] 角色 ${project.charaIndex.size} | ERB 文件 ${index.files.size} | ` +
          `函数 ${totalFunctions}（含表达式函数 ${expressionFuncs}）| 去重名 ${index.byName.size}\n` +
          `[smoke] 家族识别 ${matched}/${matched + unmatched} = ${(familyRate * 100).toFixed(2)}% | ` +
          `家族数 ${families.size} | KX 占位符残留 ${placeholders}`,
      );

      await kernel.stop();
    },
    180_000,
  );
});
