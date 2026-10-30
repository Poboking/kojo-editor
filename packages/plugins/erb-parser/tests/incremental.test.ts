import { describe, expect, it } from 'vitest';
import type { ErbFile, ErbIndex } from '@kojo/plugin-api';
import { applyIndexDelta, type IncrementalFileUpdate } from '../src/incremental';
import { aggregateIndex } from '../src/snapshot';

/**
 * WS-05 增量索引的**纯判据**（2026-10-27）。
 *
 * 这一层只钉"新索引对象怎么算"：删除按前缀、更新按覆盖、输入不动、byname / 指纹重算、
 * 反向引用刻意不带。读盘 / 去抖 / 回退整扫归 `plugin.ts`（在 `plugin.test.ts` 里钉）。
 */

function erbFile(path: string, names: readonly string[]): ErbFile {
  return {
    path,
    functions: names.map((name, i) => ({
      name,
      normalizedName: name.toUpperCase(),
      filePath: path,
      startLine: i + 1,
      endLine: i + 2,
    })),
  } as unknown as ErbFile;
}

function indexOf(files: readonly ErbFile[], mtimeMs = 10): ErbIndex {
  const aggregated = aggregateIndex(files);
  return {
    files: aggregated.files,
    byName: aggregated.byName,
    fingerprint: 'fp-old',
    fileMtimes: new Map(files.map((f) => [f.path, mtimeMs])),
    fileSizes: new Map(files.map((f) => [f.path, 100])),
  };
}

function update(path: string, names: readonly string[], size = 200): IncrementalFileUpdate {
  return { path, file: erbFile(path, names), mtimeMs: 20, size };
}

const A = '/p/kojo/a.ERB';
const B = '/p/kojo/sub/b.ERB';
const C = '/p/kojo/c.ERB';

describe('applyIndexDelta（WS-05）', () => {
  it('更新 = 原地替换：byName 换成新函数、旧函数退场，文件表不增行', () => {
    const base = indexOf([erbFile(A, ['OLD']), erbFile(B, ['KEEP'])]);
    const result = applyIndexDelta({ index: base, updated: [update(A, ['NEW'])], removed: [] });

    expect(result.replaced).toBe(1);
    expect(result.added).toBe(0);
    expect([...result.index.byName.keys()].sort()).toEqual(['KEEP', 'NEW']);
    expect(result.index.byName.has('OLD')).toBe(false);
    expect(result.index.files.size).toBe(2);
    expect(result.index.fileMtimes!.get(A)).toBe(20);
    expect(result.index.fileSizes!.get(A)).toBe(200);
  });

  it('新增 = 追加（files / byName / 逐文件 mtime,size 同步长一行）', () => {
    const base = indexOf([erbFile(A, ['A'])]);
    const result = applyIndexDelta({ index: base, updated: [update(C, ['C'])], removed: [] });

    expect(result.added).toBe(1);
    expect([...result.index.files.keys()].sort()).toEqual([A, C]);
    expect(result.index.byName.defsOf('C')).toHaveLength(1);
    expect(result.index.fileMtimes!.has(C)).toBe(true);
  });

  it('删除**按前缀**：目录下的每一格都退场，别处的同名后缀不受牵连', () => {
    const neighbour = '/p/kojo/sub-备份/x.ERB';
    const base = indexOf([erbFile(A, ['A']), erbFile(B, ['B']), erbFile(neighbour, ['X'])]);
    const result = applyIndexDelta({ index: base, updated: [], removed: ['/p/kojo/sub'] });

    expect(result.dropped).toBe(1);
    expect([...result.index.files.keys()].sort()).toEqual([A, neighbour]);
    expect(result.index.byName.has('B')).toBe(false);
    expect(result.index.byName.has('X')).toBe(true);
    expect(result.index.fileMtimes!.has(B)).toBe(false);
  });

  it('删 + 改名后的新路径同时到达：旧条目退场、新条目进来（目录改名的正确形态）', () => {
    const base = indexOf([erbFile(B, ['B'])]);
    const moved = '/p/kojo/00X/b.ERB';
    const result = applyIndexDelta({
      index: base,
      updated: [update(moved, ['B'])],
      removed: ['/p/kojo/sub'],
    });

    expect([...result.index.files.keys()]).toEqual([moved]);
    expect(result.index.byName.defsOf('B')![0]!.filePath).toBe(moved);
  });

  it('输入那份索引一个字段都不动（返回新对象、Map 不共享）', () => {
    const base = indexOf([erbFile(A, ['A'])]);
    const beforeFiles = base.files;
    const beforeMtimes = base.fileMtimes;
    const result = applyIndexDelta({ index: base, updated: [update(C, ['C'])], removed: [A] });

    expect(result.index).not.toBe(base);
    expect(base.files).toBe(beforeFiles);
    expect(base.files.has(C)).toBe(false); // 输入没被写进新路径
    expect(base.files.has(A)).toBe(true); // 输入也没被删
    expect(base.fileMtimes).toBe(beforeMtimes);
  });

  it('指纹按余下条目的 path+mtime+size 重算（改了就不是旧的）', () => {
    const base = indexOf([erbFile(A, ['A'])]);
    const same = applyIndexDelta({ index: base, updated: [], removed: [] });
    // 没改动 ⇒ 同一批事实仍得到同一枚指纹（重算而不是搬运字段）
    expect(same.index.fingerprint).toBeTruthy();
    const changed = applyIndexDelta({ index: base, updated: [update(A, ['A'], 999)], removed: [] });
    expect(changed.index.fingerprint).not.toBe(same.index.fingerprint);
  });

  it('反向引用刻意不带：增量结果里没有 references（保守失效，等下一次整扫）', () => {
    const base = indexOf([erbFile(A, ['A'])]);
    const result = applyIndexDelta({ index: base, updated: [update(A, ['A'])], removed: [] });
    expect(result.index.references).toBeUndefined();
  });
});
