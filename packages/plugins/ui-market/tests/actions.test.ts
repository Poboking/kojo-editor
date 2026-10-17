import { describe, expect, it, vi } from 'vitest';
import { MarketError, type FileIO, type InstalledPack, type Logger, type MarketPublishOutcome, type PackFileEntry } from '@kojo/plugin-api';
import {
  runPublish,
  snapshotWithInstalled,
  snapshotWithoutInstalled,
  type MarketSnapshot,
} from '../src/actions';

const hex = (c: string): string => c.repeat(64);

const files = (...bytes: number[]): PackFileEntry[] =>
  bytes.map((b, i) => ({ path: `files/a${i}.txt`, bytes: b, sha256: hex(String(i)) }));

const rec = (over: Partial<InstalledPack> = {}): InstalledPack => ({
  kind: 'kojo-pack',
  id: 'demo.pack',
  version: '1.0.0',
  name: '演示口上包',
  author: '某人',
  license: 'CC-BY-NC 4.0',
  contentDigest: hex('b'),
  installedAt: 1_700_000_000_000,
  files: files(100, 200),
  ...over,
});

const snap = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  status: 'ready',
  packs: [],
  installed: [],
  installedBytes: 0,
  dropped: [],
  reason: '',
  fetchedAt: 1_700_000_000_000,
  generatedAt: '2026-10-15T00:00:00Z',
  endpoint: 'https://example.test/index.json',
  pullNote: '',
  ...over,
});

describe('乐观更新：snapshotWithoutInstalled（卸载）', () => {
  it('只删精确 (kind,id,version) 那条，其余原样保留', () => {
    const a = rec();
    const newer = rec({ version: '1.0.1' });
    const other = rec({ kind: 'dict-pack', id: 'other.pack' });
    const before = snap({ installed: [a, newer, other], installedBytes: 900 });
    const after = snapshotWithoutInstalled(before, a);
    expect(after.installed).toEqual([newer, other]);
    // 同 id 低版本那条（newer）不受牵连：卸 1.0.0 不动 1.0.1
    expect(after.installed).toContain(newer);
  });

  it('bytes 按该条 files[] 声明之和扣减（= 服务 installedBytes 的求和口径）', () => {
    const a = rec({ files: files(100, 200) });
    const other = rec({ id: 'other.pack', files: files(500) });
    const before = snap({ installed: [a, other], installedBytes: 800 });
    const after = snapshotWithoutInstalled(before, a);
    expect(after.installedBytes).toBe(500);
  });

  it('不可变：原快照不被改动', () => {
    const a = rec();
    const before = snap({ installed: [a], installedBytes: 300 });
    snapshotWithoutInstalled(before, a);
    expect(before.installed).toHaveLength(1);
    expect(before.installedBytes).toBe(300);
  });
});

describe('乐观更新：snapshotWithInstalled（安装）', () => {
  it('同键 (kind,id,version) 原位替换，bytes 按"旧条目 → 新条目"翻账，其余条目不动', () => {
    const oldRec = rec({ files: files(50) });
    const other = rec({ id: 'other.pack', files: files(500) });
    const fresh = rec({ files: files(300) });
    const before = snap({ installed: [oldRec, other], installedBytes: 550 });
    const after = snapshotWithInstalled(before, fresh);
    expect(after.installed).toEqual([fresh, other]);
    expect(after.installedBytes).toBe(800); // 550 - 50 + 300
  });

  it('异键追加，bytes 累加新条目 files[] 之和', () => {
    const kept = rec({ id: 'kept.pack', files: files(500) });
    const fresh = rec({ files: files(100, 200) });
    const before = snap({ installed: [kept], installedBytes: 500 });
    const after = snapshotWithInstalled(before, fresh);
    expect(after.installed).toEqual([kept, fresh]);
    expect(after.installedBytes).toBe(800);
  });

  it('不可变：原快照不被改动', () => {
    const kept = rec();
    const fresh = rec({ id: 'fresh.pack' });
    const before = snap({ installed: [kept], installedBytes: 300 });
    snapshotWithInstalled(before, fresh);
    expect(before.installed).toEqual([kept]);
    expect(before.installedBytes).toBe(300);
  });
});

describe('runPublish（MK-PUB 通道：选 zip → 服务编排）', () => {
  const quietLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  // EventBus 夹具：本通道只 emit 不订阅，on/once 给空退订即可
  const busStub = {
    on: () => () => {},
    once: () => () => {},
    emit: () => {},
  };

  const depsWith = (publish: (p: string, o?: { onProgress?: (x: unknown) => void }) => Promise<unknown>) => ({
    market: { publish } as unknown as Parameters<typeof runPublish>[0]['market'],
    bus: busStub,
    log: quietLog,
  });

  const ioWith = (choose: FileIO['chooseFile']): Pick<FileIO, 'chooseFile'> => ({ chooseFile: choose });

  it('平台没有 chooseFile（Node 壳）⇒ 一句人话收场，服务一次都不被叫', async () => {
    const publish = vi.fn(async () => ({}) as unknown as MarketPublishOutcome);
    const out = await runPublish(depsWith(publish as never), undefined);
    expect(out.kind).toBe('failed');
    expect(out.note).toContain('没有文件选择能力');
    expect(publish).not.toHaveBeenCalled();
  });

  it('作者取消对话框 ⇒ cancel 单独一档（取消不是失败），服务不被叫', async () => {
    const publish = vi.fn(async () => ({}) as unknown as MarketPublishOutcome);
    const out = await runPublish(
      depsWith(publish as never),
      ioWith(async () => null),
    );
    expect(out.kind).toBe('cancel');
    expect(out.note).toBe('已取消发布，本机没动');
    expect(publish).not.toHaveBeenCalled();
  });

  it('选定 zip ⇒ 服务收到路径与 onProgress 透传；ok 裁决出 PR 链接', async () => {
    const seen: Array<string | undefined> = [];
    const outcome: MarketPublishOutcome = {
      ok: true,
      prUrl: 'https://github.com/example/registry/pull/7',
      verified: 'structure-only',
      status: 200,
      finalUrl: 'https://github.com/example/registry/pull/7',
    };
    const publish = vi.fn(async (p: string, o?: { onProgress?: (x: unknown) => void }) => {
      seen.push(p);
      o?.onProgress?.({ sentBytes: 1, totalBytes: 2 });
      return outcome;
    });
    let progress = 0;
    const out = await runPublish(
      depsWith(publish as never),
      ioWith(async () => 'C:\\tmp\\包.zip'),
      (p) => {
        progress += p.totalBytes;
      },
    );
    expect(out.kind).toBe('done');
    expect(out.note).toContain('https://github.com/example/registry/pull/7');
    expect(seen).toEqual(['C:\\tmp\\包.zip']);
    expect(progress).toBe(2); // 进度帧透传到位
  });

  it('本地预校验拒因（MarketError）⇒ failed + 人话 note + 机器细节进 log.warn', async () => {
    const warns: string[] = [];
    const deps = {
      market: {
        publish: async () => {
          throw new MarketError('bytes-limit', '包体 1 字节超过发布上限 95_000_000');
        },
      } as never,
      bus: busStub,
      log: { ...quietLog, warn: (m: string) => warns.push(m) } as Logger,
    };
    const out = await runPublish(deps, ioWith(async () => 'C:\\tmp\\包.zip'));
    expect(out.kind).toBe('failed');
    expect(out.note).toContain('发布没有成功');
    expect(out.note).not.toContain('95_000_000'); // 人话换掉了服务侧原话（平台模式命中）
    expect(warns.join('\n')).toContain('bytes-limit'); // 机器细节只进日志
  });

  it('平台侧故障（编排层已包前缀）⇒ 原样上屏不叠两层；选择框抛错也给一句', async () => {
    const depsFail = {
      market: {
        publish: async () => {
          throw new Error('发布没有成功：断网');
        },
      } as never,
      bus: busStub,
      log: quietLog,
    };
    const out = await runPublish(depsFail, ioWith(async () => 'C:\\tmp\\包.zip'));
    expect(out.note).toBe('发布没有成功：断网');

    const outPickFail = await runPublish(
      depsWith(async () => ({}) as unknown as MarketPublishOutcome),
      ioWith(async () => {
        throw new Error('对话框被组策略拦了');
      }),
    );
    expect(outPickFail.kind).toBe('failed');
    expect(outPickFail.note).toBe('没能打开文件选择：对话框被组策略拦了');
  });
});
