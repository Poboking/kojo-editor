/**
 * 深解析记忆（2026-10-18 性能批）。
 *
 * 钉的是两头：
 * 1. **收益**＝同一个 (路径, mtime, size, 选项) 不再每次击键重读盘 + 解压 + 逐 cell 解析；
 * 2. **正确性＝过期不可能**：盘上一动（改内容 / 只动 size / 只动时间戳 / 自己 inject 写过 / 关项目），
 *    下一次 `parse()` 必须重新读盘并给出**新内容**——这条是本批的硬门槛，
 *    少了它就是把"脏档"喂进回放面。
 *
 * 失败面同样钉住（内核规则 4「不静默」）：解析失败原样上抛、坏档永不入记忆、
 * 拿不到 stat 就退回改前的"每次重解析"（绝不把没信号当没变）。
 */
import { describe, expect, it } from 'vitest';
import type { ArchiveOverrides, DirEntry, FileStat, Logger } from '@kojo/plugin-api';
import { SnapshotSourceEngine } from '../src/engine';
import { makeArchiveFile, simpleCharBlock, type ArchiveSpec } from './helpers/synth';

function spec(over: Partial<ArchiveSpec> = {}): ArchiveSpec {
  return { fileType: 0, saveMes: '第 1 日', charCount: 1, charBlock: simpleCharBlock, ...over };
}

/** 尾部追加「EOF 标记 + 零字节」：解析器按 `remaining` 如实呈现（不抛）——用来只动 size 不动 mtime */
function withTail(bytes: Uint8Array, pad: number): Uint8Array {
  const out = new Uint8Array(bytes.length + pad + 1);
  out.set(bytes);
  out[bytes.length] = 0xff; // 变量流 EOF：先把多出来的一段判成"未消费的尾字节"
  return out;
}

interface HarnessOptions {
  parseMemoMax?: number;
  statMode?: 'ok' | 'null' | 'throw';
}

interface Harness {
  readonly engine: SnapshotSourceEngine;
  readonly reads: () => number;
  /** 改盘：写新字节（默认同时抬 mtime，模拟真实写入） */
  rewrite(path: string, bytes: Uint8Array, bumpMtime?: boolean): void;
}

function makeHarness(initial: Record<string, Uint8Array>, opts: HarnessOptions = {}): Harness {
  const files = new Map(Object.entries(initial));
  const mtime = new Map<string, number>();
  for (const p of files.keys()) mtime.set(p, 1_700_000_000_000);
  let readCount = 0;
  const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };

  const engine = new SnapshotSourceEngine({
    log,
    getProject: () => null,
    readBytes: async (p) => {
      readCount++;
      const b = files.get(p);
      if (!b) throw new Error(`not found: ${p}`);
      return b;
    },
    listDir: async (path): Promise<DirEntry[]> => {
      const prefix = `${path}/`;
      return [...files.keys()]
        .filter((p) => p.startsWith(prefix))
        .map((p) => ({ name: p.slice(prefix.length), path: p, isDirectory: false }));
    },
    stat: async (p): Promise<FileStat | null> => {
      if (opts.statMode === 'throw') throw new Error(`stat failed: ${p}`);
      if (opts.statMode === 'null') return null;
      const b = files.get(p);
      if (!b) return null;
      return { size: b.length, mtimeMs: mtime.get(p) ?? 1_700_000_000_000, isDirectory: false };
    },
    writeBytes: async (p, data) => {
      files.set(p, data);
    },
    backup: async (p) => (files.has(p) ? `backup:///${p}` : null),
    ...(opts.parseMemoMax === undefined ? {} : { parseMemoMax: opts.parseMemoMax }),
  });

  return {
    engine,
    reads: () => readCount,
    rewrite: (path, bytes, bumpMtime = true) => {
      files.set(path, bytes);
      if (bumpMtime) mtime.set(path, (mtime.get(path) ?? 1_700_000_000_000) + 1000);
    },
  };
}

const P = '/g/sav/save00.sav';
const Q = '/g/sav/save01.sav';
const R = '/g/sav/save02.sav';

describe('深解析记忆：命中即零重解析', () => {
  it('同判据二次 parse 只读盘一次，且返回同一个对象身份', async () => {
    const h = makeHarness({ [P]: makeArchiveFile(spec()) });
    const a1 = await h.engine.parse(P);
    const r0 = h.reads();
    const a2 = await h.engine.parse(P);
    expect(h.reads()).toBe(r0); // 第二次零读盘
    expect(a2).toBe(a1); // 同一对象 ⇒ 下游（回放视图）也能按身份记忆
    expect(h.engine.parseMemoStats()).toMatchObject({ entries: 1, hits: 1, misses: 1 });
    expect(a1.chars).toHaveLength(1);
  });

  it('并发同判据共享一次解析（两只面板同时问同一个档）', async () => {
    const h = makeHarness({ [P]: makeArchiveFile(spec()) });
    const [a, b] = await Promise.all([h.engine.parse(P), h.engine.parse(P)]);
    expect(a).toBe(b);
    expect(h.reads()).toBe(1);
  });

  it('选项分格：浅解析与深解析不互相串味', async () => {
    const h = makeHarness({ [P]: makeArchiveFile(spec({ charCount: 3 })) });
    const deep = await h.engine.parse(P);
    const shallow = await h.engine.parse(P, { headerOnly: true });
    expect(shallow).not.toBe(deep);
    expect(deep.chars).toHaveLength(3);
    expect(shallow.chars).toBeUndefined(); // headerOnly 契约：角色区省略
    // 同一个 path 只留**一格**记忆（判据含选项指纹）：浅解析不会把深解析挤成脏档，
    // 而是各算各的 ⇒ 再问深解析必然重读盘，产出一比一样的新对象
    const r0 = h.reads();
    const again = await h.engine.parse(P);
    expect(h.reads()).toBe(r0 + 1);
    expect(again).not.toBe(deep);
    expect(again.chars).toHaveLength(3);
  });

  it('记忆按上限 FIFO 收口：第三份进来后最旧的重新读盘', async () => {
    const h = makeHarness({
      [P]: makeArchiveFile(spec()),
      [Q]: makeArchiveFile(spec()),
      [R]: makeArchiveFile(spec()),
    });
    const a = await h.engine.parse(P);
    await h.engine.parse(Q);
    await h.engine.parse(R);
    const st = h.engine.parseMemoStats();
    expect(st.entries).toBeLessThanOrEqual(st.max);
    const r0 = h.reads();
    const b = await h.engine.parse(P); // P 已被逐出 ⇒ 重解析
    expect(h.reads()).toBe(r0 + 1);
    expect(b).not.toBe(a);
    expect(b.chars).toHaveLength(1);
  });

  it('parseMemoMax=0 关闭记忆＝改前行为（每次读盘解析）', async () => {
    const h = makeHarness({ [P]: makeArchiveFile(spec()) }, { parseMemoMax: 0 });
    const a1 = await h.engine.parse(P);
    const a2 = await h.engine.parse(P);
    expect(h.reads()).toBe(2);
    expect(a2).not.toBe(a1);
    expect(a2.chars).toHaveLength(a1.chars!.length);
  });
});

describe('深解析记忆：过期不可能（盘上一动就必须重解析）', () => {
  it('改档内容（mtime+size 同动）⇒ 下一次 parse 给出新内容', async () => {
    const h = makeHarness({ [P]: makeArchiveFile(spec({ saveMes: '第 1 日' })) });
    const before = await h.engine.parse(P);
    expect(before.saveMes).toBe('第 1 日');

    h.rewrite(P, makeArchiveFile(spec({ saveMes: '第 99 日(改了)' })));
    const r0 = h.reads();
    const after = await h.engine.parse(P);
    expect(h.reads()).toBe(r0 + 1); // 真重读盘，没有吐脏档
    expect(after.saveMes).toBe('第 99 日(改了)');
    expect(after).not.toBe(before);
  });

  it('只改 mtime（同值替换）⇒ 判据不符照样重解析', async () => {
    const same = makeArchiveFile(spec({ saveMes: '第 1 日' }));
    const h = makeHarness({ [P]: same });
    await h.engine.parse(P);
    const r0 = h.reads();
    h.rewrite(P, same, true); // 字节一模一样，只有时间戳动了
    await h.engine.parse(P);
    expect(h.reads()).toBe(r0 + 1);
  });

  it('只改 size、mtime 不动（保留时间戳的工具改写）⇒ 依然重解析', async () => {
    // RAW 容器（gzip 容器尾部加字节会被 inflate 判成 junk，那是解析器的正确行为，不是本条要测的）
    const base = makeArchiveFile(spec({ compress: false }));
    const h = makeHarness({ [P]: base });
    const first = await h.engine.parse(P);
    expect(first.remaining).toBe(0);
    const r0 = h.reads();
    h.rewrite(P, withTail(base, 64), false);
    const after = await h.engine.parse(P);
    expect(h.reads()).toBe(r0 + 1);
    expect(after.remaining).toBeGreaterThan(0); // 读到的是补尾后的新档，不是脏档
  });

  it('自己 inject 写过同一份档 ⇒ 记忆作废，下一次 parse 读到注入后的值', async () => {
    const h = makeHarness({ [P]: makeArchiveFile(spec()) });
    const before = await h.engine.parse(P);
    const noOf = (a: typeof before) => a.chars?.[0]?.vars.find((v) => v.key === 'NO');
    expect(noOf(before)?.type).toBe('int');

    // 注入后**字节数不变、替身 mtime 也不变**——正是 mtime+size 判据兜不住的那一类，
    // 靠 inject 自己把这条路径的记忆逐出（自写即已知变更）
    const overrides: ArchiveOverrides = { chars: new Map([[0, new Map([['NO', 7]])]]) };
    await h.engine.inject(P, overrides);
    expect(h.engine.parseMemoStats().entries).toBe(0);
    const after = await h.engine.parse(P);
    const no = noOf(after);
    expect(no && no.type === 'int' ? no.value : undefined).toBe(7);
  });

  it('项目关闭 clear() ⇒ 记忆作废（下一次重读盘）', async () => {
    const h = makeHarness({ [P]: makeArchiveFile(spec()) });
    await h.engine.parse(P);
    h.engine.clear();
    expect(h.engine.parseMemoStats().entries).toBe(0);
    const r0 = h.reads();
    await h.engine.parse(P);
    expect(h.reads()).toBe(r0 + 1);
  });
});

describe('深解析记忆：不静默（失败与无判据一律退回改前行为）', () => {
  it('坏档：失败原样上抛，且不入记忆（下一次照旧再抛）', async () => {
    const h = makeHarness({ [P]: new Uint8Array(20) });
    await expect(h.engine.parse(P)).rejects.toThrow();
    expect(h.engine.parseMemoStats().entries).toBe(0);
    await expect(h.engine.parse(P)).rejects.toThrow();
    expect(h.reads()).toBe(2); // 两次都真读盘（坏档没被当成"解析过的档"供出去）
  });

  it('stat 返回 null（取不到元信息）⇒ 不记忆、每次重解析（不把没信号当没变）', async () => {
    const h = makeHarness({ [P]: makeArchiveFile(spec()) }, { statMode: 'null' });
    const a1 = await h.engine.parse(P);
    const a2 = await h.engine.parse(P);
    expect(h.reads()).toBe(2);
    expect(a2).not.toBe(a1);
    expect(h.engine.parseMemoStats().entries).toBe(0);
  });

  it('stat 抛错 ⇒ 退回不记忆，但档本身读得动（不新增失败面）', async () => {
    const h = makeHarness({ [P]: makeArchiveFile(spec()) }, { statMode: 'throw' });
    const a = await h.engine.parse(P);
    expect(a.chars).toHaveLength(1);
    expect(h.engine.parseMemoStats().entries).toBe(0);
  });

  it('档不存在：与改前同一句读盘错误（不是"缓存里没有"）', async () => {
    const h = makeHarness({ [P]: makeArchiveFile(spec()) });
    await expect(h.engine.parse('/g/sav/missing.sav')).rejects.toThrow(/missing\.sav/);
  });
});
