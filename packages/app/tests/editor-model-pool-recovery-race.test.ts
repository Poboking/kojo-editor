/**
 * 崩溃恢复注入竞态回归（2026-10 "app ate my work" 批）。
 *
 * 事故链（旧代码）：切换 effect 里 `takeRecoveredContent` **取即删**发生在提交闸之前 →
 * 快速切换使首轮 acquire 落入 `if (cancelled) return`：①快照已被吃掉、②基线由重跑按
 * 读盘语义补成当前版本号 → 恢复内容被洗成"干净"：autosave 不存它、退出无提示丢弃它、
 * 外部 file.changed 直接覆盖它。外加 cancelled 路径**不 release 已 acquire 的引用**，
 * 快速 Ctrl+P 每竞态一次泄漏一份 model。
 *
 * 本文件钉两件事：
 *  ① **池运行期**：恢复件的基线钉 0 由池在建 model 那一刻落在记录上（不依赖调用方
 *     局部变量撑过 await）；cancelled ⇒ 对称 release 后重拿，同一快照仍重建出"未保存脏"；
 *     第二组共享/reset 不许触碰既有基线；并发等待者不会被提前退场的一方拆掉 model。
 *  ② **切换 effect 结构守门**（EditorPane 在 node 渲染不出来，照 editor-options.test.ts
 *     的静态取证先例）：快照先 peek、提交闸（!cancelled + 条目入 + 基线落定）之后才 drop；
 *     cancelled 分支必须 release 且绝不落基线；基线只在池记录为空时才落。
 *
 * 覆盖边界：React effect 重跑 + 真 Monaco 的"cancelled 后整序重拿"全序列属**手动/壳层
 * 冒烟**验收面；此处以池 API 直驱同一账本语义 + 源码结构钉，两层合起来锁死回归。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createEditorModelPool, type EditorModelPool, type PoolDeps } from '../src/ui/editor-model-pool';

interface FakeModel {
  value: string;
  disposed: boolean;
}

type FakeMonacoModel = import('../src/monaco/entry').editor.ITextModel & { dispose(): void };

function harness(files: Record<string, string>) {
  const models: FakeModel[] = [];
  const deps: PoolDeps = {
    readText: vi.fn(async (_kernel: unknown, p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return { text: files[p]!, encoding: 'utf-8', eol: 'LF' };
    }),
    createModel: vi.fn((p: string, text: string) => {
      const m: FakeModel = { value: `${p}::${text}`, disposed: false };
      const fake = m as unknown as FakeMonacoModel;
      fake.dispose = () => {
        m.disposed = true;
      };
      models.push(m);
      return fake;
    }),
  };
  return { pool: createEditorModelPool(deps), models, deps };
}

const SNAPSHOT = { text: 'recovered-draft', encoding: 'utf-16le', eol: 'CRLF' };
const kernel = {} as never;

describe('池运行期 · 恢复件基线钉在"建 model 那一刻"', () => {
  it('恢复件首次 acquire：基线=0 与 fromRecovery=true 当场落账（不等调用方 await 后补）', async () => {
    const h = harness({ 'a.erb': 'disk' });
    const e = await h.pool.acquire(kernel, 'a.erb', SNAPSHOT);
    expect(e.fromRecovery).toBe(true);
    expect(h.pool.baseline('a.erb')).toBe(0); // 0 ≠ 任何真实版本号 ⇒ O(1) 脏判定恒"未保存脏"
    expect((h.models[0]! as FakeModel).value).toContain('recovered-draft');
    expect(h.deps.readText).not.toHaveBeenCalled();
  });

  it('cancelled → 对称 release → 同快照重拿：仍从恢复内容重建、基线仍是 0（旧语义在此洗成当前版本号）', async () => {
    const h = harness({ 'a.erb': 'disk' });
    const e1 = await h.pool.acquire(kernel, 'a.erb', SNAPSHOT);
    expect(e1.fromRecovery).toBe(true);
    // 模拟 effect cancelled 退场：不提交条目，引用对称回收（refcount-leak 修复本体）
    expect(h.pool.release('a.erb')).toBe(0);
    expect(h.models[0]!.disposed).toBe(true);
    // 重跑：peek 语义下快照未被消费 ⇒ 再次进恢复分支，内容不丢
    const e2 = await h.pool.acquire(kernel, 'a.erb', SNAPSHOT);
    expect(h.models).toHaveLength(2);
    expect(h.models[1]!.value).toContain('recovered-draft');
    expect(e2.fromRecovery).toBe(true);
    expect(h.pool.baseline('a.erb')).toBe(0);
    // 第二组共享（不带快照）：池的共享分支自带来源真相，且绝不动已钉的 0
    const e3 = await h.pool.acquire(kernel, 'a.erb');
    expect(e3.model).toBe(e2.model);
    expect(e3.fromRecovery).toBe(true);
    expect(h.pool.baseline('a.erb')).toBe(0);
    expect(h.deps.readText).not.toHaveBeenCalled(); // 全程没读盘：恢复内容没被盘模型洗掉
  });

  it('读盘 model 跨组共享：acquire 共享分支不重置已有基线（保存点属文件不属组）', async () => {
    const h = harness({ 'a.erb': 'x' });
    await h.pool.acquire(kernel, 'a.erb');
    h.pool.setBaseline('a.erb', 41); // 调用方按契约在提交时落基线（模拟第一组保存点）
    const e2 = await h.pool.acquire(kernel, 'a.erb');
    expect(e2.fromRecovery).toBe(false);
    expect(h.pool.baseline('a.erb')).toBe(41);
    expect(h.pool.refCount('a.erb')).toBe(2);
  });

  it('读盘后的基线由调用方"仅在空时"落定 ⇒ 本组提交前基线为 undefined 是合法中间态', async () => {
    const h = harness({ 'a.erb': 'x' });
    await h.pool.acquire(kernel, 'a.erb');
    expect(h.pool.baseline('a.erb')).toBeUndefined(); // 池不猜版本语义，读盘件基线归调用方
  });
});

describe('池运行期 · 引用账本在并发竞态下不孤儿', () => {
  it('两组并发 acquire（读盘在途），一方提前退账：model 全程活着、账本落到另一方', async () => {
    const models: FakeModel[] = [];
    let resolveRead: ((v: { text: string; encoding: string; eol: string }) => void) | null = null;
    const deps: PoolDeps = {
      readText: () =>
        new Promise<{ text: string; encoding: string; eol: string }>((res) => {
          resolveRead = res;
        }),
      createModel: (p, text) => {
        const m: FakeModel = { value: `${p}::${text}`, disposed: false };
        const fake = m as unknown as FakeMonacoModel;
        fake.dispose = () => {
          m.disposed = true;
        };
        models.push(m);
        return fake;
      },
    };
    const pool: EditorModelPool = createEditorModelPool(deps);
    const p1 = pool.acquire(kernel, 'a.erb');
    const p2 = pool.acquire(kernel, 'a.erb');
    resolveRead!({ text: 'disk', encoding: 'utf-8', eol: 'LF' });
    const e1 = await p1;
    // p1 的调用方续体（cancelled ⇒ release）落在 p2 settle 续体之后：两笔引用都已挂账，
    // 回收一方另一方仍在 ⇒ 返回 1、model 不 dispose（pending/refs 分账是这条不变式的结构护栏）
    expect(pool.release('a.erb')).toBe(1);
    const e2 = await p2;
    expect(e2.model).toBe(e1.model);
    expect(models).toHaveLength(1);
    expect(models[0]!.disposed).toBe(false);
    expect(pool.refCount('a.erb')).toBe(1);
  });

  it('读盘在途时带快照的 acquire 不劫持：共享在途盘模型、fromRecovery=false（调用方据此**不 drop** 快照）', async () => {
    let resolveRead: ((v: { text: string; encoding: string; eol: string }) => void) | null = null;
    const h = harness({ 'a.erb': 'disk' });
    h.deps.readText = () =>
      new Promise<{ text: string; encoding: string; eol: string }>((res) => {
        resolveRead = res;
      });
    const p1 = h.pool.acquire(kernel, 'a.erb'); // 先发起：读盘在途
    const p2 = h.pool.acquire(kernel, 'a.erb', SNAPSHOT); // 恢复注入赶上新开：让位在途 loading
    resolveRead!({ text: 'disk', encoding: 'utf-8', eol: 'LF' });
    const e2 = await p2;
    expect(e2.fromRecovery).toBe(false);
    expect(await p1).toBe(e2);
    expect(h.models[0]!.value).toContain('disk');
  });

  it('失败不悬挂（回归旧行为）：reject 原样上抛、记录回收、下次 acquire 重来', async () => {
    const h = harness({});
    await expect(h.pool.acquire(kernel, 'nope.erb')).rejects.toThrow('ENOENT');
    expect(h.pool.refCount('nope.erb')).toBe(0);
    expect(h.pool.baseline('nope.erb')).toBeUndefined();
  });
});

/* ---------------- 切换 effect 结构守门（静态取证，先例：editor-options.test.ts） ---------------- */

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const editorPane = readFileSync(path.join(SRC, 'ui/EditorPane.tsx'), 'utf8');

/** 切换 effect 的"取 model + 提交闸"区段：两个 perf 探针之间就是本批的全部案发现场 */
function switchRegion(): string {
  const i0 = editorPane.indexOf("perf.start('switch.readText')");
  const i1 = editorPane.indexOf("perf.start('switch.apply')", i0);
  if (i0 < 0 || i1 < 0) throw new Error('切换 effect 的探针锚点漂移了——本守门要跟着重写');
  return editorPane.slice(i0, i1);
}

describe('切换 effect 结构守门 · 快照消费推迟到提交闸之后', () => {
  it('快照读取只剩 peek：takeRecoveredContent（取即删）在本文件零残留', () => {
    const region = switchRegion();
    expect(region).toContain('peekRecoveredContent(filePath)');
    expect(editorPane).not.toContain('takeRecoveredContent(');
  });

  it('cancelled 提交闸：必须对称 release 且绝不落基线', () => {
    const m = switchRegion().match(/if \(cancelled\) \{([\s\S]*?)\n {10}\}/);
    expect(m, '区段里找不到 cancelled 提交闸').not.toBeNull();
    expect(m![1]).toContain('editorModelPool.release(filePath);');
    expect(m![1]).toContain('return;');
    expect(m![1]).not.toContain('setBaseline');
  });

  it('基线只在池记录为空时才落；调用方不再直接钉 0（钉 0 归池的恢复分支）', () => {
    const region = switchRegion();
    expect(region).toContain('if (editorModelPool.baseline(filePath) === undefined) {');
    expect(region).toContain('editorModelPool.setBaseline(filePath, model.getAlternativeVersionId());');
    expect(region).not.toContain('setBaseline(filePath, 0)');
  });

  it('次序钉：drop 快照一定发生在条目提交之后，且只在本轮真用上了恢复 model 时', () => {
    const region = switchRegion();
    const setIdx = region.indexOf('entriesRef.current.set(filePath, entry);');
    const dropIdx = region.indexOf('dropRecoveredContent(filePath);');
    expect(setIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeGreaterThan(setIdx);
    expect(region).toContain('if (recovered && pooled.fromRecovery) dropRecoveredContent(filePath);');
  });
});
