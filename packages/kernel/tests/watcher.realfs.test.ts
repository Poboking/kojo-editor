import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileChangedEvent, FileWatchStateEvent } from '@kojo/plugin-api';
import { TypedEventBus } from '../src/bus';
import { FileWatcherServiceImpl } from '../src/watcher';
import { NodeBridge } from './helpers/node-bridge';

/**
 * 真监视器端到端（BUG-5）：内核去抖层 ↔ 平台层 `fs.watch` ↔ 真实磁盘写入。
 *
 * 单测用假桥证明了去抖逻辑，但证不了**平台真的会投递事件**——那正是 BUG-5 的原形态
 * （`watchDirs` 是空实现，逻辑全绿而盘上改动一条都不来）。这里用 NodeBridge 的
 * `fs.watch(recursive)` 走一遍完整链路，跨 OS 只放宽等待、不放宽断言。
 */

let dir: string;
const DEBOUNCE_MS = 60; // 比生产值小：本文件验的是"会合并"，不是"合并窗口多长"

function makeReal() {
  const bus = new TypedEventBus();
  const bridge = new NodeBridge(dir);
  const watcher = new FileWatcherServiceImpl({ platform: bridge, bus, log: silentLog(), debounceMs: DEBOUNCE_MS });
  const changes: FileChangedEvent[] = [];
  bus.on('file.changed', (p) => changes.push(p));
  const states: FileWatchStateEvent[] = [];
  bus.on('file.watchState', (p) => states.push(p));
  return { bus, bridge, watcher, changes, states };
}

function silentLog() {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'kojo-watch-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileWatcherServiceImpl × 真实 fs.watch', () => {
  it('外部写盘 → 去抖后恰好一条 file.changed，路径指向被写的文件', async () => {
    const { watcher, changes } = makeReal();
    await watcher.start([dir]);
    expect(watcher.state().status).toBe('watching'); // 平台 started 报告：根全部监视上

    await writeFile(nodePath.join(dir, 'outer-written.ERB'), '; 别的程序改的\n', 'utf8');

    await expect
      .poll(() => changes.length, { timeout: 4000, message: '真实监视器未投递任何事件（BUG-5 原 shape）' })
      .toBe(1);
    expect(changes[0]!.path).toBe(nodePath.join(dir, 'outer-written.ERB'));
    expect(changes[0]!.kind).toBe('change');

    watcher.stop();
  });

  it('一次原子写（临时文件 + rename）的多条平台事件被并成一次上报', async () => {
    const { watcher, bridge, changes } = makeReal();
    await watcher.start([dir]);

    const target = nodePath.join(dir, 'saved.ERB');
    await bridge.writeFileBytes(target, new TextEncoder().encode('; 一次保存\n'));

    await expect
      .poll(() => changes.length, { timeout: 4000 })
      .toBeGreaterThanOrEqual(1);
    // 再等一个去抖窗：不应出现"同一次保存报了两次"
    const afterFirst = changes.length;
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 4));
    expect(changes.length).toBe(afterFirst);
    expect(changes.every((c) => c.path === target)).toBe(true);

    watcher.stop();
  });

  it('监视范围外的目录不产生事件（递归监视只在请求的根内）', async () => {
    const { watcher, changes } = makeReal();
    const inside = nodePath.join(dir, 'kojo');
    const outside = nodePath.join(dir, 'other');
    await Promise.all([mkdir(inside, { recursive: true }), mkdir(outside, { recursive: true })]);
    await watcher.start([inside]);

    await writeFile(nodePath.join(outside, 'x.ERB'), 'b', 'utf8');
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 4));
    expect(changes).toHaveLength(0);

    await writeFile(nodePath.join(inside, 'y.ERB'), 'c', 'utf8');
    await expect.poll(() => changes.length, { timeout: 4000 }).toBeGreaterThan(0);
    expect(changes.every((c) => c.path.startsWith(inside))).toBe(true);

    watcher.stop();
  });

  it('删除文件 → unlink（node 桥的 kind 与契约三态对齐，不再恒 change）', async () => {
    const { watcher, changes } = makeReal();
    await watcher.start([dir]);
    const target = nodePath.join(dir, 'deleted.ERB');
    await writeFile(target, '; 先建再删\n', 'utf8');
    await expect
      .poll(() => changes.length, { timeout: 4000, message: '建立事件未投递' })
      .toBeGreaterThanOrEqual(1);
    await rm(target);
    // 同一路径的**末态** kind（与内核去抖「最后观测到的类别」同口径）
    await expect
      .poll(() => changes.filter((c) => c.path === target).pop()?.kind, { timeout: 4000 })
      .toBe('unlink');
    watcher.stop();
  });
});
