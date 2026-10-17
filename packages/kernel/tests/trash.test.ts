import { mkdirSync, promises as fs, renameSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pathKey, WriteNotAllowedError } from '@kojo/plugin-api';
import { FileIOServiceImpl, TrashManager, TRASH_ID_RE, TRASH_KEEP_DAYS, trashEntryTimeMs } from '../src';
import { NodeBridge } from './helpers/node-bridge';

/**
 * 回收站（2026-10-16 undo 批）：io.removeDir/removeFile 从"直接删"改为
 * "移入 {appData}/trash/"。全部用 NodeBridge 真临时目录（与 io-backups 同形态），
 * 跨卷回落用"rename 必败"的桥替身模拟（EXDEV 路径）。
 *
 * W11 回收站可见批补的钉子：`listTrash` / `restoreFromTrash` / `purgeTrash` / `holdTrash`
 * 这条对外读面（字节往返一致、闸不可绕、恢复前现状落账、超期清扫不误伤正被引用的条目）。
 */

let tmpDir: string;
let appData: string;
let io: FileIOServiceImpl;
const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-trash-'));
  appData = path.join(tmpDir, 'appdata');
  io = new FileIOServiceImpl(new NodeBridge(appData), noopLog);
});

const writableDir = (): string => {
  const dir = path.join(tmpDir, 'ws');
  io.setAppWritableRoots([dir]);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const DAY = 24 * 60 * 60 * 1000;
const p2 = (n: number): string => String(n).padStart(2, '0');
/** 毫秒段必须三位——`TRASH_ID_RE` / `io.timestamp()` 认的是 `\d{3}`（两位会让改老后的条目名直接失配） */
const p3 = (n: number): string => String(n).padStart(3, '0');
const trashRoot = (): string => path.join(appData, 'trash');
const entryDirOf = (id: string): string => path.join(trashRoot(), id);

/**
 * 条目名的时间戳段改成 N 天前（**年龄尺 = 条目名**，manifest 不动；id 形态仍命中 TRASH_ID_RE）。
 * 只算不改盘——配合下面的 `ageEntry` 使用。
 *
 * 毫秒段用 `p3`：这里少补一个零，改老出来的条目名就不合 `TRASH_ID_RE`，
 * `listTrash` 与 `purge` 会同时把它当"形态不合"跳过 —— 用例只在 `Date.now()` 的
 * 毫秒数 ≥100 时才绿（约 90% 概率绿、10% 随机红，红相是"purge 返回 0"）。
 */
const shiftIdBack = (id: string, days: number): string => {
  const d = new Date(Date.now() - days * DAY);
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${p3(d.getMilliseconds())}`;
  return `${stamp}-${id.split('-').slice(-1)[0]}`;
};

/** 造一个真条目（走 io 的删除通道），返回它的 id */
async function makeEntry(ws: string, name: string): Promise<string> {
  const target = path.join(ws, name);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'body.txt'), `${name} 的内容`);
  await io.removeDir(target);
  const found = await io.listTrash();
  const entry = found.find((e) => pathKey(e.originalPath) === pathKey(target));
  if (!entry) throw new Error(`条目没进回收站：${target}`);
  return entry.id;
}

/**
 * 把某条条目改成 N 天前（改名，年龄判据跟着走）。
 *
 * **顺序是硬约束**：`removeDir/removeFile` 内部会顺手做一次超期清扫，所以必须
 * "先造条目、后改年龄"——反过来写会让前一条被这一趟顺手清掉（测试自己造的竞态）。
 */
function ageEntry(id: string, daysAgo: number): string {
  const stale = shiftIdBack(id, daysAgo);
  renameSync(entryDirOf(id), entryDirOf(stale));
  return stale;
}

/** 造一个"已经超期"的条目（单条用例的便捷形态：先造后老） */
async function staleEntry(ws: string, name: string, daysAgo: number): Promise<string> {
  return ageEntry(await makeEntry(ws, name), daysAgo);
}

describe('io.removeDir / removeFile · 移入回收站', () => {
  it('removeDir 后目录从原位消失，trash 里出现带 manifest 的条目', async () => {
    const ws = writableDir();
    const proj = path.join(ws, 'p1');
    await fs.mkdir(path.join(proj, 'sub'), { recursive: true });
    await fs.writeFile(path.join(proj, 'a.ERB'), '内容A');
    await fs.writeFile(path.join(proj, 'sub', 'b.ERB'), '内容B');

    await io.removeDir(proj);

    await expect(fs.access(proj)).rejects.toThrow();
    const entries = await new TrashManager(new NodeBridge(appData), noopLog).list();
    expect(entries).toHaveLength(1);
    expect(TRASH_ID_RE.test(entries[0]!.id)).toBe(true);
    expect(entries[0]!.kind).toBe('dir');
    expect(entries[0]!.originalPath).toBe(proj);
    // payload 保留相对结构
    const payload = path.join(appData, 'trash', entries[0]!.id, 'payload');
    expect(await fs.readFile(path.join(payload, 'a.ERB'), 'utf-8')).toBe('内容A');
    expect(await fs.readFile(path.join(payload, 'sub', 'b.ERB'), 'utf-8')).toBe('内容B');
  });

  it('removeFile 后文件进 trash（kind=file），幂等语义不变：removeDir 不存在的目录照样成功', async () => {
    const ws = writableDir();
    const f = path.join(ws, 'x.ERB');
    await fs.writeFile(f, '数据');
    await io.removeFile(f);
    await expect(fs.access(f)).rejects.toThrow();

    const entries = await new TrashManager(new NodeBridge(appData), noopLog).list();
    expect(entries.map((e) => e.kind)).toEqual(['file']);
    // 幂等契约：removeDir 一个不存在的路径不是错误
    await expect(io.removeDir(path.join(ws, 'no-such-dir'))).resolves.toBeUndefined();
  });

  it('写允许域语义不变：越权删除照样 WriteNotAllowedError，盘上与 trash 都不动', async () => {
    const f = path.join(tmpDir, 'outside', 'y.ERB');
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, '域外');
    await expect(io.removeFile(f)).rejects.toThrow(WriteNotAllowedError);
    const entries = await new TrashManager(new NodeBridge(appData), noopLog).list();
    expect(entries).toHaveLength(0);
    expect(await fs.readFile(f, 'utf-8')).toBe('域外');
  });

  it('管理性裁剪绕回收站：备份桶 prune 直删（不往 trash 塞 .bak）', async () => {
    const ws = writableDir();
    const f = path.join(ws, 'z.ERB');
    for (let i = 0; i < 22; i++) {
      await io.writeText(f, `版本-${i}`, { encoding: 'utf-8' });
      await new Promise((r) => setTimeout(r, 3));
    }
    const list = await io.listBackups(f);
    expect(list).toHaveLength(20); // prune 正常裁剪
    const entries = await new TrashManager(new NodeBridge(appData), noopLog).list();
    expect(entries.every((e) => e.originalPath !== list[0]!.path)).toBe(true);
    expect(entries).toHaveLength(0);
  });
});

describe('TrashManager · restore / purge / 跨卷回落', () => {
  it('restore：目录整体回原位（含相对结构），trash 条目清掉', async () => {
    const tm = new TrashManager(new NodeBridge(appData), noopLog);
    const ws = writableDir();
    const proj = path.join(ws, 'p2');
    await fs.mkdir(proj, { recursive: true });
    await fs.writeFile(path.join(proj, 'keep.txt'), '原样');

    await tm.moveIntoTrash(proj, 'dir');
    const [entry] = await tm.list();
    const restored = await tm.restore(entry!.id);

    expect(restored).toBe(proj);
    expect(await fs.readFile(path.join(proj, 'keep.txt'), 'utf-8')).toBe('原样');
    expect(await tm.list()).toHaveLength(0);
  });

  it('restore：原位置已被占用 → 拒绝（回收站不覆盖）', async () => {
    const tm = new TrashManager(new NodeBridge(appData), noopLog);
    const ws = writableDir();
    const f = path.join(ws, 'gone.txt');
    await fs.writeFile(f, '旧的');
    await tm.moveIntoTrash(f, 'file');
    const [entry] = await tm.list();
    await fs.writeFile(f, '新的');
    await expect(tm.restore(entry!.id)).rejects.toThrow(/已存在/);
    expect(await fs.readFile(f, 'utf-8')).toBe('新的');
  });

  it('purge：超 30 天的条目清掉，新的留下（时间判据来自条目名，不猜）', async () => {
    const tm = new TrashManager(new NodeBridge(appData), noopLog);
    const ws = writableDir();
    const oldDir = path.join(ws, 'old');
    const newDir = path.join(ws, 'fresh');
    await fs.mkdir(oldDir, { recursive: true });
    await fs.mkdir(newDir, { recursive: true });
    await tm.moveIntoTrash(oldDir, 'dir');
    await tm.moveIntoTrash(newDir, 'dir');
    // 把 old 条目的目录名改成 31 天前（TRASH_ID_RE 仍命中）
    const entries = await tm.list();
    const oldEntry = entries.find((e) => e.originalPath === oldDir)!;
    const old31 = new Date(Date.now() - 31 * 24 * 3600 * 1000);
    const p = (n: number): string => String(n).padStart(2, '0');
    const staleId = `${old31.getFullYear()}${p(old31.getMonth() + 1)}${p(old31.getDate())}-${p(old31.getHours())}${p(old31.getMinutes())}${p(old31.getSeconds())}-000-${oldEntry.id.split('-').slice(-1)[0]}`;
    await fs.rename(
      path.join(appData, 'trash', oldEntry.id),
      path.join(appData, 'trash', staleId),
    );
    const purged = await tm.purge();
    expect(purged).toBe(1);
    const left = await tm.list();
    expect(left.map((e) => e.originalPath)).toEqual([newDir]);
  });

  it('跨卷回落：rename 抛 EXDEV → 逐文件 copy + 删源，内容与结构保真', async () => {
    class ExDevBridge extends NodeBridge {
      override async rename(): Promise<void> {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      }
    }
    const tm = new TrashManager(new ExDevBridge(appData), noopLog);
    const ws = writableDir();
    const proj = path.join(ws, 'p3');
    await fs.mkdir(path.join(proj, 'nest'), { recursive: true });
    await fs.writeFile(path.join(proj, 'n1.ERB'), '一层');
    await fs.writeFile(path.join(proj, 'nest', 'n2.ERB'), '二层');

    await tm.moveIntoTrash(proj, 'dir');
    await expect(fs.access(proj)).rejects.toThrow(); // 源已清
    const [entry] = await tm.list();
    const payload = path.join(appData, 'trash', entry!.id, 'payload');
    expect(await fs.readFile(path.join(payload, 'n1.ERB'), 'utf-8')).toBe('一层');
    expect(await fs.readFile(path.join(payload, 'nest', 'n2.ERB'), 'utf-8')).toBe('二层');

    // 文件条目的回落同样成立
    const f = path.join(ws, 'single.txt');
    await fs.writeFile(f, '单文件');
    await tm.moveIntoTrash(f, 'file');
    await expect(fs.access(f)).rejects.toThrow();
    const [fileEntry] = await tm.list();
    const filePayload = path.join(appData, 'trash', fileEntry!.id, 'payload');
    expect(await fs.readFile(filePayload, 'utf-8')).toBe('单文件');
  });
});

/* ============ W11 回收站可见批：对外读面（契约 listTrash / restoreFromTrash / purgeTrash / holdTrash） ============ */

describe('io.listTrash / io.restoreFromTrash · 往返字节一致', () => {
  it('文件条目：删掉再放回，盘上字节与删除前逐位相同（搬运链路零转码）', async () => {
    const ws = writableDir();
    const f = path.join(ws, 'raw.ERB');
    const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x1b, 0x24, 0x00]);
    await fs.writeFile(f, bytes);

    await io.removeFile(f);
    const [entry] = await io.listTrash();
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('file');
    expect(entry!.originalPath).toBe(f);
    await expect(fs.access(f)).rejects.toThrow();

    const back = await io.restoreFromTrash(entry!.id);
    expect(back).toBe(f);
    expect((await fs.readFile(f)).equals(bytes)).toBe(true);
    // 条目用掉即消失：回收站不是第二份历史账（"现状"那一侧由写前备份负责）
    expect(await io.listTrash()).toHaveLength(0);
  });

  it('目录条目：整棵子树回到原位（相对结构与每个文件的字节都不变）', async () => {
    const ws = writableDir();
    const dir = path.join(ws, '包');
    await fs.mkdir(path.join(dir, '子'), { recursive: true });
    const a = Buffer.from('一一一');
    const b = Buffer.from([0x82, 0xa0, 0x82, 0xb1]); // shift_jis 字节，按 UTF-8 解码会炸——正好当零转码的证据
    await fs.writeFile(path.join(dir, 'a.ERB'), a);
    await fs.writeFile(path.join(dir, '子', 'b.ERB'), b);

    await io.removeDir(dir);
    const [entry] = await io.listTrash();
    expect(entry!.kind).toBe('dir');
    await io.restoreFromTrash(entry!.id);
    expect((await fs.readFile(path.join(dir, 'a.ERB'))).equals(a)).toBe(true);
    expect((await fs.readFile(path.join(dir, '子', 'b.ERB'))).equals(b)).toBe(true);
  });

  it('落点不在写允许域 ⇒ 可见拒绝，条目与原位都不动（恢复不许绕第一道闸）', async () => {
    const ws = writableDir();
    const f = path.join(ws, 'gate.ERB');
    await fs.writeFile(f, 'x');
    await io.removeFile(f);
    const [entry] = await io.listTrash();

    io.setAppWritableRoots([]); // 授权收回（项目关闭的形态）
    await expect(io.restoreFromTrash(entry!.id)).rejects.toThrow(WriteNotAllowedError);
    await expect(fs.access(f)).rejects.toThrow(); // 一个字节都没搬
    expect((await io.listTrash()).map((e) => e.id)).toEqual([entry!.id]); // 条目还在，授权回来可以再试

    io.setAppWritableRoots([ws]);
    await expect(io.restoreFromTrash(entry!.id)).resolves.toBe(f);
  });

  it('恢复前的现状保护确实落账：原位站着另一个文件时，它先被记进写前备份账再被换掉', async () => {
    const ws = writableDir();
    const f = path.join(ws, 'both.ERB');
    await fs.writeFile(f, Buffer.from('删除的那一版', 'utf-8'));
    await io.removeFile(f);
    const [entry] = await io.listTrash();
    // 原位又站了东西——用裸写绕开 writeText，故意让这份现状**不在任何账上**
    await fs.writeFile(f, Buffer.from('后来写的现状', 'utf-8'));
    expect(await io.listBackups(f)).toHaveLength(0);

    await io.restoreFromTrash(entry!.id);
    const versions = await io.listBackups(f);
    expect(versions).toHaveLength(1);
    const landed = Buffer.from(await io.readBytes(versions[0]!.path)).toString('utf-8');
    expect(landed).toBe('后来写的现状'); // 现状落了账 ⇒ 同一条时间线上看得见
    expect((await fs.readFile(f)).toString('utf-8')).toBe('删除的那一版'); // 条目回到原位
  });

  it('目录条目撞上"原位已有同名目录" ⇒ 拒绝（整棵子树没有一份现状可以备份）', async () => {
    const ws = writableDir();
    const dir = path.join(ws, 'pkg');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'old.txt'), '旧');
    await io.removeDir(dir);
    const [entry] = await io.listTrash();
    await fs.mkdir(path.join(dir, '新子'), { recursive: true });
    await fs.writeFile(path.join(dir, '新子', 'now.txt'), '新');

    await expect(io.restoreFromTrash(entry!.id)).rejects.toThrow(/原位置已存在/);
    expect((await fs.readFile(path.join(dir, '新子', 'now.txt'), 'utf-8'))).toBe('新');
    expect((await io.listTrash()).map((e) => e.id)).toEqual([entry!.id]);
  });
});

describe('io.listTrash · 字段口径（剩余天数不许撒谎）', () => {
  it('年龄只认条目名的时间戳段：manifest 里的 deletedAt 改了也不动口径', async () => {
    const ws = writableDir();
    const dir = path.join(ws, 'age');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.txt'), 'x');
    await io.removeDir(dir);
    const [e] = await io.listTrash();
    const manifestPath = path.join(entryDirOf(e!.id), 'manifest.json');
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as { deletedAt: number };
    raw.deletedAt = Date.now() - 60 * DAY; // 另一个时钟：假装"其实 60 天前就删了"
    await fs.writeFile(manifestPath, JSON.stringify(raw));

    const [again] = await io.listTrash();
    expect(again!.deletedAtMs).toBe(trashEntryTimeMs(again!.id));
    expect(again!.expiresAtMs - again!.deletedAtMs).toBe(TRASH_KEEP_DAYS * DAY);
    expect(again!.expiresAtMs - Date.now()).toBeGreaterThan(29 * DAY); // 还有一整个保留期，不是"已过期"
  });

  it('反向证据：条目名超期而 manifest 说自己很新 ⇒ purge 认条目名（显示与清理同一把尺）', async () => {
    const ws = writableDir();
    const stale = await staleEntry(ws, 'old', 31);
    const manifestPath = path.join(entryDirOf(stale), 'manifest.json');
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as { deletedAt: number };
    raw.deletedAt = Date.now();
    await fs.writeFile(manifestPath, JSON.stringify(raw));
    expect(await io.purgeTrash()).toBe(1);
    expect(await io.listTrash()).toHaveLength(0);
  });

  it('bytes：文件 = 本体大小，目录 = payload 递归求和；payloadPath 就是那一坨内容', async () => {
    const ws = writableDir();
    const f = path.join(ws, 'size.txt');
    await fs.writeFile(f, Buffer.alloc(7, 1));
    const dir = path.join(ws, 'sizes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'x'), Buffer.alloc(3, 2));
    await fs.writeFile(path.join(dir, 'y'), Buffer.alloc(4, 3));
    await io.removeFile(f);
    await io.removeDir(dir);
    const entries = await io.listTrash();
    const fileEntry = entries.find((e) => e.kind === 'file')!;
    const dirEntry = entries.find((e) => e.kind === 'dir')!;
    expect(fileEntry.bytes).toBe(7);
    expect(dirEntry.bytes).toBe(7);
    expect(dirEntry.payloadPath).toBe(path.join(trashRoot(), dirEntry.id, 'payload'));
  });

  it('forPath 只留相关条目：同一个东西 / 在被删目录里 / 目录里有被删文件（不给 = 全量）', async () => {
    const ws = writableDir();
    const a = path.join(ws, 'A');
    await fs.mkdir(a, { recursive: true });
    const inner = path.join(a, 'inner.ERB');
    await fs.writeFile(inner, 'i');
    const b = path.join(ws, 'B.ERB');
    await fs.writeFile(b, 'b');
    await io.removeDir(a);
    await io.removeFile(b);

    expect((await io.listTrash({ forPath: inner })).map((e) => e.kind)).toEqual(['dir']);
    expect((await io.listTrash({ forPath: b })).map((e) => e.kind)).toEqual(['file']);
    // 大小写/分隔符写法不算另一个文件
    expect((await io.listTrash({ forPath: path.join(ws, 'a', 'INNER.erb') })).map((e) => e.kind)).toEqual(['dir']);
    expect(await io.listTrash({ forPath: path.join(ws, 'C.ERB') })).toHaveLength(0);
    expect(await io.listTrash()).toHaveLength(2);
  });

  it('形态不合 / manifest 坏的目录不进清单（列出来只会摆一个点不动的按钮）', async () => {
    const stray = path.join(trashRoot(), 'stray-dir');
    await fs.mkdir(stray, { recursive: true });
    await fs.writeFile(
      path.join(stray, 'manifest.json'),
      JSON.stringify({ v: 1, originalPath: 'C:/x', deletedAt: Date.now(), kind: 'file' }),
    );
    const ws = writableDir();
    const f = path.join(ws, 'good.txt');
    await fs.writeFile(f, 'x');
    await io.removeFile(f);
    const [good] = await io.listTrash();
    await fs.rm(path.join(entryDirOf(good!.id), 'manifest.json'), { force: true });
    expect(await io.listTrash()).toHaveLength(0); // 坏 manifest 的那条 + 形态不合的那条都不进清单
  });
});

/** rename 必败的桥替身（非跨卷失败 ⇒ 走账本回滚路径，不走 copy+delete 回落） */
class RenameFailingBridge extends NodeBridge {
  override async rename(_from: string, _to: string): Promise<void> {
    throw new Error('EIO: 注入的写失败');
  }
}

/** 记录「manifest 落盘」与「rename 搬运」先后顺序的桥替身（两阶段提交的序判据） */
class OrderRecordingBridge extends NodeBridge {
  readonly calls: string[] = [];
  override async rename(from: string, to: string): Promise<void> {
    this.calls.push('rename');
    return super.rename(from, to);
  }
  override async writeFileBytes(p: string, data: Uint8Array): Promise<void> {
    if (p.endsWith('manifest.json')) this.calls.push('manifest');
    return super.writeFileBytes(p, data);
  }
}

describe('moveIntoTrash · 两阶段提交（manifest 先行，2026-10-17 修复）', () => {
  it('rename 失败（非跨卷）⇒ 上抛、账本回滚不留半成品条目、源文件原位不动', async () => {
    const ws = writableDir();
    const target = path.join(ws, 'gone');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'body.txt'), 'x');
    const failing = new TrashManager(new RenameFailingBridge(appData), noopLog);
    await expect(failing.moveIntoTrash(target, 'dir')).rejects.toThrow(/注入的写失败/);
    expect(await fs.readdir(trashRoot()).catch(() => [])).toEqual([]);
    expect(await fs.readFile(path.join(target, 'body.txt'), 'utf-8')).toBe('x');
  });

  it('manifest 先于 rename 落盘：中间崩溃只剩「有账无货」（rename 原子 ⇒ 源不丢）', async () => {
    const ws = writableDir();
    const f = path.join(ws, 'f.txt');
    await fs.writeFile(f, 'x');
    const bridge = new OrderRecordingBridge(appData);
    const tm = new TrashManager(bridge, noopLog);
    await tm.moveIntoTrash(f, 'file');
    expect(bridge.calls.indexOf('manifest')).toBeGreaterThanOrEqual(0);
    expect(bridge.calls.indexOf('manifest')).toBeLessThan(bridge.calls.indexOf('rename'));
    const [entry] = await tm.list();
    expect(entry?.kind).toBe('file');
  });
});

describe('io.purgeTrash / io.holdTrash · 超期清扫不误伤正被引用的条目', () => {
  it('holdTrash 登记过的超期条目跳过；撤回引用后同一趟就清掉', async () => {
    const ws = writableDir();
    // 先都造好、再一起改老（改老之后再删别的条目，会让那一趟顺手清扫提前把人收走）
    const keepId = await makeEntry(ws, 'keep');
    const goneId = await makeEntry(ws, 'gone');
    const keep = ageEntry(keepId, 31);
    ageEntry(goneId, 31);

    io.holdTrash([keep]);
    expect(await io.purgeTrash()).toBe(1);
    expect((await io.listTrash()).map((e) => e.id)).toEqual([keep]);
    // "正看着"不只是嘴上说说：被引用的条目必须还能恢复
    await io.restoreFromTrash(keep);
    expect(await fs.readFile(path.join(ws, 'keep', 'body.txt'), 'utf-8')).toBe('keep 的内容');
    expect(await io.listTrash()).toHaveLength(0);

    io.holdTrash([]); // 撤回引用（整替语义）
    const lastId = await makeEntry(ws, 'last');
    ageEntry(lastId, 31);
    expect(await io.purgeTrash()).toBe(1);
    expect(await io.listTrash()).toHaveLength(0);
  });

  it('holdTrash 是整替语义（第二次的清单取代第一次的，不叠加成永久豁免）', async () => {
    const ws = writableDir();
    // 先都造好、再一起改老（否则"改老 a 之后再删 b"会让 b 那趟顺手清扫把 a 直接收走）
    const aId = await makeEntry(ws, 'a');
    const bId = await makeEntry(ws, 'b');
    const a = ageEntry(aId, 31);
    const b = ageEntry(bId, 31);
    io.holdTrash([a]);
    io.holdTrash([b]); // a 不再被引用
    expect(await io.purgeTrash()).toBe(1);
    expect((await io.listTrash()).map((e) => e.id)).toEqual([b]);
  });

  it('删除时顺手的自动清扫同样走这一条保护（不因为"顺手"就抽走用户正看着的东西）', async () => {
    const ws = writableDir();
    const tm = new TrashManager(new NodeBridge(appData), noopLog);
    const target = path.join(ws, 'watched');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'a.txt'), 'x');
    await tm.moveIntoTrash(target, 'dir');
    const [fresh] = await tm.list();
    const stale = ageEntry(fresh!.id, 31);

    tm.hold([stale]);
    const other = path.join(ws, 'other.txt');
    await fs.writeFile(other, 'y');
    await tm.moveIntoTrash(other, 'file'); // 内部顺手 purge（尽力而为的异步动作）
    await tm.flushSweep();
    expect((await tm.list()).map((e) => e.id)).toContain(stale); // 被引用的超期条目活下来了

    tm.hold([]);
    await expect(tm.purge()).resolves.toBe(1); // 只清超期那一条：另一条还没到期
    expect((await tm.list()).map((e) => e.id)).toHaveLength(1);
  });

  it('purgeTrash([id]) = 用户显式彻底删除：不看保留期也不看引用；id 不合形态或不在位都抛错', async () => {
    const ws = writableDir();
    const f = path.join(ws, 'purge.txt');
    await fs.writeFile(f, 'x');
    await io.removeFile(f);
    const [e] = await io.listTrash();
    io.holdTrash([e!.id]);
    expect(await io.purgeTrash([e!.id])).toBe(1); // 显式指令赢过引用登记
    expect(await io.listTrash()).toHaveLength(0);
    await expect(io.purgeTrash([e!.id])).rejects.toThrow(/不存在|已被清理/);
    await expect(io.purgeTrash(['../../etc'])).rejects.toThrow(/无效的回收站条目/);
    expect(await io.purgeTrash([])).toBe(0); // 传空数组 = 显式删 0 个，不是"清空过期"
  });

  it('彻底删除是真删（不进回收站；trash 根不自增殖）', async () => {
    const ws = writableDir();
    const f = path.join(ws, 'gone-for-good.txt');
    await fs.writeFile(f, 'x');
    await io.removeFile(f);
    const [e] = await io.listTrash();
    await io.purgeTrash([e!.id]);
    expect(await fs.stat(entryDirOf(e!.id)).catch(() => null)).toBeNull();
    const rest = await fs.readdir(trashRoot()).catch(() => []);
    expect(rest).toEqual([]);
  });
});

