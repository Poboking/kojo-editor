import { mkdirSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileIOServiceImpl, TrashManager, TRASH_ID_RE } from '../src';
import { NodeBridge } from './helpers/node-bridge';

/**
 * 回收站（2026-10-16 undo 批）：io.removeDir/removeFile 从"直接删"改为
 * "移入 {appData}/trash/"。全部用 NodeBridge 真临时目录（与 io-backups 同形态），
 * 跨卷回落用"rename 必败"的桥替身模拟（EXDEV 路径）。
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
    await expect(io.removeFile(f)).rejects.toThrow(/Write not allowed/);
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
