import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createKernel } from '../../kernel/src/kernel';
import { NodeBridge } from '../../kernel/tests/helpers/node-bridge';
import { MemoryStorageBackend } from '../../kernel/tests/helpers/memory-storage';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createErakumamaidAdapterPlugin } from '@kojo/plugin-eraakumamaid-adapter';

/**
 * 双 adapter 共存闸（eraakumamaid 撞名激活必炸的回归钉）。
 *
 * 真实装配次序照 bootstrap.ts：eratw-adapter 开机常驻（kernel.start 激活）、
 * eraakumamaid-adapter 项目级（开项目前 registerPlugin 入场）。两枚插件的槽位
 * 贡献 id 一旦同槽同名，内核 SlotRegistry 抛错 → runtime 回滚后激活者的全部副作用
 * （game.adapter / file.changed 订阅一并消失）→ 该游戏项目无法识别。
 *
 * 装配桩照抄 search-scope.fixtures.test.ts：真内核 + NodeBridge 临时数据目录 +
 * 内存存储后端；这里不开真项目，只钉「两枚都活着、四类槽位贡献并存」这个集成面。
 */
describe('双 adapter 共存（eratw 常驻 × eraakumamaid 项目级）', () => {
  const kernelPromise = (async () => {
    const kernel = await createKernel({
      platform: new NodeBridge(mkdtempSync(join(tmpdir(), 'kojo-dual-adapter-'))),
      plugins: [createEratwAdapterPlugin()],
      storageBackend: new MemoryStorageBackend(),
    });
    await kernel.start();
    // 生产次序：项目级插件在 kernel.start 之后、开项目之前经 registerPlugin 入场
    await kernel.registerPlugin(createErakumamaidAdapterPlugin());
    return kernel;
  })();

  afterAll(async () => {
    const kernel = await kernelPromise;
    await kernel.stop();
  }, 30_000);

  it('两枚插件都 active，且没有任何 error 态', async () => {
    const kernel = await kernelPromise;
    for (const id of ['eratw-adapter', 'eraakumamaid-adapter']) {
      expect(kernel.plugins.get(id)?.status, id).toBe('active');
    }
    expect(kernel.plugins.list().filter((s) => s.status === 'error')).toEqual([]);
  });

  it('ui.panel：两块「我的口上项目」并存（各自命名空间，不再互相顶掉）', async () => {
    const kernel = await kernelPromise;
    const ids = kernel.slots.query('ui.panel').map((p) => p.id);
    expect(ids).toContain('kojo-projects');
    expect(ids).toContain('eraakumamaid.kojo-projects');
  });

  it('editor.command：两条导入命令并存（eratw 的原名保留，AM 归命名空间）', async () => {
    const kernel = await kernelPromise;
    const ids = kernel.slots.query('editor.command').map((c) => c.id);
    expect(ids).toContain('kojo.importKojoProject');
    expect(ids).toContain('eraakumamaid.importKojoProject');
  });

  it('game.adapter：两个适配器都在场（detect 轮询两边都到得了）', async () => {
    const kernel = await kernelPromise;
    const ids = kernel.slots.query('game.adapter').map((a) => a.id);
    expect(ids).toContain('eratw-adapter');
    expect(ids).toContain('eraakumamaid-adapter');
  });
});
