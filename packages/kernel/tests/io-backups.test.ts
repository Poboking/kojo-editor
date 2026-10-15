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
