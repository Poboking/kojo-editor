/**
 * EOL-OVERRIDE-SAVE 批：**显式 `{ eol }` 覆盖档**的落盘语义（内核面）。
 *
 * 背景：状态栏 EOL 切换的保存闭环由宿主 `ModelEntry.eolOverride` 置位 +
 * `writeText(path, text, { eol })` 显式档驱动。本文件用真实 `FileIOServiceImpl`
 * + Node 桥 + 临时目录钉死内核语义，与宿主接线（`status-eol-save.test.ts`）
 * 两半拼成闭环取证：
 *
 *   1. **纯切换**：盘上 CRLF 文件 readText 后原样 writeText + `{ eol: 'lf' }`
 *      → 原始字节全 LF（反之亦然）——显式档下"零改动快道"被跳过、整段统一，
 *      纯换行切换能真正落盘变档（缺省 preserve 会把它归回原档，故必须有覆盖档）；
 *   2. **切换 + 混改**：改一行内容 + 显式 eol → 全文件统一到目标档；
 *   3. **对照（旧消费方零改动）**：缺省（不传 eol）= preserve 逐行保换行，
 *      纯切换（未改内容）走零改动快道逐字节直写——字节保真不变量原样钉住。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-io-eol-'));
  appData = path.join(tmpDir, 'appdata');
  io = new FileIOServiceImpl(new NodeBridge(appData));
  io.setWritableRoots([path.join(tmpDir, 'game')]);
});

const CRLF_TEXT = '@M_KOJO_K1\r\nPRINTL こんにちは\r\nPRINTL また見てね\r\n';
const LF_BYTES = Buffer.from(CRLF_TEXT.replace(/\r\n/g, '\n'), 'utf8');
const CRLF_BYTES = Buffer.from(CRLF_TEXT, 'utf8');

describe('FileIOService · 显式 eol 覆盖档（EOL-OVERRIDE-SAVE 批）', () => {
  it('纯切换 CRLF → LF：原样回写 + { eol: lf } ⇒ 盘上字节全 LF、内容不变', async () => {
    const f = path.join(tmpDir, 'game', 'a.kojo');
    await writeRaw(f, CRLF_BYTES);
    const tf = await io.readText(f);
    expect(tf.eol).toBe('crlf');
    expect(tf.text).not.toContain('\r');

    await io.writeText(f, tf.text, { eol: 'lf' });

    const bytes = await fs.readFile(f);
    expect(bytes.equals(LF_BYTES)).toBe(true);
    // 回读口径：探测为 LF，文本无 \r
    const after = await io.readText(f);
    expect(after.eol).toBe('lf');
    expect(after.text).toBe(tf.text);
  });

  it('纯切换 LF → CRLF：反向同口径（盘上字节全 CRLF）', async () => {
    const f = path.join(tmpDir, 'game', 'b.kojo');
    await writeRaw(f, LF_BYTES);
    const tf = await io.readText(f);
    expect(tf.eol).toBe('lf');

    await io.writeText(f, tf.text, { eol: 'crlf' });

    const bytes = await fs.readFile(f);
    expect(bytes.equals(CRLF_BYTES)).toBe(true);
    expect((await io.readText(f)).eol).toBe('crlf');
  });

  it('切换 + 混改：改一行内容 + 显式 eol ⇒ 整文件（含改动行）统一到目标档', async () => {
    const f = path.join(tmpDir, 'game', 'c.kojo');
    await writeRaw(f, CRLF_BYTES);
    const tf = await io.readText(f);
    // 改第二行内容（混改：既切档又动文本）
    const mixed = tf.text.replace('PRINTL こんにちは', 'PRINTL こんばんは');
    expect(mixed).not.toBe(tf.text);

    await io.writeText(f, mixed, { eol: 'crlf' });

    const bytes = await fs.readFile(f);
    expect(bytes.equals(Buffer.from(mixed.replace(/\n/g, '\r\n'), 'utf8'))).toBe(true);
    const after = await io.readText(f);
    expect(after.eol).toBe('crlf');
    expect(after.text).toContain('こんばんは');
  });

  it('对照：缺省（不传 eol）= preserve——纯未改动内容走零改动快道，逐字节直写', async () => {
    const f = path.join(tmpDir, 'game', 'd.kojo');
    await writeRaw(f, CRLF_BYTES);
    const tf = await io.readText(f);

    await io.writeText(f, tf.text); // 缺省：旧消费方形状，逐字不变

    expect((await fs.readFile(f)).equals(CRLF_BYTES)).toBe(true);
  });
});
