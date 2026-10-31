/**
 * 「1G 内存下无头浏览器被杀」的判据（2026-10-31 反哺，PITFALLS 293）。
 *
 * 起因：容器只给 1G 时，无头 Edge 跑到一半被杀死，现象像"浏览器 bug"。
 * 查下来是两件事叠在一起：
 * ① 本仓**没有任何**浏览器内存闸（`js-flags` / `renderer-process-limit` / `dev-shm` 零命中），
 *    杀来自容器 cgroup 的 OOM killer，而内核按 RSS 挑最大的杀——常常正是渲染进程；
 * ② 调试宿写死 `--max-old-space-size=4096`：小内存环境里 V8 以为自己有四 GB 就不早 GC，
 *    容器 OOM 先到，进一步把"最大的那个"推给浏览器。②是本仓的配置缺陷，这一组就是它的守卫。
 *
 * 钉四件事：
 * ① **常态逐字不变**：64GB 本机仍算出 4096，不许借"修 bug"把老行为悄悄改掉；
 * ② 小预算真的收：1G ⇒ 地板 512、2G ⇒ 921（0.45 份额）、8G ⇒ 3686；
 * ③ cgroup 读法：v2 `max` / v1 天文数字都当"没设"；子树优先且与根取最小；
 *    只在**低于物理内存**时才认（避免把"等于物理"当成额外预算）；
 * ④ CLI 侧不许再出现写死的 4096 字面量——那正是本坑的入口。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HOST_HEAP_DEFAULT_MB,
  HOST_HEAP_MIN_MB,
  hostHeapMb,
  memoryBudget,
  memorySourceLabel,
  resolveHostHeap,
  resolveMemoryBudget,
} from '../debug-lib.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CLI = readFileSync(path.join(ROOT, 'tools', 'debug-cli.mjs'), 'utf8');

/** 假 readFile：路径 → 内容；不认识的路径抛错（与真 fs 同形，逼调用方 try/catch） */
function fakeFs(map: Record<string, string>) {
  return (p: string) => {
    if (!(p in map)) throw new Error(`ENOENT ${p}`);
    return map[p];
  };
}

describe('调试宿堆上限 · 按内存预算收敛（PITFALLS 293）', () => {
  it('64GB 本机仍夹回 4096——常态行为逐字不变', () => {
    expect(hostHeapMb({ budgetMb: 65536 })).toBe(HOST_HEAP_DEFAULT_MB);
    expect(hostHeapMb({ budgetMb: 4096 })).toBe(1843); // 边界：4G 机器开始收
  });

  it('1G 容器 ⇒ 地板 512；2G ⇒ 921；8G ⇒ 3686（0.45 份额，夹在 [512, 4096]）', () => {
    expect(hostHeapMb({ budgetMb: 1024 })).toBe(HOST_HEAP_MIN_MB);
    expect(hostHeapMb({ budgetMb: 2048 })).toBe(921);
    expect(hostHeapMb({ budgetMb: 8192 })).toBe(3686);
  });

  it('KOJO_DEBUG_HOST_HEAP 覆盖优先；非数 / 过小（<128）不认，回落预算', () => {
    expect(hostHeapMb({ budgetMb: 1024, overrideMb: '3072' })).toBe(3072);
    expect(hostHeapMb({ budgetMb: 1024, overrideMb: 4096 })).toBe(4096);
    expect(hostHeapMb({ budgetMb: 1024, overrideMb: 'abc' })).toBe(HOST_HEAP_MIN_MB);
    expect(hostHeapMb({ budgetMb: 1024, overrideMb: 64 })).toBe(HOST_HEAP_MIN_MB);
  });

  it('预算缺失 / 非法 ⇒ 回落 4096（宁可维持老行为，也不静默收紧）', () => {
    expect(hostHeapMb({})).toBe(HOST_HEAP_DEFAULT_MB);
    expect(hostHeapMb({ budgetMb: 0 })).toBe(HOST_HEAP_DEFAULT_MB);
    expect(hostHeapMb({ budgetMb: Number.NaN })).toBe(HOST_HEAP_DEFAULT_MB);
  });
});

describe('内存预算 · cgroup 读法', () => {
  it('v2 根 memory.max = 1G ⇒ limit 1024、source=cgroup', () => {
    const r = memoryBudget({
      platform: 'linux',
      totalMb: 65536,
      readFile: fakeFs({ '/sys/fs/cgroup/memory.max': `${1024 * 1024 * 1024}\n` }),
    });
    expect(r).toEqual({ totalMb: 65536, limitMb: 1024, budgetMb: 1024, source: 'cgroup' });
  });

  it('v2 写 `max` ⇒ 当"没设"，按物理内存', () => {
    const r = memoryBudget({
      platform: 'linux',
      totalMb: 65536,
      readFile: fakeFs({ '/sys/fs/cgroup/memory.max': 'max' }),
    });
    expect(r.limitMb).toBeNull();
    expect(r.source).toBe('total');
    expect(r.budgetMb).toBe(65536);
  });

  it('v1 的"无限制"天文数字同样当"没设"（不能拿 9.2e18 去算堆）', () => {
    const r = memoryBudget({
      platform: 'linux',
      totalMb: 65536,
      readFile: fakeFs({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }),
    });
    expect(r.limitMb).toBeNull();
    expect(r.budgetMb).toBe(65536);
  });

  it('子树优先且与根取最小（容器里收紧通常落在子树上）', () => {
    const r = memoryBudget({
      platform: 'linux',
      totalMb: 65536,
      readFile: fakeFs({
        '/proc/self/cgroup': '0::/docker/abc\n',
        '/sys/fs/cgroup/docker/abc/memory.max': String(1536 * 1024 * 1024),
        '/sys/fs/cgroup/memory.max': String(4096 * 1024 * 1024),
      }),
    });
    expect(r.limitMb).toBe(1536);
  });

  it('cgroup 值 ≥ 物理内存 ⇒ 不认（"等于物理"不是额外预算）', () => {
    const r = memoryBudget({
      platform: 'linux',
      totalMb: 1024,
      readFile: fakeFs({ '/sys/fs/cgroup/memory.max': String(1024 * 1024 * 1024) }),
    });
    expect(r.limitMb).toBeNull();
    expect(r.budgetMb).toBe(1024);
  });

  it('非 Linux（Windows Job Object 读不到）⇒ 只按物理内存，绝不瞎猜', () => {
    const r = memoryBudget({ platform: 'win32', totalMb: 65536, readFile: fakeFs({}) });
    expect(r).toMatchObject({ limitMb: null, budgetMb: 65536, source: 'total' });
  });
});

describe('内存预算 · 显式声明（Windows 容器读不到 Job Object 时）', () => {
  const base = { totalMb: 65536, limitMb: null, budgetMb: 65536, source: 'total' };

  it('KOJO_MEM_BUDGET_MB 比探测值小 ⇒ 采信，source=env', () => {
    expect(resolveMemoryBudget({ KOJO_MEM_BUDGET_MB: '1024' }, base)).toMatchObject({
      budgetMb: 1024,
      limitMb: 1024,
      source: 'env',
    });
  });

  it('声明值 ≥ 探测值 / 非数 / 过小（<256）⇒ 不采信（不把大机器改小，也不按笔误收堆）', () => {
    expect(resolveMemoryBudget({ KOJO_MEM_BUDGET_MB: '131072' }, base).source).toBe('total');
    expect(resolveMemoryBudget({ KOJO_MEM_BUDGET_MB: 'abc' }, base).source).toBe('total');
    expect(resolveMemoryBudget({ KOJO_MEM_BUDGET_MB: '64' }, base).source).toBe('total');
  });

  it('来源标签三态（CLI 与冒烟共用同一份措辞，不许各写一套）', () => {
    expect(memorySourceLabel('cgroup')).toBe('cgroup 上限');
    expect(memorySourceLabel('env')).toBe('KOJO_MEM_BUDGET_MB');
    expect(memorySourceLabel('total')).toBe('物理内存');
  });

  it('声明 1G ⇒ 端到端算出 512 的堆（不论本机物理内存多少）', () => {
    expect(resolveHostHeap({ KOJO_MEM_BUDGET_MB: '1024' }).heapMb).toBe(HOST_HEAP_MIN_MB);
  });
});

describe('接线 · CLI 不许再写死 4096', () => {
  it('启动参数改成 `${heap.heapMb}`，且经 resolveHostHeap 计算', () => {
    expect(CLI).not.toContain("'--max-old-space-size=4096'");
    expect(CLI).toContain('resolveHostHeap');
    expect(CLI).toContain('--max-old-space-size=${heap.heapMb}');
  });

  it('只有预算偏离缺省时才打印（常态输出不许被这行污染）', () => {
    expect(CLI).toContain('if (heap.heapMb !== HOST_HEAP_DEFAULT_MB)');
  });
});
