/**
 * SPLIT-1 · model 池单测：引用计数（同文件多组共享一份 model，归零才 dispose）、
 * 并发 acquire 共享同一次读盘、失败不悬挂、基线随文件存续 / 随最后释放清理。
 * monaco 与内核 io 全部注入假件——纯逻辑闭环，不加载真 Monaco。
 */

import { describe, expect, it, vi } from 'vitest';
import { createEditorModelPool, type PoolDeps } from '../src/ui/editor-model-pool';

interface FakeModel {
  value: string;
  disposed: boolean;
}

function harness(files: Record<string, string>) {
  const models: FakeModel[] = [];
  const deps: PoolDeps = {
    readText: vi.fn(async (_kernel: unknown, path: string) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return { text: files[path]!, encoding: 'utf-8', eol: 'LF' };
    }),
    createModel: vi.fn((path: string, text: string) => {
      const m: FakeModel = { value: `${path}::${text}`, disposed: false };
      const fake = m as unknown as import('../src/monaco/entry').editor.ITextModel & { dispose(): void };
      fake.dispose = () => {
        m.disposed = true;
      };
      models.push(m);
      return fake;
    }),
  };
  const pool = createEditorModelPool(deps);
  return { pool, models, deps };
}

describe('model 池 · 引用计数', () => {
  it('同文件二次 acquire：共享同一份 model、只建一次', async () => {
    const h = harness({ 'a.erb': 'hello' });
    const e1 = await h.pool.acquire({} as never, 'a.erb');
    const e2 = await h.pool.acquire({} as never, 'a.erb');
    expect(e1.model).toBe(e2.model);
    expect(h.models).toHaveLength(1);
    expect(h.pool.refCount('a.erb')).toBe(2);
  });

  it('归零才 dispose：释放一份还剩一份时 model 活着', async () => {
    const h = harness({ 'a.erb': 'x' });
    await h.pool.acquire({} as never, 'a.erb');
    await h.pool.acquire({} as never, 'a.erb');
    const model = h.models[0]! as unknown as FakeModel;
    expect(h.pool.release('a.erb')).toBe(1);
    expect(model.disposed).toBe(false);
    expect(h.pool.release('a.erb')).toBe(0);
    expect(model.disposed).toBe(true);
    expect(h.pool.refCount('a.erb')).toBe(0);
  });

  it('归零释放后重新 acquire：走重读重建（版本号从 1 重新数）', async () => {
    const h = harness({ 'a.erb': 'v1' });
    await h.pool.acquire({} as never, 'a.erb');
    h.pool.release('a.erb');
    const e2 = await h.pool.acquire({} as never, 'a.erb');
    expect(h.models).toHaveLength(2);
    expect(e2.model).not.toBe(h.models[0]);
  });

  it('释放不存在的路径：返回 0 不抛', () => {
    const h = harness({});
    expect(h.pool.release('ghost.erb')).toBe(0);
  });
});

describe('model 池 · 并发与失败', () => {
  it('并发 acquire 同文件：只读一次盘、共享同一份 model', async () => {
    const h = harness({ 'a.erb': 'x' });
    const [e1, e2] = await Promise.all([
      h.pool.acquire({} as never, 'a.erb'),
      h.pool.acquire({} as never, 'a.erb'),
    ]);
    expect(e1.model).toBe(e2.model);
    expect(h.deps.readText).toHaveBeenCalledTimes(1);
    expect(h.pool.refCount('a.erb')).toBe(2);
  });

  it('读盘失败：acquire 抛原错误；池不悬挂', async () => {
    const h = harness({});
    await expect(h.pool.acquire({} as never, 'nope.erb')).rejects.toThrow('ENOENT');
    expect(h.pool.refCount('nope.erb')).toBe(0);
    // 同一池对象在盘上事实补好后（这里以另一个同路径有文件的池模拟重试语义）
    const again = harness({ 'nope.erb': 'ok' });
    const e = await again.pool.acquire({} as never, 'nope.erb');
    expect(e.model).toBeDefined();
  });

  it('恢复件注入：首次 acquire 用注入内容建 model（不读盘）', async () => {
    const h = harness({ 'a.erb': 'disk' });
    const e = await h.pool.acquire({} as never, 'a.erb', { text: 'recovered', encoding: 'utf-16le', eol: 'CRLF' });
    expect((e.model as unknown as FakeModel).value).toContain('recovered');
    expect(e.encoding).toBe('utf-16le');
    expect(e.eol).toBe('CRLF');
    expect(h.deps.readText).not.toHaveBeenCalled();
  });
});

describe('model 池 · 已保存基线', () => {
  it('基线随文件存续；最后一份引用释放时一并清掉', async () => {
    const h = harness({ 'a.erb': 'x' });
    await h.pool.acquire({} as never, 'a.erb');
    h.pool.setBaseline('a.erb', 7);
    expect(h.pool.baseline('a.erb')).toBe(7);
    h.pool.release('a.erb');
    expect(h.pool.baseline('a.erb')).toBeUndefined();
  });

  it('setBaseline 对不在池里的路径 no-op（不复活已回收的记录）', async () => {
    const h = harness({});
    h.pool.setBaseline('ghost.erb', 3);
    expect(h.pool.baseline('ghost.erb')).toBeUndefined();
  });
});

/**
 * ZH-F3：三方合并要有 base **文本**（版本号判得了"有没有变"，判不了"变在哪一行"）。
 * 生命周期必须与记录一致——关掉的 tab 跟着释放，不许在池外留副本。
 */
describe('model 池 · 磁盘文本快照（三方合并的 base）', () => {
  it('读盘首开：base = 盘上那份文本', async () => {
    const h = harness({ 'a.erb': '盘上原文' });
    await h.pool.acquire({} as never, 'a.erb');
    expect(h.pool.savedBase('a.erb')).toBe('盘上原文');
  });

  it('恢复件首开：盘上真相未知 ⇒ base 留空（调用方据此退回两方语义）', async () => {
    const h = harness({ 'a.erb': '盘上原文' });
    const e = await h.pool.acquire({} as never, 'a.erb', { text: '恢复的未保存稿' });
    expect(e.fromRecovery).toBe(true);
    expect(h.pool.savedBase('a.erb')).toBeUndefined();
  });

  it('保存成功推进 base；最后一份引用释放后与记录一起清掉', async () => {
    const h = harness({ 'a.erb': 'v1' });
    await h.pool.acquire({} as never, 'a.erb');
    await h.pool.acquire({} as never, 'a.erb');
    h.pool.setSavedBase('a.erb', 'v2');
    expect(h.pool.savedBase('a.erb')).toBe('v2');
    expect(h.pool.release('a.erb')).toBe(1);
    expect(h.pool.savedBase('a.erb')).toBe('v2');
    expect(h.pool.release('a.erb')).toBe(0);
    expect(h.pool.savedBase('a.erb')).toBeUndefined();
  });

  it('关标签后重开：base 随新一次读盘重建（不拿陈年快照做三方）', async () => {
    const files = { 'a.erb': 'v1' };
    const h = harness(files);
    await h.pool.acquire({} as never, 'a.erb');
    h.pool.release('a.erb');
    files['a.erb'] = 'v2';
    await h.pool.acquire({} as never, 'a.erb');
    expect(h.pool.savedBase('a.erb')).toBe('v2');
  });

  it('并发首开只读一次盘：base 落定一次、两方共享同一条记录', async () => {
    const h = harness({ 'a.erb': 'x' });
    await Promise.all([h.pool.acquire({} as never, 'a.erb'), h.pool.acquire({} as never, 'a.erb')]);
    expect(h.pool.savedBase('a.erb')).toBe('x');
    expect(h.deps.readText).toHaveBeenCalledTimes(1);
  });

  it('setSavedBase 对不在池里的路径 no-op（不复活已回收的记录，也就不会泄漏）', () => {
    const h = harness({});
    h.pool.setSavedBase('ghost.erb', 'x');
    expect(h.pool.savedBase('ghost.erb')).toBeUndefined();
  });
});
