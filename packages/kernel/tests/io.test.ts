import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { WriteNotAllowedError, pathKey, type PlatformBridge } from '@kojo/plugin-api';
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

  it('addAppWritableRoot：追加去重，且不收回既有授权（与 setAppWritableRoots 的整替语义并存）', () => {
    const a = path.join(tmpDir, 'works', 'A');
    const b = path.join(tmpDir, 'works', 'B');
    io.setAppWritableRoots([a]);
    expect(io.isWritable(path.join(a, '包', '事件.ERB'))).toBe(true);
    expect(io.isWritable(path.join(b, 'x.txt'))).toBe(false);

    io.addAppWritableRoot(b);
    expect(io.isWritable(path.join(b, '子', 'x.txt'))).toBe(true);
    expect(io.isWritable(path.join(a, 'x.txt'))).toBe(true); // 旧授权没被收回

    // 同一个目录的另一种写法（尾分隔符）不重复登记：整替一次即可回到干净状态
    io.addAppWritableRoot(`${b}${path.sep}`);
    io.setWritableRoots([]);
    expect(io.isWritable(path.join(b, 'x.txt'))).toBe(true);
  });

  it('chooseWorkspaceRoot：选定只回答"作品能建在哪"，不在 io 侧整根放宽；取消时更是一个字节不动', async () => {
    const chosen = path.join(tmpDir, 'works', '自选位置');
    /** 以 NodeBridge 为原型覆写对话框通道（类方法在原型上，展开复制会丢） */
    const withPicked = (root: string | null): PlatformBridge =>
      Object.assign(Object.create(new NodeBridge(appData)) as PlatformBridge, {
        chooseWorkspaceRoot: async () => root,
      });

    expect(io.isWritable(path.join(chosen, 'x.txt'))).toBe(false);

    const cancelled = new FileIOServiceImpl(withPicked(null));
    await expect(cancelled.chooseWorkspaceRoot({ title: '选吧' })).resolves.toBeNull();
    expect(cancelled.isWritable(path.join(chosen, 'x.txt'))).toBe(false);

    const picked = new FileIOServiceImpl(withPicked(chosen));
    await expect(picked.chooseWorkspaceRoot({ title: '选吧' })).resolves.toBe(chosen);
    // 2026-10-27 收窄批：选定根可能是游戏目录，本层绝不整根放宽；
    // 可写的是 WorkspaceService 建出来/扫出来的作品目录（那条链在 workspace.test.ts 钉着）。
    expect(picked.isWritable(path.join(chosen, '包', '事件.ERB'))).toBe(false);
    expect(picked.isWritable(path.join(chosen, 'x.txt'))).toBe(false);
  });

  it('chooseWorkspaceRoot：平台无对话框能力时错误如实上抛（不静默降级回默认位置）', async () => {
    await expect(io.chooseWorkspaceRoot({ title: '选吧' })).rejects.toThrow(
      /chooseWorkspaceRoot is not supported by NodeBridge/,
    );
  });

  it('pickDirectory：只选不授权（选定路径一个字节都不进可写域）；平台无此能力时人话上抛', async () => {
    const source = path.join(tmpDir, '作者包来源');
    const withPicker = Object.assign(Object.create(new NodeBridge(appData)) as PlatformBridge, {
      pickDirectory: async () => source,
    });
    const pickIo = new FileIOServiceImpl(withPicker);
    await expect(pickIo.pickDirectory({ title: '选来源' })).resolves.toBe(source);
    // 2026-10-27 导入来源批：来源目录是只读的，绝不因为"选过"就变可写
    expect(pickIo.isWritable(path.join(source, 'x.txt'))).toBe(false);

    await expect(io.pickDirectory({ title: '选来源' })).rejects.toThrow(/没有目录选择能力/);
  });
});

describe('FileIOService · ensureDir（先建目录再写文件的链路）', () => {
  it('域内递归建目录；已存在时幂等成功', async () => {
    const kojo = path.join(tmpDir, 'game', '個人口上');
    io.setWritableRoots([kojo]);
    const deep = path.join(kojo, '012 Rumia', 'ルーミア');
    await io.ensureDir(deep);
    expect(await io.exists(deep)).toBe(true);
    // 幂等：重复调用不抛
    await expect(io.ensureDir(deep)).resolves.toBeUndefined();
  });

  it('域外目录创建被拒（与 writeBytes 同闸，不先造出目录）', async () => {
    io.setWritableRoots([path.join(tmpDir, 'game', '個人口上')]);
    const outside = path.join(tmpDir, 'game', 'ERB', 'out');
    await expect(io.ensureDir(outside)).rejects.toThrow(WriteNotAllowedError);
    expect(await io.exists(outside)).toBe(false);
  });

  it('未声明任何可写根时一切目录创建被拒', async () => {
    await expect(io.ensureDir(path.join(tmpDir, 'game', 'x'))).rejects.toThrow(WriteNotAllowedError);
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

describe('FileIOService · removeFile（文件树编辑批；与 removeDir 同闸，但不做幂等兜底）', () => {
  it('域内删除成功：盘上真的没了', async () => {
    const kojo = path.join(tmpDir, 'game', '個人口上');
    io.setWritableRoots([kojo]);
    const f = path.join(kojo, 'a.ERB');
    await writeRaw(f, Buffer.from('PRINTL 1', 'utf8'));
    await expect(io.removeFile(f)).resolves.toBeUndefined();
    expect(await io.exists(f)).toBe(false);
  });

  it('目标不存在时如实拒绝（平台 NotFound 原样上抛，不静默吞）', async () => {
    const kojo = path.join(tmpDir, 'game', '個人口上');
    io.setWritableRoots([kojo]);
    const missing = path.join(kojo, '没有这个文件.ERB');
    await expect(io.removeFile(missing)).rejects.toThrow();
    // 对齐 Rust 侧 std::fs::remove_file 的 NotFound 语义：拒绝即拒绝，不做幂等兜底
  });

  it('越域拒绝（WriteNotAllowedError），盘上不动', async () => {
    const kojo = path.join(tmpDir, 'game', '個人口上');
    io.setWritableRoots([kojo]);
    const outside = path.join(tmpDir, 'game', 'ERB', 'other.ERB');
    await writeRaw(outside, Buffer.from('x', 'utf8'));
    await expect(io.removeFile(outside)).rejects.toThrow(WriteNotAllowedError);
    expect(await io.exists(outside)).toBe(true);
  });

  it('未声明任何可写根时一律拒绝', async () => {
    const f = path.join(tmpDir, 'game', 'a.ERB');
    await writeRaw(f, Buffer.from('x', 'utf8'));
    await expect(io.removeFile(f)).rejects.toThrow(WriteNotAllowedError);
    expect(await io.exists(f)).toBe(true);
  });

  it('删除成功后失效会话文本缓存：删后批量读必须看到"没了"（口径与 writeBytes 逐字相同）', async () => {
    const dir = path.join(tmpDir, 'game');
    io.setWritableRoots([dir]);
    const f = path.join(dir, 'cached.ERB');
    await writeRaw(f, Buffer.from('PRINTL 旧内容', 'utf8'));

    await io.readTexts([f]); // 进会话缓存
    expect(io.debugCaches().text.files).toBe(1);

    await io.removeFile(f);
    expect(io.debugCaches().text.files).toBe(0); // 盘上没了，缓存不能还留着旧内容

    // 删后再批量读：该位为 null（失败条件与 readText 一致），且不复活任何缓存条目
    const reread = await io.readTexts([f]);
    expect(reread[0]).toBeNull();
    expect(io.debugCaches().text.files).toBe(0);
  });
});

describe('FileIOService · 导出（唯一法定绕闸通道，§5.97）', () => {
  /** 以 NodeBridge 为原型覆写单个方法（类方法在原型上，展开复制会丢） */
  function bridgeWith(overrides: Partial<PlatformBridge>): PlatformBridge {
    const spy = Object.create(new NodeBridge(appData)) as PlatformBridge;
    return Object.assign(spy, overrides);
  }

  it('平台无对话框能力 → 错误如实上抛（调用侧自解释呈现，不静默降级）', async () => {
    await expect(io.exportFile('某包.zip', new Uint8Array([1, 2]))).rejects.toThrow(/not supported by NodeBridge/);
  });

  it('透传文件名 / 字节 / 对话框标题给平台桥，返回落点完整路径', async () => {
    const calls: Array<{ fileName: string; data: Uint8Array; title?: string }> = [];
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x3b]);
    const svc = new FileIOServiceImpl(
      bridgeWith({
        exportFile: async (fileName: string, data: Uint8Array, opts?: { title?: string }) => {
          calls.push({
            fileName,
            data,
            ...(opts?.title !== undefined ? { title: opts.title } : {}),
          });
          return path.join('D:', '发布', '某包.zip');
        },
      }),
    );
    const target = await svc.exportFile('某包.zip', bytes, { title: '导出「某包」到…' });
    expect(target).toBe(path.join('D:', '发布', '某包.zip'));
    expect(calls.length).toBe(1);
    expect(calls[0]?.fileName).toBe('某包.zip');
    // 字节必须**原样**递过桥：内核只搬运，转码就是"一次转码毁半库"的那类错
    expect([...(calls[0]?.data ?? [])]).toEqual([0xef, 0xbb, 0xbf, 0x3b]);
    expect(calls[0]?.title).toBe('导出「某包」到…');
  });

  it('用户取消对话框 → 原样返回 null（取消不是失败，不抛不记错）', async () => {
    const svc = new FileIOServiceImpl(bridgeWith({ exportFile: async () => null }));
    await expect(svc.exportFile('某包.zip', new Uint8Array([1]))).resolves.toBeNull();
  });

  it('导出不受写白名单约束：一个可写根都没批也能导出', async () => {
    // 白名单管的是「改游戏目录」，不是「把副本拿出去」——落点由用户在系统对话框里
    // 显式选定，对话框本身即授权。这条断言把该设计意图钉住，防止后续误加闸。
    const svc = new FileIOServiceImpl(bridgeWith({ exportFile: async () => 'D:/发布/某包.zip' }));
    svc.setWritableRoots([]);
    const src = path.join(tmpDir, 'game', '某包');
    expect(svc.isWritable(src)).toBe(false);
    await expect(svc.exportFile('某包.zip', new Uint8Array([1]))).resolves.toBe('D:/发布/某包.zip');
  });
});

describe('FileIOService · writeBytes 的缓存刷新（保编码不变量）', () => {
  it('字节覆盖后 encodingCache/eolCache 跟随盘上新真相：preserve 不再按旧编码写回', async () => {
    const kojo = path.join(tmpDir, 'game', 'ERB');
    io.setWritableRoots([kojo]);
    const f = path.join(kojo, 'a.ERB');
    // 先按 Shift-JIS + CRLF 建档：两个缓存都记为 shift_jis / crlf
    await io.writeText(f, 'こんにちは', { encoding: 'shift_jis', eol: 'crlf' });
    expect(io.debugCaches().encoding.get(pathKey(f))).toBe('shift_jis');
    expect(io.debugCaches().eol.get(pathKey(f))).toBe('crlf');
    // 字节级覆盖（导入 / 外部同步的写路径）：盘上真相变成 UTF-8 + LF
    await io.writeBytes(f, new TextEncoder().encode('こんにちは\n'));
    expect(io.debugCaches().encoding.get(pathKey(f))).toBe('utf-8');
    expect(io.debugCaches().eol.get(pathKey(f))).toBe('lf');
    // 端到端后果：随后的 preserve 写回必须是 utf-8
    //（修复前按陈旧缓存转回 Shift-JIS，这正是「保编码」不变量被打破的形状）
    await io.writeText(f, 'こんにちは\n', { encoding: 'preserve', eol: 'preserve' });
    expect((await io.readText(f)).encoding).toBe('utf-8');
  });
});

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 字节保真（byte-fidelity）—— 口上编辑器的头号卖点：
 * "保存绝不改动用户没碰的字节"。覆盖混合 CRLF/LF、孤立 CR、GBK、有效 SJIS、
 * UTF-16LE（含 BOM）、emoji 代理对偏移，全部走 **FileIOServiceImpl.readText→writeText**
 * 真实读写管线（node 桥 = iconv/TextEncoder，与桌面壳 Rust encoding_rs 同 WHATWG 口径）。
 */
describe('FileIOService · 字节保真：未改动行保留原换行 / 零改动逐字节直写', () => {
  const dir = () => path.join(tmpDir, 'game');
  beforeEach(() => io.setWritableRoots([dir()]));

  it('混合 CRLF+LF：改一行，少数派 LF 行不被静默翻成 CRLF', async () => {
    const f = path.join(dir(), 'mixed.ERB');
    const original = Buffer.from('a\r\nb\r\nc\nd\r\n', 'utf8'); // 多数派 crlf，c 行是手写 lf
    await writeRaw(f, original);

    const tf = await io.readText(f);
    expect(tf.eol).toBe('crlf'); // 多数派判据
    await io.writeText(f, tf.text.replace('a', 'A')); // 只改第 0 行

    const bytes = await fs.readFile(f);
    expect(bytes.toString('utf8')).toBe('A\r\nb\r\nc\nd\r\n'); // c 行的 \n 保住了
    expect(bytesEqual(bytes, Buffer.from('A\r\nb\r\nc\r\nd\r\n', 'utf8'))).toBe(false); // 旧行为会这样
  });

  it('孤立 CR（旧 Mac）：零改动保存逐字节还原（不再被整文件重写）', async () => {
    const f = path.join(dir(), 'cr.ERB');
    const original = Buffer.from('a\rb\rc', 'utf8'); // detectEol 这里返回 lf，旧实现整文件按 lf 重写
    await writeRaw(f, original);
    const tf = await io.readText(f);
    await io.writeText(f, tf.text); // 零改动
    expect(bytesEqual(await fs.readFile(f), original)).toBe(true);
  });

  it('孤立 CR（旧 Mac）：改一行时未改动行的 CR 仍保留', async () => {
    const f = path.join(dir(), 'cr2.ERB');
    await writeRaw(f, Buffer.from('a\rb\rc', 'utf8'));
    const tf = await io.readText(f);
    await io.writeText(f, tf.text.replace('a', 'A'));
    const bytes = await fs.readFile(f);
    expect(bytes.toString('utf8')).toBe('A\nb\rc'); // b→c 的 CR 保住，被改行邻接用默认 lf
  });

  it('GBK 中文：零改动保存逐字节直写（旧管线会被 Shift-JIS 解码再编码毁字节）', async () => {
    const f = path.join(dir(), 'gbk.ERB');
    const original = Buffer.from(iconv.encode('口上测试，简体中文\r\n第二行\n', 'gbk'));
    await writeRaw(f, original);
    // 现行 probeEncoding 会把无 BOM GBK 判成 shift_jis（编码标签缺口，见回执）——
    // 但"零改动快道"用原文**字节**直写，绕开解码→重编码，逐字节一致：
    const tf = await io.readText(f);
    await io.writeText(f, tf.text); // 零改动
    expect(bytesEqual(await fs.readFile(f), original)).toBe(true);
  });

  it('有效 Shift-JIS：改一行时未改动行保换行、编码往返字节一致', async () => {
    const f = path.join(dir(), 'sjis.ERB');
    const original = Buffer.from(iconv.encode('こんにちは\r\nせかい\nさよなら\r\n', 'shift_jis'));
    await writeRaw(f, original);
    const tf = await io.readText(f);
    expect(tf.encoding).toBe('shift_jis');
    await io.writeText(f, tf.text.replace('こんにちは', 'おはよう')); // 只改第 0 行
    const decoded = iconv.decode(await fs.readFile(f), 'shift_jis');
    expect(decoded).toBe('おはよう\r\nせかい\nさよなら\r\n'); // せかい 行的 \n 保住
  });

  it('UTF-16LE：零改动逐字节还原（含 BOM），改一行时桥 encode 补回 BOM', async () => {
    const f = path.join(dir(), 'u16.ERB');
    const original = Buffer.from(iconv.encode('\uFEFFPRINTL 世界\r\n', 'utf-16le'));
    await writeRaw(f, original);
    const tf = await io.readText(f);
    expect(tf.encoding).toBe('utf-16le');

    // (a) 零改动 → 逐字节直写（含 BOM 原样）
    await io.writeText(f, tf.text);
    expect(bytesEqual(await fs.readFile(f), original)).toBe(true);

    // (b) 改内容 → 走重编码，withUtf16Bom 补回前导 BOM（否则桥的 UTF_16LE.encode 无 BOM）
    await io.writeText(f, tf.text + 'PRINTL 追加\r\n');
    const afterEdit = await fs.readFile(f);
    expect([afterEdit[0], afterEdit[1]]).toEqual([0xff, 0xfe]); // BOM 在位
    // 端点回读仍是合法 utf-16le 且 BOM 不进入正文
    const reread = await io.readText(f);
    expect(reread.encoding).toBe('utf-16le');
    expect(reread.text).toContain('追加');
    expect(reread.text).not.toContain('\uFEFF');
  });

  it('emoji / 代理对：偏移不影响按行对齐（零改动字节一致，改行不错位）', async () => {
    const f = path.join(dir(), 'emoji.ERB');
    // 😀 与 🎉 各占两个 UTF-16 code unit；若按 code unit 计偏移会错位毁行
    const original = Buffer.from('😀\r\n你好\r\n🎉\r\n尾\n', 'utf8'); // 多数派 crlf，尾行是手写 lf
    await writeRaw(f, original);
    const tf = await io.readText(f);
    await io.writeText(f, tf.text); // 零改动
    expect(bytesEqual(await fs.readFile(f), original)).toBe(true);

    await io.writeText(f, tf.text.replace('你好', '你呀')); // 只改第 1 行
    // 😀 行的 \r\n、🎉 行的 \r\n、尾行的 \n（均非改动行邻接）全部保住，内容不错位
    expect((await fs.readFile(f)).toString('utf8')).toBe('😀\r\n你呀\r\n🎉\r\n尾\n');
  });
});

/**
 * PS-2（性能批）：读入侧的内存税与新鲜度税。
 * ①只读路径不留指纹/字节快照（游戏目录整体只读 ⇒ 那些副本永远写不回去）；
 * ②"先只读读入、后批准写、再保存"必须零保真损失（writeText 就地补捞盘上真相）；
 * ③`peekTexts` 零 IPC 只peek（refs 一轮 37 趟纯排队 stat 的出口）；
 * ④换项目（`setWritableRoots([])` = project.closed 的内核钩子）清空三类项目态缓存。
 */
describe('FileIOService · PS-2 缓存闸 / 懒指纹 / peekTexts / 换项目清空', () => {
  /** 计数桥（原型覆写；口径同 io-batch） */
  function countingIo(bridgeAppData = appData): {
    io: FileIOServiceImpl;
    stats: { readFilesRaw: number; statFiles: number; readFileBytes: number };
  } {
    const inner = new NodeBridge(bridgeAppData);
    const stats = { readFilesRaw: 0, statFiles: 0, readFileBytes: 0 };
    const bridge = Object.create(inner) as PlatformBridge & { stats: typeof stats };
    bridge.stats = stats;
    const raw = inner.readFilesRaw.bind(inner);
    const st = inner.statFiles.bind(inner);
    const rb = inner.readFileBytes.bind(inner);
    bridge.readFilesRaw = async (p) => { stats.readFilesRaw++; return raw(p); };
    bridge.statFiles = async (p) => { stats.statFiles++; return st(p); };
    bridge.readFileBytes = async (p) => { stats.readFileBytes++; return rb(p); };
    return { io: new FileIOServiceImpl(bridge), stats };
  }

  it('只读路径读入：不留指纹/字节快照；可写路径照留', async () => {
    const dir = path.join(tmpDir, 'gate');
    const f = path.join(dir, 'a.ERB');
    await writeRaw(f, Buffer.from('@A\r\nPRINTL 一\r\n'));
    const { io } = countingIo();

    await io.readText(f); // 未批准写根 = 只读
    expect(io.debugCaches().eolMaps.files).toBe(0);
    expect(io.debugCaches().rawBytes.files).toBe(0);
    expect(io.debugCaches().encoding.size).toBe(1); // 编码/EOL 判据仍要（preserve 写回与编辑器都吃它）

    io.setWritableRoots([dir]);
    await io.readText(f);
    expect(io.debugCaches().eolMaps.files).toBe(1);
    expect(io.debugCaches().rawBytes.files).toBe(1);

    await io.readTexts([f]); // 批量路同闸（先清根再批量）
    io.setWritableRoots([]); // 项目收回 ⇒ 清缓存（④），顺带重置
    io.setWritableRoots([path.join(tmpDir, 'other')]);
    await io.readTexts([f]);
    expect(io.debugCaches().eolMaps.files).toBe(0); // f 此刻在别的根授权下 ⇒ 对 f 仍是只读
    expect(io.debugCaches().rawBytes.files).toBe(0);
  });

  it('先只读读入、后批准写、再保存：逐行保真零损失（补捞盘上真相，一趟批量读）', async () => {
    const dir = path.join(tmpDir, 'lateapprove');
    const f = path.join(dir, 'mix.ERB');
    await writeRaw(f, Buffer.from('第一行\r\n第二行\n第三行\r\n')); // 少数派 LF 夹在 CRLF 里
    const { io, stats } = countingIo();

    const tf = await io.readText(f); // 只读期读入（无指纹存底）
    io.setWritableRoots([dir]);
    stats.readFilesRaw = 0;
    await io.writeText(f, tf.text.replace('第一行', '第一行改'));

    expect(stats.readFilesRaw).toBe(1); // 保存前的一趟补捞（exists+readFileBytes 两趟的旧形状不许回来）
    // 改动行邻接的换行走多数派（crlf）；**两个未改动行之间**的少数派 `\n` 必须保住
    // ——没有补捞就没有这张指纹，那将整篇统一成 crlf（旧退化路），这条即"保真不打折"的钉。
    expect(bytesEqual(await fs.readFile(f), Buffer.from('第一行改\r\n第二行\n第三行\r\n', 'utf8'))).toBe(true);
  });

  it('peekTexts：命中给缓存、未命中给 null，全程零 IPC（stat 一趟都不付）', async () => {
    const dir = path.join(tmpDir, 'peek');
    const a = path.join(dir, 'a.ERB');
    const b = path.join(dir, 'b.ERB');
    await writeRaw(a, Buffer.from('@A\n'));
    await writeRaw(b, Buffer.from('@B\n'));
    const { io, stats } = countingIo();

    expect(io.peekTexts([a, b])).toEqual([null, null]); // 冷peek：不读盘
    expect(stats.readFilesRaw).toBe(0);
    expect(stats.statFiles).toBe(0);

    await io.readTexts([a]); // 只有 a 进缓存
    const [pa, pb] = io.peekTexts([a, b]);
    expect(pa?.text).toBe('@A\n');
    expect(pb).toBeNull();
    expect(stats.readFilesRaw).toBe(1); // 还是 readTexts 那一趟
    expect(stats.statFiles).toBe(1); // peek 没有追加任何 stat 趟

    const dbg = io.debugCaches().text;
    expect(dbg.hits).toBeGreaterThan(0); // peek 计入命中观测面
  });

  it('换项目清空：setWritableRoots([])（project.closed 钩子）丢弃文本/指纹/字节三类与编码/EOL 判据', async () => {
    const dirA = path.join(tmpDir, 'projA');
    const fA = path.join(dirA, 'a.ERB');
    await writeRaw(fA, Buffer.from('@A\n'));
    const { io, stats } = countingIo();

    io.setWritableRoots([dirA]);
    await io.readTexts([fA]);
    expect(io.debugCaches().text.files).toBe(1);
    expect(io.debugCaches().eolMaps.files).toBe(1);
    expect(io.debugCaches().rawBytes.files).toBe(1);

    io.setWritableRoots([]); // = project.close() 的既有动作
    const dbg = io.debugCaches();
    expect(dbg.text.files).toBe(0);
    expect(dbg.eolMaps.files).toBe(0);
    expect(dbg.rawBytes.files).toBe(0);
    expect(dbg.encoding.size).toBe(0);
    expect(dbg.eol.size).toBe(0);

    stats.readFilesRaw = 0;
    await io.readTexts([fA]); // 新会话视角：必须真读盘，不许吃到 A 的残影
    expect(stats.readFilesRaw).toBe(1);
  });

  it('编码/EOL 判据缓存有界（此前无界）：超限按 FIFO 从队首削', async () => {
    const dir = path.join(tmpDir, 'metacap');
    const files: string[] = [];
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, `f${i}.ERB`);
      await writeRaw(f, Buffer.from(`@F${i}\n`));
      files.push(f);
    }
    const io = new FileIOServiceImpl(new NodeBridge(appData), undefined, { maxMetaEntries: 3 });
    await io.readTexts(files);
    expect(io.debugCaches().encoding.size).toBe(3);
    expect(io.debugCaches().eol.size).toBe(3);
    // 队首三个已被挤掉，最后三个留着
    expect(io.debugCaches().encoding.has(pathKey(files[0]!))).toBe(false);
    expect(io.debugCaches().encoding.has(pathKey(files[5]!))).toBe(true);
  });
});
