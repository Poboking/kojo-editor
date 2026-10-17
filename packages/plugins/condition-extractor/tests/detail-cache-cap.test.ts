/**
 * 按需明细 / 正文缓存的上限收口（2026-10-18 性能批）。
 *
 * 旧形态：`detailCache` 与 `fileTextCache` 只在**全量索引重建**时整体清空 ⇒
 * 任何走完 99,228 个函数的面板都会把「明细 + 整棵正文」各留一份常驻（正文是第三份，
 * 内核 io 会话缓存里已经有一份）。现在照 `kernel/src/io.ts:313-317` 的 FIFO 形状收口。
 *
 * 钉两件：①**上限真在削**（条数与字符数双双越不过去，越界即红）；
 * ②**逐出零改变产出**——明细是按 (索引位, 盘上正文) 的纯函数，重问只是重算，
 * 逐字相同（回放未知率基线不受影响）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ComputePool, ControlFlowStatement, ErbFile, ErbIndex, GameProject, Logger } from '@kojo/plugin-api';
import { ConditionEngine } from '../src/engine';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const project = { rootDir: 'D:/game', adapterId: 'eratw', inputDigest: 'd1' } as unknown as GameProject;

function makeComputeStub(): ComputePool {
  return {
    async runSliced<T, R>(items: readonly T[], _o: unknown, fn: (t: T, i: number) => R | Promise<R>): Promise<R[]> {
      const out: R[] = [];
      for (let i = 0; i < items.length; i++) out.push(await fn(items[i]!, i));
      return out;
    },
    stats: () => ({ tasks: [], yields: 0, interactiveActive: false, offload: { parallel: false, dispatched: 0, fellBack: 0, inline: 0 } }),
  } as unknown as ComputePool;
}

/** 一棵两函数的最小 ERB：`@FN_i` 在第 1 行，体内一条 IF（第 2 行） */
function erbText(i: number): string {
  return [`@FN_${i}()`, 'IF CFLAG:2 >= 500', 'ENDIF', ''].join('\n');
}

function erbFileOf(path: string, name: string): ErbFile {
  return {
    path,
    functions: [
      { name, normalizedName: name, params: [], startLine: 1, endLine: 3, filePath: path, isExpressionFunction: false },
    ],
    dims: [],
    hasFunctionDirective: false,
    lineCount: 4,
  } as ErbFile;
}

/** `byName` 的值是**引用数组**（契约 `ErbIndex.byName: Map<string, ErbFunctionRef[]>`，引擎取首个） */
function byNameOf(files: Map<string, ErbFile>): Map<string, unknown[]> {
  const byName = new Map<string, unknown[]>();
  for (const f of files.values()) {
    for (const fn of f.functions) {
      const list = byName.get(fn.normalizedName) ?? [];
      list.push(fn);
      byName.set(fn.normalizedName, list);
    }
  }
  return byName;
}

interface Harness {
  readonly engine: ConditionEngine;
  readonly reads: () => number;
  readonly scans: () => number;
}

function makeHarness(count: number, caps?: { maxDetails?: number; maxFiles?: number; maxChars?: number }): Harness {
  const files = new Map<string, ErbFile>();
  for (let i = 0; i < count; i++) files.set(`/f/k${i}.ERB`, erbFileOf(`/f/k${i}.ERB`, `FN_${i}`));
  const index = { files, byName: byNameOf(files) } as unknown as ErbIndex;

  let readCount = 0;
  let scanCount = 0;
  const engine = new ConditionEngine({
    log: silentLog,
    getProject: () => project,
    getIndex: () => index,
    readFile: async (path) => {
      readCount++;
      const f = files.get(path);
      if (!f) throw new Error(`not found: ${path}`);
      return erbText(Number(path.replace(/\D+/g, '')));
    },
    scanControlFlow: async (text: string): Promise<ControlFlowStatement[]> => {
      scanCount++;
      const out: ControlFlowStatement[] = [];
      text.split('\n').forEach((line, idx) => {
        const m = /^IF\s+(.*)$/.exec(line);
        if (m) out.push({ kind: 'IF', expression: m[1]!, depth: 0, line: idx + 1 });
        if (/^ENDIF/.test(line)) out.push({ kind: 'ENDIF', expression: '', depth: 0, line: idx + 1 });
      });
      return out;
    },
    getSchemaLookup: () => undefined,
    compute: makeComputeStub(),
    ...(caps ? { detailCacheCaps: caps } : {}),
  });
  return { engine, reads: () => readCount, scans: () => scanCount };
}

describe('明细 / 正文缓存上限', () => {
  it('走完 24 棵函数：两条缓存都越不过上限，且每棵都能拿到明细', async () => {
    const h = makeHarness(24, { maxDetails: 4, maxFiles: 2, maxChars: 400 });
    const got: string[] = [];
    for (let i = 0; i < 24; i++) {
      const d = await h.engine.functionPredicates(`FN_${i}`);
      expect(d).not.toBeNull();
      got.push(d!.normalizedName);
    }
    expect(got).toHaveLength(24);
    const st = h.engine.cacheStats();
    expect(st.details).toBeLessThanOrEqual(st.maxDetails);
    expect(st.details).toBeLessThanOrEqual(4);
    expect(st.textFiles).toBeLessThanOrEqual(st.maxTextFiles);
    expect(st.textFiles).toBeLessThanOrEqual(2);
    expect(st.textChars).toBeLessThanOrEqual(st.maxTextChars);
    expect(st.textChars).toBeLessThanOrEqual(400);
  });

  it('逐出后重问：重读盘 + 重扫，但明细逐字相同（基线不动）', async () => {
    const h = makeHarness(6, { maxDetails: 1 });
    const first = await h.engine.functionPredicates('FN_0');
    expect(first?.predicates).toHaveLength(1);
    const r0 = h.reads();
    for (let i = 1; i < 6; i++) await h.engine.functionPredicates(`FN_${i}`); // 把 FN_0 挤出去
    expect(h.engine.cacheStats().details).toBeLessThanOrEqual(1);
    const again = await h.engine.functionPredicates('FN_0');
    expect(h.reads()).toBeGreaterThan(r0); // 真重读了盘（没把逐出当失败）
    expect(again).toEqual(first); // 产出逐字相同
  });

  it('命中缓存零读盘；resetCache 语义不变：clear() 与索引重建都会清空', async () => {
    const h = makeHarness(3);
    await h.engine.functionPredicates('FN_0');
    const r0 = h.reads();
    await h.engine.functionPredicates('FN_0');
    expect(h.reads()).toBe(r0); // 明细命中 ⇒ 不再读盘
    expect(h.engine.cacheStats().details).toBe(1);

    h.engine.clear();
    expect(h.engine.cacheStats()).toMatchObject({ details: 0, textFiles: 0, textChars: 0 });

    await h.engine.functionPredicates('FN_1');
    expect(h.engine.cacheStats().details).toBe(1);
    await h.engine.ensureIndex(); // 索引重建 ⇒ 两条缓存整体作废
    expect(h.engine.cacheStats()).toMatchObject({ details: 0, textFiles: 0, textChars: 0 });
  });

  it('默认上限是有限数（无上限形态只能显式传 Infinity，供量例 A/B）', () => {
    const h = makeHarness(1);
    const st = h.engine.cacheStats();
    expect(st.maxDetails).toBeGreaterThan(0);
    expect(Number.isFinite(st.maxDetails)).toBe(true);
    expect(Number.isFinite(st.maxTextFiles)).toBe(true);
    expect(Number.isFinite(st.maxTextChars)).toBe(true);
    const open = makeHarness(1, { maxFiles: Infinity, maxChars: Infinity, maxDetails: Infinity });
    expect(Number.isFinite(open.engine.cacheStats().maxTextFiles)).toBe(false);
  });

  it('同一棵文件里多个函数共用正文（命中即零重复读盘）', async () => {
    const files = new Map<string, ErbFile>();
    const path = '/f/multi.ERB';
    files.set(path, {
      path,
      functions: [
        { name: 'FN_A', normalizedName: 'FN_A', params: [], startLine: 1, endLine: 3, filePath: path, isExpressionFunction: false },
        { name: 'FN_B', normalizedName: 'FN_B', params: [], startLine: 5, endLine: 7, filePath: path, isExpressionFunction: false },
      ],
      dims: [],
      hasFunctionDirective: false,
      lineCount: 8,
    } as ErbFile);
    const index = { files, byName: byNameOf(files) } as unknown as ErbIndex;
    const readMock = vi.fn(async () => ['@FN_A()', 'IF CFLAG:2 >= 500', 'ENDIF', '', '@FN_B()', 'IF CFLAG:2 >= 900', 'ENDIF', ''].join('\n'));
    const engine = new ConditionEngine({
      log: silentLog,
      getProject: () => project,
      getIndex: () => index,
      readFile: readMock,
      scanControlFlow: async () => [],
      getSchemaLookup: () => undefined,
      compute: makeComputeStub(),
    });
    await engine.functionPredicates('FN_A');
    await engine.functionPredicates('FN_B');
    expect(readMock).toHaveBeenCalledTimes(1); // 同批两个函数只读一次（改前既有语义，一条没动）
    expect(engine.cacheStats().textFiles).toBe(1);
  });
});
