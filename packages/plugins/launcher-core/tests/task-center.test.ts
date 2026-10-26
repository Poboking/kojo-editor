/**
 * 任务中心：终态、进度节流（不丢终态）、取消语义。
 *
 * 节流用例走假时钟（`vi.useFakeTimers`）：真等 100 ms 只会让测试变慢且随机。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskCenterImpl } from '../src/task-center';
import type { LauncherTask } from '@kojo/plugin-api';

function idGen(): () => string {
  let n = 0;
  return () => `t-${++n}`;
}

describe('TaskCenter · 增删改与终态', () => {
  it('queued 可取消 → cancelled，并向执行方发出取消请求', async () => {
    const center = new TaskCenterImpl({ newId: idGen() });
    let requested = 0;
    const task = center.create({ kind: 'verify', onCancel: () => void requested++ });

    expect(task.state).toBe('queued');
    await center.cancel(task.id);
    expect(center.get(task.id)?.state).toBe('cancelled');
    expect(center.get(task.id)?.endedAt).not.toBeNull();
    expect(requested).toBe(1);
  });

  it('running 的取消走请求语义：状态不变，终态只能由执行方给出', async () => {
    const center = new TaskCenterImpl({ newId: idGen() });
    let requested = 0;
    const task = center.create({ kind: 'instance-copy', onCancel: () => void requested++ });
    center.begin(task.id);

    await center.cancel(task.id);
    expect(requested).toBe(1);
    expect(center.get(task.id)?.state).toBe('running');

    // 执行方确认取消后推来终态
    const running = center.get(task.id)!;
    center.adopt({ ...running, state: 'cancelled', endedAt: '2026-10-26T00:00:09.000Z' });
    expect(center.get(task.id)?.state).toBe('cancelled');
  });

  it('不可取消的 running 任务：cancel 抛 LAUNCHER_TASK_BUSY', async () => {
    const center = new TaskCenterImpl({ newId: idGen() });
    const task = center.create({ kind: 'verify', cancellable: false });
    center.begin(task.id);
    await expect(center.cancel(task.id)).rejects.toMatchObject({ code: 'LAUNCHER_TASK_BUSY' });
  });

  it('未知任务 / 已终态任务：前者报错，后者幂等', async () => {
    const center = new TaskCenterImpl({ newId: idGen() });
    await expect(center.cancel('nope')).rejects.toMatchObject({ code: 'LAUNCHER_INTERNAL' });

    const task = center.create({ kind: 'verify' });
    center.succeed(task.id);
    await expect(center.cancel(task.id)).resolves.toBeUndefined();
    expect(center.get(task.id)?.state).toBe('succeeded');
  });

  it('终态不可回退：迟到的 running 快照不得把 succeeded 拉回去', () => {
    const center = new TaskCenterImpl({ newId: idGen() });
    const task = center.create({ kind: 'content-install' });
    center.begin(task.id);
    center.succeed(task.id, { files: 3 });

    const stale: LauncherTask = { ...center.get(task.id)!, state: 'running', endedAt: null };
    center.adopt(stale);
    expect(center.get(task.id)).toMatchObject({ state: 'succeeded', result: { files: 3 } });
  });
});

describe('TaskCenter · 进度节流', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('100 次进度推送被合并，但终态一条不丢、进度读数不倒退', () => {
    const center = new TaskCenterImpl({ newId: idGen(), throttleMs: 100 });
    const task = center.create({ kind: 'content-install' });
    center.begin(task.id);

    const observed: LauncherTask[] = [];
    center.subscribe((next) => observed.push(next));

    for (let done = 1; done <= 100; done++) {
      center.setProgress(task.id, { done, total: 100, unit: 'files', message: `第 ${done} 个` });
      vi.advanceTimersByTime(1);
    }
    center.succeed(task.id, { ok: true });

    // 节流：100 次推送 + 一条终态，广播次数远少于 101
    expect(observed.length).toBeLessThan(20);
    const last = observed.at(-1)!;
    expect(last.state).toBe('succeeded');
    // 终态携带的是最新进度（节流不得把手上的读数丢了）
    expect(last.progress).toMatchObject({ done: 100, total: 100 });
    expect(last.result).toEqual({ ok: true });

    // 尾沿定时器不得在终态之后再补一条旧快照
    vi.advanceTimersByTime(500);
    expect(observed.at(-1)!.state).toBe('succeeded');
  });

  it('进度不倒退：迟到的较小 done 不覆盖已有读数', () => {
    const center = new TaskCenterImpl({ newId: idGen(), throttleMs: 0 });
    const task = center.create({ kind: 'instance-copy' });
    center.begin(task.id);
    center.setProgress(task.id, { done: 50, total: 100, unit: 'bytes', message: '' });
    center.setProgress(task.id, { done: 20, total: 100, unit: 'bytes', message: '' });
    expect(center.get(task.id)?.progress?.done).toBe(50);
  });
});
