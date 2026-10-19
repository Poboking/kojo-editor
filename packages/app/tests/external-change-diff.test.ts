import { describe, expect, it, vi, type Mock } from 'vitest';
import type { KernelEventMap, TextFile } from '@kojo/plugin-api';
import {
  externalChangeClashCount,
  hasExternalChangeClash,
  openExternalChangeDiff,
  type ExternalChangeDiffDeps,
  type ExternalChangeDiffInput,
} from '../src/ui/external-change';
import type { ExternalChangeDecision, MergeConflictChunk } from '../src/ui/external-change';

/**
 * 工包 H：外部改动冲突 → 差异视图的接线纯逻辑（`openExternalChangeDiff`）。
 *
 * 判钉四件（一条都不许漂）：
 * ①有 clash 才给 diff 入口（noop/reload/merge 一律 `no-clash`，且**不读盘**——
 *    没有要交给用户裁决的冲突就不该白跑一趟 IO）；
 * ②无 clash 不给（同上的负向）；
 * ③两侧内容只认真源：内存侧 = 点击时刻传入的 memoryText，盘侧 = 本次
 *    `io.readText(path)` 的返回值（逐字进 request，不许换源、不许二次加工）；
 * ④盘读失败**退回 notify 口径**：error 通知（含路径与错误文本）、不开窗、
 *    返回 read-failed——绝不白屏、绝不静默。
 */

const tf = (path: string, text: string): TextFile => ({
  path,
  text,
  encoding: 'utf-8',
  eol: 'lf',
  mtimeMs: null,
});

const chunk = (over: Partial<MergeConflictChunk> = {}): MergeConflictChunk => ({
  baseStart: 0,
  baseEnd: 1,
  base: 'b',
  disk: 'd',
  memory: 'm',
  ...over,
});

const mkInput = (decision: ExternalChangeDecision, over: Partial<ExternalChangeDiffInput> = {}): ExternalChangeDiffInput => ({
  decision,
  path: 'C:/game/data/x.ERB',
  memoryText: 'MY MEMORY TEXT',
  ...over,
});

type EmitFn = (p: KernelEventMap['ui.diffView.open']) => void;
type NotifyFn = ExternalChangeDiffDeps['notify'];

interface MockDeps extends ExternalChangeDiffDeps {
  readText: Mock<(path: string) => Promise<TextFile>>;
  emitDiffOpen: Mock<EmitFn>;
  notify: Mock<NotifyFn>;
}

const mkDeps = (diskText = 'FRESH DISK TEXT'): MockDeps => {
  const readText = vi.fn(async (_path: string): Promise<TextFile> => tf('C:/game/data/x.ERB', diskText));
  const emitDiffOpen = vi.fn((_p: KernelEventMap['ui.diffView.open']): void => {});
  const notify = vi.fn((_i: { kind: 'error'; message: string }): void => {});
  return { io: { readText }, emitDiffOpen, notify, readText };
};

describe('hasExternalChangeClash / externalChangeClashCount', () => {
  it('两方 conflict 与三方 merge-conflict 都算 clash；noop/reload/merge 都不算', () => {
    expect(hasExternalChangeClash('conflict')).toBe(true);
    expect(hasExternalChangeClash({ kind: 'merge-conflict', conflicts: [chunk()] })).toBe(true);
    expect(hasExternalChangeClash('noop')).toBe(false);
    expect(hasExternalChangeClash('reload')).toBe(false);
    expect(hasExternalChangeClash({ kind: 'merge', text: 'x' })).toBe(false);
  });

  it('处数只来自 merge-conflict 的逐块清单；两方 conflict 是 0 但仍是冲突', () => {
    expect(externalChangeClashCount({ kind: 'merge-conflict', conflicts: [chunk(), chunk()] })).toBe(2);
    expect(externalChangeClashCount('conflict')).toBe(0);
    expect(externalChangeClashCount('noop')).toBe(0);
  });
});

describe('openExternalChangeDiff — ①②有 clash 才给入口', () => {
  it('noop / reload / merge ⇒ no-clash：不发意图、不读盘、不通知', async () => {
    for (const decision of ['noop', 'reload', { kind: 'merge', text: 'm' }] as const) {
      const deps = mkDeps();
      const out = await openExternalChangeDiff(mkInput(decision), deps);
      expect(out.kind).toBe('no-clash');
      expect(deps.readText).not.toHaveBeenCalled();
      expect(deps.emitDiffOpen).not.toHaveBeenCalled();
      expect(deps.notify).not.toHaveBeenCalled();
    }
  });

  it('merge-conflict ⇒ open：意图恰好一条，走既有 ui.diffView.open 管线', async () => {
    const deps = mkDeps();
    const out = await openExternalChangeDiff(
      mkInput({ kind: 'merge-conflict', conflicts: [chunk(), chunk(), chunk()] }),
      deps,
    );
    expect(out.kind).toBe('open');
    expect(deps.emitDiffOpen).toHaveBeenCalledTimes(1);
    const p = deps.emitDiffOpen.mock.calls[0]![0] as KernelEventMap['ui.diffView.open'];
    expect(p.title).toContain('3 处冲突');
    expect(p.title).toContain('C:/game/data/x.ERB');
    expect(p.source).toBe('host:external-change-conflict');
  });

  it('两方 conflict（无逐块清单）⇒ 照样 open，标题不编造处数', async () => {
    const deps = mkDeps();
    const out = await openExternalChangeDiff(mkInput('conflict'), deps);
    expect(out.kind).toBe('open');
    if (out.kind !== 'open') return;
    expect(out.request.title).not.toMatch(/处冲突/);
  });
});

describe('openExternalChangeDiff — ③两侧内容取自哪（真源逐字进 request）', () => {
  it('盘侧 = 本次 io.readText(path) 的返回文本；内存侧 = 点击时刻传入的 memoryText', async () => {
    const deps = mkDeps('DISK TRUTH');
    const input = mkInput('conflict', { memoryText: 'MY WORK IN PROGRESS' });
    const out = await openExternalChangeDiff(input, deps);
    expect(out.kind).toBe('open');
    if (out.kind !== 'open') return;
    expect(deps.readText).toHaveBeenCalledTimes(1);
    expect(deps.readText).toHaveBeenCalledWith('C:/game/data/x.ERB');
    // 左 = 参照侧（盘），右 = 对照侧（我）；两侧都是**内联文本**——开窗后不再二次读盘
    expect(out.request.original).toEqual({ label: expect.stringContaining('磁盘'), text: 'DISK TRUTH' });
    expect(out.request.modified).toEqual({ label: expect.stringContaining('编辑器'), text: 'MY WORK IN PROGRESS' });
    expect(out.request.original.path).toBeUndefined();
    expect(out.request.modified.path).toBeUndefined();
    // 发出的意图与返回的请求同体（overlay 经 bindDiffView 收到的就是这一份）
    expect(deps.emitDiffOpen.mock.calls[0]![0]).toMatchObject(out.request);
  });

  it('内存文本为空串也是合法一侧（"我全删了"正需要空侧比对）', async () => {
    const deps = mkDeps('SOMETHING');
    const out = await openExternalChangeDiff(mkInput('conflict', { memoryText: '' }), deps);
    expect(out.kind).toBe('open');
    if (out.kind !== 'open') return;
    expect(out.request.modified.text).toBe('');
  });
});

describe('openExternalChangeDiff — ④盘读失败退回 notify 口径', () => {
  it('readText 抛错 ⇒ 不开窗、不白屏：error 通知含路径与错误文本，返回 read-failed', async () => {
    const readText = vi.fn(async (_path: string): Promise<TextFile> => {
      throw new Error('EACCES: denied');
    });
    const emitDiffOpen = vi.fn((_p: KernelEventMap['ui.diffView.open']): void => {});
    const notify = vi.fn((_i: { kind: 'error'; message: string }): void => {});
    const deps = { io: { readText }, emitDiffOpen, notify } satisfies ExternalChangeDiffDeps;
    const out = await openExternalChangeDiff(mkInput('conflict'), deps);
    expect(out.kind).toBe('read-failed');
    expect(out.kind === 'read-failed' && out.message).toContain('C:/game/data/x.ERB');
    expect(out.kind === 'read-failed' && out.message).toContain('EACCES: denied');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ kind: 'error', message: out.kind === 'read-failed' ? out.message : '' });
    expect(emitDiffOpen).not.toHaveBeenCalled();
  });

  it('非 Error 抛出值也进通知文本（errorText 口径，不吞）', async () => {
    const readText = vi.fn(async (_path: string): Promise<TextFile> => {
      throw 'string boom';
    });
    const notify = vi.fn((_i: { kind: 'error'; message: string }): void => {});
    const deps = {
      io: { readText },
      emitDiffOpen: vi.fn((_p: KernelEventMap['ui.diffView.open']): void => {}),
      notify,
    } satisfies ExternalChangeDiffDeps;
    const out = await openExternalChangeDiff(mkInput({ kind: 'merge-conflict', conflicts: [chunk()] }), deps);
    expect(out.kind).toBe('read-failed');
    expect(notify.mock.calls[0]![0].message).toContain('string boom');
  });
});
