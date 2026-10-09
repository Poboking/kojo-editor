import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { WriteNotAllowedError } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../src/io';
import { NodeBridge } from './helpers/node-bridge';

let tmpDir: string;
let appData: string;
let io: FileIOServiceImpl;

async function writeRaw(file: string, bytes: Uint8Array | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-io-'));
  appData = path.join(tmpDir, 'appdata');
  io = new FileIOServiceImpl(new NodeBridge(appData));
});

describe('FileIOService · 读取与编码探测', () => {
  it('UTF-8-BOM 文件：探测 utf-8-bom、BOM 不进入内部文本', async () => {
    const f = path.join(tmpDir, 'kojo.ERB');
    await writeRaw(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('@M_KOJO_K1\nPRINTL 你好', 'utf8')]));
    const tf = await io.readText(f);
    expect(tf.encoding).toBe('utf-8-bom');
    expect(tf.text.startsWith('@M_KOJO_K1')).toBe(true);
    expect(tf.text).not.toContain('\uFEFF');
  });

  it('Shift-JIS 文件：探测 shift_jis 并以 UTF-8 内部表示读入', async () => {
    const f = path.join(tmpDir, 'sjis.ERB');
    await writeRaw(f, iconv.encode('@M_KOJO_K1_EVENT\r\n	PRINTFORML 「こんにちは」', 'shift_jis'));
    const tf = await io.readText(f);
    expect(tf.encoding).toBe('shift_jis');
    expect(tf.eol).toBe('crlf');
    expect(tf.text).toContain('こんにちは');
    expect(tf.text).toContain('\n');
    expect(tf.text).not.toContain('\r');
  });
});

describe('FileIOService · 写保护', () => {
  it('未声明可写根时一切写入被拒（游戏目录整体只读假设）', async () => {
    const f = path.join(tmpDir, 'game', 'x.ERB');
    await expect(io.writeText(f, 'data')).rejects.toThrow(WriteNotAllowedError);
    await expect(io.writeBytes(f, new Uint8Array([1]))).rejects.toThrow(WriteNotAllowedError);
  });

  it('声明可写根后允许写入其子树；根外仍拒绝', async () => {
    const kojo = path.join(tmpDir, 'game', 'ERB', '個人口上');
    io.setWritableRoots([kojo]);
    await io.writeText(path.join(kojo, '001', 'a.ERB'), 'ok');
    expect(await io.exists(path.join(kojo, '001', 'a.ERB'))).toBe(true);
    await expect(io.writeText(path.join(tmpDir, 'game', 'ERB', 'other.ERB'), 'no')).rejects.toThrow(WriteNotAllowedError);
  });

  it('isWritable 判定与白名单同步', () => {
    const kojo = path.join(tmpDir, 'game', '個人口上');
    expect(io.isWritable(path.join(kojo, 'x.ERB'))).toBe(false);
    io.setWritableRoots([kojo]);
    expect(io.isWritable(path.join(kojo, 'sub', 'x.ERB'))).toBe(true);
    io.setWritableRoots([]);
    expect(io.isWritable(path.join(kojo, 'x.ERB'))).toBe(false);
  });
});

describe('FileIOService · 编码保持与换行保持（防"一次保存毁半库"）', () => {
  it('Shift-JIS 文件读后写回：仍是 Shift-JIS 字节', async () => {
    const f = path.join(tmpDir, 'game', 'kojo.ERB');
    await writeRaw(f, iconv.encode('PRINTFORML 「おはよう」\r\n', 'shift_jis'));
    io.setWritableRoots([path.join(tmpDir, 'game')]);

    const tf = await io.readText(f);
    await io.writeText(f, tf.text + 'PRINTFORML 「おやすみ」\n');

    const bytes = await fs.readFile(f);
    expect(bytes[0]).not.toBe(0xef); // 无 UTF-8 BOM
    const decoded = iconv.decode(bytes, 'shift_jis');
    expect(decoded).toContain('おやすみ');
    expect(decoded).toContain('\r\n'); // CRLF 保持
    expect(decoded.endsWith('\r\n')).toBe(true);
  });

  it('UTF-8-BOM 文件写回保持 BOM', async () => {
    const f = path.join(tmpDir, 'game', 'cn.ERB');
    await writeRaw(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('PRINTL 你好\n', 'utf8')]));
    io.setWritableRoots([path.join(tmpDir, 'game')]);
    const tf = await io.readText(f);
    await io.writeText(f, tf.text + 'PRINTL 世界\n');
    const bytes = await fs.readFile(f);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('新文件默认 utf-8-bom + lf', async () => {
    const f = path.join(tmpDir, 'game', 'new.ERB');
    io.setWritableRoots([path.join(tmpDir, 'game')]);
    await io.writeText(f, 'PRINTL 新文件\n');
    const bytes = await fs.readFile(f);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.includes(0x0d)).toBe(false);
  });

  it('原子写：无 .tmp 残留', async () => {
    const dir = path.join(tmpDir, 'game');
    io.setWritableRoots([dir]);
    await io.writeText(path.join(dir, 'a.ERB'), 'x\n');
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.includes('.tmp'))).toHaveLength(0);
  });
});

describe('FileIOService · 备份', () => {
  it('写前自动备份到 appdata/backup；内容为旧版本', async () => {
    const f = path.join(tmpDir, 'game', 'a.ERB');
    io.setWritableRoots([path.join(tmpDir, 'game')]);
    await io.writeText(f, 'v1\n');
    await io.writeText(f, 'v2\n');

    const backupRoot = path.join(appData, 'backup');
    const dirs = await fs.readdir(backupRoot);
    expect(dirs.length).toBeGreaterThan(0);
    const files = await fs.readdir(path.join(backupRoot, dirs[0]!));
    expect(files.filter((x) => x.endsWith('.bak')).length).toBe(1);

    // 文件不存在时不产生备份
    const missing = await io.backup(path.join(tmpDir, 'nope.ERB'));
    expect(missing).toBeNull();
  });
});
