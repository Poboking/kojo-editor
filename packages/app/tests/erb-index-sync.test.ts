import { describe, expect, it, vi } from 'vitest';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, ErbParserService } from '@kojo/plugin-api';
import { planIndexDelta, syncErbIndexAfterDiskChange, type DiskDelta } from '../src/ui/erb-index-sync';

/**
 * 盘上改动 → 索引增量的接线（WS-05，2026-10-27）。
 *
 * 两条腿各钉各的：`planIndexDelta` 是纯函数（目录改名按前缀映射、删除按前缀移除、
 * 同路径去重），`syncErbIndexAfterDiskChange` 是"谁被叫、失败怎么出声"。
 * 这里**不**碰真解析器：增量语义归 `erb-parser` 的单测，这一层只管把事实说对。
 */

const DIR = 'C:/game/ERB/001';
const DIR_NEW = 'C:/game/ERB/00X';
const A = `${DIR}/a.ERB`;
const B = `${DIR}/sub/b.ERM`;
const OTHER = 'C:/game/ERB/002/c.ERB';

const paths = (delta: DiskDelta, indexed: readonly string[] = [A, B, OTHER]): ReturnType<typeof planIndexDelta> =>
  planIndexDelta(indexed, delta);

describe('planIndexDelta · 纯判据', () => {
  it('目录改名：旧目录按前缀移除，其下已索引文件整体映射到新前缀', () => {
    const delta = paths({ renamed: [{ from: DIR, to: DIR_NEW }] });
    expect(delta.removed).toEqual([DIR]);
    expect(delta.changed).toEqual([`${DIR_NEW}/a.ERB`, `${DIR_NEW}/sub/b.ERM`]);
  });

  it('文件改名：恰好一格搬家（新路径重读、旧路径移出）', () => {
    const delta = paths({ renamed: [{ from: A, to: `${DIR}/renamed.ERB` }] });
    expect(delta.changed).toEqual([`${DIR}/renamed.ERB`]);
    expect(delta.removed).toEqual([A]);
  });

  it('删除目录：只交目录那一条（前缀语义交给解析器，不在这里逐条算出子路径）', () => {
    const delta = paths({ removed: [DIR] });
    expect(delta.removed).toEqual([DIR]);
    expect(delta.changed).toEqual([]);
  });

  it('新建文件：不在索引里也照交（解析器负责读盘与扩展名判定）', () => {
    const delta = paths({ changed: [`${DIR}/fresh.ERB`] });
    expect(delta.changed).toEqual([`${DIR}/fresh.ERB`]);
    expect(delta.removed).toEqual([]);
  });

  it('同一路径只出现一次（写法变体算同一条），且 changed 胜过 removed', () => {
    const delta = paths({
      changed: [A, 'c:/game/erb/001/A.erb'],
      removed: [A],
    });
    expect(delta.changed).toEqual([A]);
    expect(delta.removed).toEqual([]);
  });

  it('原地改名（只是写法不同）零动作', () => {
    const delta = paths({ renamed: [{ from: DIR, to: 'c:\\game\\erb\\001' }] });
    expect(delta).toEqual({ changed: [], removed: [] });
  });

  it('空 / 非法输入一律忽略（不许把垃圾路径塞进索引操作）', () => {
    const delta = planIndexDelta([A], {
      // 字段整个缺席（undefined）与传成 null 是同一件事：都当"这一类没有"，不许抛
      changed: null as unknown as string[],
      removed: [undefined as unknown as string, '', null as unknown as string],
      renamed: [{ from: '', to: 'x' }, { from: 'y', to: '' }, null as unknown as { from: string; to: string }],
    });
    expect(delta).toEqual({ changed: [], removed: [] });
  });
});

type SyncKernel = Pick<Kernel, 'services'>;

function fakeKernel(service: Partial<ErbParserService> | null): SyncKernel {
  return {
    services: {
      tryGet: (key: string) => (key === 'erb.parser' ? (service ?? undefined) : undefined),
    },
  } as unknown as SyncKernel;
}

function fakeIndex(): ErbIndex {
  return { files: new Map([A, B].map((p) => [p, { path: p }])) } as unknown as ErbIndex;
}

describe('syncErbIndexAfterDiskChange · 谁被叫、失败怎么出声', () => {
  it('索引还没建好 ⇒ 整趟跳过（不是失败；下一次整扫自会读到盘上现状）', async () => {
    const apply = vi.fn();
    const outcome = await syncErbIndexAfterDiskChange({
      kernel: fakeKernel({ applyFileChanges: apply } as Partial<ErbParserService>),
      index: null,
      notify: vi.fn(),
      delta: { changed: [A] },
    });
    expect(outcome).toBe('skipped');
    expect(apply).not.toHaveBeenCalled();
  });

  it('解析器没提供增量（旧实现）⇒ unsupported，不抛、不假装成功', async () => {
    const outcome = await syncErbIndexAfterDiskChange({
      kernel: fakeKernel({ currentIndex: () => null } as Partial<ErbParserService>),
      index: fakeIndex(),
      notify: vi.fn(),
      delta: { changed: [A] },
    });
    expect(outcome).toBe('unsupported');
  });

  it('服务键缺席（浏览器壳 / 插件未装）⇒ unsupported', async () => {
    const outcome = await syncErbIndexAfterDiskChange({
      kernel: fakeKernel(null),
      index: fakeIndex(),
      notify: vi.fn(),
      delta: { removed: [DIR] },
    });
    expect(outcome).toBe('unsupported');
  });

  it('成功：把规划后的两表原样交给解析器（目录改名 → removed 旧目录 + changed 新路径）', async () => {
    const apply = vi.fn(async () => null);
    const outcome = await syncErbIndexAfterDiskChange({
      kernel: fakeKernel({ applyFileChanges: apply } as Partial<ErbParserService>),
      index: fakeIndex(),
      notify: vi.fn(),
      delta: { renamed: [{ from: DIR, to: DIR_NEW }] },
    });
    expect(outcome).toBe('applied');
    expect(apply).toHaveBeenCalledWith({
      changed: [`${DIR_NEW}/a.ERB`, `${DIR_NEW}/sub/b.ERM`],
      removed: [DIR],
    });
  });

  it('零改动 ⇒ 跳过（不为"什么都没变"多跑一趟）', async () => {
    const apply = vi.fn(async () => null);
    const outcome = await syncErbIndexAfterDiskChange({
      kernel: fakeKernel({ applyFileChanges: apply } as Partial<ErbParserService>),
      index: fakeIndex(),
      notify: vi.fn(),
      delta: {},
    });
    expect(outcome).toBe('skipped');
    expect(apply).not.toHaveBeenCalled();
  });

  it('失败必须出声：通知里带原始原因（不静默留幽灵行）', async () => {
    const notify = vi.fn();
    const outcome = await syncErbIndexAfterDiskChange({
      kernel: fakeKernel({
        applyFileChanges: async () => {
          throw new Error('IPC 断了');
        },
      } as Partial<ErbParserService>),
      index: fakeIndex(),
      notify,
      delta: { changed: [A] },
    });
    expect(outcome).toBe('failed');
    expect(notify).toHaveBeenCalledTimes(1);
    const notice = notify.mock.calls[0]![0] as { kind: string; message: string };
    expect(notice.kind).toBe('error');
    expect(notice.message).toContain('索引增量更新失败');
    expect(notice.message).toContain('IPC 断了');
  });
});
