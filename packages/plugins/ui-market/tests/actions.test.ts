import { describe, expect, it } from 'vitest';
import type { InstalledPack, PackFileEntry } from '@kojo/plugin-api';
import {
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
