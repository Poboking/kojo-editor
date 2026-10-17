/**
 * 测试替身（W6 名录批专用；**刻意不塞进 `support.ts`**——那是别的批次也在改的共享夹具）。
 *
 * 只给 `kojo-sugar` 装配真正会读的三件：分野表（用户函数的产物名由它的命名模板生成，
 * 缺席就是一条都产不出来）、指令/变量表留空（本批的语料用不到），四个必填字段按
 * `GameAdapter` 的形状摆齐。断言贴近生产、又不假装是完整适配器（同 `stubDict` 的口径）。
 */

import type { GameAdapterContribution } from '@kojo/plugin-api';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';

export function stubEratwAdapterContribution(): GameAdapterContribution {
  return {
    id: 'eratw',
    adapter: {
      gameId: 'eratw',
      displayName: 'eraTW（测试替身）',
      detect: async () => true,
      loadProject: async () => {
        throw new Error('测试替身不加载项目');
      },
      kojoFaceTemplates: createEratwFaceTable(),
    },
  } as unknown as GameAdapterContribution;
}
