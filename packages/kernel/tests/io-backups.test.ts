import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { WriteNotAllowedError } from '@kojo/plugin-api';
import {
  BACKUP_VERSION_RE,
  backupBucketName,
  backupHashOf,
  parseBackupTakenAtMs,
} from '../src/io';
import { FileIOServiceImpl } from '../src/io';
import { NodeBridge } from './helpers/node-bridge';

/**
 * 本地时间线的查询与恢复（1015 历史批）。
 *
 * 口径钉死：版本树 = 既有写前自动备份（同桶名、同文件名，不发明第二套约定）；
 * 恢复 = 既有写链路（第一道闸 + 写前自动备份 + 字节级原子写 + 编码缓存跟版本）。
 * 全部用临时目录造备份树，不依赖真实 appData。
 */

let tmpDir: string;
let appData: string;
let io: FileIOServiceImpl;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-backups-'));
  appData = path.join(tmpDir, 'appdata');
  io = new FileIOServiceImpl(new NodeBridge(appData));
});

const writableFile = (): string => {
  const dir = path.join(tmpDir, 'ws');
  io.setAppWritableRoots([dir]);
  return path.join(dir, 'x.ERB');
};

/** 备份文件名精确到毫秒：连写之间让开 3ms，保证版本名互异（时序断言才成立） */
const nap = (): Promise<void> => new Promise((r) => setTimeout(r, 3));

describe('backupHashOf / 版本文件名（单一真源自证）', () => {
  it('同一文件的不同写法（大小写/分隔符）折叠成同一个哈希；不同路径不同哈希', () => {
    const a = backupHashOf('C:\\Game\\ERB\\事件.ERB');
    const b = backupHashOf('C:/game/erb/事件.erb');
    const c = backupHashOf('C:/other/事件.erb');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(backupBucketName('C:\\Game\\ERB\\事件.ERB')).toMatch(/^[A-Za-z0-9._-]{1,44}-[0-9a-f]{8}$/);
  });

  it('写侧前缀两种写法各成一桶，读侧按哈希后缀仍读得到全部版本（列举折叠历史写法）', async () => {
    const dir = path.join(tmpDir, 'ws');
    io.setAppWritableRoots([dir]);
    const f = path.join(dir, 'Z.ERB');
    await io.writeText(f, 'a');
    await nap();
    await io.writeText(f, 'bb'); // 写前备份 'a' → 正常桶 1 版
    // 另一写法的历史桶（前缀不同、哈希相同）：手放一版，读侧必须也看见它
    const stray = path.join(appData, 'backup', `zzz-${backupHashOf(path.join(dir, 'z.erb'))}`);
    await fs.mkdir(stray, { recursive: true });
    await fs.writeFile(path.join(stray, '20200101-000000-000.bak'), 'old');
    const list = await io.listBackups(path.join(dir, 'z.erb'));
    expect(list).toHaveLength(2);
    expect(list.map((v) => v.id)).toContain('20200101-000000-000.bak');
    expect(list[0]!.id.localeCompare(list[1]!.id)).toBeGreaterThan(0); // 新在前
  });

  it('timestamp 文件形态与 BACKUP_VERSION_RE / parseBackupTakenAtMs 互证', () => {
    const id = '20261015-093001-123.bak';
    expect(BACKUP_VERSION_RE.test(id)).toBe(true);
    expect(parseBackupTakenAtMs(id)).toBe(new Date(2026, 9, 15, 9, 30, 1, 123).getTime());
    expect(BACKUP_VERSION_RE.test('..evil.bak')).toBe(false);
    expect(BACKUP_VERSION_RE.test('20261015-093001.bak')).toBe(false);
    expect(parseBackupTakenAtMs('nope.txt')).toBeNull();
  });
});

describe('listBackups · 列举口径', () => {
  it('从未保存的文件 → 空数组（不是错误）', async () => {
    expect(await io.listBackups(path.join(tmpDir, 'nope.ERB'))).toEqual([]);
  });

  it('同哈希后缀的外来桶（32 位碰撞防御）不进清单；无属主的历史旧桶照常可见', async () => {
    const f = writableFile();
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, 'A 的现状');
    await io.writeText(f, 'A v1', { encoding: 'utf-8' });
    expect((await io.listBackups(f)).length).toBeGreaterThanOrEqual(1);
    // 手摆一个同哈希后缀的外来桶：属主指向别的 pathKey（fnv1a 碰撞模拟）
    const foreign = path.join(appData, 'backup', `${backupBucketName(f)}-2`);
    await fs.mkdir(foreign, { recursive: true });
    await fs.writeFile(path.join(foreign, 'owner.json'), JSON.stringify({ v: 1, pathKey: 'foreign-key-not-ours' }));
    await fs.writeFile(path.join(foreign, '20200101-000000-000.bak'), 'B 的旧版');
    const list = await io.listBackups(f);
    // 只看桶目录名：版本文件名的时间段（如 20:06:32 = `-200632`）本身就可能含 "-2"，
    // 对整条路径 includes('-2') 会在某些时刻把正常桶误判成外来桶。
    expect(list.every((v) => path.basename(path.dirname(v.path)) !== `${backupBucketName(f)}-2`)).toBe(true);
    // 历史旧桶（无 owner.json）按现通配放行：升级不炸旧数据
    const legacy = path.join(appData, 'backup', `${backupBucketName(f)}-3`);
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, '20200101-000000-000.bak'), '历史旧版');
    expect((await io.listBackups(f)).map((v) => v.id)).toContain('20200101-000000-000.bak');
  });

  it('多次保存 → 新在前、id 命中版本形态、takenAtMs 可解析、size 如实', async () => {
    const f = writableFile();
    await io.writeText(f, 'v1', { encoding: 'utf-8' });
    await nap();
    await io.writeText(f, 'v2-longer', { encoding: 'utf-8' });
    await nap();
    await io.writeText(f, 'v3', { encoding: 'utf-8' });
    const list = await io.listBackups(f);
    expect(list).toHaveLength(2); // v1 版（空文件之前的首存不产备份？——首存无旧内容：见下断言）
    // 备份的是"写前的旧内容"：第一次写（文件不存在）不留版，第二次写备份 v1、第三次写备份 v2-longer
    const sizes = list.map((v) => v.size).sort((a, b) => a - b);
    expect(sizes).toEqual([2, 9]);
    expect(list[0]!.id).toMatch(BACKUP_VERSION_RE);
    expect(parseBackupTakenAtMs(list[0]!.id)).not.toBeNull();
    expect(list.map((v) => v.id)).toEqual([...list.map((v) => v.id)].sort((a, b) => b.localeCompare(a)));
  });

  it('保留最近 N 版：22 次写后只剩 20 条（与 prune 同一口径）', async () => {
    const f = writableFile();
    for (let i = 0; i < 22; i++) {
      await io.writeText(f, `内容-${i}`, { encoding: 'utf-8' });
      await nap();
    }
    const list = await io.listBackups(f);
    expect(list).toHaveLength(20);
  });

  it('非版本文件混进桶里不计数（BACKUP_VERSION_RE 认，别的都是盘上的杂物）', async () => {
    const f = writableFile();
    await io.writeText(f, 'a');
    await io.writeText(f, 'b');
    const bucket = path.join(appData, 'backup', backupBucketName(f));
    await fs.writeFile(path.join(bucket, 'stray.txt'), 'junk');
    const list = await io.listBackups(f);
    expect(list.every((v) => BACKUP_VERSION_RE.test(v.id))).toBe(true);
  });
});

describe('restoreBackup · 恢复 = 既有写链路', () => {
  it('字节级恢复：Shift-JIS + CRLF 的老版本原样回来，后续保存 preserve 跟着版本编码', async () => {
    const f = writableFile();
    const sjis = iconv.encode('事件\r\nこんにちは', 'shift_jis');
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, sjis);
    // 现在改存成 UTF-8（显式换编码）——老 SJIS 版进了备份
    await io.writeText(f, '新内容', { encoding: 'utf-8' });
    const list = await io.listBackups(f);
    expect(list).toHaveLength(1);
    await io.restoreBackup(f, list[0]!.id);
    const back = await io.readText(f);
    expect(back.encoding).toBe('shift_jis');
    expect(back.eol).toBe('crlf');
    expect(back.text).toContain('こんにちは');
    expect(await fs.readFile(f)).toEqual(sjis); // 逐字节相等（零转码）
    // 恢复本身也留了写前备份：UTF-8 现状进了历史（共 2 版）
    expect(await io.listBackups(f)).toHaveLength(2);
  });

  it('只读目录（未批写权限）→ WriteNotAllowedError 可见拒绝，备份与盘都不动', async () => {
    const dir = path.join(tmpDir, 'ws');
    io.setAppWritableRoots([dir]);
    const f = path.join(dir, 'y.ERB');
    await io.writeText(f, 'a');
    await io.writeText(f, 'b');
    const list = await io.listBackups(f);
    io.setAppWritableRoots([]); // 游戏目录口径：不在允许域
    await expect(io.restoreBackup(f, list[0]!.id)).rejects.toBeInstanceOf(WriteNotAllowedError);
    const disk = (await fs.readFile(f)).toString();
    expect(disk).toContain('b'); // 盘没动（首存无原编码可保 → utf-8-bom 口径）
    expect(disk).not.toContain('a');
    expect(await io.listBackups(f)).toHaveLength(list.length); // 也没多写前备份
  });

  it('versionId 必须是版本文件名形态：路径逃逸/任意名一律拒（备份桶不可逃逸）', async () => {
    const f = writableFile();
    for (const evil of ['..\\..\\secrets.bak', '../../x.bak', 'notes.txt', '2026-10-15.bak']) {
      await expect(io.restoreBackup(f, evil)).rejects.toThrow('无效的历史版本号');
    }
  });

  it('版本号合法但盘上没有 → 明确报"历史版本不存在"，不静默成功', async () => {
    const f = writableFile();
    await expect(io.restoreBackup(f, '20200101-000000-000.bak')).rejects.toThrow('历史版本不存在');
  });
});
describe('字节上限（2026-10-18 字节上限批）', () => {
  /** 备份根下全部 .bak 的实算总字节（与 sweep 的计数口径一致：只认 .bak） */
  const backupRootBytes = async (): Promise<number> => {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.endsWith('.bak')) total += (await fs.stat(p)).size;
      }
    };
    await walk(path.join(appData, 'backup'));
    return total;
  };

  /** 带字节挡位的独立 io 实例（不干扰 beforeEach 的默认挡位 io） */
  const cappedIo = (
    caps: { maxPerBucketBytes?: number; maxTotalBytes?: number },
    warns?: string[],
  ): { io: FileIOServiceImpl; f: (name: string) => string } => {
    const log = warns === undefined
      ? undefined
      : { debug() {}, info() {}, warn: (m: string) => warns.push(m), error() {} };
    const io2 = new FileIOServiceImpl(new NodeBridge(appData), log, {}, undefined, caps);
    const dir = path.join(tmpDir, `ws-${Math.random().toString(36).slice(2)}`);
    io2.setAppWritableRoots([dir]);
    return { io: io2, f: (name: string) => path.join(dir, name) };
  };

  it('单桶字节超限：最旧先裁到预算内，且裁剪出声（铁律 4）', async () => {
    const warns: string[] = [];
    const { io: io2, f } = cappedIo({ maxPerBucketBytes: 10 }, warns);
    const x = f('x.ERB');
    await io2.writeText(x, 'aa', { encoding: 'utf-8' }); // 首存无备份
    await nap();
    await io2.writeText(x, 'bbbb', { encoding: 'utf-8' }); // 备份 'aa' 2B → 桶 2B
    await nap();
    await io2.writeText(x, 'cc', { encoding: 'utf-8' }); // 备份 'bbbb' 4B → 桶 6B
    await nap();
    await io2.writeText(x, 'dd', { encoding: 'utf-8' }); // 备份 'cc' 2B → 桶 8B
    await nap();
    await io2.writeText(x, 'ee', { encoding: 'utf-8' }); // 备份 'dd' 2B → 桶 10B（贴着上限）
    await nap();
    await io2.writeText(x, 'ff', { encoding: 'utf-8' }); // 备份 'ee' 2B → 12B > 10 ⇒ 裁 'aa' 2B
    const list = await io2.listBackups(x);
    expect(list).toHaveLength(4); // 'bbbb'/'cc'/'dd'/'ee'，最旧的 'aa' 被裁
    expect(list.map((v) => v.size).sort((a, b) => a - b)).toEqual([2, 2, 2, 4]);
    // 时间线最旧一版是 'bbbb'（4B）——'aa' 的 2B 已不在
    expect(list.reduce((m, v) => (v.id < m.id ? v : m)).size).toBe(4);
    expect(warns.some((w) => w.includes('备份桶字节超限'))).toBe(true);
  });

  it('总量超限（force 巡检）：跨桶按版本时序最旧先裁到预算内', async () => {
    const { io: io2, f } = cappedIo({ maxTotalBytes: 15 });
    const a = f('a.ERB');
    const b = f('b.ERB');
    await io2.writeText(a, 'a1', { encoding: 'utf-8' });
    await nap();
    await io2.writeText(a, 'a2', { encoding: 'utf-8' }); // 备份 2B
    await nap();
    await io2.writeText(a, 'a3', { encoding: 'utf-8' }); // 备份 2B
    await nap();
    await io2.writeText(b, 'b1', { encoding: 'utf-8' });
    await nap();
    await io2.writeText(b, 'b2', { encoding: 'utf-8' }); // 备份 2B → 总 6B ≤ 15
    await io2.sweepBackupRootBytes(true);
    expect(await backupRootBytes()).toBe(6);
    await nap();
    await io2.writeText(b, 'b3', { encoding: 'utf-8' }); // 8B
    await nap();
    await io2.writeText(b, 'b44', { encoding: 'utf-8' }); // 10B
    await nap();
    await io2.writeText(b, 'b555', { encoding: 'utf-8' }); // 13B
    await nap();
    await io2.writeText(b, 'b6', { encoding: 'utf-8' }); // 备份 'b555' 4B → 17B > 15
    await io2.sweepBackupRootBytes(true); // 裁最旧 'a1' 2B → 15B ≤ 15
    expect(await backupRootBytes()).toBe(15);
    // a 只剩较新一版（最旧 'a1' 被裁），b 完整保留（5 版）
    expect((await io2.listBackups(a)).map((v) => v.size)).toEqual([2]);
    expect((await io2.listBackups(b)).map((v) => v.size).sort((x, y) => x - y)).toEqual([2, 2, 2, 3, 4]);
  });

  it('总量巡检节流：60s 内不重复全根扫，force 绕过', async () => {
    const { io: io2, f } = cappedIo({ maxTotalBytes: 4 });
    const x = f('x.ERB');
    await io2.writeText(x, 'a1', { encoding: 'utf-8' });
    await nap();
    await io2.writeText(x, 'a2', { encoding: 'utf-8' }); // 备份 2B
    await io2.sweepBackupRootBytes(true); // 锚定节流钟（总量 2B ≤ 4 无操作）
    await nap();
    await io2.writeText(x, 'a3', { encoding: 'utf-8' }); // 4B；顺手巡检被节流
    await nap();
    await io2.writeText(x, 'a44', { encoding: 'utf-8' }); // 6B > 4；顺手巡检仍节流
    expect(await backupRootBytes()).toBe(6); // 节流内没裁
    await io2.sweepBackupRootBytes(); // 60s 内 ⇒ 早退
    expect(await backupRootBytes()).toBe(6);
    await io2.sweepBackupRootBytes(true); // force ⇒ 真裁最旧 2B
    expect(await backupRootBytes()).toBe(4);
  });
});
