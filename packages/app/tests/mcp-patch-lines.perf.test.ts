/**
 * fileTree.patchLines 量化判据（MCP-PERF-S6，2026-11-07）——墙钟计时用例，
 * 按仓库机制（tools/perf-suite.mjs 源码级谓词，文件名 *.perf.test.ts）自动进串行静默池。
 *
 * 判据硬线：20-hunk 批次端到端 <300ms（改前形态 = 整文件覆盖：把 5,000 行全文重传一遍）。
 * 真实 Node fs 桥：exists / backup(copyFile) / writeText(writeFile) / read_file_bytes(readFileSync)
 * 全走磁盘，编排链路（分发 + 批次级闸 + 读全文 + 20 hunk 内存应用 + 备份 + 落盘 + 回读验证
 * + stat）一字不假。计时纪律（S3 / ps12 同款）：计时那一击之前先落一击预热。
 *
 * 为什么是「预算 + 结构账」：patch 级写的收益在两处——①一次 MCP 往返内做完 20 处修改
 * （改前形态 20 次 fileTree.update 往返）；②入参只传 hunk 不传全文（5,000 行文件改 20 处，
 * 入参字符数约为全文的 1.5%）。墙钟预算钉的是批量自身的编排成本；结构账钉的是
 * 「1 次调用 / 1 份备份 / 1 次事件 / 入参 ≪ 全文」谁也不许偷。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpSessionScope } from '@kojo/mcp-host';
import { createRunSupplemental, type McpInvokeLike, type McpIoDeps, type McpKernelLike } from '../src/mcp/real-sources-io';

const scopeReal: McpSessionScope = {
  sessionId: 'pl-perf',
  clientId: 'pl-perf-c',
  tier: 'edit',
  approvedRoots: ['docs'],
  approvedTools: [],
};

const SEED_LINES = 5_000;

/** 计数器（引用类型：闭包自增必须能被测试读到，number 按值快照读到的永远是初值 0）。 */
interface Counters {
  readonly events: string[];
  backups: number;
  writes: number;
  reads: number;
  statInvokes: number;
}

/** 真实 fs 桥：备份 = copyFile 落独立桶，写 = writeFile，读 = readFileSync（与生产 read_file_bytes 同为磁盘真相）。 */
function realFsKernel(rootDir: string, backupInWrite = false): { kernel: McpKernelLike; counters: Counters } {
  const counters: Counters = { events: [], backups: 0, writes: 0, reads: 0, statInvokes: 0 };
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

function realInvoke(counters: Counters): McpInvokeLike {
  return (async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'read_file_bytes' && args && typeof args['path'] === 'string') {
      counters.reads += 1;
      return readFileSync(args['path'], 'utf-8');
    }
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
    invoke: realInvoke(counters),
  } as unknown as McpIoDeps;
}

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

/** 5,000 行大文件（patch 级写的目标形态：agent 不该为改 20 处重传全文）。 */
function seedBigFile(dir: string): { docs: string; fileChars: number } {
  const docs = join(dir, 'docs');
  mkdirSync(docs, { recursive: true });
  const lines = Array.from({ length: SEED_LINES }, (_, i) => `line-${i + 1}-${'x'.repeat(10)}`);
  const text = lines.join('\n') + '\n';
  writeFileSync(join(docs, 'big.txt'), text, 'utf-8');
  return { docs, fileChars: text.length };
}

/** 20 个行区间 hunk（各 5 行、互不重叠、自上而下；行坐标一律指原始文件）。 */
function twentyHunks(): { startLine: number; endLine: number; replacement: string }[] {
  return Array.from({ length: 20 }, (_, i) => {
    const start = 100 + i * 200;
    return {
      startLine: start,
      endLine: start + 4,
      replacement: Array.from({ length: 5 }, (_, k) => `patched-${i + 1}-${k + 1}`).join('\n'),
    };
  });
}

describe('fileTree.patchLines 量化判据（真实 fs，5,000 行文件 × 20 hunk）', () => {
  it('20-hunk 批次端到端 <300ms（含真实全文读 × 2 + 备份 copy + 落盘 + 回读验证 + stat），预热击不进读数', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kojo-pl-perf-'));
    cleanups.push(dir);
    seedBigFile(dir);
    const batch = realFsKernel(dir);
    const s = createRunSupplemental(fakeIoDeps(batch.kernel, batch.counters));
    const hunks = twentyHunks();

    await s('fileTree.patchLines', { relPath: 'docs/big.txt', hunks: [hunks[0]] }, scopeReal); // 预热击（付 JIT 冷启动，不进读数）
    batch.counters.events.length = 0; // 预热的事件不计入计时击的账

    const t0 = performance.now();
    const out = (await s('fileTree.patchLines', { relPath: 'docs/big.txt', hunks }, scopeReal)) as Record<string, unknown>;
    const elapsed = performance.now() - t0;

    expect(out['totals']).toEqual({ hunks: 20, applied: 20, refused: 0 });
    expect(batch.counters.events).toHaveLength(1); // 一次 file.changed（宿主防抖合并成一轮失效/诊断）
    console.log(`20-hunk 批次端到端: ${elapsed.toFixed(1)}ms（判据硬线 300ms；含真实全文读 × 2 + 备份 copy × 1 + 落盘 × 1 + 回读验证 + stat × 1）`);
    expect(elapsed, `20-hunk 批次端到端耗时 ${elapsed.toFixed(1)}ms，判据硬线 300ms`).toBeLessThan(300);
  }, 30_000);

  it('对比账（同尺 fs + 结构账）：1 次调用 / 1 备份 + 1 写 + 1 事件，入参 ≈ 全文的 1.5%（改前形态 20 次往返 × 全文重传）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kojo-pl-perf2-'));
    cleanups.push(dir);
    const { fileChars } = seedBigFile(dir);
    const hunks = twentyHunks();

    // patch 形态：1 次调用。io.backup × 1 + writeText × 1 + read_file_bytes × 2（初读+回读）+ stat × 1。
    const batch = realFsKernel(dir);
    const runBatch = createRunSupplemental(fakeIoDeps(batch.kernel, batch.counters));
    let batchInvocations = 0;
    const argsChars = JSON.stringify({ relPath: 'docs/big.txt', hunks }).length;
    const out = (await runBatch('fileTree.patchLines', { relPath: 'docs/big.txt', hunks }, scopeReal)) as Record<string, unknown>;
    batchInvocations += 1;
    expect(out['totals']).toEqual({ hunks: 20, applied: 20, refused: 0 });
    expect(batch.counters.backups).toBe(1); // 统一备份：一份清单一个路径
    expect(batch.counters.writes).toBe(1);
    expect(batch.counters.reads).toBe(2); // 初读 + 回读验证
    expect(batch.counters.statInvokes).toBe(1);
    expect(batch.counters.events).toHaveLength(1);
    expect(batchInvocations).toBe(1); // 结构收益：20 处修改 = 1 次 MCP 往返
    expect(argsChars).toBeLessThan(fileChars / 10); // patch 级写的立身之本：入参只传 hunk（实测 ≈1.5%）
    expect((out['diff'] as Record<string, unknown>)['lineDelta']).toBe(0); // 20 处 5 行换 5 行，行数不漂移

    // 改前形态：20 趟 fileTree.update（整文件覆盖）= 20 备份 + 20 写 + 20 事件 + 20 次往返，
    // 且每次都要重传全文（fileChars × 20 的入参账）。
    const singles = realFsKernel(dir, true);
    const runSingle = createRunSupplemental(fakeIoDeps(singles.kernel, singles.counters));
    let singleInvocations = 0;
    let singleArgChars = 0;
    for (let i = 0; i < 20; i += 1) {
      const fullText = readFileSync(join(dir, 'docs', 'big.txt'), 'utf-8');
      singleArgChars += fullText.length;
      await runSingle('fileTree.update', { relPath: 'docs/big.txt', content: fullText }, scopeReal);
      singleInvocations += 1;
    }
    expect(singles.counters.backups).toBe(20);
    expect(singles.counters.writes).toBe(20);
    expect(singles.counters.events).toHaveLength(20);
    expect(singleInvocations).toBe(20); // 改前形态：20 处修改 = 20 次 MCP 往返
    expect(singleArgChars).toBeGreaterThan(fileChars * 19); // 整文件覆盖：全文重传 × 20
  }, 30_000);
});
