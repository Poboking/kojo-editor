/**
 * PS-5 · model 池的文本常驻预算（editor-model-pool.ts）。
 *
 * 背景（改前的账）：每个开着的标签同时背着**两份**整篇正文——Monaco model 一份 +
 * 池里的 `savedBase`（三方合并的 base）一份。20 个 2 MB 级标签就是 40 MB 只增不减。
 *
 * 本文件钉两件事：
 *  ① 预算生效的形状：单份越界不留 / 全池越界按最久未读写淘汰 / 记录回收同批归还额度；
 *  ② **正确性红线**：脏判定一条都不许动。脏只认 `baseline`（model 的
 *    alternativeVersionId），`savedBase` 只服务三方合并 ⇒ 基线被丢掉的文件，
 *    脏与不脏的判断必须与留着基线时**逐字同结果**（既不假"已保存"也不假"未保存"）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { PoolDeps } from '../src/ui/editor-model-pool';
import {
  SAVED_BASE_MAX_UNITS,
  SAVED_BASE_POOL_BUDGET_UNITS,
  createEditorModelPool,
  savedBaseWorthKeeping,
} from '../src/ui/editor-model-pool';

const big = (units: number) => '字'.repeat(units);

function harness(files: Record<string, string>) {
  const deps: PoolDeps = {
    readText: vi.fn(async (_kernel: unknown, path: string) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return { text: files[path]!, encoding: 'utf-8', eol: 'LF' };
    }),
    createModel: vi.fn((path: string, text: string) => {
      const model = {
        path,
        text,
        dispose: () => {},
      } as unknown as import('../src/monaco/entry').editor.ITextModel;
      return model;
    }),
  };
  return { pool: createEditorModelPool(deps), deps };
}

describe('savedBaseWorthKeeping（纯判据）', () => {
  it('单份上限与全池预算各自独立生效', () => {
    expect(savedBaseWorthKeeping(10, 0)).toBe(true);
    expect(savedBaseWorthKeeping(SAVED_BASE_MAX_UNITS, 0)).toBe(true);
    expect(savedBaseWorthKeeping(SAVED_BASE_MAX_UNITS + 1, 0)).toBe(false);
    expect(savedBaseWorthKeeping(1_000, SAVED_BASE_POOL_BUDGET_UNITS - 1)).toBe(false);
    expect(savedBaseWorthKeeping(1_000, SAVED_BASE_POOL_BUDGET_UNITS - 1_000)).toBe(true);
  });

  it('阈值口径要说得清：真实语料最大单文件（52,601 行 ≈ 0.8–1.3 M 码元）留在预算内', () => {
    expect(SAVED_BASE_MAX_UNITS).toBeGreaterThan(1_300_000);
    expect(SAVED_BASE_POOL_BUDGET_UNITS).toBeGreaterThan(SAVED_BASE_MAX_UNITS);
  });
});

describe('磁盘基线的常驻预算', () => {
  it('读盘得来的小文件基线照旧留得住（改前行为零回退）', async () => {
    const h = harness({ 'a.erb': '盘上原文' });
    await h.pool.acquire({} as never, 'a.erb');
    expect(h.pool.savedBase('a.erb')).toBe('盘上原文');
  });

  it('单份越界 ⇒ 不留基线，但**版本号基线照钉**（脏判定不受影响）', async () => {
    const text = big(SAVED_BASE_MAX_UNITS + 1);
    const h = harness({ 'huge.erb': text });
    await h.pool.acquire({} as never, 'huge.erb');
    expect(h.pool.savedBase('huge.erb')).toBeUndefined();
    h.pool.setBaseline('huge.erb', 7);
    expect(h.pool.baseline('huge.erb')).toBe(7); // 越界文件照样能判脏——这条是红线
    h.pool.setSavedBase('huge.erb', text); // 保存后想推进 base：越界仍然不留
    expect(h.pool.savedBase('huge.erb')).toBeUndefined();
  });

  it('全池越界 ⇒ 从最久未读写的那份开始淘汰，最近用到的那份留着', async () => {
    const per = 1_400_000; // 单份在上限内，5 份合计 7 M > 预算 6 M
    const files: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) files[`f${i}.erb`] = big(per);
    const h = harness(files);
    for (let i = 1; i <= 5; i++) await h.pool.acquire({} as never, `f${i}.erb`);
    const kept = [1, 2, 3, 4, 5].filter((i) => h.pool.savedBase(`f${i}.erb`) !== undefined);
    expect(kept.length).toBeLessThanOrEqual(Math.floor(SAVED_BASE_POOL_BUDGET_UNITS / per));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toContain(5); // 最新那一份必在
    expect(kept).not.toContain(1); // 最旧那一份先走
  });

  it('读到即 touch：被淘汰判据先问的是"多久没碰"，不是"谁先建"', async () => {
    const per = 1_400_000;
    const files: Record<string, string> = {};
    for (let i = 1; i <= 4; i++) files[`g${i}.erb`] = big(per);
    const h = harness(files);
    for (let i = 1; i <= 4; i++) await h.pool.acquire({} as never, `g${i}.erb`);
    expect(h.pool.savedBase('g1.erb')).toBeDefined(); // 四份 5.6 M 仍在 6 M 预算内
    h.pool.savedBase('g1.erb'); // 碰一次 g1 ⇒ 它变成最新，g2 成为最旧
    h.pool.setSavedBase('g1.erb', big(per)); // 再写一次（重新入池，仍在预算内）
    await h.pool.acquire({} as never, 'g4.erb'); // 第二次引用 g4（已开，不新增额度）
    expect(h.pool.savedBase('g1.erb')).toBeDefined();
  });

  it('记录回收同批归还额度：关了大标签之后，别的大文件还能拿到基线（预算不只会扣不会还）', async () => {
    const per = 1_400_000;
    const files: Record<string, string> = {};
    for (let i = 1; i <= 4; i++) files[`r${i}.erb`] = big(per);
    const h = harness(files);
    for (let i = 1; i <= 4; i++) await h.pool.acquire({} as never, `r${i}.erb`);
    // 关掉 r1（含它可能被淘汰过的额度）
    h.pool.release('r1.erb');
    const fresh = { 'z.erb': big(per) };
    const h2 = harness(fresh);
    await h2.pool.acquire({} as never, 'z.erb');
    expect(h2.pool.savedBase('z.erb')).toBe(fresh['z.erb']); // 新池独立预算，必留
    // 同一个池里：关两份再开第三份 ⇒ 额度回来了
    for (let i = 2; i <= 3; i++) h.pool.release(`r${i}.erb`);
    const more = { [`late.erb`]: big(per) };
    const samePool = createEditorModelPool({
      readText: async () => ({ text: more['late.erb']!, encoding: 'utf-8', eol: 'LF' }),
      createModel: () => ({ dispose: () => {} }) as never,
    });
    await samePool.acquire({} as never, 'late.erb');
    expect(samePool.savedBase('late.erb')).toBe(more['late.erb']);
  });

  it('三方合并的语义不因"没有基线"而变味：无基线 ⇒ undefined（调用方据此退回两方），绝不给空串冒充', async () => {
    const h = harness({});
    expect(h.pool.savedBase('never-opened.erb')).toBeUndefined(); // 不是 ''
    const recovery = { 'rec.erb': '恢复件内容' };
    const p2 = createEditorModelPool({
      readText: async (_k, _p) => ({ text: '不该被读到', encoding: 'utf-8', eol: 'LF' }),
      createModel: () => ({ dispose: () => {} }) as never,
    });
    await p2.acquire({} as never, 'rec.erb', { text: recovery['rec.erb'] });
    expect(p2.savedBase('rec.erb')).toBeUndefined(); // 恢复件不是盘上真相（改前口径，不许被预算改动带偏）
    expect(p2.baseline('rec.erb')).toBe(0); // 恢复件钉 0 = 一生出来就是脏
    void h;
  });
});
