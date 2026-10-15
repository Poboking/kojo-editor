import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import type { PlatformBridge } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../src/io';
import { NodeBridge } from './helpers/node-bridge';

/**
 * 批量读（2026-10-16 批量 IO 批）判据：
 *
 * 1. **IPC 形状**：`readTexts` 全程只走批量原语（readFilesRaw / statFiles），
 *    不落回 readFileBytes / stat 的单文件两趟——这是"~9,000 次单文件读"消掉的结构面；
 * 2. **只读一遍**：同一批文件第二次 `readTexts`（mtime+size 未变）零读盘（会话缓存命中）；
 * 3. **真变了要重读**：mtime 或内容变 ⇒ 重读那一个；写盘后缓存失效；
 * 4. **语义与 readText 逐位对齐**：同一文件两条路径产出的 {text, encoding, eol} 全等（含
 *    shift_jis / utf-8-bom / utf-16 夹具）；失败位 null 与 readText 抛错的失败条件一致；
 * 5. **上限纪律**：超上限削最旧（FIFO）、命中不动序。
 */

let tmpDir: string;
let appData: string;

/** 计数桥：以 NodeBridge 为原型覆写读原语（类方法在原型上，展开复制会丢） */
interface CountingBridge extends PlatformBridge {
  stats: {
    readFileBytes: number;
    stat: number;
    readFilesRaw: number;
    statFiles: number;
    readPaths: string[];
  };
}

function countingBridge(): CountingBridge {
  const inner = new NodeBridge(appData);
  const stats = { readFileBytes: 0, stat: 0, readFilesRaw: 0, statFiles: 0, readPaths: [] as string[] };
  const bridge = Object.create(inner) as CountingBridge;
  bridge.stats = stats;
  bridge.readFileBytes = async (p: string) => {
    stats.readFileBytes++;
    return inner.readFileBytes(p);
  };
  bridge.stat = async (p: string) => {
    stats.stat++;
    return inner.stat(p);
  };
  bridge.readFilesRaw = async (paths: readonly string[]) => {
    stats.readFilesRaw++;
    stats.readPaths.push(...paths);
    return inner.readFilesRaw(paths);
  };
  bridge.statFiles = async (paths: readonly string[]) => {
    stats.statFiles++;
    return inner.statFiles(paths);
  };
  return bridge;
}

async function writeRaw(file: string, bytes: Uint8Array | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

/** 显式设 mtime（避免同毫秒写入让"变更后重读"用例假绿） */
async function setMtime(file: string, ms: number): Promise<void> {
  const t = new Date(ms);
  await fs.utimes(file, t, t);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-iobatch-'));
  appData = path.join(tmpDir, 'appdata');
});

describe('FileIOService · readTexts（批量路径 + 会话缓存）', () => {
  it('批量路径全程不落单文件原语；二次读零读盘（只 statFiles）', async () => {
    const dir = path.join(tmpDir, 'proj');
    const files: string[] = [];
    for (let i = 0; i < 40; i++) {
      const f = path.join(dir, `f${String(i).padStart(3, '0')}.ERB`);
      await writeRaw(f, new TextEncoder().encode(`@F${i}\nPRINTL 第${i}条\n`));
      files.push(f);
    }
    const bridge = countingBridge();
    const io = new FileIOServiceImpl(bridge);

    const first = await io.readTexts(files);
    expect(first).toHaveLength(40);
    expect(first.every((t) => t !== null)).toBe(true);
    expect(first[7]!.text).toBe('@F7\nPRINTL 第7条\n');
    // IPC 形状：批量原语各走一趟（40 < 批大小 64 ⇒ 1 趟），单文件原语零调用
    expect(bridge.stats.readFilesRaw).toBe(1);
    expect(bridge.stats.statFiles).toBe(1);
    expect(bridge.stats.readFileBytes).toBe(0);
    expect(bridge.stats.stat).toBe(0);

    // 二次读（mtime+size 未变）：零读盘，只再批量 stat 一次
    const second = await io.readTexts(files);
    expect(second.map((t) => t?.text)).toEqual(first.map((t) => t?.text));
    expect(bridge.stats.readFilesRaw).toBe(1);
    expect(bridge.stats.statFiles).toBe(2);
    expect(bridge.stats.readFileBytes).toBe(0);
  });

  it('改过的文件只重读那一个（mtime 判据），其余零读盘', async () => {
    const dir = path.join(tmpDir, 'proj2');
    const a = path.join(dir, 'a.ERB');
    const b = path.join(dir, 'b.ERB');
    await writeRaw(a, Buffer.from('@A\n'));
    await writeRaw(b, Buffer.from('@B\n'));
    await setMtime(a, 1_000_000);
    await setMtime(b, 2_000_000);
    const bridge = countingBridge();
    const io = new FileIOServiceImpl(bridge);

    await io.readTexts([a, b]);
    expect(bridge.stats.readPaths.sort()).toEqual([a, b].sort());

    bridge.stats.readPaths.length = 0;
    await writeRaw(a, Buffer.from('@A2\n')); // 内容变了（mtime 也会刷新）
    await setMtime(a, 3_000_000);
    const again = await io.readTexts([a, b]);
    expect(again[0]!.text).toBe('@A2\n');
    expect(again[1]!.text).toBe('@B\n');
    expect(bridge.stats.readPaths).toEqual([a]); // 只有 A 重读
  });

  it('writeText 失效该 path：写后批量读必须看到新内容', async () => {
    const dir = path.join(tmpDir, 'proj3');
    const f = path.join(dir, 'w.ERB');
    await writeRaw(f, Buffer.from('@OLD\n'));
    const bridge = countingBridge();
    const io = new FileIOServiceImpl(bridge);
    io.setWritableRoots([dir]);

    const before = await io.readTexts([f]);
    expect(before[0]!.text).toBe('@OLD\n');

    await io.writeText(f, '@NEW\n');
    const after = await io.readTexts([f]);
    expect(after[0]!.text).toBe('@NEW\n');
    expect(bridge.stats.readPaths).toEqual([f, f]); // 两次都真读（写后缓存已失效）
  });

  it('失败位与 readText 的失败条件一致：缺文件 null、其余照常（不整批抛）', async () => {
    const dir = path.join(tmpDir, 'proj4');
    const ok = path.join(dir, 'ok.ERB');
    const missing = path.join(dir, 'gone.ERB');
    await writeRaw(ok, Buffer.from('@OK\n'));
    const io = new FileIOServiceImpl(countingBridge());

    const out = await io.readTexts([missing, ok]);
    expect(out[0]).toBeNull();
    expect(out[1]!.text).toBe('@OK\n');
    await expect(io.readText(missing)).rejects.toThrow(); // 失败条件同一条（丢文件）
  });

  it('编码语义与 readText 逐位对齐（shift_jis / utf-8-bom / utf-16le / 空文件）', async () => {
    const dir = path.join(tmpDir, 'proj5');
    const sjis = path.join(dir, 'sjis.ERB');
    const bom = path.join(dir, 'bom.ERB');
    const u16 = path.join(dir, 'u16.ERB');
    const empty = path.join(dir, 'empty.ERB');
    await writeRaw(sjis, iconv.encode('@K\r\nPRINTFORML 「こんにちは」\r\n', 'shift_jis'));
    await writeRaw(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('@B\nPRINTL 你好\n', 'utf8')]));
    await writeRaw(u16, iconv.encode('\uFEFF@U\nPRINTL 世界\n', 'utf-16le'));
    await writeRaw(empty, Buffer.from(''));
    const io = new FileIOServiceImpl(countingBridge());

    const paths = [sjis, bom, u16, empty];
    const batch = await io.readTexts(paths);
    const single = await Promise.all(paths.map((p) => io.readText(p)));
    for (let i = 0; i < paths.length; i++) {
      expect(batch[i]!.text).toBe(single[i]!.text);
      expect(batch[i]!.encoding).toBe(single[i]!.encoding);
      expect(batch[i]!.eol).toBe(single[i]!.eol);
      expect(batch[i]!.mtimeMs).toBe(single[i]!.mtimeMs);
    }
    // 且复核两条路径各自探测出的编码是对的（不是"两边都错成一样"）
    expect(batch.map((t) => t!.encoding)).toEqual(['shift_jis', 'utf-8-bom', 'utf-16le', 'utf-8']);
    expect(batch[0]!.eol).toBe('crlf');
  });

  it('缓存上限（FIFO）：超限削最旧；命中不动序', async () => {
    const dir = path.join(tmpDir, 'proj6');
    const a = path.join(dir, 'a.ERB');
    const b = path.join(dir, 'b.ERB');
    const c = path.join(dir, 'c.ERB');
    for (const [f, t] of [
      [a, '@A\n'],
      [b, '@B\n'],
      [c, '@C\n'],
    ] as const) {
      await writeRaw(f, Buffer.from(t));
      await setMtime(f, 1_000_000); // 同值 mtime：判据仍看 size+内容（本用例只测淘汰序）
    }
    const bridge = countingBridge();
    const io = new FileIOServiceImpl(bridge, undefined, { maxFiles: 2 });

    await io.readTexts([a, b]); // 缓存 [A, B]
    await io.readTexts([a]); // 命中：**不得**把 A 挪到队尾（FIFO 命中不动序）
    bridge.stats.readPaths.length = 0;
    await io.readTexts([c]); // 入 C ⇒ 削队首 A
    expect(bridge.stats.readPaths).toEqual([c]);
    bridge.stats.readPaths.length = 0;
    await io.readTexts([b]);
    // B 仍是命中 ⇒ 上一步削的是 A（若命中动序，此时队首会是 B、这里就是重读）
    expect(bridge.stats.readPaths).toEqual([]);

    const dbg = io.debugCaches().text;
    expect(dbg.files).toBeLessThanOrEqual(2);
  });

  it('缓存占用按 UTF-16 字符数收敛（超 chars 上限同样削）', async () => {
    const dir = path.join(tmpDir, 'proj7');
    const a = path.join(dir, 'big.ERB');
    const b = path.join(dir, 'small.ERB');
    await writeRaw(a, Buffer.from('@A\n' + 'x'.repeat(500)));
    await writeRaw(b, Buffer.from('@B\n'));
    const bridge = countingBridge();
    const io = new FileIOServiceImpl(bridge, undefined, { maxChars: 100 });

    await io.readTexts([a]);
    let dbg = io.debugCaches().text;
    expect(dbg.files).toBe(0); // 单文件即超限：入队后立刻被削掉（不是拒绝入队）
    expect(dbg.chars).toBe(0);
    expect(dbg.misses).toBe(1);

    await io.readTexts([b]);
    dbg = io.debugCaches().text;
    expect(dbg.files).toBe(1);
    expect(dbg.hits + dbg.misses).toBe(2); // 计数如实：一次未命中也要看得见
  });
});
