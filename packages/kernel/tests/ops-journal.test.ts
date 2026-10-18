import { mkdirSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import type { EventBus, FileChangedEvent } from '@kojo/plugin-api';
import { WriteNotAllowedError } from '@kojo/plugin-api';
import { FileIOServiceImpl, OpsJournalImpl, OP_ID_RE, OP_SNAPSHOT_MAX_PER_OP_BYTES, OP_SNAPSHOT_MAX_TOTAL_BYTES, OP_SNAPSHOT_RETENTION_MAX } from '../src';
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

  it('撤销注入的失效广播：回滚落盘 ⇒ file.changed（同 mtime 同 size 也必发，bug 1 的 kernel 半边）', async () => {
    // 形状照抄注入：int 原位替换——字节数不变。undo 走 io.writeBytes 落盘，
    // 下游二进制解析记忆**不能等 mtime/size 判据发现过期**（粗粒度介质同值），
    // 必须由知情写入方（内核 io）广播 `file.changed` 显式逐出（接线在 sav-parser 插件）。
    const events: FileChangedEvent[] = [];
    const bus = {
      on: () => () => {},
      once: () => () => {},
      emit: (type: string, payload: FileChangedEvent) => {
        if (type === 'file.changed') events.push(payload);
      },
    } as unknown as EventBus;
    const bridge = new NodeBridge(appData);
    const io2 = new FileIOServiceImpl(bridge, noopLog, {}, bus);
    io2.setAppWritableRoots([path.join(tmpDir, 'ws')]);
    const ops2 = new OpsJournalImpl({ bridge, io: io2, log: noopLog });

    const f = wsPath('inject-target.dat');
    const v0 = new TextEncoder().encode('AAAA'); // 注入前
    const v1 = new TextEncoder().encode('BBBB'); // 注入后：**同 size**，mtime 也可能同 tick
    await fs.writeFile(f, v0);

    const id = await ops2.begin('snapshot-inject', '注入');
    await ops2.record(id, f);
    await io2.writeBytes(f, v1);
    await ops2.commit(id);
    expect(events.filter((e) => e.kind === 'change' && e.path === f).length).toBeGreaterThanOrEqual(1);

    events.length = 0;
    await ops2.undo(id); // 撤销注入：io.writeBytes 写回 v0
    expect(events).toEqual([{ kind: 'change', path: f }]); // 恰发一条、原样透传路径、不折叠写法
    expect(new Uint8Array(await fs.readFile(f))).toEqual(v0); // 值真的回到了注入前
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
    await expect(ops.undo(id)).rejects.toThrow(WriteNotAllowedError);
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
    expect(ops.maintenanceReport()).toMatchObject({
      openOrphanDocs: 0,
      rollbackFailedDocs: 0,
      unreadableDocs: 0,
      orphanSnapshotDirs: 0,
    });
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

describe('undo · 不许删掉操作前就存在的目录', () => {
  it('新建文件的父目录是本 op 之前就存在的 ⇒ 撤销只删文件，目录留着', async () => {
    const dir = path.join(tmpDir, 'ws', 'pre-existing');
    await fs.mkdir(dir, { recursive: true });
    const f = path.join(dir, 'new.txt');

    const id = await ops.begin('t', '父目录已存在');
    await ops.record(id, f); // record 时文件不存在 = 操作内新建；但父目录**已存在**
    await io.writeText(f, '内容', { encoding: 'utf-8' });
    await ops.commit(id);

    await ops.undo(id);
    await expect(fs.access(f)).rejects.toThrow(); // 文件按语义删除
    const st = await fs.stat(dir); // 关键：之前就存在的空目录不能被撤销删掉
    expect(st.isDirectory()).toBe(true);
  });

  it('父目录链是本 op 创建的 ⇒ 撤销后空壳清干净（深→浅全清）', async () => {
    const f = path.join(tmpDir, 'ws', 'x', 'y', 'z', 'new.txt');
    const id = await ops.begin('t', '整条链新建');
    await ops.record(id, f);
    await io.writeText(f, '内容', { encoding: 'utf-8' });
    await ops.commit(id);
    expect((await fs.stat(path.join(tmpDir, 'ws', 'x'))).isDirectory()).toBe(true);

    await ops.undo(id);
    for (const d of ['z', 'y', 'x']) {
      await expect(fs.access(path.join(tmpDir, 'ws', d))).rejects.toThrow();
    }
    expect((await fs.stat(path.join(tmpDir, 'ws'))).isDirectory()).toBe(true); // 工作区根本身不动
  });

  it('旧形态文档（无 createdDirs）⇒ 宁可留空壳也不猜着删', async () => {
    const dir = path.join(tmpDir, 'ws', 'legacy');
    await fs.mkdir(dir, { recursive: true });
    const f = path.join(dir, 'new.txt');
    const id = await ops.begin('t', 'legacy');
    await ops.record(id, f);
    await io.writeText(f, '内容', { encoding: 'utf-8' });
    await ops.commit(id);

    // 手工抹掉文档里的 createdDirs（模拟旧版本落盘的历史）
    const docPath = path.join(appData, 'ops', `${id}.json`);
    const doc = JSON.parse(await fs.readFile(docPath, 'utf-8'));
    for (const e of doc.entries) delete e.createdDirs;
    await fs.writeFile(docPath, JSON.stringify(doc));

    await ops.undo(id);
    await expect(fs.access(f)).rejects.toThrow(); // 文件仍按语义删除
    expect((await fs.stat(dir)).isDirectory()).toBe(true); // 但目录不再被删
  });
});

describe('维护提示 · 残留不静默（铁律 #4）', () => {
  const ORPHAN_ID = 'op-20260101-000000-000-abcdef';
  const BAD_DOC_ID = 'op-20260101-000001-000-badbad';

  it('崩溃残留的 open 文档 + 孤儿快照目录 + 不可读文档：不进历史，但计数并出声', async () => {
    // 实例 A 开了个头就"崩"（文档留在 open 态，快照目录也建了）
    const f = wsPath('crash.txt');
    await fs.writeFile(f, '原样');
    const id = await ops.begin('t', '崩溃批');
    await ops.record(id, f);

    // 实例 B（等价于重启后的新内核）看不到 A 的内存态
    const bridgeB = new NodeBridge(appData);
    const warns: string[] = [];
    const logB = { debug() {}, info() {}, warn: (m: string) => warns.push(m), error() {} };
    const opsB = new OpsJournalImpl({ bridge: bridgeB, io, log: logB });

    // 孤儿快照目录：有目录没文档
    await fs.mkdir(path.join(appData, 'ops', ORPHAN_ID), { recursive: true });
    await fs.writeFile(path.join(appData, 'ops', ORPHAN_ID, '0.before'), '无人认领');
    // 不可读文档：名字合法、内容不是合法 op 文档
    await fs.writeFile(path.join(appData, 'ops', `${BAD_DOC_ID}.json`), '{ 这不是 JSON');
    // 名字不合法 / 后缀不合法：无视，不崩
    await fs.writeFile(path.join(appData, 'ops', 'op-9999.json'), '名字不合法');
    await fs.writeFile(path.join(appData, 'ops', 'README.txt'), '与本机制无关');

    const list = await opsB.list();
    expect(list).toHaveLength(0); // open 残留不列（半批回滚比不回滚更险）
    expect(opsB.maintenanceReport()).toMatchObject({
      openOrphanDocs: 1,
      rollbackFailedDocs: 0,
      unreadableDocs: 1,
      orphanSnapshotDirs: 1,
    });
    expect(warns.some((w) => w.includes('维护提示'))).toBe(true);
    expect(warns.some((w) => w.includes('不可读'))).toBe(true);
    // 巡检不崩：还能再来一次，计数稳定
    expect(await opsB.list()).toHaveLength(0);
    expect(opsB.maintenanceReport().openOrphanDocs).toBe(1);
  });

  it('abort 回滚半途失败 ⇒ 快照保留 + 文档留痕 + 上抛（不销毁唯一救命数据）', async () => {
    const gameDir = path.join(tmpDir, 'game');
    const gameFile = path.join(gameDir, 'sav.dat'); // 名字与存档格式无关，只是"白名单内的一份用户文件"
    await fs.mkdir(gameDir, { recursive: true });
    await fs.writeFile(gameFile, '受保护');
    io.setWritableRoots([gameDir]);

    const warns: string[] = [];
    const spy = new OpsJournalImpl({
      bridge: new NodeBridge(appData),
      io,
      log: { debug() {}, info() {}, warn: (m: string) => warns.push(m), error() {} },
    });
    const id = await spy.begin('inject', '注入');
    await spy.record(id, gameFile);
    await io.writeBytes(gameFile, new TextEncoder().encode('被改写'));
    // 授权被收回 ⇒ 回滚的写回必过闸、必失败
    io.setWritableRoots([]);
    await expect(spy.abort(id)).rejects.toThrow(WriteNotAllowedError);

    // 快照目录与文档仍在（可人工救），且维护提示点名
    const snapDir = path.join(appData, 'ops', id);
    expect((await fs.stat(snapDir)).isDirectory()).toBe(true);
    const doc = JSON.parse(await fs.readFile(path.join(appData, 'ops', `${id}.json`), 'utf-8'));
    expect(doc.status).toBe('open');
    // 序列化后的文档只剩文本，错误类拿不到 ⇒ 只能按句子判（判的是「拒因是只读闸」这条语义）
    expect(String(doc.rollbackError)).toMatch(/只读范围内，不能写入/);
    expect(await spy.list()).toHaveLength(0);
    expect(spy.maintenanceReport()).toMatchObject({ openOrphanDocs: 1, rollbackFailedDocs: 1 });
    expect(warns.some((w) => w.includes('快照与文档已保留'))).toBe(true);

    // 留痕文档不假装能 undo（open 态直接拒），但快照确实还在
    io.setWritableRoots([gameDir]);
    await expect(spy.undo(id)).rejects.toThrow(/仍在进行中/);
    expect((await fs.readFile(path.join(snapDir, '0.before'))).toString()).toContain('受保护');
  });

  it('abort 成功不留痕：快照目录与文档一并清掉', async () => {
    const f = wsPath('clean.txt');
    await fs.writeFile(f, '原样');
    const id = await ops.begin('t', '正常批');
    await ops.record(id, f);
    await io.writeText(f, '改了', { encoding: 'utf-8' });
    await ops.abort(id);
    await expect(fs.access(path.join(appData, 'ops', id))).rejects.toThrow();
    await expect(fs.access(path.join(appData, 'ops', `${id}.json`))).rejects.toThrow();
  });
});

describe('保留期收口（OP_SNAPSHOT_RETENTION_MAX）', () => {
  it('超过上限的已完结 op 连文档带快照清掉；被清的 undo 显式拒绝；最新一批照常可撤销', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      await new Promise((r) => setTimeout(r, 2)); // 让 startedAt 互异（同毫秒 tie 会让归属不确定）
      const f = wsPath(`r${i}.txt`);
      await fs.writeFile(f, `旧${i}`);
      const id = await ops.begin('t', `op${i}`);
      await ops.record(id, f);
      await fs.writeFile(f, `新${i}`);
      await ops.commit(id);
      ids.push(id);
    }
    const survivors = new Set((await ops.list()).map((o) => o.id));
    expect(survivors.size).toBe(OP_SNAPSHOT_RETENTION_MAX);
    expect(survivors.has(ids[ids.length - 1]!)).toBe(true);
    const swept = ids.filter((id) => !survivors.has(id));
    expect(swept.length).toBe(2);
    for (const id of swept) {
      await expect(fs.access(path.join(appData, 'ops', id))).rejects.toThrow();
      await expect(fs.access(path.join(appData, 'ops', `${id}.json`))).rejects.toThrow();
    }
    // 新一批照常可撤销（字节级回滚不受保留期影响）
    await ops.undo(ids[ids.length - 1]!);
    expect(await fs.readFile(wsPath('r21.txt'), 'utf-8')).toBe('旧21');
  });

  it('快照目录被清但文档还在（半清残留）⇒ undo 先行核验、显式拒绝，不半途爆炸', async () => {
    const f = wsPath('guard.txt');
    await fs.writeFile(f, '旧值');
    const id = await ops.begin('t', '护栏');
    await ops.record(id, f);
    await fs.writeFile(f, '新值');
    await ops.commit(id);
    await fs.rm(path.join(appData, 'ops', id), { recursive: true, force: true });
    await expect(ops.undo(id)).rejects.toThrow(/保留上限清理/);
    expect(await fs.readFile(f, 'utf-8')).toBe('新值'); // 盘没动
  });
});
describe('字节上限（2026-10-18 字节上限批）', () => {
  it('默认挡位常量：单 op 512MB / 总量 1GB（产品面数值，改动须过评审）', () => {
    expect(OP_SNAPSHOT_MAX_PER_OP_BYTES).toBe(512 * 1024 * 1024);
    expect(OP_SNAPSHOT_MAX_TOTAL_BYTES).toBe(1024 * 1024 * 1024);
  });

  it('单 op 超限拒记：抛错、条目不落、累计不污染——跳过该文件后批仍成立可撤销', async () => {
    const capped = new OpsJournalImpl({
      bridge: new NodeBridge(appData),
      io,
      log: noopLog,
      byteCaps: { perOp: 10 },
    });
    const five = wsPath('five.txt');
    const big = wsPath('big.txt');
    const four = wsPath('four.txt');
    await fs.writeFile(five, '12345'); // 5B
    await fs.writeFile(big, 'x'.repeat(20)); // 20B：一票超限
    await fs.writeFile(four, '1234'); // 4B：拒记后累计仍干净（5+4=9 ≤ 10）
    const id = await capped.begin('t', '小挡位批');
    await capped.record(id, five);
    await expect(capped.record(id, big)).rejects.toThrow(/单操作上限/);
    await capped.record(id, four); // 拒记不留半截状态
    await capped.commit(id);
    expect((await capped.entriesOf(id)).map((e) => path.basename(e.path))).toEqual([
      'five.txt',
      'four.txt',
    ]);
    // 记不上账的大文件被调用方跳过 ⇒ 不写；undo 只回滚记上账的两个
    await fs.writeFile(five, '被改');
    await capped.undo(id);
    expect(await fs.readFile(five, 'utf-8')).toBe('12345');
  });

  it('总量超限：sweep 实算、最旧先裁、被裁 op 不可再撤销、幸存者照常回滚', async () => {
    const capped = new OpsJournalImpl({
      bridge: new NodeBridge(appData),
      io,
      log: noopLog,
      byteCaps: { total: 15 },
    });
    const mk = async (name: string): Promise<string> => {
      await new Promise((r) => setTimeout(r, 2)); // startedAt 互异（同毫秒 tie 会让归属不确定）
      const f = wsPath(name);
      await fs.writeFile(f, `旧${name}`); // 快照 8B 上下：三档累加才过 15B
      const id = await capped.begin('t', name);
      await capped.record(id, f);
      await fs.writeFile(f, `新${name}`);
      await capped.commit(id); // commit 触发 sweep：实算保留集字节、超限裁最旧
      return id;
    };
    const a = await mk('a.txt'); // 8B ≤ 15：留
    const b = await mk('b.txt'); // 16B > 15：裁 a
    const c = await mk('c.txt'); // b+c=16B > 15：裁 b
    expect((await capped.list()).map((r) => r.id)).toEqual([c]);
    await expect(capped.undo(b)).rejects.toThrow(); // 被裁的显式拒绝，不半途爆炸
    // 幸存者照常可撤销（字节级回滚不受总量档影响）
    await capped.undo(c);
    expect(await fs.readFile(wsPath('c.txt'), 'utf-8')).toBe('旧c.txt');
  });
});
