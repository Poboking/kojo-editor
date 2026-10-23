import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { pathKey, type FileEncoding } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../src/io';
import { decodeWithEncoding, ENCODING_IDS, isFileEncoding } from '../src/encoding';
import { NodeBridge } from './helpers/node-bridge';

/**
 * 显式编码读写（批次十 S2）：按指定编码重开 / 另存编码。
 *
 * 三条必须钉死的不变量：
 * 1. **重开即纠判**：探测认错的编码由调用方指定，读回的文本与 `iconv` 同口径；
 * 2. **缓存跟随**：重开 / 另存后的下一次 preserve 保存按指定编码写回，不退回旧探测；
 * 3. **未知编码报错**：`FileEncoding` 全集之外的值必须抛错，绝不静默按别的编码写。
 */

let tmpDir: string;
let appData: string;
let io: FileIOServiceImpl;

async function writeRaw(file: string, bytes: Uint8Array | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

async function readRaw(file: string): Promise<number[]> {
  return Array.from(await fs.readFile(file));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-enc-explicit-'));
  appData = path.join(tmpDir, 'appdata');
  io = new FileIOServiceImpl(new NodeBridge(appData));
  io.setWritableRoots([tmpDir]);
});

describe('显式编码 · 枚举与校验', () => {
  it('ENCODING_IDS 覆盖 FileEncoding 全集，isFileEncoding 只认这八个', () => {
    expect(ENCODING_IDS).toHaveLength(8);
    for (const id of ENCODING_IDS) expect(isFileEncoding(id)).toBe(true);
    expect(isFileEncoding('utf-32')).toBe(false);
    expect(isFileEncoding('latin1')).toBe(false);
  });

  it('decodeWithEncoding：按指定编码解码，未知编码抛原话错误', () => {
    const sjis = new Uint8Array(iconv.encode('「こんにちは」', 'shift_jis'));
    expect(decodeWithEncoding(sjis, 'shift_jis')).toBe('「こんにちは」');
    expect(() => decodeWithEncoding(sjis, 'utf-32' as FileEncoding)).toThrow(/不支持的编码/);
  });
});

describe('显式编码 · 重开（readTextWithEncoding）', () => {
  it('Shift-JIS 样本：显式解码 + 零改动保存逐字节不变（不退回探测）', async () => {
    const f = path.join(tmpDir, 'sjis.ERB');
    const original = new Uint8Array(iconv.encode('@K\r\nPRINTFORML 「こんにちは」\r\n', 'shift_jis'));
    await writeRaw(f, original);

    const tf = await io.readTextWithEncoding(f, 'shift_jis');
    expect(tf.encoding).toBe('shift_jis');
    expect(tf.eol).toBe('crlf');
    expect(tf.text).toBe('@K\nPRINTFORML 「こんにちは」\n');
    // 编码判据跟着入参走（下一次 preserve 保存的依据）
    expect(io.debugCaches().encoding.get(pathKey(f))).toBe('shift_jis');

    await io.writeText(f, tf.text); // 零改动 ⇒ 走原字节直写快道
    expect(await readRaw(f)).toEqual(Array.from(original));
  });

  it('GBK 样本：重开后编辑保存仍写 GBK，且逐行保留原换行（CRLF/LF 混排）', async () => {
    const f = path.join(tmpDir, 'gbk.ERB');
    await writeRaw(f, iconv.encode('口上测试，简体中文\r\n第二行\n', 'gbk'));

    const tf = await io.readTextWithEncoding(f, 'gbk');
    expect(tf.text).toBe('口上测试，简体中文\n第二行\n');

    await io.writeText(f, tf.text.replace('第二行', '第三行'));
    // 改动行两侧的分隔符按多数派 eol（此例 CRLF=1 / LF=1 平局 ⇒ lf）——既有 preserve 口径
    expect(iconv.decode(await fs.readFile(f), 'gbk')).toBe('口上测试，简体中文\n第三行\n');
    expect(io.debugCaches().encoding.get(pathKey(f))).toBe('gbk');
  });

  it('会话文本缓存按新解读失效（批量读不会留旧编码的正文）', async () => {
    const f = path.join(tmpDir, 'peek.ERB');
    await writeRaw(f, iconv.encode('こんにちは\n', 'shift_jis'));

    const [listed] = await io.readTexts([f]);
    expect(listed?.encoding).toBe('shift_jis');
    expect(io.peekTexts([f])[0]).not.toBeNull();

    await io.readTextWithEncoding(f, 'utf-8'); // 换一种解读 ⇒ 旧缓存不能再冒充新正文
    expect(io.peekTexts([f])[0]).toBeNull();
  });
});

describe('显式编码 · BOM 与另存编码（encodeForSave / adoptEncoding）', () => {
  it('UTF-16LE：显式解码剥 BOM；encodeForSave 重新补回 BOM', async () => {
    const f = path.join(tmpDir, 'utf16.ERB');
    await writeRaw(f, new Uint8Array(iconv.encode('\uFEFFPRINTL 世界\r\n', 'utf-16le')));

    const tf = await io.readTextWithEncoding(f, 'utf-16le');
    expect(tf.encoding).toBe('utf-16le');
    expect(tf.text).toBe('PRINTL 世界\n');
    expect(tf.text).not.toContain('\uFEFF');

    const bytes = await io.encodeForSave(f, tf.text, 'utf-16le');
    expect(Array.from(bytes.slice(0, 2))).toEqual([0xff, 0xfe]);
    expect(iconv.decode(Buffer.from(bytes), 'utf-16le').replace(/^\uFEFF/, '')).toBe('PRINTL 世界\r\n');
  });

  it('UTF-8-BOM：encodeForSave 产出前导 BOM', async () => {
    const f = path.join(tmpDir, 'u8bom.ERB');
    await writeRaw(f, new Uint8Array(new TextEncoder().encode('AB\n')));

    const bytes = await io.encodeForSave(f, 'AB\n', 'utf-8-bom');
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('UTF-8 → Shift-JIS 另存：写字节 + adoptEncoding 后，后续 preserve 保存不退回 UTF-8', async () => {
    const f = path.join(tmpDir, 'to-sjis.ERB');
    await writeRaw(f, new Uint8Array(new TextEncoder().encode('PRINTL こんにちは\r\n二行目\r\n')));

    const tf = await io.readText(f); // 探测 = utf-8
    expect(tf.encoding).toBe('utf-8');

    const bytes = await io.encodeForSave(f, tf.text, 'shift_jis');
    await io.writeBytes(f, bytes);
    io.adoptEncoding(f, 'shift_jis', bytes);

    expect(iconv.decode(await fs.readFile(f), 'shift_jis')).toBe('PRINTL こんにちは\r\n二行目\r\n');
    expect(io.debugCaches().encoding.get(pathKey(f))).toBe('shift_jis');

    // preserve 保存必须按 adopt 后的编码写回（而不是探测回来判成的编码）
    await io.writeText(f, tf.text.replace('こんにちは', 'おはよう'));
    expect(iconv.decode(await fs.readFile(f), 'shift_jis')).toBe('PRINTL おはよう\r\n二行目\r\n');
  });
});

describe('显式编码 · 未知编码必须报错', () => {
  it('重开 / 编码 / adopt 三个入口都对未知编码抛错（不静默写错）', async () => {
    const f = path.join(tmpDir, 'x.ERB');
    await writeRaw(f, new Uint8Array(new TextEncoder().encode('x\n')));

    await expect(io.readTextWithEncoding(f, 'utf-32' as FileEncoding)).rejects.toThrow(/不支持的编码/);
    await expect(io.encodeForSave(f, 'x', 'latin1' as FileEncoding)).rejects.toThrow(/不支持的编码/);
    expect(() => io.adoptEncoding(f, 'utf-32' as FileEncoding, new Uint8Array())).toThrow(/不支持的编码/);
  });
});
