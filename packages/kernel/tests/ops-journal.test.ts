import { mkdirSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { FileIOServiceImpl, OpsJournalImpl, OP_ID_RE } from '../src';
import { NodeBridge } from './helpers/node-bridge';

/**
 * 批操作 journal（2026-10-16 undo 批）：begin/record/commit/abort/undo 语义 +
 * 字节级保真 + undo 的 undo（重做）。NodeBridge 真临时目录。
 */

let tmpDir: string;
let appData: string;
let io: FileIOServiceImpl;
let ops: OpsJournalImpl;
const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-ops-'));
  appData = path.join(tmpDir, 'appdata');
  const bridge = new NodeBridge(appData);
  io = new FileIOServiceImpl(bridge, noopLog);
  ops = new OpsJournalImpl({ bridge, io, log: noopLog });
  io.setAppWritableRoots([path.join(tmpDir, 'ws')]);
  mkdirSync(path.join(tmpDir, 'ws'), { recursive: true });
});

const wsPath = (name: string): string => path.join(tmpDir, 'ws', name);

describe('begin/record/commit · 历史面', () => {
  it('commit 后 list 出现（新在前），entriesOf 给出文件清单与 hasBefore', async () => {
    const a = wsPath('a.txt');
    const b = wsPath('b.txt');
    await fs.writeFile(a, '旧A');
    await fs.mkdir(path.dirname(b), { recursive: true });
    await fs.writeFile(b, '旧B');

    const id = await ops.begin('test-op', '测试操作');
    expect(OP_ID_RE.test(id)).toBe(true);
    await ops.record(id, a);
    await ops.record(id, b);
    await io.writeText(a, '新A', { encoding: 'utf-8' });
    await io.writeText(b, '新B', { encoding: 'utf-8' });
    await ops.commit(id);

    const list = await ops.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, kind: 'test-op', label: '测试操作', status: 'committed', fileCount: 2 });
    const entries = await ops.entriesOf(id);
    expect(entries.map((e) => [path.basename(e.path), e.hasBefore])).toEqual([
      ['a.txt', true],
      ['b.txt', true],
    ]);
    expect(entries.every((e) => e.encoding !== null)).toBe(true);
  });

  it('进行中的 open op 不进 list；同一路径重复 record 以第一次为准', async () => {
    const f = wsPath('dup.txt');
    await fs.writeFile(f, '最初的');
    const id = await ops.begin('t', 't');
    await ops.record(id, f);
    // 中途盘上又变了：重复 record 不覆盖第一次快照（undo 恢复"操作开始前"）
    await fs.writeFile(f, '中途改的');
    await ops.record(id, f);
    // commit 之前：open 态不进 list
    expect(await ops.list()).toHaveLength(0);
    await ops.commit(id);
    expect(await ops.list()).toHaveLength(1);
    await ops.undo(id);
    expect(await fs.readFile(f, 'utf-8')).toBe('最初的');
  });
});

describe('undo · 字节级回滚', () => {
  it('改写 + 新建混合批：改写的恢复原字节（Shift-JIS 保真），新建的删除', async () => {
    const sjis = wsPath('sjis.ERB');
    await fs.writeFile(sjis, iconv.encode('こんにちは\r\n旧世界', 'shift_jis'));
    const created = wsPath('new.txt'); // record 时尚不存在 = 操作内新建

    const id = await ops.begin('batch', '混合批');
    await ops.record(id, sjis);
    await ops.record(id, created);
    // 模拟批操作：改写（换编码）+ 新建
    await io.writeBytes(sjis, new TextEncoder().encode('ハロー\n新世界'));
    await io.writeText(created, '被本操作新建的内容', { encoding: 'utf-8' });
    await ops.commit(id);

    await ops.undo(id);

    // SJIS + CRLF 原字节回来（零转码）
    const back = new Uint8Array(await fs.readFile(sjis));
    expect(Array.from(back)).toEqual(Array.from(iconv.encode('こんにちは\r\n旧世界', 'shift_jis')));
    // 操作内"新建"的文件：删除（物理上进回收站兜底，不在原位）
    await expect(fs.access(created)).rejects.toThrow();

    // undo 本身进了历史（kind=undo:batch），再 undo 它 = 重做
    const list = await ops.list();
    expect(list.map((r) => r.kind)).toContain('undo:batch');
  });

  it('undo 的 undo = 重做：undo op 记录的是回滚前状态', async () => {
    const f = wsPath('redo.txt');
    await fs.writeFile(f, 'V0');
    const id = await ops.begin('t', 't');
    await ops.record(id, f);
    await io.writeText(f, 'V1', { encoding: 'utf-8' });
    await ops.commit(id);

    const undoId = await ops.undo(id);
    expect(await fs.readFile(f, 'utf-8')).toBe('V0'); // 撤销生效
    await ops.undo(undoId); // 对撤销再撤销 = 重做
    expect(await fs.readFile(f, 'utf-8')).toBe('V1'); // V1 回来了
  });

  it('undo 过写允许域闸：授权收回后（白名单外）拒绝回滚且内容不动', async () => {
    const gameFile = path.join(tmpDir, 'game', 'sav.dat');
    await fs.mkdir(path.dirname(gameFile), { recursive: true });
    await fs.writeFile(gameFile, '受保护');
    // 模拟授权期注入：record 走 bridge（内核管理域），写入经 io（当时在白名单内）
    io.setWritableRoots([path.join(tmpDir, 'game')]);
    const id = await ops.begin('inject', '注入');
    await ops.record(id, gameFile);
    await io.writeBytes(gameFile, new TextEncoder().encode('被改写'));
    await ops.commit(id);
    // 项目关闭 → setWritableRoots([]) 收回授权；undo 的回滚写回必须拒绝
    io.setWritableRoots([]);
    await expect(ops.undo(id)).rejects.toThrow(/Write not allowed/);
    expect(await fs.readFile(gameFile, 'utf-8')).toBe('被改写'); // 未动
    // 重新授权后同一操作可正常回滚
    io.setWritableRoots([path.join(tmpDir, 'game')]);
    await ops.undo(id);
    expect(await fs.readFile(gameFile, 'utf-8')).toBe('受保护');
  });
});

describe('abort · 半批回滚（失败路径）', () => {
  it('abort 逆序恢复已写文件、删除新建文件，且 op 不留痕', async () => {
    const f = wsPath('abort.txt');
    await fs.writeFile(f, 'Before');
    const created = wsPath('halfway.txt');

    const id = await ops.begin('batch', '失败批');
    await ops.record(id, f);
    await io.writeText(f, 'After', { encoding: 'utf-8' });
    await ops.record(id, created);
    await io.writeText(created, '半成品', { encoding: 'utf-8' });
    await ops.abort(id);

    expect(await fs.readFile(f, 'utf-8')).toBe('Before');
    await expect(fs.access(created)).rejects.toThrow();
    expect(await ops.list()).toHaveLength(0); // abort 即撤销，无痕
  });

  it('record 一个"存在但读不动"的文件 → 上抛（绝不降级成新建，否则 undo 会删掉它）', async () => {
    const f = wsPath('cursed.txt');
    await fs.writeFile(f, '内容');
    const broken = new NodeBridge(appData);
    broken.readFileBytes = async (p: string) => {
      if (path.basename(p) === 'cursed.txt') throw new Error('EIO: 模拟读损坏');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return NodeBridge.prototype.readFileBytes.call(broken, p);
    };
    const ops2 = new OpsJournalImpl({ bridge: broken, io, log: noopLog });
    const id = await ops2.begin('t', 't');
    await expect(ops2.record(id, f)).rejects.toThrow(/EIO/);
  });
});
