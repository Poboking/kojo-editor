/**
 * 注入写链路单测（v0.2 第十五批）：engine.inject + 容器组装 + 回读验证。
 *
 * 全部合成档（不入真实数据）；写目标 = 内存文件表（不触盘）。
 * 顺序安全语义逐条覆盖：守卫先于备份 / 备份先于覆盖 / 越权传播 / 回读失败显式报错。
 */
import { describe, expect, it } from 'vitest';
import type { DirEntry, FileStat, Logger } from '@kojo/plugin-api';
import { SnapshotSourceEngine } from '../src/engine';
import { gunzipBytes } from '../src/gunzip';
import { parseArchive } from '../src/parse';
import { serializePayload } from '../src/serialize';
import { assembleArchiveFile, gzipBytes } from '../src/container';
import { verifyOverrides, verifyReadbackBytes } from '../src/verify';
import { MAGIC_GZIP, makeArchiveFile, simpleCharBlock, W, type ArchiveSpec } from './helpers/synth';

/* ---------------- 测试替身 ---------------- */

function spec(over: Partial<ArchiveSpec> = {}): ArchiveSpec {
  return { fileType: 0, saveMes: '第 1 日', charCount: 1, charBlock: simpleCharBlock, ...over };
}

/** 内存文件系统 + 双闸替身（writable 判定可控），返回引擎与观测口 */
function makeHarness(opts: {
  files: Record<string, Uint8Array>;
  writable?: (path: string) => boolean;
  /** 'zero' = 写入非法字节（回读 parse 抛）；'stale' = 写回旧档（回读值不匹配 → 验证失败路径） */
  writeMode?: 'zero' | 'stale';
  /** 2026-10-16 undo 批：注入记录型 journal，观测编排顺序（begin/record/commit/abort） */
  withJournal?: boolean;
}) {
  const files = opts.files;
  const backups: string[] = [];
  const written: string[] = [];
  const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
  const isWritable = opts.writable ?? (() => true);
  const engine = new SnapshotSourceEngine({
    log,
    getProject: () => null,
    readBytes: async (p) => {
      const b = files[p];
      if (!b) throw new Error(`not found: ${p}`);
      return b;
    },
    listDir: async (path) => {
      const prefix = `${path}/`;
      const out: DirEntry[] = Object.keys(files)
        .filter((p) => p.startsWith(prefix))
        .map((p) => ({ name: p.slice(prefix.length), path: p, isDirectory: false }));
      return out;
    },
    stat: async (p): Promise<FileStat | null> => {
      const b = files[p];
      return b ? { size: b.length, mtimeMs: 1, isDirectory: false } : null;
    },
    writeBytes: async (p, data) => {
      if (!isWritable(p)) {
        throw Object.assign(new Error(`Write not allowed outside writable roots: ${p}`), {
          name: 'WriteNotAllowedError',
        });
      }
      written.push(p);
      // 写坏模式（回读失败路径）
      if (opts.writeMode === 'zero') {
        files[p] = new Uint8Array(17); // 非法档：回读 parse 直接抛 → 同样走显式失败
      } else if (opts.writeMode === 'stale') {
        const cur = files[p];
        if (cur) files[p] = cur; // 原样写回（模拟回滚）：覆盖值不落盘 → 回读验证失败
      } else {
        files[p] = data;
      }
    },
    backup: async (p) => {
      if (!files[p]) return null;
      const target = `backup:///${p.replace(/\//g, '_')}.bak`;
      backups.push(target);
      return target;
    },
  });
  const journalCalls: string[] = [];
  if (opts.withJournal) {
    engineWithJournal(engine, journalCalls);
  }
  return { engine, backups, written, files, journalCalls };
}

/** 记录型 journal 替身：只观测编排顺序，不做真快照（内容回滚由 kernel 单测证） */
function engineWithJournal(engine: SnapshotSourceEngine, calls: string[]): void {
  const fake = {
    begin: async () => {
      calls.push('begin');
      return 'op-20261016-000000-000-abc123';
    },
    record: async () => {
      calls.push('record');
    },
    commit: async () => {
      calls.push('commit');
    },
    abort: async () => {
      calls.push('abort');
    },
  };
  (engine as unknown as { deps: { journal?: typeof fake } }).deps.journal = fake;
}

/* ---------------- 容器组装 ---------------- */

describe('容器组装（container）', () => {
  it('gzip 档：组装 → gunzip → parse 全链路语义恒等', async () => {
    const original = makeArchiveFile(spec());
    const archive = await parseArchive(original, 'x.sav', { keepArrayCells: true });
    const payload = serializePayload(archive);
    const full = await assembleArchiveFile(payload, 'gzip');

    const dv = new DataView(full.buffer, full.byteOffset, full.byteLength);
    expect(dv.getBigUint64(0, true)).toBe(MAGIC_GZIP);
    expect(dv.getUint32(8, true)).toBe(1808);
    expect(dv.getUint32(12, true)).toBe(0);

    const body = await gunzipBytes(full.subarray(16));
    // 解压后的正文是「载荷」，重打包须用 RAW 头（gzip 头会再次触发解压而失败）
    const repacked = new Uint8Array(16 + body.length);
    const rdv = new DataView(repacked.buffer);
    rdv.setBigUint64(0, 0x0a1a0a0d41524589n, true);
    rdv.setUint32(8, 1808, true);
    repacked.set(body, 16);
    const reparsed = await parseArchive(repacked, 'x.sav', { keepArrayCells: true });
    expect(reparsed.fileType).toBe('normal');
    expect(reparsed.chars).toHaveLength(1);
    expect(reparsed.remaining).toBe(0);
  });

  it('raw 档：沿用 raw 容器（正文即载荷）', async () => {
    const original = makeArchiveFile(spec({ compress: false }));
    const archive = await parseArchive(original, 'x.sav', {});
    const full = await assembleArchiveFile(serializePayload(archive), 'raw');
    expect(full.length).toBe(original.length);
    const reparsed = await parseArchive(full, 'x.sav', {});
    expect(reparsed.format).toBe('raw');
    expect(reparsed.remaining).toBe(0);
  });

  it('gzipBytes 与 gunzipBytes 互逆', async () => {
    const data = new Uint8Array(4096);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const round = await gunzipBytes(await gzipBytes(data));
    expect([...round]).toEqual([...data]);
  });
});

/* ---------------- 回读验证（verifyOverrides / verifyReadbackBytes） ---------------- */

describe('verifyReadbackBytes · 回读字节态（W17 判等核）', () => {
  it('逐字节相同 ⇒ 通过', () => {
    const data = new Uint8Array([1, 2, 3, 0xfd, 255]);
    expect(verifyReadbackBytes(data, data.slice())).toEqual({ checked: 1, mismatches: [] });
  });

  it('值可能碰巧对上、字节已不同 ⇒ 显式报首个差异偏移', () => {
    const report = verifyReadbackBytes(new Uint8Array([1, 2, 3, 4]), new Uint8Array([1, 2, 9, 4]));
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toContain('回读字节与写入字节不同');
    expect(report.mismatches[0]).toContain('偏移 2');
  });

  it('长度不同 ⇒ 差异偏移 = 较短一侧长度', () => {
    const report = verifyReadbackBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]));
    expect(report.mismatches[0]).toContain('写入 2B，落盘 3B');
    expect(report.mismatches[0]).toContain('偏移 2');
  });
});

describe('verifyOverrides', () => {
  it('标量：命中 / 值不符 / 变量缺失 三态', async () => {
    const a = await parseArchive(makeArchiveFile(spec()), 'x', { keepArrayCells: true });
    const block = a.chars![0]!;
    const noVar = block.vars.find((v) => v.key === 'NO') as { key: string; value: number };

    const ok = verifyOverrides(a, {
      chars: new Map([[block.index, new Map([[noVar.key, noVar.value]])]]),
    });
    expect(ok.mismatches).toEqual([]);
    expect(ok.checked).toBe(1);

    const wrong = verifyOverrides(a, {
      chars: new Map([[block.index, new Map([[noVar.key, noVar.value + 1]])]]),
    });
    expect(wrong.mismatches).toHaveLength(1);
    expect(wrong.mismatches[0]).toContain('落盘');

    const missing = verifyOverrides(a, {
      chars: new Map([[block.index, new Map([['NOPE', 1]])]]),
    });
    expect(missing.mismatches[0]).toContain('变量未找到');
  });

  it('数组单元：命中与缺失下标', async () => {
    const a = await parseArchive(makeArchiveFile(spec()), 'x', { keepArrayCells: true });
    const cflag = a.chars![0]!.vars.find((v) => v.type === 'int-array-1d')!;

    const ok = verifyOverrides(a, {
      chars: new Map([[0, new Map([[cflag.key, [{ index: [0], value: 1 }]]])]]),
    });
    expect(ok.mismatches).toEqual([]);
    expect(ok.checked).toBe(1);

    const miss = verifyOverrides(a, {
      chars: new Map([[0, new Map([[cflag.key, [{ index: [2], value: 9 }]]])]]),
    });
    expect(miss.mismatches[0]).toContain('单元未落盘');
  });

  it('顶层 vars 覆盖集作用于主变量区', async () => {
    const data = makeArchiveFile(spec({ vars: (w) => w.u8(0x00).str('DAY').int(47) }));
    const a = await parseArchive(data, 'x', { keepArrayCells: true });

    const ok = verifyOverrides(a, { vars: new Map([['DAY', 47]]) });
    expect(ok.mismatches).toEqual([]);
    const wrong = verifyOverrides(a, { vars: new Map([['DAY', 48]]) });
    expect(wrong.mismatches).toHaveLength(1);
  });
});

/* ---------------- inject 编排 ---------------- */

describe('SnapshotSourceEngine.inject', () => {
  it('标量注入端到端：备份 → 覆盖 → 回读验证通过', async () => {
    const data = makeArchiveFile(spec());
    const h = makeHarness({ files: { '/g/sav/save00.sav': data } });
    const archive = await parseArchive(data, '/g/sav/save00.sav', { keepArrayCells: true });
    const block = archive.chars![0]!;
    const noVar = block.vars.find((v) => v.type === 'int')!;
    const oldValue = (noVar as { value: number }).value;

    const r = await h.engine.inject('/g/sav/save00.sav', {
      chars: new Map([[block.index, new Map([[noVar.key, 777]])]]),
    });

    expect(r.path).toBe('/g/sav/save00.sav');
    expect(r.backupPath).toBe(h.backups[0]);
    expect(h.backups).toHaveLength(1);
    expect(h.written).toEqual(['/g/sav/save00.sav']);
    expect(r.verifiedCount).toBe(1);

    const reparsed = await parseArchive(h.files['/g/sav/save00.sav']!, '/g/sav/save00.sav', {});
    const hit = reparsed.chars![0]!.vars.find((v) => v.key === noVar.key)!;
    expect((hit as { value: number }).value).toBe(777);
    expect(oldValue).not.toBe(777);
  });

  it('数组单元补丁端到端：替换 + 新增 + 未列单元 passthrough', async () => {
    const data = makeArchiveFile(spec());
    const h = makeHarness({ files: { '/g/sav/save00.sav': data } });
    const archive = await parseArchive(data, '/g/sav/save00.sav', { keepArrayCells: true });
    const cflag = archive.chars![0]!.vars.find((v) => v.type === 'int-array-1d')!;

    const r = await h.engine.inject('/g/sav/save00.sav', {
      chars: new Map([
        [0, new Map([[cflag.key, [{ index: [1], value: 30 }, { index: [2], value: 99 }]]])],
      ]),
    });
    expect(r.verifiedCount).toBe(2);

    const reparsed = await parseArchive(h.files['/g/sav/save00.sav']!, '/g/sav/save00.sav', {});
    const hit = reparsed.chars![0]!.vars.find((v) => v.key === cflag.key) as unknown as {
      cells: { index: number[]; value: number }[];
    };
    const byIdx = new Map(hit.cells.map((c) => [c.index.join(','), c.value]));
    expect(byIdx.get('1')).toBe(30); // 替换
    expect(byIdx.get('2')).toBe(99); // 新增
    expect(byIdx.get('0')).toBe(1); // 既有单元原样保留
  });

  it('Int64 守卫：不安全整数在备份与写盘之前拒绝（显式报错，零副作用）', async () => {
    const data = makeArchiveFile(spec());
    const h = makeHarness({ files: { '/g/sav/save00.sav': data } });

    await expect(
      h.engine.inject('/g/sav/save00.sav', { chars: new Map([[0, new Map([['NO', 2 ** 60]])]]) }),
    ).rejects.toThrow(/安全整数/);
    expect(h.backups).toHaveLength(0);
    expect(h.written).toHaveLength(0);
  });

  it('越权写：WriteNotAllowedError 原样传播（备份已做、未覆盖）', async () => {
    const data = makeArchiveFile(spec());
    const h = makeHarness({ files: { '/g/sav/save00.sav': data }, writable: () => false });

    await expect(
      h.engine.inject('/g/sav/save00.sav', { chars: new Map([[0, new Map([['NO', 5]])]]) }),
    ).rejects.toThrow(/not allowed/i);
    expect(h.backups).toHaveLength(1);
    expect(h.written).toHaveLength(0);
  });

  it('回读验证失败：显式报错并携带备份位置', async () => {
    const data = makeArchiveFile(spec());
    const h = makeHarness({ files: { '/g/sav/save00.sav': data }, writeMode: 'stale' });

    await expect(
      h.engine.inject('/g/sav/save00.sav', { chars: new Map([[0, new Map([['NO', 5]])]]) }),
    ).rejects.toThrow(/回读验证失败.*备份/);
    // W17：写回旧档时值级断言之外，字节态也先被抓住（同一份判等核）
    await expect(
      h.engine.inject('/g/sav/save00.sav', { chars: new Map([[0, new Map([['NO', 6]])]]) }),
    ).rejects.toThrow(/回读字节与写入字节不同/);
    expect(h.backups).toHaveLength(2);
  });

  it('journal 在场（2026-10-16 undo 批）：成功路径 begin→record→…→commit，record 先于写盘', async () => {
    const data = makeArchiveFile(spec());
    const h = makeHarness({ files: { '/g/sav/save00.sav': data }, withJournal: true });
    await h.engine.inject('/g/sav/save00.sav', { chars: new Map([[0, new Map([['NO', 5]])]]) });
    expect(h.journalCalls).toEqual(['begin', 'record', 'commit']);
    expect(h.backups).toHaveLength(1);
  });

  it('journal 在场：回读验证失败 → abort（回滚编排），原始错误仍上抛', async () => {
    const data = makeArchiveFile(spec());
    const h = makeHarness({ files: { '/g/sav/save00.sav': data }, writeMode: 'stale', withJournal: true });
    await expect(
      h.engine.inject('/g/sav/save00.sav', { chars: new Map([[0, new Map([['NO', 5]])]]) }),
    ).rejects.toThrow(/回读验证失败/);
    expect(h.journalCalls).toEqual(['begin', 'record', 'abort']);
    expect(h.journalCalls).not.toContain('commit');
  });

  it('journal 在场：Int64 守卫拒绝 → abort 清理空 op，备份与写盘都未发生', async () => {
    const data = makeArchiveFile(spec());
    const h = makeHarness({ files: { '/g/sav/save00.sav': data }, withJournal: true });
    await expect(
      h.engine.inject('/g/sav/save00.sav', { chars: new Map([[0, new Map([['NO', 2 ** 60]])]]) }),
    ).rejects.toThrow(/安全整数/);
    expect(h.journalCalls).toEqual(['begin', 'abort']);
    expect(h.backups).toHaveLength(0);
    expect(h.written).toHaveLength(0);
  });

  it('全局档（global）：vars 覆盖集作用于全局变量区', async () => {
    const body = new W();
    body.u8(1); // global
    body.i64(7153n);
    body.i64(0n);
    body.str('全局');
    body.u8(0x00).str('DAY').int(47);
    body.u8(0xff);
    const header = new W();
    header.i64(MAGIC_GZIP);
    header.u32(1808);
    header.u32(0);
    // 复用 node:zlib gzip（helper 同款；仅测试环境）
    const { gzipSync } = await import('node:zlib');
    const raw = new Uint8Array(
      header.bytes().length + gzipSync(body.bytes()).length,
    );
    raw.set(header.bytes(), 0);
    raw.set(gzipSync(body.bytes()), 16);

    const h = makeHarness({ files: { '/g/sav/global.sav': raw } });
    const r = await h.engine.inject('/g/sav/global.sav', { vars: new Map([['DAY', 48]]) });
    expect(r.verifiedCount).toBe(1);

    const reparsed = await parseArchive(h.files['/g/sav/global.sav']!, '/g/sav/global.sav', {});
    const hit = reparsed.globalVars!.find((v) => v.key === 'DAY')!;
    expect((hit as { value: number }).value).toBe(48);
  });
});
