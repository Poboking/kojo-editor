/**
 * 守门测试：**导入一条链路到底花几趟 IPC，以及写允许域那道闸还在不在**（2026-10-16 市场与导入 IO 批，BOARD §S PERF-10 ①）。
 *
 * ## 为什么要单开一份文件
 *
 * `WorkspaceServiceImpl.importDirectory` 旧形态是每文件
 * `ensureDir(dirname(to))` + `readBytes(from)` + `writeBytes(to, bytes)` = **3N 趟串行往返**，
 * 写侧字节还要 base64 过界（膨胀 1.34× + JS 侧逐字节还原）。导入是"作者点一次就付一次钱"的面：
 * 忙时一趟 229–762ms（PITFALLS 74 口径），100 个文件就是几百趟白等。
 *
 * 修法用的是**已存在**的平台原语 `copy_file`（Rust 侧自己 `create_dir_all` 父目录、
 * 并且目标侧已过写域闸 `ensure_write_allowed(.., "copy_dst")`），今天只有 `backup()` 在用它。
 * 契约侧新增 `FileIO.copyFile(from, to)`，导入循环改成每文件**一趟**。
 *
 * ## 闸的语义（本文件钉死的就是这两条，一条都不能松）
 *
 * - **`to` 必须过闸**：这是安全线。`copyFile` 容易被误读成"第二条绕开写允许域的通道"，
 *   它不是——铁律 6 的法定域外写通道只有 `exportFile`（对话框即授权、JS 拿不到落点）。
 *   本原语的 `to` 是普通路径参数，越权 ⇒ `WriteNotAllowedError`，**盘上一个字节都不许多**。
 * - **`from` 不过闸**：读路径本来就不受写允许域约束，而"从只读的外部目录复制进工作区"
 *   正是这条原语存在的全部理由。**照 `rename`（两端都断言）抄过来会把导入整条链路误拒**，
 *   所以这里必须有一条"源在非可写域 ⇒ 仍然成功"的正向判据。
 *
 * ## 五条判据
 *
 * 1. N 个文件的导入 = **恰好 N 趟** `copyFile`，且这条循环里
 *    `readBytes` / `writeBytes` / `ensureDir` **零趟**（按落点归属计数，
 *    不与 manifest 自身写前备份混在一起）；
 * 2. 源目录**不在**可写根内（只读外部目录 = 导入的常态）⇒ 成功，且逐文件**字节级**一致
 *    （非 UTF-8 内容零转码）；
 * 3. 目标落点**不在**可写根内 ⇒ `WriteNotAllowedError`，且目标侧什么都没被造出来
 *    （连父目录都不许出现）；
 * 4. 源侧仍不被改动（导入只读源）；
 * 5. `copyFile` 覆盖写之后，会话文本缓存必须失效（否则批量读会端出旧内容）。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { WriteNotAllowedError, type PlatformBridge } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../src/io';
import { WorkspaceServiceImpl } from '../src/workspace';
import { NodeBridge } from './helpers/node-bridge';

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/* --------------------------- 计数桥（按落点归属计数） --------------------------- */

interface IoCall {
  readonly op: 'readBytes' | 'writeBytes' | 'ensureDir' | 'copyFile' | 'rename';
  readonly path: string;
  readonly from?: string;
}

/**
 * 在 `NodeBridge` 外面套一层**只记不拦**的计数壳。
 *
 * 记的是**每一次调用的路径**而不是裸计数：`writeManifest` 自己也会经 `backup()` 走
 * `copyFile`/`ensureDir`，只报"总共几趟"会把 manifest 链路算进导入账上（假红/假绿都能造出来）。
 * 判据因此按**落点归属**过滤：只数那些指向导入包目录、或指向源目录的趟。
 */
function countingBridge(inner: PlatformBridge, sink: IoCall[]): PlatformBridge {
  const self: PlatformBridge = new Proxy(inner, {
    get(target, prop: string | symbol) {
      if (prop === 'readFileBytes') {
        return async (p: string): Promise<Uint8Array> => {
          sink.push({ op: 'readBytes', path: p });
          return target.readFileBytes(p);
        };
      }
      if (prop === 'writeFileBytes') {
        return async (p: string, data: Uint8Array): Promise<void> => {
          sink.push({ op: 'writeBytes', path: p });
          return target.writeFileBytes(p, data);
        };
      }
      if (prop === 'ensureDir') {
        return async (p: string): Promise<void> => {
          sink.push({ op: 'ensureDir', path: p });
          return target.ensureDir(p);
        };
      }
      if (prop === 'copyFile') {
        return async (from: string, to: string): Promise<void> => {
          sink.push({ op: 'copyFile', path: to, from });
          return target.copyFile(from, to);
        };
      }
      if (prop === 'rename') {
        return async (from: string, to: string): Promise<void> => {
          sink.push({ op: 'rename', path: to, from });
          return target.rename(from, to);
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return self;
}

const count = (calls: IoCall[], op: IoCall['op'], belongs: (p: string) => boolean): number =>
  calls.filter((c) => c.op === op && belongs(c.path)).length;

/* ---------------------------------- 夹具 ---------------------------------- */

/** 源包：两层结构 + 非 UTF-8 字节（字节级保真是这条链路的硬语义） */
const SOURCE_FILES: Record<string, string> = {
  'README.md': '# 源包说明\n',
  '事件.ERB': 'PRINTL 你好\n',
  '子目录/深文件.ERB': 'PRINTL 深层\n',
};
const RAW_BYTES = Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xa9]);

let tmpDir: string;
let appData: string;
/** 只读外部源目录（**刻意不登记为任何可写根** = 导入的真实形态） */
let sourceDir: string;
let calls: IoCall[];
let io: FileIOServiceImpl;
let ws: WorkspaceServiceImpl;
let projectDir: string;

async function buildSource(dir: string): Promise<number> {
  for (const [rel, text] of Object.entries(SOURCE_FILES)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, 'utf8');
  }
  await fs.writeFile(path.join(dir, '二进制.bin'), RAW_BYTES);
  return Object.keys(SOURCE_FILES).length + 1;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-import-ipc-'));
  appData = path.join(tmpDir, 'appdata');
  sourceDir = path.join(tmpDir, 'external-readonly-source');
  await buildSource(sourceDir);

  const inner = new NodeBridge(appData);
  calls = [];
  const bridge = countingBridge(inner, calls);
  io = new FileIOServiceImpl(bridge);
  ws = new WorkspaceServiceImpl({ bridge, io, log: noopLog });
  await ws.init();
  const project = await ws.create({ name: '作品' });
  projectDir = ws.projectDir(project.id);
});

describe('importDirectory · 每文件一趟服务端复制（PERF-10 ①）', () => {
  it('N 个文件 = N 趟 copyFile；readBytes / writeBytes / ensureDir 零趟', async () => {
    const dirName = '导入包';
    const pkgDir = path.join(projectDir, dirName);
    const inPkg = (p: string): boolean => p.startsWith(pkgDir + path.sep) || p === pkgDir;
    const inSource = (p: string): boolean => p.startsWith(sourceDir + path.sep);
    const mark = calls.length;

    await ws.importDirectory((await ws.list())[0]!.id, {
      name: '导入包',
      dirName,
      sourceDir,
    });
    const mine = calls.slice(mark);

    // 4 = README.md + 事件.ERB + 子目录/深文件.ERB + 二进制.bin
    expect(count(mine, 'copyFile', inPkg)).toBe(4);
    // 整条导入里 copyFile 只可能被用在"把源文件搬进包目录"这一件事上
    // （manifest 写盘带 `backup:false` ⇒ 不混入写前备份的趟）
    expect(count(mine, 'copyFile', () => true)).toBe(4);
    // 旧形态的三趟里，ensureDir 每文件一次、读写各一次：这三条就是"3N 有没有真被压成 N"的尺
    expect(count(mine, 'readBytes', inSource)).toBe(0);
    expect(count(mine, 'writeBytes', inPkg)).toBe(0);
    expect(count(mine, 'ensureDir', inPkg)).toBe(0);

    // 结果面照旧：文件确实落盘、逐字节一致（含非 UTF-8 内容零转码）
    expect(await fs.readFile(path.join(pkgDir, 'README.md'), 'utf8')).toBe('# 源包说明\n');
    expect([...(await fs.readFile(path.join(pkgDir, '二进制.bin')))]).toEqual([...RAW_BYTES]);
    expect(
      await fs.readFile(path.join(pkgDir, '子目录', '深文件.ERB'), 'utf8'),
    ).toBe('PRINTL 深层\n');
    // 子目录那一路本来要先 ensureDir；现在由平台侧 create_dir_all 兑现 ⇒ 深路径照样成立
    expect(await fs.stat(path.join(pkgDir, '子目录'))).toBeTruthy();
  });

  it('源在只读外部目录（非任何可写根）照样导入成功；源一个字节都不动', async () => {
    // 这条是"别照 rename 抄成两端断言"的正向判据：from 侧过闸 = 导入整条链路被误拒
    expect(io.isWritable(sourceDir)).toBe(false);
    const p = (await ws.list())[0]!;
    const art = await ws.importDirectory(p.id, { name: '导入', dirName: 'pkg', sourceDir });
    expect(art.dirName).toBe('pkg');
    expect(await fs.readFile(path.join(sourceDir, 'README.md'), 'utf8')).toBe('# 源包说明\n');
    expect(await fs.readFile(path.join(sourceDir, '二进制.bin'))).toEqual(RAW_BYTES);
  });
});

describe('copyFile · 写允许域那道闸（安全线，一条都不许松）', () => {
  it('to 在非允许域 ⇒ WriteNotAllowedError，且连父目录都不被造出来', async () => {
    io.setWritableRoots([path.join(tmpDir, 'authorized-game')]);
    const outside = path.join(tmpDir, 'outside-domain', 'deep', 'evil.bin');
    await expect(io.copyFile(path.join(sourceDir, 'README.md'), outside)).rejects.toThrow(
      WriteNotAllowedError,
    );
    // 拒绝必须发生在任何盘上动作之前：域外不许先长出目录（"游戏目录整体只读"的同一条纪律）
    expect(await io.exists(path.join(tmpDir, 'outside-domain'))).toBe(false);
  });

  it('to 在项目常驻可写根内 ⇒ 放行（常驻根不受项目授权收回影响）', async () => {
    io.setWritableRoots([]); // 项目关闭 = 游戏目录授权收回
    expect(io.isWritable(sourceDir)).toBe(false);
    const to = path.join(projectDir, 'ok', 'copied.md');
    await io.copyFile(path.join(sourceDir, 'README.md'), to);
    expect(await fs.readFile(to, 'utf8')).toBe('# 源包说明\n');
  });

  it('覆盖写之后会话文本缓存必须失效（批量读不许端出旧内容）', async () => {
    const to = path.join(projectDir, 'pkg', 'cached.md');
    await io.ensureDir(path.dirname(to));
    await io.writeText(to, '旧内容\n');
    expect((await io.readTexts([to]))[0]?.text).toBe('旧内容\n');

    await io.copyFile(path.join(sourceDir, 'README.md'), to);
    const after = await io.readTexts([to]);
    expect(after[0]?.text).toBe('# 源包说明\n');
  });
});
