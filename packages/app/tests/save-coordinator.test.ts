/**
 * A10 保存协调的判据（纯函数半边）：per-path 互斥、并发池上限、一条合成回执。
 *
 * 为什么测在协调器这一层：`EditorPane` 挂着 Monaco 与整套内核槽位，node 里渲染
 * 不出来（同 `readonly-pill.test.ts` 的取证）。所以写盘协议用**假 bridge** 在协调器
 * 上打穿（连点只写一次 / 两文件并发各自成功 / 池上限生效），EditorPane 的接线
 * 正确性由文件末尾的结构守卫钉住——少一根线下一批就会漂回全局锁。
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SAVE_MAX_CONCURRENCY,
  buildSaveReceipt,
  createPathMutex,
  mapWithConcurrency,
  runSaveBatch,
  withPathLock,
  type SaveFileOutcome,
} from '../src/ui/save-coordinator';

/* --------------------------- per-path 互斥 --------------------------- */

describe('createPathMutex · 锁按路径分把', () => {
  it('同一路径：第二次 tryAcquire 拒绝；release 后重新可取', () => {
    const lock = createPathMutex();
    expect(lock.tryAcquire('a.erb')).toBe(true);
    expect(lock.isBusy('a.erb')).toBe(true);
    expect(lock.tryAcquire('a.erb')).toBe(false);
    expect(lock.release('a.erb')).toBe(true);
    expect(lock.isBusy('a.erb')).toBe(false);
    expect(lock.tryAcquire('a.erb')).toBe(true);
  });

  it('不同路径互不相干：A 在途不挡 B（全局一把锁退役的根据）', () => {
    const lock = createPathMutex();
    expect(lock.tryAcquire('a.erb')).toBe(true);
    expect(lock.tryAcquire('b.erb')).toBe(true);
    expect(lock.isBusy('c.erb')).toBe(false);
  });

  it('release 未持有的路径 = false（幂等防泄漏逻辑被误用出声）', () => {
    const lock = createPathMutex();
    expect(lock.release('nope.erb')).toBe(false);
  });
});

describe('withPathLock · 拿不到走 onBusy，抛错必还锁', () => {
  it('同文件连点只执行一次：第二次拿不到锁 → onBusy，第一次完成后锁已还', async () => {
    const lock = createPathMutex();
    let writes = 0;
    let gate: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      gate = resolve;
    });
    const first = withPathLock(lock, 'a.erb', async () => {
      writes++;
      await blocked;
      return 'saved' as const;
    }, () => 'busy' as const);
    const second = await withPathLock(lock, 'a.erb', async () => {
      writes++;
      return 'saved' as const;
    }, () => 'busy' as const);
    expect(second).toBe('busy');
    gate();
    expect(await first).toBe('saved');
    expect(writes).toBe(1);
    // 在途已结束：第三次能正常拿锁
    const third = await withPathLock(lock, 'a.erb', async () => {
      writes++;
      return 'saved' as const;
    }, () => 'busy' as const);
    expect(third).toBe('saved');
    expect(writes).toBe(2);
  });

  it('task 抛错也必须释放锁——泄漏一把 per-path 锁 = 该文件永远存不了', async () => {
    const lock = createPathMutex();
    await expect(
      withPathLock(lock, 'a.erb', async () => {
        throw new Error('写盘炸了');
      }, () => 'busy'),
    ).rejects.toThrow('写盘炸了');
    expect(lock.isBusy('a.erb')).toBe(false);
  });
});

/* ----------------------------- 并发池 ----------------------------- */

describe('mapWithConcurrency · 定长泳道', () => {
  it('结果按输入序返回，与完成顺序无关', async () => {
    const out = await mapWithConcurrency([30, 5, 15], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 5, 15]);
  });

  it('在途并发不超上限，且每个条目都跑到', async () => {
    let live = 0;
    let peak = 0;
    const items = Array.from({ length: 9 }, (_, i) => i);
    const out = await mapWithConcurrency(items, SAVE_MAX_CONCURRENCY, async (i) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
      return i * 2;
    });
    expect(out).toEqual(items.map((i) => i * 2));
    expect(peak).toBeLessThanOrEqual(SAVE_MAX_CONCURRENCY);
    expect(peak).toBeGreaterThan(1); // 上限内确实并发了，不是假串行
  });

  it('空输入与 limit>数量都收口', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 4, async (x) => x + 1)).toEqual([2, 3]);
  });
});

/* ------------------- 假 bridge：全保存端到端语义 ------------------- */

/** 假写盘桥：记录逐路径写次数与并发形态（EditorPane 的 kernel.io.writeText 替身） */
function fakeBridge() {
  const writes = new Map<string, number>();
  let live = 0;
  let peak = 0;
  const fail = new Set<string>();
  const saveLock = createPathMutex();
  const saveOne = (p: string): Promise<SaveFileOutcome> =>
    withPathLock<SaveFileOutcome>(
      saveLock,
      p,
      async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 1)); // 写盘窗口（IPC 往返的形状）
        live--;
        if (fail.has(p)) return { path: p, status: 'failed', message: '磁盘拒绝写入' };
        writes.set(p, (writes.get(p) ?? 0) + 1);
        return { path: p, status: 'saved' };
      },
      () => ({ path: p, status: 'skipped-busy' as const }),
    );
  return {
    saveOne,
    writes,
    fail,
    peakOf: () => peak,
  };
}

describe('runSaveBatch · 假 bridge 上的全保存语义', () => {
  it('两个不同文件并发：各自成功、各写一次（全局一把锁时第二个会被整批挡掉）', async () => {
    const bridge = fakeBridge();
    const results = await Promise.all([bridge.saveOne('a.erb'), bridge.saveOne('b.erb')]);
    expect(results.map((r) => r.status)).toEqual(['saved', 'saved']);
    expect(bridge.writes.get('a.erb')).toBe(1);
    expect(bridge.writes.get('b.erb')).toBe(1);
  });

  it('同文件并发（连点/跨组分屏）：只写一次，第二个 skipped-busy', async () => {
    const bridge = fakeBridge();
    const results = await Promise.all([bridge.saveOne('a.erb'), bridge.saveOne('a.erb')]);
    expect(results.map((r) => r.status)).toEqual(['saved', 'skipped-busy']);
    expect(bridge.writes.get('a.erb')).toBe(1);
  });

  it('9 个脏文件全保存：池上限生效（峰值 ≤ 4）、逐文件都落盘、全成功零回执', async () => {
    const bridge = fakeBridge();
    const targets = Array.from({ length: 9 }, (_, i) => `f${i}.erb`);
    const { ok, receipt } = await runSaveBatch(targets, bridge.saveOne);
    expect(ok).toBe(true);
    expect(receipt).toBeNull();
    expect(bridge.peakOf()).toBeLessThanOrEqual(SAVE_MAX_CONCURRENCY);
    for (const t of targets) expect(bridge.writes.get(t)).toBe(1);
  });

  it('混合结局：ok=false、一条回执里跳过可见、失败合并带原因', async () => {
    const bridge = fakeBridge();
    bridge.fail.add('bad.erb');
    const { ok, receipt } = await runSaveBatch(['good.erb', 'warn.erb', 'bad.erb'], async (p) => {
      if (p === 'warn.erb') return { path: p, status: 'skipped-choice' as const };
      return bridge.saveOne(p);
    });
    expect(ok).toBe(false);
    expect(receipt?.kind).toBe('error');
    expect(receipt?.message).toContain('已保存 1/3');
    expect(receipt?.message).toContain('失败 1：「bad.erb」（磁盘拒绝写入）');
    expect(receipt?.message).toContain('跳过 1：保存告警待处理');
    expect(receipt?.needsReauth).toBe(false);
    expect(bridge.writes.get('good.erb')).toBe(1);
    expect(bridge.writes.get('bad.erb')).toBeUndefined();
  });

  it('needs-choice 跳过必须可见（不静默吞）：回执含跳过段且 kind=info', async () => {
    const outcomes: SaveFileOutcome[] = [
      { path: 'a.erb', status: 'saved' },
      { path: 'b.erb', status: 'skipped-choice' },
      { path: 'c.erb', status: 'skipped-busy' },
    ];
    const receipt = buildSaveReceipt(outcomes)!;
    expect(receipt.kind).toBe('info');
    expect(receipt.message).toContain('跳过 1：保存告警待处理');
    expect(receipt.message).toContain('跳过 1：已有在途保存');
  });

  it('写允许域拒绝：needsReauth 汇聚到回执（授权入口挂在这条唯一通知上）', async () => {
    const receipt = buildSaveReceipt([
      { path: 'a.erb', status: 'failed', message: '项目当前为只读', needsReauth: true },
      { path: 'b.erb', status: 'saved' },
    ])!;
    expect(receipt.kind).toBe('error');
    expect(receipt.needsReauth).toBe(true);
  });
});

describe('buildSaveReceipt · 一条不轰炸', () => {
  it('全部 saved → null（成功不吭声，旧语义不变）', () => {
    expect(buildSaveReceipt([{ path: 'a.erb', status: 'saved' }])).toBeNull();
    expect(buildSaveReceipt([])).toBeNull();
  });

  it('失败明细最多列 3 个，再多只报个数', () => {
    const outcomes: SaveFileOutcome[] = [1, 2, 3, 4, 5].map((i) => ({
      path: `f${i}.erb`,
      status: 'failed' as const,
      message: '原因',
    }));
    const receipt = buildSaveReceipt(outcomes)!;
    expect(receipt.message).toContain('失败 5');
    expect(receipt.message).toContain('「f1.erb」');
    expect(receipt.message).toContain('「f3.erb」');
    expect(receipt.message).not.toContain('「f5.erb」');
    expect(receipt.message).toContain('等5个');
  });

  it('kept-dirty（写盘窗口内有新输入）单独成段，不混进失败', () => {
    const receipt = buildSaveReceipt([
      { path: 'a.erb', status: 'saved' },
      { path: 'b.erb', status: 'kept-dirty' },
    ])!;
    expect(receipt.kind).toBe('info');
    expect(receipt.message).toContain('保持未保存 1：写盘期间又有新输入');
    expect(receipt.message).not.toContain('失败');
  });
});

/* ---------------------- EditorPane 接线的结构守卫 ---------------------- */

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const editorPane = readFileSync(path.join(SRC, 'ui/EditorPane.tsx'), 'utf8');

describe('EditorPane 接线守卫 · A10 不许漂回全局锁', () => {
  it('全局互斥 savingRef 已退役，源码零残留', () => {
    expect(editorPane).not.toMatch(/\bsavingRef\b/);
  });

  it('per-path 锁在模块级共享（分屏跨实例同锁），写路径经 withPathLock', () => {
    expect(editorPane).toMatch(/^const sharedSaveLock = createPathMutex\(\);$/m);
    expect(editorPane).toContain('withPathLock(');
  });

  it('saveAll 走并发池 + 回执通知；逐条后台通知受 quiet 闸', () => {
    expect(editorPane).toContain('runSaveBatch(targets');
    expect(editorPane).toContain('savePathDetailed(p, undefined, true)');
    expect(editorPane).toMatch(/if \(receipt\)/);
  });
});
