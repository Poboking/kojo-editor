/**
 * `ContentManager` 的运维面：卸载 / 启停 / 排序 / 诊断。
 *
 * 三条纪律在这里被钉住：
 * - 卸载只删**本包独占**的 ownership 记录（两个包写同一路径 ⇒ 那条不删，只记 warning）；
 * - 任何启停 / 卸载 / 排序都**先停游戏**（宿主命令次序断言）；
 * - 诊断是只读汇总，人话 `warnings` + 机器码表分开。
 */

import { describe, expect, it } from 'vitest';
import { makeContentHarness } from './helpers/content-harness';
import {
  makeContentFile,
  makeContentManifest,
  makeInstalledContent,
} from './helpers/fake-host';
import type { ContentDiagnosisReport } from '../src/content-manager';

function packOf(id: string, files: Array<[string, string]>, extra: {
  readonly order?: number;
  readonly enabled?: boolean;
  readonly requires?: readonly { id: string; version: string }[];
} = {}) {
  return makeInstalledContent({
    manifest: makeContentManifest({
      id,
      files: files.map(([rootId, path]) => makeContentFile(rootId, path, 1)),
      ...(extra.requires === undefined ? {} : { requires: extra.requires }),
    }),
    ...(extra.order === undefined ? {} : { order: extra.order }),
    ...(extra.enabled === undefined ? {} : { enabled: extra.enabled }),
    ownedFiles: files.map(([rootId, path]) => ({ rootId, path })),
  });
}

describe('内容包列表', () => {
  it('直接透传宿主读数，宿主错误码原样带出', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [packOf('a.pack', [['script', 'mod/a.txt']])]);

    const list = await harness.manager.list('i1');
    expect(list.map((pack) => pack.manifest.id)).toEqual(['a.pack']);

    harness.host.listError = { code: 'LAUNCHER_CONTENT_BROKEN', message: '内容目录不可读' };
    await expect(harness.manager.list('i1')).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_BROKEN',
      message: '内容目录不可读',
      detail: '读取已装内容失败',
    });
  });
});

describe('内容包卸载 · 只删自己的文件', () => {
  it('两个包写同一路径 ⇒ 那条不进删除清单，另一个包的文件原地不动', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [
      packOf('a.pack', [
        ['script', 'mod/a.txt'],
        ['data', 'data/shared.csv'],
      ]),
      packOf('b.pack', [['data', 'data/shared.csv']]),
    ]);
    harness.host.gameFiles.add('script/mod/a.txt');
    harness.host.gameFiles.add('data/data/shared.csv');

    const task = await harness.manager.uninstall('i1', 'a.pack');

    expect(harness.host.uninstallRequests).toEqual([
      { instanceId: 'i1', packId: 'a.pack', files: ['script/mod/a.txt'] },
    ]);
    expect(harness.host.writeLog).toEqual(['delete:script/mod/a.txt']);
    expect(harness.host.gameFiles.has('data/data/shared.csv')).toBe(true);
    expect(task.result?.sharedPaths).toEqual([
      { rootId: 'data', path: 'data/shared.csv', otherPackId: 'b.pack' },
    ]);
    expect(harness.host.packs.get('i1')?.map((pack) => pack.manifest.id)).toEqual(['b.pack']);
  });

  it('大小写不同的同名路径也算「别的包写过」（Windows 上就是同一个文件）', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [
      packOf('a.pack', [['data', 'Data/Config.csv']]),
      packOf('b.pack', [['data', 'data/config.csv']]),
    ]);

    await harness.manager.uninstall('i1', 'a.pack');

    expect(harness.host.uninstallRequests[0]?.files).toEqual([]);
    expect(harness.host.writeLog).toEqual([]);
  });

  it('未安装的包 ⇒ LAUNCHER_CONTENT_BROKEN（不猜、不静默成功）', async () => {
    const harness = makeContentHarness();

    await expect(harness.manager.uninstall('i1', 'ghost.pack')).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_BROKEN',
      message: '该内容包未安装，或安装记录已损坏',
      detail: 'packId=ghost.pack',
    });
    expect(harness.host.calls).toEqual(['contentList:i1']);
  });

  it('游戏在跑时先停再卸（调用次序）', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [packOf('a.pack', [['script', 'mod/a.txt']])]);
    harness.setRunning(true);

    await harness.manager.uninstall('i1', 'a.pack');

    const stopAt = harness.host.calls.indexOf('stop');
    const uninstallAt = harness.host.calls.findIndex((call) => call.startsWith('contentUninstall'));
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(uninstallAt).toBeGreaterThan(stopAt);
  });

  it('游戏没在跑时不发 stop（ProcessSupervisor 幂等，不惊动宿主）', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [packOf('a.pack', [['script', 'mod/a.txt']])]);

    await harness.manager.uninstall('i1', 'a.pack');

    expect(harness.host.calls).toEqual(['contentList:i1', 'contentUninstall:i1:a.pack']);
  });
});

describe('内容包启停', () => {
  it('启用：先停游戏再写，任务 kind 为 content-toggle', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [packOf('a.pack', [['script', 'mod/a.txt']], { enabled: false })]);
    harness.setRunning(true);

    const task = await harness.manager.setEnabled('i1', 'a.pack', true);

    const stopAt = harness.host.calls.indexOf('stop');
    const writeAt = harness.host.calls.findIndex((call) => call.startsWith('contentSetEnabled'));
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThan(stopAt);
    expect(harness.host.calls[writeAt]).toBe('contentSetEnabled:i1:a.pack:true');
    expect(task.kind).toBe('content-toggle');
    expect(task.result).toEqual({ packId: 'a.pack', enabled: true });
    expect(harness.host.packs.get('i1')?.[0]?.enabled).toBe(true);
  });

  it('宿主失败 ⇒ 码透传，启用状态不半截、锁也不残留', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [packOf('a.pack', [['script', 'mod/a.txt']], { enabled: true })]);
    harness.host.setEnabledError = { code: 'LAUNCHER_CONTENT_BROKEN', message: '有文件被占用' };

    await expect(harness.manager.setEnabled('i1', 'a.pack', false)).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_BROKEN',
      message: '有文件被占用',
      detail: '停用内容包失败',
    });
    expect(harness.host.packs.get('i1')?.[0]?.enabled).toBe(true);

    harness.host.setEnabledError = null;
    await expect(harness.manager.setEnabled('i1', 'a.pack', false)).resolves.toMatchObject({
      state: 'succeeded',
    });
    expect(harness.host.packs.get('i1')?.[0]?.enabled).toBe(false);
  });

  it('未安装的包不能启停', async () => {
    const harness = makeContentHarness();

    await expect(harness.manager.setEnabled('i1', 'ghost.pack', true)).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_BROKEN',
      message: '该内容包未安装，无法切换启停',
    });
    expect(harness.host.calls).toEqual(['contentList:i1']);
  });

  it('宿主报「没在运行」⇒ 继续（不当失败处理）', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [packOf('a.pack', [['script', 'mod/a.txt']], { enabled: false })]);
    harness.setRunning(true);
    harness.host.stopImpl = async () => {
      throw { code: 'LAUNCHER_INSTANCE_NOT_FOUND', message: '该实例没有在运行的进程' };
    };

    const task = await harness.manager.setEnabled('i1', 'a.pack', true);

    expect(task.state).toBe('succeeded');
    expect(harness.host.packs.get('i1')?.[0]?.enabled).toBe(true);
  });

  it('停游戏失败（非「未运行」）⇒ 一个字节都不写', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [packOf('a.pack', [['script', 'mod/a.txt']], { enabled: false })]);
    harness.setRunning(true);
    harness.host.stopImpl = async () => {
      throw { code: 'LAUNCHER_INTERNAL', message: '杀不掉进程' };
    };

    await expect(harness.manager.setEnabled('i1', 'a.pack', true)).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      message: '杀不掉进程',
    });
    expect(harness.host.calls.some((call) => call.startsWith('contentSetEnabled'))).toBe(false);
    expect(harness.host.packs.get('i1')?.[0]?.enabled).toBe(false);
  });
});

describe('内容包排序', () => {
  it('合法排列原样交给宿主，顺序落地', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [
      packOf('a.pack', [['script', 'mod/a.txt']], { order: 0 }),
      packOf('b.pack', [['script', 'mod/b.txt']], { order: 1 }),
    ]);

    await harness.manager.setOrder('i1', ['b.pack', 'a.pack']);

    expect(harness.host.orderRequests).toEqual([{ instanceId: 'i1', packIds: ['b.pack', 'a.pack'] }]);
    const packs = harness.host.packs.get('i1') ?? [];
    expect(packs.find((pack) => pack.manifest.id === 'b.pack')?.order).toBe(0);
    expect(packs.find((pack) => pack.manifest.id === 'a.pack')?.order).toBe(1);
  });

  it('含未安装的包 ⇒ 拒，宿主零写入', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [packOf('a.pack', [['script', 'mod/a.txt']])]);

    await expect(harness.manager.setOrder('i1', ['a.pack', 'ghost.pack'])).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_CONFLICT',
      message: '加载顺序里有未安装的包，已拒绝',
      detail: 'ghost.pack',
    });
    expect(harness.host.calls).toEqual(['contentList:i1']);
  });

  it('漏掉已安装的包 ⇒ 拒（不「尽量排」）', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [
      packOf('a.pack', [['script', 'mod/a.txt']]),
      packOf('b.pack', [['script', 'mod/b.txt']], { order: 1 }),
    ]);

    await expect(harness.manager.setOrder('i1', ['a.pack'])).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_CONFLICT',
      message: '加载顺序漏掉了已安装的包，已拒绝',
      detail: 'b.pack',
    });
    expect(harness.host.calls).toEqual(['contentList:i1']);
  });

  it('重复 id ⇒ 拒', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [packOf('a.pack', [['script', 'mod/a.txt']])]);

    await expect(harness.manager.setOrder('i1', ['a.pack', 'a.pack'])).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_CONFLICT',
      message: '加载顺序里同一个包出现了两次，已拒绝',
      detail: 'a.pack',
    });
  });

  it('游戏在跑时先停再写', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [
      packOf('a.pack', [['script', 'mod/a.txt']], { order: 0 }),
      packOf('b.pack', [['script', 'mod/b.txt']], { order: 1 }),
    ]);
    harness.setRunning(true);

    await harness.manager.setOrder('i1', ['b.pack', 'a.pack']);

    const stopAt = harness.host.calls.indexOf('stop');
    const orderAt = harness.host.calls.findIndex((call) => call.startsWith('contentSetOrder'));
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(orderAt).toBeGreaterThan(stopAt);
  });

  it('宿主失败 ⇒ 码透传且锁释放（可以立刻重试）', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [packOf('a.pack', [['script', 'mod/a.txt']])]);
    harness.host.setOrderError = { code: 'LAUNCHER_CONTENT_BROKEN', message: '顺序文件写不进去' };

    await expect(harness.manager.setOrder('i1', ['a.pack'])).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_BROKEN',
      message: '顺序文件写不进去',
      detail: '调整加载顺序失败',
    });

    harness.host.setOrderError = null;
    await expect(harness.manager.setOrder('i1', ['a.pack'])).resolves.toBeUndefined();
    expect(harness.host.orderRequests).toEqual([{ instanceId: 'i1', packIds: ['a.pack'] }]);
  });
});

describe('内容包诊断（只读）', () => {
  it('映射宿主诊断：孤儿文件与顺序异常落到 conflict，人话前缀区分，码表不出界', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [
      packOf('a.pack', [['script', 'mod/x.txt']], { order: 0 }),
      packOf('b.pack', [['script', 'mod/y.txt']], { order: 1 }),
    ]);
    harness.host.diagnoses.set('i1', {
      instanceId: 'i1',
      issues: [
        { packId: 'b.pack', code: 'load-order', message: '与 a.pack 同序' },
        { packId: 'a.pack', code: 'missing-file', path: 'mod/x.txt', message: 'mod/x.txt 不在盘上' },
        { packId: 'a.pack', code: 'orphan-file', path: 'data/old.csv', message: 'data/old.csv 不属于任何包' },
      ],
    });

    const report = (await harness.manager.diagnose('i1')) as ContentDiagnosisReport;

    expect(report.instanceId).toBe('i1');
    expect(report.checkedAt).toBe('2026-10-26T12:00:00.000Z');
    expect(report.issues).toEqual([
      {
        packId: 'a.pack',
        code: 'conflict',
        path: 'data/old.csv',
        message: '孤儿文件：data/old.csv 不属于任何包',
      },
      {
        packId: 'a.pack',
        code: 'missing-file',
        path: 'mod/x.txt',
        message: '文件缺失：mod/x.txt 不在盘上',
      },
      { packId: 'b.pack', code: 'conflict', message: '启用顺序异常：与 a.pack 同序' },
    ]);
    expect(report.warnings).toEqual([
      '共检出 3 项内容问题',
      'a.pack：孤儿文件：data/old.csv 不属于任何包',
      'a.pack：文件缺失：mod/x.txt 不在盘上',
      'b.pack：启用顺序异常：与 a.pack 同序',
    ]);
    // 只读：只有 list + diagnose 两条命令，没有任何写面
    expect(harness.host.calls).toEqual(['contentList:i1', 'contentDiagnose:i1']);
  });

  it('篡改与归属冲突按契约码原样透传（只补人话前缀）', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [packOf('a.pack', [['script', 'mod/a.txt']])]);
    harness.host.diagnoses.set('i1', {
      instanceId: 'i1',
      issues: [
        { packId: 'a.pack', code: 'hash-mismatch', path: 'mod/a.txt', message: '哈希与安装记录不符' },
        { packId: 'a.pack', code: 'conflict', path: 'mod/a.txt', message: '与 b.pack 声明同一路径' },
      ],
    });

    const report = (await harness.manager.diagnose('i1')) as ContentDiagnosisReport;

    expect(report.issues).toEqual([
      {
        packId: 'a.pack',
        code: 'conflict',
        path: 'mod/a.txt',
        message: '文件归属冲突：与 b.pack 声明同一路径',
      },
      {
        packId: 'a.pack',
        code: 'hash-mismatch',
        path: 'mod/a.txt',
        message: '文件被改动：哈希与安装记录不符',
      },
    ]);
  });

  it('本层补「依赖缺失」：requires 指向未安装的包', async () => {    const harness = makeContentHarness();
    harness.host.packs.set('i1', [
      packOf('a.pack', [['script', 'mod/a.txt']], { requires: [{ id: 'b.pack', version: '1.0.0' }] }),
    ]);

    const report = (await harness.manager.diagnose('i1')) as ContentDiagnosisReport;

    expect(report.issues).toEqual([
      { packId: 'a.pack', code: 'missing-dependency', message: '依赖缺失：需要 b.pack 1.0.0' },
    ]);
  });

  it('本层补「启用顺序异常」：两个启用的包并列同一 order', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [
      packOf('a.pack', [['script', 'mod/a.txt']], { order: 0 }),
      packOf('b.pack', [['script', 'mod/b.txt']], { order: 0 }),
    ]);

    const report = (await harness.manager.diagnose('i1')) as ContentDiagnosisReport;

    expect(report.issues).toEqual([
      { packId: 'a.pack', code: 'conflict', message: '启用顺序异常：与 b.pack 并列在 0，加载次序不确定' },
      { packId: 'b.pack', code: 'conflict', message: '启用顺序异常：与 a.pack 并列在 0，加载次序不确定' },
    ]);
  });

  it('一切正常时 issues 与 warnings 都是空的（不编造问题）', async () => {
    const harness = makeContentHarness();
    harness.host.packs.set('i1', [
      packOf('a.pack', [['script', 'mod/a.txt']], { order: 0 }),
      packOf('b.pack', [['script', 'mod/b.txt']], { order: 1 }),
    ]);

    const report = (await harness.manager.diagnose('i1')) as ContentDiagnosisReport;

    expect(report.issues).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('诊断命令失败 ⇒ 码透传', async () => {
    const harness = makeContentHarness();
    harness.host.diagnoseError = { code: 'LAUNCHER_CONTENT_BROKEN', message: '内容记录损坏' };

    await expect(harness.manager.diagnose('i1')).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_BROKEN',
      message: '内容记录损坏',
      detail: '内容诊断失败',
    });
  });
});
