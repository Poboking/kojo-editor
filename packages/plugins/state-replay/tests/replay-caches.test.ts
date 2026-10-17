/**
 * 回放面的两处缓存收口（2026-10-18 性能批）。
 *
 * ① `createView` 的**视图记忆**：判据＝解析产物对象身份（sav-parser 那侧把同
 *    (路径, mtime, size) 钉成同一个对象后，击键路径上视图不再重建）。
 * ② 函数体**行文本缓存的上限**：旧形态无上限、只随项目生命周期整体清空 ⇒
 *    走完 99,228 个函数的面板会把整树正文再抄一份常驻。现在照 `kernel/src/io.ts`
 *    的 FIFO 形状收口，并且**逐出永不改变回放结果**（本批硬门槛：未知率基线不许动）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { FunctionPredicates, Logger, SnapshotArchive } from '@kojo/plugin-api';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { StateReplayEngine } from '../src/engine';

function silentLog(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/** 一个角色 NO=49 的合成档（与 plugin.test 同形态） */
function archive(no = 49, name = '古明地 觉'): SnapshotArchive {
  return {
    path: 'D:/fake/save.sav',
    fileName: 'save.sav',
    size: 0,
    format: 'gzip',
    version: 1808,
    fileType: 'normal',
    uniqueCode: '7153',
    gameVersion: '0',
    saveMes: '',
    charCount: 1,
    decompressedSize: 0,
    bodySize: 0,
    consumed: 0,
    remaining: 0,
    chars: [
      {
        index: 0,
        dimSepIndex: null,
        vars: [
          { type: 'int', key: 'NO', value: no, offset: 0 },
          { type: 'str', key: 'NAME', value: name, offset: 0 },
          {
            type: 'int-array-1d',
            key: 'CFLAG',
            saveLen: [100],
            cursor: [100],
            nonEmpty: 1,
            cells: [{ index: [2], value: 800 }],
            offset: 0,
          },
        ],
      },
    ],
    vars: [],
  };
}

function detail(name: string, filePath: string, exprs: string[]): FunctionPredicates {
  return {
    normalizedName: name,
    filePath,
    startLine: 1,
    endLine: 20,
    statements: [],
    assignments: [],
    predicates: exprs.map((e, i) => ({
      kind: 'IF' as const,
      text: e,
      expr: parseExpression(e),
      line: i + 2,
      depth: 0,
    })),
    returns: [],
  };
}

const F1 = 'D:/fake/kojo/a.erb';
const F2 = 'D:/fake/kojo/b.erb';

interface HarnessOptions {
  files?: Record<string, string>;
  /** 函数名 → (所在文件, 谓词表达式)；缺省 FN_A / FN_B 两枚 */
  details?: Record<string, { path: string; exprs: string[] }>;
  lineCacheCaps?: { maxFiles?: number; maxChars?: number };
  viewCacheMax?: number;
}

interface Harness {
  readonly engine: StateReplayEngine;
  readonly reads: () => number;
  readonly setArchive: (path: string, a: SnapshotArchive) => void;
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const texts = opts.files ?? { [F1]: '#FUNCTION\nLOCAL = 1\n#ENDFUNCTION\n', [F2]: '; 空文件\n' };
  const details =
    opts.details ?? { FN_A: { path: F1, exprs: ['CFLAG:2 >= 500'] }, FN_B: { path: F2, exprs: ['CFLAG:2 >= 900'] } };
  const archives = new Map<string, SnapshotArchive>();
  let readCount = 0;
  const parseArchive = vi.fn(async (path: string): Promise<SnapshotArchive> => {
    const a = archives.get(path);
    if (!a) throw new Error(`not found: ${path}`);
    return a; // **同一个对象身份**——sav-parser 记忆生效后的真实形态
  });
  const engine = new StateReplayEngine({
    log: silentLog(),
    parseArchive,
    functionPredicates: async (name) => {
      const d = details[name];
      return d ? detail(name, d.path, d.exprs) : null;
    },
    getSchemaLookup: () => undefined,
    readFileText: async (path) => {
      readCount++;
      const t = texts[path];
      if (t === undefined) throw new Error(`not found: ${path}`);
      return t;
    },
    ...(opts.lineCacheCaps ? { lineCacheCaps: opts.lineCacheCaps } : {}),
    ...(opts.viewCacheMax === undefined ? {} : { viewCacheMax: opts.viewCacheMax }),
  });
  return { engine, reads: () => readCount, setArchive: (p, a) => archives.set(p, a) };
}

const SAV = '/s/save01.sav';

describe('createView 的视图记忆', () => {
  it('同一份解析产物 + 同一角色 ⇒ 第二次拿到同一个视图对象', async () => {
    const h = makeHarness();
    h.setArchive(SAV, archive());
    const v1 = await h.engine.createView(SAV, 49);
    const v2 = await h.engine.createView(SAV, 49);
    expect(v2).toBe(v1);
    expect(h.engine.cacheStats().views).toBe(1);
    expect(v1.characterName).toBe('古明地 觉');
  });

  it('解析产物换人（档被重解析过）⇒ 视图必然重建，读到的是新档', async () => {
    const h = makeHarness();
    h.setArchive(SAV, archive(49, '旧名'));
    const v1 = await h.engine.createView(SAV, 49);
    expect(v1.characterName).toBe('旧名');
    h.setArchive(SAV, archive(49, '新名')); // 身份变 = 失效判据变
    const v2 = await h.engine.createView(SAV, 49);
    expect(v2).not.toBe(v1);
    expect(v2.characterName).toBe('新名');
  });

  it('角色号 / 档路径分开记账；上限按 FIFO 收口', async () => {
    const h = makeHarness({ viewCacheMax: 2 });
    h.setArchive('/s/a.sav', archive(49, '甲'));
    h.setArchive('/s/b.sav', archive(50, '乙'));
    const b50 = await h.engine.createView('/s/b.sav', 50);
    const a49 = await h.engine.createView('/s/a.sav', 49); // 不同档 = 不同格
    expect(a49).not.toBe(b50);
    // 视图上限 2：三格记账后最旧的那格已被挤掉
    await h.engine.createView('/s/b.sav', 50);
    expect(h.engine.cacheStats().views).toBeLessThanOrEqual(2);
  });

  it('视图上限 0 = 关闭记忆：每次重建，结果等价', async () => {
    const h = makeHarness({ viewCacheMax: 0 });
    h.setArchive(SAV, archive());
    const v1 = await h.engine.createView(SAV, 49);
    const v2 = await h.engine.createView(SAV, 49);
    expect(v2).not.toBe(v1);
    expect(v2.characterNo).toBe(v1.characterNo);
    expect(h.engine.cacheStats().views).toBe(0);
  });

  it('解析失败：原样上抛、不留视图（不静默伪造空视图）', async () => {
    const h = makeHarness();
    await expect(h.engine.createView('/s/missing.sav', 49)).rejects.toThrow(/missing\.sav/);
    expect(h.engine.cacheStats().views).toBe(0);
  });

  it('resetCaches（项目切换 / 索引重建）⇒ 视图与行文本一起清空', async () => {
    const h = makeHarness();
    h.setArchive(SAV, archive());
    const view = await h.engine.createView(SAV, 49);
    await h.engine.replayFunction(view, 'FN_A');
    expect(h.engine.cacheStats().views).toBe(1);
    expect(h.engine.cacheStats().files).toBe(1);
    h.engine.resetCaches();
    expect(h.engine.cacheStats()).toMatchObject({ views: 0, files: 0, chars: 0 });
    expect(await h.engine.createView(SAV, 49)).not.toBe(view);
  });
});

describe('函数体行文本缓存的上限', () => {
  it('走完整树也不越界：条数与字符数双双收口，产出与逐棵现读一致', async () => {
    // 24 棵文件、每棵 100 行 × 80 字符（≈8k 字符/棵）；上限 4 棵 / 20k 字符
    const files: Record<string, string> = {};
    const details: Record<string, { path: string; exprs: string[] }> = {};
    for (let i = 0; i < 24; i++) {
      const path = `/f/k${i}.erb`;
      files[path] = `${';'.padEnd(80, 'x')}\n`.repeat(100);
      details[`FN_${i}`] = { path, exprs: ['CFLAG:2 >= 500'] };
    }
    const h = makeHarness({ files, details, lineCacheCaps: { maxFiles: 4, maxChars: 20_000 } });
    h.setArchive(SAV, archive());
    const view = await h.engine.createView(SAV, 49);

    const results: unknown[] = [];
    for (let i = 0; i < 24; i++) results.push(await h.engine.replayFunction(view, `FN_${i}`));
    const st = h.engine.cacheStats();
    expect(st.files).toBeLessThanOrEqual(st.maxFiles);
    expect(st.chars).toBeLessThanOrEqual(st.maxChars);
    // 24 棵全走过 ⇒ 上限 4 棵，剩下的必然被逐出后重读（读盘次数远大于棵数说明没攒着）
    expect(h.reads()).toBeGreaterThan(4);
    // 每一棵的产出都相同（同一个谓词、同一份档）⇒ 逐出没有改变任何结果
    for (const r of results) expect(r).toMatchObject({ stats: { total: 1, hit: 1, miss: 0, unknown: 0 } });
  });

  it('逐出后重问：重读盘，但回放结果逐字相同（未知率基线不动）', async () => {
    const h = makeHarness({ lineCacheCaps: { maxFiles: 1, maxChars: Number.MAX_SAFE_INTEGER } });
    h.setArchive(SAV, archive());
    const view = await h.engine.createView(SAV, 49);

    const first = await h.engine.replayFunction(view, 'FN_A');
    const r0 = h.reads();
    const again = await h.engine.replayFunction(view, 'FN_A'); // 内联缓存命中 ⇒ 零读盘
    expect(h.reads()).toBe(r0);
    expect(again).toEqual(first);

    await h.engine.replayFunction(view, 'FN_B'); // 把 FN_A 那棵正文挤出去（上限 1 棵）
    expect(h.engine.cacheStats().files).toBeLessThanOrEqual(1);
    const third = await h.engine.replayFunction(view, 'FN_A');
    expect(h.reads()).toBeGreaterThan(r0); // 真的重读了盘
    expect(third).toEqual(first); // 产出逐字相同
  });

  it('默认上限是有限数；传 Infinity 即改前的无上限形态（量例 A/B 用）', () => {
    const h = makeHarness();
    const st = h.engine.cacheStats();
    expect(st.maxFiles).toBeGreaterThan(0);
    expect(Number.isFinite(st.maxFiles)).toBe(true);
    expect(Number.isFinite(st.maxChars)).toBe(true);
    const open = makeHarness({ lineCacheCaps: { maxFiles: Infinity, maxChars: Infinity } });
    expect(Number.isFinite(open.engine.cacheStats().maxFiles)).toBe(false);
  });
});
