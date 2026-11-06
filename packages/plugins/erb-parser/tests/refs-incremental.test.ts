/**
 * 反向边增量数据面的**对拍**（MCP-PERF-S2，2026-11-06）。
 *
 * 钉的是 `refs-live.ts` 头注那条**语义红线**：无论多少轮增量（改流水 / 换名录 / 增删文件），
 * 常驻态就地重建出的 `bySymbol` 与"对同一份流出账全集冷跑 `buildReferenceIndex`"**逐位一致**
 * ——组内序 = 文件序（`orderToPath` 升序序号，退场留洞、替换保座、新增追加）→ 行 → 列。
 * 判据本体不在这里（那在 `references.ts` 的落表口径），这里钉的是**增量维护不漂移**：
 * 每一轮都拿"当前流出账的全量冷聚合"当日后对照，任何一轮对不上就是第二判据起作用。
 * 纯数据、零 IO——`RescanOutcome` 直接手写扁平流水（布局见 `REF_STRIDE`）。
 */
import { describe, expect, it } from 'vitest';

import type { ErbFile, ErbReference } from '@kojo/plugin-api';

import {
  applyRefsLiveDelta,
  bumpRefsVersion,
  createRefsLiveState,
  markRescanFailures,
  prewarmRefsLive,
  refsViewOf,
  type RefsLiveState,
  type RescanOutcome,
} from '../src/refs-live';
import { buildReferenceIndex } from '../src/references';
import { candidateHash } from '../src/snapshot';

/** 最小 ErbFile 替身：本层只消费 `path`（`prewarm` 走键集、聚合走 `file.path`） */
const fileOf = (path: string): ErbFile => ({ path }) as unknown as ErbFile;

/** 手写一条引用流水（每 4 格一条：归一化名, 行, 列, 旗标 0=定义 1=调用 2=提及） */
const stream = (...entries: readonly (readonly [string, number, number, number])[]): RescanOutcome['refs'] =>
  entries.flat();

/** 流水 → 候选哈希集（与 plugin 接线同一把尺子：候选名字过一遍 `candidateHash`） */
const candidatesOf = (...names: readonly string[]): Uint16Array => {
  const hs = [...new Set(names)].map((n) => candidateHash(n));
  return Uint16Array.from(hs);
};

const outcome = (refs: RescanOutcome['refs'], candidates: Uint16Array): RescanOutcome => ({ refs, candidates });

/** 全量冷聚合（对照真源）：对当前流出账按 files 迭代序重跑一次 `buildReferenceIndex` */
const coldBySymbol = (state: RefsLiveState, files: ReadonlyMap<string, ErbFile>) =>
  buildReferenceIndex(files.values(), new Map(state.refsByPath)).bySymbol;

/** 就地更新的 files 镜像（语义同 `applyIndexDelta`：替换保位、新增追加、删除移除） */
function mirrorFiles(
  files: Map<string, ErbFile>,
  rescanned: ReadonlyMap<string, RescanOutcome>,
  removed: ReadonlySet<string>,
): void {
  for (const path of removed) files.delete(path);
  for (const path of rescanned.keys()) files.set(path, fileOf(path));
}

describe('refs-live：增量对拍（与全量冷聚合逐位一致）', () => {
  it('单文件改流水（不变名录）：受影响名字的组与冷聚合逐位一致', () => {
    const files = new Map<string, ErbFile>([
      ['/p/a.ERB', fileOf('/p/a.ERB')],
      ['/p/b.ERB', fileOf('/p/b.ERB')],
      ['/p/c.ERB', fileOf('/p/c.ERB')],
    ]);
    const state = createRefsLiveState();
    prewarmRefsLive(
      state,
      files,
      (path) =>
        path === '/p/a.ERB'
          ? stream(['ALPHA', 1, 2, 1], ['GAMMA', 3, 4, 2])
          : path === '/p/b.ERB'
            ? stream(['BETA', 1, 1, 0], ['ALPHA', 5, 3, 1])
            : stream(['GAMMA', 2, 7, 2]),
      (path) => candidatesOf(path === '/p/a.ERB' ? 'ALPHA' : path === '/p/b.ERB' ? 'BETA' : 'GAMMA'),
    );
    refsViewOf(state, files); // 物化（常见形态：保存前有人查过引用）

    // b.ERB 保存：ALPHA 多一处调用、BETA 换行
    const rescanned = new Map<string, RescanOutcome>([
      ['/p/b.ERB', outcome(stream(['BETA', 2, 1, 0], ['ALPHA', 5, 3, 1], ['ALPHA', 6, 3, 1]), candidatesOf('BETA', 'ALPHA'))],
    ]);
    const affected = applyRefsLiveDelta(state, files, rescanned, new Set());
    expect(affected.has('ALPHA')).toBe(true);
    expect(affected.has('BETA')).toBe(true);

    const cold = coldBySymbol(state, files);
    expect([...state.bySymbol!.keys()].sort()).toEqual([...cold.keys()].sort());
    for (const [name, list] of cold) expect(state.bySymbol!.get(name)).toEqual(list);
    // 视图同代同枚：version 一致、bySymbol 就是常驻那份
    const view = refsViewOf(state, files);
    expect(view.bySymbol).toBe(state.bySymbol);
    expect(view.staleNames).toBeUndefined();
  });

  it('名录对称差（新定义让别的文件多边）：受染重扫后与冷聚合逐位一致', () => {
    const files = new Map<string, ErbFile>([
      ['/p/a.ERB', fileOf('/p/a.ERB')],
      ['/p/b.ERB', fileOf('/p/b.ERB')],
    ]);
    const state = createRefsLiveState();
    prewarmRefsLive(
      state,
      files,
      (path) => (path === '/p/a.ERB' ? stream(['ALPHA', 1, 2, 1]) : stream(['BETA', 1, 1, 0])),
      (path) => candidatesOf(path === '/p/a.ERB' ? 'ALPHA' : 'BETA'),
    );
    refsViewOf(state, files);

    // b.ERB 定义了 DELTA（新名字进名录）且自身流水变化；a.ERB 未变但候选含 DELTA（受染）⇒ 重扫
    const rescanned = new Map<string, RescanOutcome>([
      ['/p/b.ERB', outcome(stream(['BETA', 1, 1, 0], ['DELTA', 2, 3, 1]), candidatesOf('BETA', 'DELTA'))],
      ['/p/a.ERB', outcome(stream(['ALPHA', 1, 2, 1], ['DELTA', 4, 2, 2]), candidatesOf('ALPHA', 'DELTA'))],
    ]);
    applyRefsLiveDelta(state, files, rescanned, new Set());
    mirrorFiles(files, rescanned, new Set());

    const cold = coldBySymbol(state, files);
    for (const [name, list] of cold) expect(state.bySymbol!.get(name)).toEqual(list);
    expect(state.bySymbol!.get('DELTA')).toEqual([
      { filePath: '/p/a.ERB', line: 4, column: 2, endColumn: 7, kind: 'mention' },
      { filePath: '/p/b.ERB', line: 2, column: 3, endColumn: 8, kind: 'call' },
    ]);
  });

  it('替换保座（改动文件的序号不挪窝）：组内文件序与冷聚合逐位一致', () => {
    const files = new Map<string, ErbFile>([
      ['/p/a.ERB', fileOf('/p/a.ERB')],
      ['/p/b.ERB', fileOf('/p/b.ERB')],
      ['/p/c.ERB', fileOf('/p/c.ERB')],
    ]);
    const state = createRefsLiveState();
    prewarmRefsLive(
      state,
      files,
      () => stream(['ALPHA', 1, 1, 1]),
      () => candidatesOf('ALPHA'),
    );
    refsViewOf(state, files);

    // 首个文件重扫：它必须**回到原位**（组里仍排在 b / c 的 ALPHA 前面——序号回到原位的红线）
    const rescanned = new Map<string, RescanOutcome>([
      ['/p/a.ERB', outcome(stream(['ALPHA', 9, 9, 1]), candidatesOf('ALPHA'))],
    ]);
    applyRefsLiveDelta(state, files, rescanned, new Set());
    expect(state.bySymbol!.get('ALPHA')).toEqual([
      { filePath: '/p/a.ERB', line: 9, column: 9, endColumn: 14, kind: 'call' },
      { filePath: '/p/b.ERB', line: 1, column: 1, endColumn: 6, kind: 'call' },
      { filePath: '/p/c.ERB', line: 1, column: 1, endColumn: 6, kind: 'call' },
    ]);
    const cold = coldBySymbol(state, files);
    expect(state.bySymbol!.get('ALPHA')).toEqual(cold.get('ALPHA'));
  });

  it('增删文件（退场让位留洞、新增序号追加）：多轮之后仍与冷聚合逐位一致', () => {
    const files = new Map<string, ErbFile>([
      ['/p/a.ERB', fileOf('/p/a.ERB')],
      ['/p/b.ERB', fileOf('/p/b.ERB')],
    ]);
    const state = createRefsLiveState();
    prewarmRefsLive(
      state,
      files,
      () => stream(['ALPHA', 1, 1, 1], ['OMEGA', 2, 1, 2]),
      () => candidatesOf('ALPHA', 'OMEGA'),
    );
    refsViewOf(state, files);

    // 轮 1：删 b.ERB（OMEGA 只剩 a 的一处）+ 新增 d.ERB（ALPHA 尾部追加）
    //（files 镜像先行——与 plugin 接线同序：applyIndexDelta 交出**最终** files 才轮到 refs 增量）
    const rescanned1 = new Map<string, RescanOutcome>([
      ['/p/d.ERB', outcome(stream(['ALPHA', 3, 1, 1]), candidatesOf('ALPHA'))],
    ]);
    const removed1 = new Set(['/p/b.ERB']);
    mirrorFiles(files, rescanned1, removed1);
    applyRefsLiveDelta(state, files, rescanned1, removed1);
    let cold = coldBySymbol(state, files);
    for (const [name, list] of cold) expect(state.bySymbol!.get(name)).toEqual(list);
    expect(state.bySymbol!.get('OMEGA')).toEqual([
      { filePath: '/p/a.ERB', line: 2, column: 1, endColumn: 6, kind: 'mention' },
    ]); // b 的那条边退场，a 的还在

    // 轮 2：中间插一个新文件 e.ERB（files 追加在尾），再删 a.ERB（洞）
    const rescanned2 = new Map<string, RescanOutcome>([
      ['/p/e.ERB', outcome(stream(['OMEGA', 1, 1, 0]), candidatesOf('OMEGA'))],
    ]);
    const removed2 = new Set(['/p/a.ERB']);
    mirrorFiles(files, rescanned2, removed2);
    applyRefsLiveDelta(state, files, rescanned2, removed2);
    cold = coldBySymbol(state, files);
    expect([...cold.keys()].sort()).toEqual(['ALPHA', 'OMEGA']);
    for (const [name, list] of cold) expect(state.bySymbol!.get(name)).toEqual(list);
    expect(state.bySymbol!.get('OMEGA')).toEqual([
      { filePath: '/p/e.ERB', line: 1, column: 1, endColumn: 6, kind: 'definition' },
    ]);
  });

  it('未物化时增量只记账：物化那一刻从当前状态冷建，与逐位一致', () => {
    const files = new Map<string, ErbFile>([['/p/a.ERB', fileOf('/p/a.ERB')]]);
    const state = createRefsLiveState();
    prewarmRefsLive(
      state,
      files,
      () => stream(['ALPHA', 1, 1, 1]),
      () => candidatesOf('ALPHA'),
    );
    // 没人读过 references ⇒ bySymbol 从未物化；增量轮照常记账
    const rescanned = new Map<string, RescanOutcome>([
      ['/p/b.ERB', outcome(stream(['ALPHA', 2, 2, 2]), candidatesOf('ALPHA'))],
    ]);
    applyRefsLiveDelta(state, files, rescanned, new Set());
    mirrorFiles(files, rescanned, new Set());
    expect(state.bySymbol).toBeNull();
    const view = refsViewOf(state, files);
    expect(view.bySymbol.get('ALPHA')).toEqual([
      { filePath: '/p/a.ERB', line: 1, column: 1, endColumn: 6, kind: 'call' },
      { filePath: '/p/b.ERB', line: 2, column: 2, endColumn: 7, kind: 'mention' },
    ]);
  });
});

describe('refs-live：版本号与显式 stale 面', () => {
  const bootstrap = (): { state: RefsLiveState; files: Map<string, ErbFile> } => {
    const files = new Map<string, ErbFile>([['/p/a.ERB', fileOf('/p/a.ERB')]]);
    const state = createRefsLiveState();
    prewarmRefsLive(
      state,
      files,
      () => stream(['ALPHA', 1, 1, 1]),
      () => candidatesOf('ALPHA'),
    );
    return { state, files };
  };

  it('版本号：整扫预热 +1、每次增量换代，视图按代缓存', () => {
    const { state, files } = bootstrap();
    bumpRefsVersion(state); // 整扫提交段
    const v1 = refsViewOf(state, files);
    expect(v1.version).toBe(1);
    expect(refsViewOf(state, files)).toBe(v1); // 同代同枚对象
    const rescanned = new Map<string, RescanOutcome>([
      ['/p/a.ERB', outcome(stream(['ALPHA', 1, 1, 1]), candidatesOf('ALPHA'))],
    ]);
    bumpRefsVersion(state); // 增量提交段换代（plugin 接线：bump → applyRefsLiveDelta）
    applyRefsLiveDelta(state, files, rescanned, new Set());
    const v2 = refsViewOf(state, files);
    expect(v2.version).toBe(2);
    expect(v2).not.toBe(v1);
  });

  it('显式 stale：判不了的名字可见交出（不答空）；重扫成功即除名回空集', () => {
    const { state, files } = bootstrap();
    bumpRefsVersion(state);
    applyRefsLiveDelta(state, files, new Map(), new Set());
    // 读盘失败：a.ERB 判不了 ⇒ ALPHA 进 stale 面（组内容仍是尽力而为的最新账）
    markRescanFailures(state, new Map([['/p/a.ERB', new Set(['ALPHA'])]]));
    const view = refsViewOf(state, files);
    expect(view.staleNames?.has('ALPHA')).toBe(true);
    expect(view.bySymbol.get('ALPHA')).toEqual([
      { filePath: '/p/a.ERB', line: 1, column: 1, endColumn: 6, kind: 'call' },
    ]); // 不答空

    // 下一轮 a.ERB 重扫成功 ⇒ 名册除名 ⇒ stale 面回空集（键缺席）
    const rescanned = new Map<string, RescanOutcome>([
      ['/p/a.ERB', outcome(stream(['ALPHA', 1, 1, 1], ['ALPHA', 5, 1, 1]), candidatesOf('ALPHA'))],
    ]);
    applyRefsLiveDelta(state, files, rescanned, new Set());
    const healed = refsViewOf(state, files);
    expect(healed.staleNames).toBeUndefined();
    expect(healed.bySymbol.get('ALPHA')).toHaveLength(2);
  });

  it('退场文件从名册除名；名册跨轮保留（没重扫成功就一直可见）', () => {
    const { state, files } = bootstrap();
    files.set('/p/b.ERB', fileOf('/p/b.ERB'));
    bumpRefsVersion(state);
    applyRefsLiveDelta(
      state,
      files,
      new Map([['/p/b.ERB', outcome(stream(['BETA', 1, 1, 0]), candidatesOf('BETA'))]]),
      new Set(),
    );
    markRescanFailures(state, new Map([['/p/b.ERB', new Set(['BETA'])]]));
    expect(refsViewOf(state, files).staleNames?.has('BETA')).toBe(true);

    // 别的轮次没碰 b.ERB ⇒ 可疑照旧可见
    const other = new Map<string, RescanOutcome>([
      ['/p/a.ERB', outcome(stream(['ALPHA', 2, 1, 1]), candidatesOf('ALPHA'))],
    ]);
    applyRefsLiveDelta(state, files, other, new Set());
    expect(refsViewOf(state, files).staleNames?.has('BETA')).toBe(true);

    // b.ERB 退场 ⇒ 除名（它的疑点随文件一起消失）
    files.delete('/p/b.ERB');
    applyRefsLiveDelta(state, files, new Map(), new Set(['/p/b.ERB']));
    const after = refsViewOf(state, files);
    expect(after.staleNames).toBeUndefined();
    expect(after.bySymbol.has('BETA')).toBe(false);
  });

  it('引用点的形状：endColumn = column + 名字长（与全量聚合同口径）', () => {
    const { state, files } = bootstrap();
    const rescanned = new Map<string, RescanOutcome>([
      ['/p/a.ERB', outcome(stream(['ＡＬＰＨＡ', 3, 4, 1]), candidatesOf('ＡＬＰＨＡ'))],
    ]);
    applyRefsLiveDelta(state, files, rescanned, new Set());
    const ref: ErbReference = refsViewOf(state, files).bySymbol.get('ＡＬＰＨＡ')![0]!;
    expect(ref.endColumn - ref.column).toBe('ＡＬＰＨＡ'.length);
  });
});
