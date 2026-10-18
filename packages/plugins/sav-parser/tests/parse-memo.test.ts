/**
 * 深解析记忆（2026-10-18 性能批 + 同批修复：分格判据与显式失效）。
 *
 * 钉的是两头：
 * 1. **收益**＝同一个 (路径折叠键, mtime, size, 选项) 不再每次击键重读盘 + 解压 + 逐 cell 解析；
 *    且**三种消费者形态各占一格互不逐出**（回放腿默认 / 注入面板 keepRaw / 归档浏览器轻形态），
 *    同一路径的旧盘上版本残格在新版本入格时清掉；
 * 2. **正确性＝过期不可能**：盘上一动（改内容 / 只动 size / 只动时间戳 / 自己 inject 写过 / 关项目），
 *    下一次 `parse()` 必须重新读盘并给出**新内容**——这条是本批的硬门槛，
 *    少了它就是把"脏档"喂进回放面。
 *
 * **mtime/size 判据只是第二道防线**：撤销注入（journal rollback）与恢复备份（restoreBackup）
 * 都会以"字节数不变、mtime 落在粗粒度 tick 内"的形态重写同一份档 ⇒ 判据同值命中旧格。
 * 失效的**第一信源是知情写入方的事件**（kernel io 的 `file.changed` → 装配层 `invalidate()`，
 * 接线钉在 `plugin.test.ts`；写侧广播钉在 kernel 的 ops-journal / io-backups 测试）。
 * 本文件里 `invalidate()` 与在途回填闸门直接可见。
 *
 * 失败面同样钉住（内核规则 4「不静默」）：解析失败原样上抛、坏档永不入记忆、
 * 拿不到 stat 就退回改前的"每次重解析"（绝不把没信号当没变）。
 */
import { describe, expect, it } from 'vitest';
import type { ArchiveOverrides, DirEntry, FileStat, Logger, SnapshotArchive } from '@kojo/plugin-api';
import { SnapshotSourceEngine } from '../src/engine';
import { makeArchiveFile, makeRawNoArchive, simpleCharBlock, type ArchiveSpec } from './helpers/synth';

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

/** RAW 档（helpers/synth 的 `makeRawNoArchive`）：int 原位替换 ⇒ **字节数逐字相等**，
 *  正是"注入原地改值 ⇒ size 判据失效"的真实形状 */
const rawNo = makeRawNoArchive;

function noOf(a: SnapshotArchive): number | string | undefined {
  const v = a.chars?.[0]?.vars.find((x) => x.key === 'NO');
  return v && v.type === 'int' ? v.value : undefined;
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

  it('选项分格共存：三种消费者形态各占一格互不逐出，切面板零重读（bug 2 钉死）', async () => {
    const h = makeHarness({ [P]: makeArchiveFile(spec({ charCount: 3 })) });
    // 三个真实消费者的选项形态（回放腿 / 注入面板 / 归档浏览器）+ headerOnly 浅形态
    const deep = await h.engine.parse(P);
    const raw = await h.engine.parse(P, { keepArrayCells: true, keepRaw: true });
    const light = await h.engine.parse(P, { keepArrayCells: false, maxCellsPerArray: 0 });
    const shallow = await h.engine.parse(P, { headerOnly: true });
    expect(shallow.chars).toBeUndefined(); // 分格不只讲共存，串味仍然绝迹：浅解析不冒充深解析
    expect(deep.chars).toHaveLength(3);
    expect(h.engine.parseMemoStats().entries).toBe(4);

    // 逐形态再问一遍：全部按身份命中（同一个对象、零重读盘）——旧实现按 path 单格存放，
    // 这里每切一次面板都会把上一形态挤出去，记忆形同虚设
    const r0 = h.reads();
    expect(await h.engine.parse(P)).toBe(deep);
    expect(await h.engine.parse(P, { keepArrayCells: true, keepRaw: true })).toBe(raw);
    expect(await h.engine.parse(P, { keepArrayCells: false, maxCellsPerArray: 0 })).toBe(light);
    expect(await h.engine.parse(P, { headerOnly: true })).toBe(shallow);
    expect(h.reads()).toBe(r0);
  });

  it('记忆按上限 FIFO 收口：第三份进来后最旧的重新读盘（上限显式钉 2，与默认值解耦）', async () => {
    const h = makeHarness(
      {
        [P]: makeArchiveFile(spec()),
        [Q]: makeArchiveFile(spec()),
        [R]: makeArchiveFile(spec()),
      },
      { parseMemoMax: 2 },
    );
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
    expect(noOf(before)).toBe(0);

    // 注入后**字节数不变、替身 mtime 也不变**——正是 mtime+size 判据兜不住的那一类，
    // 靠 inject 自己把这条路径的记忆显式逐出（自写即已知变更）
    const overrides: ArchiveOverrides = { chars: new Map([[0, new Map([['NO', 7]])]]) };
    await h.engine.inject(P, overrides);
    expect(h.engine.parseMemoStats().entries).toBe(0);
    const after = await h.engine.parse(P);
    expect(noOf(after)).toBe(7);
  });

  it('撤销注入（journal rollback 写回）：同 mtime 同 size 的字节重写 ⇒ invalidate 后必读新值（bug 1 钉死）', async () => {
    // 与 inject 同一形状但**不经 inject**：回滚是内核写路径直接落字节，插件记忆毫不知情。
    // 这里用 RAW 档的 int 原位替换保证 size 逐字相等，mtime 不抬（粗粒度介质的 1–2s tick）
    const h = makeHarness({ [P]: rawNo(0) });
    const before = await h.engine.parse(P);
    expect(noOf(before)).toBe(0);

    h.rewrite(P, rawNo(7), false); // 回滚落盘：同 size、同 mtime
    const stale = await h.engine.parse(P);
    expect(stale).toBe(before); // 判据同值 ⇒ 命中旧格。如实钉住"光靠 mtime/size 兜不住"这一半

    h.engine.invalidate(P); // = file.changed 事件到达后装配层做的事（接线见 plugin.test.ts）
    expect(h.engine.parseMemoStats().entries).toBe(0);
    const r0 = h.reads();
    const fresh = await h.engine.parse(P);
    expect(h.reads()).toBe(r0 + 1); // 真重读盘，吐的是新值
    expect(noOf(fresh)).toBe(7);
  });

  it('恢复备份（restoreBackup 写回）：同判据换内容 ⇒ invalidate 逐出后读到备份里的旧值', async () => {
    // 备份版 NO=0、现盘注入版 NO=7——恢复吃的正是"注入原地改值 size 不变"这一口
    const h = makeHarness({ [P]: rawNo(7) });
    expect(noOf(await h.engine.parse(P))).toBe(7);
    h.rewrite(P, rawNo(0), false); // 恢复落盘：同 size、同 mtime
    h.engine.invalidate(P);
    expect(noOf(await h.engine.parse(P))).toBe(0);
  });

  it('invalidate 判等走 pathKey：另一种写法（大小写/分隔符）也逐得掉', async () => {
    const W1 = 'C:\\G\\SAV\\S.SAV';
    const h = makeHarness({ [W1]: rawNo(0) });
    const before = await h.engine.parse(W1);
    expect(noOf(before)).toBe(0);
    h.rewrite(W1, rawNo(7), false);
    h.engine.invalidate('c:/g/sav/s.sav'); // 事件路径来自平台原样透传，写法未必一致
    expect(h.engine.parseMemoStats().entries).toBe(0);
    expect(noOf(await h.engine.parse(W1))).toBe(7);
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

  it('项目关闭时深解析**在途** ⇒ 结果不得回填记忆（bug 3 钉死：keepRaw 大档不许活过项目）', async () => {
    const bytes = makeArchiveFile(spec());
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reads = 0;
    const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const engine = new SnapshotSourceEngine({
      log,
      getProject: () => null,
      readBytes: async () => {
        reads++;
        await gate; // 卡在"读盘"这一段，模拟 MB 级慢解析
        return bytes;
      },
      listDir: async (): Promise<DirEntry[]> => [],
      stat: async (): Promise<FileStat | null> => ({ size: bytes.length, mtimeMs: 1_700_000_000_000, isDirectory: false }),
      writeBytes: async () => {},
      backup: async () => null,
    });

    const inFlight = engine.parse(P);
    while (reads === 0) await Promise.resolve(); // 已进入读盘挂起
    engine.clear(); // 项目关闭：此刻记忆是空的，但旧实现里在途解析完成后会把它塞回来
    release();
    const archive = await inFlight;
    expect(archive.chars).toHaveLength(1); // 请求方仍拿到结果（不虚报失败）
    expect(engine.parseMemoStats().entries).toBe(0); // 但记忆必须仍是空的
    await engine.parse(P);
    expect(reads).toBe(2); // 下一次照常重读盘（没有在途残档回填）
  });

  it('invalidate 时在途解析的结果不得回填（写盘与慢解析赛跑的窗口）', async () => {
    const bytes = makeArchiveFile(spec());
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reads = 0;
    const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const engine = new SnapshotSourceEngine({
      log,
      getProject: () => null,
      readBytes: async () => {
        reads++;
        await gate;
        return bytes;
      },
      listDir: async (): Promise<DirEntry[]> => [],
      stat: async (): Promise<FileStat | null> => ({ size: bytes.length, mtimeMs: 1_700_000_000_000, isDirectory: false }),
      writeBytes: async () => {},
      backup: async () => null,
    });
    const inFlight = engine.parse(P);
    while (reads === 0) await Promise.resolve();
    engine.invalidate(P); // 事件先于解析完成到达：这份字节读于改动前
    release();
    await inFlight;
    expect(engine.parseMemoStats().entries).toBe(0);
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
