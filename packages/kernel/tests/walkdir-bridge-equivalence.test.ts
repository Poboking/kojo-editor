/**
 * `walkDir` 的 `filter` 语义**跨桥可证等价**（2026-10-16 桥分叉批）。
 *
 * 老现场：node 测试桥自己递归并兑现 `filter`（连目录一起剪），Tauri 桥把 opts 过一次 JSON
 * 之后 `filter` 整键消失、宿主 DTO 里根本没这项 ⇒ 同一条调用两种结果，**测试全绿而产品是错的**。
 * 修法是把谓词收到内核 `FileIOServiceImpl.walkDir` 一处兑现，桥只枚举。
 *
 * 本文件钉的就是"一处兑现"这件事本身，用同一组断言跑**两具桥**：
 * 1. 同一个谓词、同一棵盘 ⇒ 两具桥的最终返回集合逐字相等；
 * 2. 桥手上永远收不到 `filter` 键（谓词根本不过线）；
 * 3. 新契约「只筛输出条目、不剪枝」在两具桥上同形（旧 node 桥的剪枝形在这里必须判负）；
 * 4. 可序列化字段（`maxDepth` / `includeDirs` / `withMetadata`）照旧过线并生效——
 *    收窄的只有 `filter`，不是整份 `WalkOptions`。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DirEntry, Logger, WalkOptions } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../src/io';
import { NodeBridge } from './helpers/node-bridge';
import { newWireFacts, tauriShapedBridge, type WireFacts } from './helpers/ipc-shaped-bridge';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let root = '';
const F = (...segs: string[]): string => join(root, ...segs);
/** 夹具树（一层深 + 一个"该被剪还是该留下"的争议目录） */
const FILES = [
  ['a.ERB'],
  ['note.txt'],
  ['deep'], // 无扩展名的文件
  ['keep', 'b.ERB'],
  ['keep', 'note.txt'],
  ['skipme', 'c.ERB'],
  ['skipme', 'note.md'],
];

/** 两具桥共用同一片盘：node（JS 递归）与 Tauri 形（参数过 JSON、桥不看谓词） */
let nodeIo: FileIOServiceImpl;
let ipcIo: FileIOServiceImpl;
let facts: WireFacts;

const paths = (es: readonly DirEntry[]): string[] => es.map((e) => e.path).sort();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kojo-walkdir-equiv-'));
  mkdirSync(F('keep'), { recursive: true });
  mkdirSync(F('skipme'), { recursive: true });
  for (const segs of FILES) writeFileSync(F(...segs), '1\n', 'utf8');
  facts = newWireFacts();
  nodeIo = new FileIOServiceImpl(new NodeBridge(root), silentLog);
  ipcIo = new FileIOServiceImpl(tauriShapedBridge(new NodeBridge(root), facts), silentLog);
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe('walkDir filter 的兑现方 = 内核：两具桥同结果', () => {
  const dialect: WalkOptions = { filter: (e) => e.isDirectory || /\.erb$/i.test(e.name) };

  it('同一谓词跑两具桥 ⇒ 返回集合逐字相等（且=夹具里的三份方言文件）', async () => {
    const viaNode = await nodeIo.walkDir(root, dialect);
    const viaIpc = await ipcIo.walkDir(root, dialect);
    expect(paths(viaIpc)).toEqual(paths(viaNode));
    expect(paths(viaNode)).toEqual([F('a.ERB'), F('keep', 'b.ERB'), F('skipme', 'c.ERB')].sort());
  });

  it('谓词不过线：递到桥手上的 opts 里没有 filter 键', async () => {
    const before = facts.walkOptKeys.length;
    await ipcIo.walkDir(root, { ...dialect, includeFiles: true });
    expect(facts.walkOptKeys.length).toBe(before + 1);
    expect(facts.walkOptKeys[before], '内核必须剥掉 filter 再交给桥').toEqual(['includeFiles']);
    expect(facts.wireWalkOpts[before]).toEqual({ includeFiles: true });
  });

  it('新契约「只筛输出条目、不剪枝」在两具桥上同形', async () => {
    // `skipme` 目录命中谓词的 false 分支：旧 node 桥会连子树一起剪（子孙消失），
    // 新语义只去掉那条目录项本身——枚举先于筛选，剪枝在跨进程桥上根本不可能。
    const opts: WalkOptions = { includeDirs: true, filter: (e) => !e.isDirectory || !e.name.startsWith('skip') };
    const viaNode = paths(await nodeIo.walkDir(root, opts));
    const viaIpc = paths(await ipcIo.walkDir(root, opts));
    expect(viaIpc).toEqual(viaNode);
    expect(viaNode).not.toContain(F('skipme')); // 目录项被筛掉
    expect(viaNode).toContain(F('skipme', 'note.md')); // 但它的子孙照旧在（不剪枝）
    expect(viaNode).toContain(F('keep')); // 未命中的目录照常输出
  });

  it('可序列化字段照旧生效（收窄的只有 filter）', async () => {
    const shallow = { maxDepth: 0 } satisfies WalkOptions;
    const viaNode = paths(await nodeIo.walkDir(root, shallow));
    const viaIpc = paths(await ipcIo.walkDir(root, shallow));
    expect(viaIpc).toEqual(viaNode);
    expect(viaNode).toEqual([F('a.ERB'), F('deep'), F('note.txt')].sort());

    const dirs = paths(await nodeIo.walkDir(root, { includeDirs: true }));
    const dirsIpc = paths(await ipcIo.walkDir(root, { includeDirs: true }));
    expect(dirsIpc).toEqual(dirs);

    const meta = await ipcIo.walkDir(root, { withMetadata: true });
    expect(meta.every((e) => e.isDirectory || (typeof e.mtimeMs === 'number' && typeof e.size === 'number'))).toBe(
      true,
    );
    const metaNode = await nodeIo.walkDir(root, { withMetadata: true });
    expect(paths(meta)).toEqual(paths(metaNode));
  });
});
