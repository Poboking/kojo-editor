/**
 * fileTree.applyChangeset 量化判据（MCP-PERF-S3，2026-11-06）——墙钟计时用例，
 * 按仓库机制（tools/perf-suite.mjs 源码级谓词）自动进串行静默池。
 *
 * 判据硬线：20 文件批次端到端 <300ms（改前形态 = 20 趟单写 + 20 次事件/失效）。
 * 真实 Node fs 桥：exists / backup(copyFile) / writeText(writeFile) 全走磁盘，
 * 编排链路（分发 + 批次级闸 + 逐条写 + manifest + 批量 stat）一字不假。
 *
 * 计时纪律（ps12 / tree-sitter 同款）：计时那一击之前先落一击预热——首击付模块 JIT 冷启动
 * （实测 ~30ms），不是批次编排的成本形态，混进读数只会放大满载抖动。
 *
 * 为什么是「预算 + 结构账」而不是「批量墙钟 < 20 趟单写墙钟」的不等式：
 * 批量的本地账**诚实地**比 20 趟单写多付一趟批量 stat 读回（20 × statSync，Windows 上
 * 实测 ~40ms）——这是 applied 回执里 bytes 的成本，不是浪费；它省下的 19 次 MCP 往返
 * （HTTP + JSON + 会话闸 × 19）在本进程直调 harness 里**物理不存在**，谁也替不了谁付。
 * 两边各付各的账之后拿墙钟比大小，只会把「回执功能」误判成「批量更慢」。所以这里钉的是
 * ①批量自身的 300ms 预算硬线（判据原文）②落盘动作账逐字同尺（20 备份 + 20 写，谁也不偷）
 * ③结构性收益：1 次工具调用完成 20 文件（改前形态需要 20 次 MCP 往返）。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpSessionScope } from '@kojo/mcp-host';
import { createRunSupplemental, type McpInvokeLike, type McpIoDeps, type McpKernelLike } from '../src/mcp/real-sources-io';

const scopeReal: McpSessionScope = {
  sessionId: 'cs-perf',
  clientId: 'cs-perf-c',
  tier: 'edit',
  approvedRoots: ['docs'],
  approvedTools: [],
};

/** 计数器（引用类型：闭包自增必须能被测试读到，number 按值快照读到的永远是初值 0）。 */
interface Counters {
  readonly events: string[];
  backups: number;
  writes: number;
  statInvokes: number;
}

/** 真实 fs 桥：备份 = copyFile 落独立桶（同一备份机制的成本形态），写 = writeFile。
 * `backupInWrite` 模拟内核 writeText 的「写前自动备份」内部形态（fileTree.update 走的就是
 * 这条——备份藏在 writeText 里）；批量腿显式调 io.backup 后 writeText{backup:false}，
 * 两种形态落盘动作账同尺（20 备份 + 20 写），差的只是备份的**记账位置**。 */
function realFsKernel(rootDir: string, backupInWrite: boolean): { kernel: McpKernelLike; counters: Counters } {
  const counters: Counters = { events: [], backups: 0, writes: 0, statInvokes: 0 };
  const doBackup = (p: string): string => {
    const bucket = join(rootDir, '.cs-backup-bucket');
    mkdirSync(bucket, { recursive: true });
    const target = join(bucket, `${p.replace(/[^a-zA-Z0-9]/g, '_')}.bak`);
    copyFileSync(p, target);
    counters.backups += 1;
    return target;
  };
  const kernel: McpKernelLike = {
    project: { current: () => ({ rootDir, adapterId: 'adapter-a', kojoPaths: [], charaIndex: new Map() }) },
    io: {
      walkDir: async () => [],
      exists: async (p) => existsSync(p),
      backup: async (p) => (existsSync(p) ? doBackup(p) : null),
      writeText: async (p, text) => {
        if (backupInWrite) doBackup(p); // 内核 writeText 的写前自动备份（update 形态）
        writeFileSync(p, text, 'utf-8');
        counters.writes += 1;
      },
    },
    plugins: { list: () => [] },
    services: { tryGet: () => undefined },
    bus: {
      on: () => () => {},
      emit: (name) => {
        counters.events.push(name);
      },
    },
    slots: { query: () => [] },
  };
  return { kernel, counters };
}

function realStatInvoke(counters: Counters): McpInvokeLike {
  return (async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'stat_files' && args && Array.isArray(args['paths'])) {
      counters.statInvokes += 1;
      return (args['paths'] as string[]).map((p) => {
        if (!existsSync(p)) return { path: p, exists: false, size: null, mtimeMs: null };
        const st = statSync(p);
        return { path: p, exists: true, size: st.size, mtimeMs: st.mtimeMs };
      });
    }
    return null;
  }) as McpInvokeLike;
}

function fakeIoDeps(kernel: McpKernelLike, counters: Counters): McpIoDeps {
  return {
    getKernel: () => kernel,
    getCommands: () => [],
    invoke: realStatInvoke(counters),
  } as unknown as McpIoDeps;
}

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

function seedDocs(dir: string): string {
  const docs = join(dir, 'docs');
  mkdirSync(docs, { recursive: true });
  for (let i = 0; i < 20; i += 1) writeFileSync(join(docs, `f${i}.txt`), `seed-${i}\n`, 'utf-8');
  return docs;
}

describe('fileTree.applyChangeset 量化判据（真实 fs，20 文件批次）', () => {
  it('20 文件批次端到端 <300ms（含真实备份 copy + 落盘 + 批量 stat + 20 条事件），预热击不进读数', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kojo-cs-perf-'));
    cleanups.push(dir);
    const docs = seedDocs(dir);
    const { kernel, counters } = realFsKernel(dir, false);
    const s = createRunSupplemental(fakeIoDeps(kernel, counters));
    const changes = Array.from({ length: 20 }, (_, i) => ({ path: `docs/f${i}.txt`, content: `body-${i}\n`.repeat(10) }));

    await s('fileTree.applyChangeset', { changes: [changes[0]!] }, scopeReal); // 预热击（付 JIT 冷启动，不进读数）
    counters.events.length = 0; // 预热的事件不计入计时击的账

    const t0 = performance.now();
    const out = (await s('fileTree.applyChangeset', { changes }, scopeReal)) as Record<string, unknown>;
    const elapsed = performance.now() - t0;

    expect(out['totals']).toEqual({ total: 20, applied: 20, refused: 0, backups: 20 });
    expect(counters.events).toHaveLength(20);
    for (let i = 0; i < 20; i += 1) {
      expect(existsSync(join(docs, `f${i}.txt`))).toBe(true);
    }
    expect(existsSync(join(dir, '.cs-backup-bucket'))).toBe(true);
    console.log(`20 文件批次端到端: ${elapsed.toFixed(1)}ms（判据硬线 300ms；含真实备份 copy × 20 + 落盘 × 20 + 批量 stat × 1 + 事件 × 20）`);
    expect(elapsed, `20 文件批次端到端耗时 ${elapsed.toFixed(1)}ms，判据硬线 300ms`).toBeLessThan(300);
  }, 30_000);

  it('对比账（同尺 fs + 结构账）：1 趟批量 = 20 备份 + 20 写 + 1 趟批量 stat + 20 事件，1 次工具调用完成 20 文件（改前形态 20 次往返）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kojo-cs-perf2-'));
    cleanups.push(dir);
    seedDocs(dir);
    const contents = Array.from({ length: 20 }, (_, i) => `body-${i}\n`.repeat(10));
    const changes = contents.map((c, i) => ({ path: `docs/f${i}.txt`, content: c }));

    // 批量形态：1 次调用。显式 io.backup × 20 + writeText{backup:false} × 20 + 1 趟 stat_files。
    const batch = realFsKernel(dir, false);
    const runBatch = createRunSupplemental(fakeIoDeps(batch.kernel, batch.counters));
    let batchInvocations = 0;
    const out = (await runBatch('fileTree.applyChangeset', { changes }, scopeReal)) as Record<string, unknown>;
    batchInvocations += 1;
    expect(out['totals']).toMatchObject({ applied: 20, backups: 20 });
    expect(batch.counters.backups).toBe(20);
    expect(batch.counters.writes).toBe(20);
    expect(batch.counters.events).toHaveLength(20);
    expect(batch.counters.statInvokes).toBe(1); // 回执 bytes = 1 趟批量 stat（不逐文件付 stat）
    expect(batchInvocations).toBe(1); // 结构收益：20 文件 = 1 次工具调用（改前形态要 20 次 MCP 往返）
    const applied = out['applied'] as Record<string, unknown>[];
    expect(applied.every((a) => typeof a['bytes'] === 'number' && (a['bytes'] as number) > 0)).toBe(true);

    // 改前形态：20 趟单写腿。备份藏在内核 writeText 内部（update 语义原样），
    // 落盘动作账逐字同尺（20 备份 + 20 写），但付 20 次工具调用 + 0 stat（单写无回执）。
    const singles = realFsKernel(dir, true);
    const runSingle = createRunSupplemental(fakeIoDeps(singles.kernel, singles.counters));
    let singleInvocations = 0;
    for (let i = 0; i < 20; i += 1) {
      await runSingle('fileTree.update', { relPath: `docs/f${i}.txt`, content: contents[i]! }, scopeReal);
      singleInvocations += 1;
    }
    expect(singles.counters.backups).toBe(20);
    expect(singles.counters.writes).toBe(20);
    expect(singles.counters.events).toHaveLength(20);
    expect(singles.counters.statInvokes).toBe(0);
    expect(singleInvocations).toBe(20); // 改前形态：20 文件 = 20 次 MCP 往返
  }, 30_000);
});
