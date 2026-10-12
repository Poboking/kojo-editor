import { describe, expect, it } from 'vitest';
import type { ErbFile } from '@kojo/plugin-api';
import {
  SNAPSHOT_VERSION,
  aggregateIndex,
  coerceSnapshot,
  diffSnapshot,
  mergeEntries,
  snapshotKeyFor,
  type IndexSnapshot,
  type SnapshotEntry,
} from '../src/snapshot';

const ROOT = 'D:/proj/eratw';

function file(path: string, names: readonly string[]): ErbFile {
  return {
    path,
    functions: names.map((name, i) => ({
      name,
      normalizedName: name.toUpperCase(),
      filePath: path,
      startLine: 1 + i * 10,
      endLine: 10 + i * 10,
      params: [],
      isFunction: true,
    })),
    dims: [],
    hasFunctionDirective: false,
    lineCount: 100,
  } as unknown as ErbFile;
}

function entry(path: string, mtimeMs: number | null, names: readonly string[]): SnapshotEntry {
  return { mtimeMs, textLength: 1000, file: file(path, names) };
}

function snapshot(entries: Record<string, SnapshotEntry>, rootDir = ROOT): IndexSnapshot {
  return { version: SNAPSHOT_VERSION, rootDir, savedAt: 1234, entries };
}

describe('snapshotKeyFor（存储键安全）', () => {
  it('产出安全段且确定', () => {
    const k = snapshotKeyFor(ROOT);
    expect(k).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/);
    expect(k).toBe(snapshotKeyFor(ROOT));
  });

  it('不同项目根 → 不同键（不串项目）', () => {
    expect(snapshotKeyFor('D:/a')).not.toBe(snapshotKeyFor('D:/b'));
  });

  it('键里带格式版本（升级格式时天然换键）', () => {
    expect(snapshotKeyFor(ROOT)).toContain(`v${SNAPSHOT_VERSION}`);
  });
});

describe('aggregateIndex（聚合必须与全量重建同源同序）', () => {
  it('按传入顺序聚合 byName；同名函数跨文件累积', () => {
    const { files, byName } = aggregateIndex([file('/a.ERB', ['FOO', 'BAR']), file('/b.ERB', ['FOO'])]);
    expect([...files.keys()]).toEqual(['/a.ERB', '/b.ERB']);
    expect(byName.get('FOO')!.map((r) => r.filePath)).toEqual(['/a.ERB', '/b.ERB']);
    expect(byName.get('BAR')).toHaveLength(1);
    expect(byName.get('BAR')![0]).toMatchObject({ name: 'BAR', filePath: '/a.ERB', startLine: 11, endLine: 20 });
  });
});

describe('diffSnapshot（保守失效）', () => {
  const snap = snapshot({
    '/a.ERB': entry('/a.ERB', 100, ['FOO']),
    '/b.ERB': entry('/b.ERB', null, ['BAR']), // 平台未提供 mtime
  });

  it('mtime 一致 → 复用；缺失 / 变了 / 任一侧 null → 过期', () => {
    const stats = new Map<string, { mtimeMs: number } | null>([
      ['/a.ERB', { mtimeMs: 100 }],
      ['/b.ERB', { mtimeMs: 100 }],
      ['/c.ERB', { mtimeMs: 100 }], // 快照里没有
      ['/d.ERB', null], // stat 失败
    ]);
    const d = diffSnapshot(snap, ['/a.ERB', '/b.ERB', '/c.ERB', '/d.ERB'], stats as never);
    expect(d.reusable).toEqual(['/a.ERB']);
    expect(d.stale).toEqual(['/b.ERB', '/c.ERB', '/d.ERB']);
  });

  it('mtime 是浮点也必须逐位相等（同源口径才可比）', () => {
    const stats = new Map<string, { mtimeMs: number } | null>([['/a.ERB', { mtimeMs: 100.5 }]]);
    expect(diffSnapshot(snap, ['/a.ERB'], stats as never).reusable).toEqual([]);
  });
});

describe('coerceSnapshot（fail-closed）', () => {
  it('合法快照 round-trip 后可还原', () => {
    const snap = snapshot({ '/a.ERB': entry('/a.ERB', 100, ['FOO']) });
    const back = coerceSnapshot(JSON.parse(JSON.stringify(snap)), ROOT);
    expect(back).not.toBeNull();
    expect(back!.entries['/a.ERB']!.file.functions[0]!.name).toBe('FOO');
  });

  it('版本 / 项目根 / 结构任一不符 → null（整体弃用，绝不修）', () => {
    const snap = snapshot({ '/a.ERB': entry('/a.ERB', 100, ['FOO']) });
    expect(coerceSnapshot({ ...snap, version: SNAPSHOT_VERSION + 1 }, ROOT)).toBeNull();
    expect(coerceSnapshot(snap, 'D:/other')).toBeNull();
    expect(coerceSnapshot({ ...snap, entries: { '/x.ERB': { mtimeMs: 1 } } }, ROOT)).toBeNull();
    expect(coerceSnapshot({ ...snap, entries: { '/a.ERB': { ...snap.entries['/a.ERB']!, file: { ...snap.entries['/a.ERB']!.file, path: '/other.ERB' } } } }, ROOT)).toBeNull();
    expect(coerceSnapshot('garbage', ROOT)).toBeNull();
    expect(coerceSnapshot(null, ROOT)).toBeNull();
  });
});

describe('mergeEntries（收尸 + 沿用）', () => {
  it('本次重扫的用新结果；其余沿用旧条目；消失的文件不保留', () => {
    const prev = snapshot({
      '/a.ERB': entry('/a.ERB', 100, ['FOO']),
      '/gone.ERB': entry('/gone.ERB', 100, ['GONE']),
    });
    const fresh = new Map<string, SnapshotEntry>([['/b.ERB', entry('/b.ERB', 200, ['NEW'])]]);
    const merged = mergeEntries(prev, ['/a.ERB', '/b.ERB'], fresh);
    expect(Object.keys(merged).sort()).toEqual(['/a.ERB', '/b.ERB']);
    expect(merged['/b.ERB']!.file.functions[0]!.name).toBe('NEW');
    expect(merged['/a.ERB']).toEqual(prev.entries['/a.ERB']);
    expect(merged['/gone.ERB']).toBeUndefined();
  });
});
