import { describe, expect, it } from 'vitest';
import { StorageServiceImpl, assertSafeSegment } from '../src/storage';
import { MemoryStorageBackend } from './helpers/memory-storage';

describe('存储域', () => {
  it('域隔离：插件 A 写的数据，插件 B 读不到', async () => {
    const storage = new StorageServiceImpl(new MemoryStorageBackend());
    const a = storage.scope('plugin-a');
    const b = storage.scope('plugin-b');
    await a.set('cfg', { v: 1 });
    expect(await a.get('cfg')).toEqual({ v: 1 });
    expect(await b.get('cfg')).toBeUndefined();
  });

  it('keys 只列本域', async () => {
    const storage = new StorageServiceImpl(new MemoryStorageBackend());
    const a = storage.scope('plugin-a');
    const b = storage.scope('plugin-b');
    await a.set('k1', 1);
    await a.set('k2', 2);
    await b.set('k3', 3);
    expect((await a.keys()).sort()).toEqual(['k1', 'k2']);
    expect(await b.keys()).toEqual(['k3']);
  });

  it('路径穿越 key / scope 被拒绝', async () => {
    const storage = new StorageServiceImpl(new MemoryStorageBackend());
    const a = storage.scope('plugin-a');
    await expect(a.set('../evil', 1)).rejects.toThrow(/Invalid storage key/);
    await expect(a.set('..', 1)).rejects.toThrow(/Invalid storage key/);
    await expect(a.set('a/b', 1)).rejects.toThrow(/Invalid storage key/);
    expect(() => storage.scope('../evil')).toThrow(/Invalid storage scope/);
    expect(() => storage.scope('a\\b')).toThrow(/Invalid storage scope/);
  });

  it('assertSafeSegment 边界：下划线开头合法（_global），点开头非法', () => {
    expect(() => assertSafeSegment('scope', '_global')).not.toThrow();
    expect(() => assertSafeSegment('scope', '.hidden')).toThrow();
    expect(() => assertSafeSegment('key', 'a.b-c_d')).not.toThrow();
    expect(() => assertSafeSegment('key', 'a..b')).toThrow();
    expect(() => assertSafeSegment('key', '')).toThrow();
    expect(() => assertSafeSegment('key', 'x'.repeat(121))).toThrow();
  });

  it('global 域独立于任何插件域', async () => {
    const storage = new StorageServiceImpl(new MemoryStorageBackend());
    const g = storage.global();
    await g.set('recent', [1, 2]);
    expect(await g.get('recent')).toEqual([1, 2]);
    expect(await storage.scope('_global').get('recent')).toEqual([1, 2]);
  });

  it('delete 移除数据', async () => {
    const storage = new StorageServiceImpl(new MemoryStorageBackend());
    const a = storage.scope('p');
    await a.set('t', 1);
    await a.delete('t');
    expect(await a.get('t')).toBeUndefined();
  });
});
