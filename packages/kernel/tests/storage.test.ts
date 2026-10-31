import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBridge, RawFileRead } from '@kojo/plugin-api';
import { FileStorageBackend, StorageServiceImpl, assertSafeSegment } from '../src/storage';
import type { StorageBackend, StorageReadResult } from '../src/storage';
import { MemoryStorageBackend } from './helpers/memory-storage';
import { NodeBridge } from './helpers/node-bridge';
import { newWireFacts, tauriShapedBridge, type WireFacts } from './helpers/ipc-shaped-bridge';

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

describe('存储域 · 文件后端（持久化路径）', () => {
  let appData: string;

  beforeEach(async () => {
    appData = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-store-'));
  });

  const makeStorage = () => new StorageServiceImpl(new FileStorageBackend(new NodeBridge(appData)));

  it('空作用域：目录不存在时 keys() 返回 []（首次启动 / 首次访问 / 清空数据后）', async () => {
    const storage = makeStorage();
    // 域目录从未创建
    await expect(storage.scope('fresh-plugin').keys()).resolves.toEqual([]);
    await expect(storage.global().keys()).resolves.toEqual([]);
    // read/remove 同样安全
    await expect(storage.scope('fresh-plugin').get('nope')).resolves.toBeUndefined();
    await expect(storage.scope('fresh-plugin').delete('nope')).resolves.toBeUndefined();
  });

  it('keys 只列本域；重新构造后端可跨会话读回（模拟重启）', async () => {
    const storage = makeStorage();
    await storage.scope('plugin-a').set('k1', { v: 1 });
    await storage.scope('plugin-a').set('k2', 2);
    await storage.scope('plugin-b').set('k3', 3);

    expect((await storage.scope('plugin-a').keys()).sort()).toEqual(['k1', 'k2']);

    // 新实例 + 新后端，指向同一 appData：等价于重启
    const restarted = makeStorage();
    expect(await restarted.scope('plugin-a').get('k1')).toEqual({ v: 1 });
    expect((await restarted.scope('plugin-a').keys()).sort()).toEqual(['k1', 'k2']);
  });
});

/**
 * PS-2①（PERF-14）：快照读从 `exists` + `readFileBytes` 两趟 IPC 合并为**一趟**
 * `readFilesRaw([path])`。以下逐条钉住"必须活下来的语义"：
 * missing ≠ unreadable、读失败出声且可区分、corrupt 是显式第三态、两桥同形守卫。
 */
describe('存储域 · 文件后端（PS-2：一趟 IPC + 显式三态）', () => {
  let appData: string;
  let warns: string[];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const keyPath = (scope: string, key: string) => path.join(appData, 'store', scope, `${key}.json`);
  /** 计数 + Tauri 形（JSON 过境建模）的桥：读路形状从这里读 */
  const wiredBridge = (): { bridge: PlatformBridge; facts: WireFacts } => {
    const facts = newWireFacts();
    return { bridge: tauriShapedBridge(new NodeBridge(appData), facts), facts };
  };

  beforeEach(async () => {
    appData = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-store-ps2-'));
    warns = [];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
      warns.push(String(m));
    });
  });
  afterEach(() => warnSpy.mockRestore());

  it('一次 get 只走一趟 readFilesRaw：exists 与单文件读零趟（两趟合一趟的结构性判据）', async () => {
    const { bridge, facts } = wiredBridge();
    const storage = new StorageServiceImpl(new FileStorageBackend(bridge));
    await storage.scope('p').set('snap', { v: 7 });
    facts.batchInvocations.length = 0;
    facts.batchReads.length = 0;

    expect(await storage.scope('p').get<{ v: number }>('snap')).toEqual({ v: 7 });
    expect(facts.existsCalls).toEqual([]);
    expect(facts.singleReads).toEqual([]);
    expect(facts.batchInvocations).toEqual([{ size: 1 }]);
    expect(facts.batchReads).toEqual([keyPath('p', 'snap')]);

    // 不存在键同样只一趟（候选键探测每次都从两趟降到一趟）
    facts.batchInvocations.length = 0;
    expect(await storage.scope('p').get('absent')).toBeUndefined();
    expect(facts.batchInvocations).toEqual([{ size: 1 }]);
    expect(facts.existsCalls).toEqual([]);
  });

  it('missing ≠ unreadable：缺失是首启语义（返回 undefined、不删任何东西、不冒充读失败）', async () => {
    const storage = new StorageServiceImpl(new FileStorageBackend(new NodeBridge(appData)));
    const s = storage.scope('fresh');
    expect(await s.get('nope')).toBeUndefined(); // 契约面：undefined
    expect(await s.entry('nope')).toEqual({ state: 'missing' }); // 状态面：明确"没有"
    expect(warns).toEqual([]); // 首启不该有读失败的动静
    // "不得删任何东西"：missing 不触发任何 removeFile（盘上无物可删，也绝不静默清别键）
    expect(await s.keys()).toEqual([]);
  });

  it('unreadable：读失败 → 出声 + 上抛（与 missing 可区分，调用方按重建处理）', async () => {
    const target = keyPath('p', 'boom');
    const broken = Object.assign(Object.create(new NodeBridge(appData)) as PlatformBridge, {
      readFilesRaw: async (): Promise<RawFileRead[]> => [
        { path: target, status: 'read-error', mtimeMs: null, size: null, data: new Uint8Array(0) },
      ],
    });
    const storage = new StorageServiceImpl(new FileStorageBackend(broken));
    await expect(storage.scope('p').get('boom')).rejects.toThrow(/unreadable/);
    expect(warns.some((w) => w.includes('unreadable'))).toBe(true);
    // 桥少回条目同样是 unreadable（不静默补位、不冒充 missing）
    const shorty = Object.assign(Object.create(new NodeBridge(appData)) as PlatformBridge, {
      readFilesRaw: async (): Promise<RawFileRead[]> => [],
    });
    await expect(new StorageServiceImpl(new FileStorageBackend(shorty)).scope('p').get('k')).rejects.toThrow(/unreadable/);
  });

  it('corrupt JSON 是显式第三态（旧的咽成 undefined 会静默解除下游 fail-closed 判死跟删）', async () => {
    const { bridge } = wiredBridge();
    const storage = new StorageServiceImpl(new FileStorageBackend(bridge));
    await fs.mkdir(path.dirname(keyPath('p', 'snap')), { recursive: true });
    await fs.writeFile(keyPath('p', 'snap'), '{ this is not json', 'utf8');

    // 契约投影不变：get 仍 undefined（旧消费者零改动）
    expect(await storage.scope('p').get('snap')).toBeUndefined();
    // 但状态可区分——这正是插件侧"损坏 ⇒ 删除 + 重建"分支重新生效的前提
    const e = await storage.scope('p').entry('snap');
    expect(e.state).toBe('corrupt');
    expect(warns.some((w) => w.includes('corrupted JSON'))).toBe(true);
    // 且 corrupt **不是** missing（missing 不许删、corrupt 许删——两态绝不能互混）
    expect(await storage.scope('p').entry('other')).toEqual({ state: 'missing' });
  });

  it('两桥同形守卫（PITFALLS 73 教训）：node 桥与 Tauri 形桥对同一盘上真相给出逐字一致的结果', async () => {
    await fs.mkdir(path.join(appData, 'store', 'p'), { recursive: true });
    await fs.writeFile(keyPath('p', 'good'), JSON.stringify({ v: 1 }), 'utf8');
    await fs.writeFile(keyPath('p', 'bad'), 'not-json{', 'utf8');

    const runOver = async (bridge: PlatformBridge) => {
      const storage = new StorageServiceImpl(new FileStorageBackend(bridge));
      return {
        good: await storage.scope('p').entry('good'),
        bad: await storage.scope('p').entry('bad'),
        absent: await storage.scope('p').entry('absent'),
      };
    };
    const node = await runOver(new NodeBridge(appData));
    const { bridge: shaped, facts } = wiredBridge();
    const tauriShaped = await runOver(shaped);

    // 三态逐字一致（corrupt 的 detail 带异常原文，比对状态与投影值）
    expect(tauriShaped).toEqual(node);
    expect(node.good).toEqual({ state: 'ok', value: { v: 1 } });
    expect((node.bad as { state: string }).state).toBe('corrupt');
    expect(node.absent).toEqual({ state: 'missing' });
    // 形状也一致：每键一趟批量读，零 exists、零单文件读
    expect(facts.existsCalls).toEqual([]);
    expect(facts.singleReads).toEqual([]);
    expect(facts.batchInvocations.every((b) => b.size === 1)).toBe(true);
    expect(facts.batchInvocations).toHaveLength(3);
  });
});

/**
 * 落盘屏障（E·R6，2026-10-31）。
 *
 * 背景：插件侧的写一律是 `void storage.set(...)`（索引快照 42.7M 码元 / 写窗口 0.7s 起）。
 * 宿主在"进程马上要走"的点上必须能问一句「还有几笔在飞、等不等得到」，否则整轮索引白算。
 * 这里的判据只钉屏障本身：等谁、等多久、等不完怎么报、失败算不算等到。
 */
describe('落盘屏障 flush（E·R6）', () => {
  /**
   * 写入可控：`release(key)` 之前这个键的 write 一直挂着——模拟"写还在飞"。
   * 按**键**放行而不是"一次全放"：否则"等待中新起的写"会被同一发 release 顺手放掉，
   * 那一条判据（屏障不追新账）就测不出来了。
   */
  class GatedBackend implements StorageBackend {
    readonly written: string[] = [];
    private readonly gates = new Map<string, (() => void)[]>();
    read(): Promise<StorageReadResult> { return Promise.resolve({ kind: 'missing' }); }
    write(_scope: string, key: string): Promise<void> {
      this.written.push(key);
      return new Promise<void>((resolve) => {
        const bucket = this.gates.get(key) ?? [];
        bucket.push(resolve);
        this.gates.set(key, bucket);
      });
    }
    remove(): Promise<void> { return Promise.resolve(); }
    list(): Promise<string[]> { return Promise.resolve([]); }
    release(key: string): void {
      const bucket = this.gates.get(key) ?? [];
      this.gates.delete(key);
      for (const g of bucket) g();
    }
    get inflight(): number {
      let n = 0;
      for (const bucket of this.gates.values()) n += bucket.length;
      return n;
    }
  }

  /** 让一笔 set 走到 backend.write（它前面有一跳 yieldToMain） */
  const reachWrite = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  it('没有在途写 ⇒ 立即返回，不白等', async () => {
    const storage = new StorageServiceImpl(new GatedBackend());
    const report = await storage.flush(500);
    expect(report).toEqual({ pending: 0, drained: true, ms: 0 });
  });

  it('有在途写 ⇒ 等它落地，且报出"等了几笔"', async () => {
    const backend = new GatedBackend();
    const storage = new StorageServiceImpl(backend);
    const writing = storage.scope('plugin-a').set('k', { v: 1 });
    const flushing = storage.flush(500);
    let settled = false;
    void flushing.then(() => { settled = true; });
    await reachWrite();
    expect(settled).toBe(false); // 写没落地，屏障就不许放行
    backend.release('k');
    await writing;
    expect(await flushing).toMatchObject({ pending: 1, drained: true });
  });

  it('超时 ⇒ drained:false 且按时返回（关窗这条路不许被写盘卡住）', async () => {
    const backend = new GatedBackend();
    const storage = new StorageServiceImpl(backend);
    const writing = storage.scope('plugin-a').set('k', 1);
    const startedAt = Date.now();
    const report = await storage.flush(20);
    const elapsed = Date.now() - startedAt;
    expect(report.pending).toBe(1);
    expect(report.drained).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(elapsed).toBeLessThan(500); // 有上限，不是"等到天荒地老"
    backend.release('k');
    await writing;
  });

  it('写失败也算"等到"：错误仍由原调用方接，屏障不吞也不改语义', async () => {
    const failing: StorageBackend = {
      read: () => Promise.resolve({ kind: 'missing' }),
      write: () => Promise.reject(new Error('boom')),
      remove: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    };
    const storage = new StorageServiceImpl(failing);
    const writing = storage.scope('plugin-a').set('k', 1);
    const report = await storage.flush(500);
    expect(report).toMatchObject({ pending: 1, drained: true });
    await expect(writing).rejects.toThrow('boom');
  });

  it('只等"叫它之前"那批：等待中新起的写不追（否则永远等不完）', async () => {
    const backend = new GatedBackend();
    const storage = new StorageServiceImpl(backend);
    const a = storage.scope('plugin-a');
    const first = a.set('k1', 1);
    const flushing = storage.flush(500);
    const second = a.set('k2', 2); // 屏障已经在等了，这一笔属于下一拍
    await reachWrite();
    backend.release('k1');
    await first;
    const report = await flushing;
    expect(report).toMatchObject({ pending: 1, drained: true });
    expect(backend.inflight).toBe(1); // k2 仍在飞——屏障没追它
    backend.release('k2');
    await second;
  });

  it('落地之后登记表清空（不攒幽灵，重复 flush 立刻返回）', async () => {
    const backend = new GatedBackend();
    const storage = new StorageServiceImpl(backend);
    const writing = storage.scope('plugin-a').set('k', 1);
    await reachWrite();
    backend.release('k');
    await writing;
    await new Promise((r) => setTimeout(r, 0));
    expect(await storage.flush(500)).toEqual({ pending: 0, drained: true, ms: 0 });
  });
});
