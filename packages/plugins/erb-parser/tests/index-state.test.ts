/**
 * 索引状态事实的**判据**单测（IDX-STATE，2026-10-19）。
 *
 * 与 `index-state-plugin.test.ts` 的分工：这里钉形状判据本身（纯函数），那里钉装配时机。
 * 三条本刀的存在理由都在这里：
 * 1. **降级与成功不同形**（`coverageOf()`）——"工作区根读不到"必须读得出"少了哪一类"，
 *    而不是只有一声 console；
 * 2. **"没扫到位置" ≠ "扫了什么都没有"**（`phaseOf()`）——两态的 `filesScanned` 都可能是 0，
 *    旧形态对两者都只会说"正在构建函数索引"，那是假话；
 * 3. **"读到空清单"不等于"读不到"**——把作者没授权污蔑成编辑器读不到，比静默更糟。
 */

import { describe, expect, it } from 'vitest';
import type { ErbScanSourceFact } from '@kojo/plugin-api';
import { coverageOf, indexStateOf, phaseOf, sourceFactsOf, INDEX_FAILURE_SAMPLES } from '../src/index-state';

/** 造一条来源事实（缺省 = 读得到且给了根） */
const fact = (
  source: 'project' | 'workspace',
  offered: number,
  available = true,
  reason?: string,
): ErbScanSourceFact => ({
  source,
  offered,
  available,
  ...(reason === undefined ? {} : { reason }),
});

/** 一轮真实降级：口上根 1 条读到了，工作区那类位置抛了 */
const DEGRADED: ErbScanSourceFact[] = [fact('project', 1), fact('workspace', 0, false, 'Error: no platform data dir')];
/** 一轮扫全了：两侧都读到 */
const WHOLE: ErbScanSourceFact[] = [fact('project', 1), fact('workspace', 2)];
/** 作者没授权工作区：读得到，但清单是空的（**这不是降级**） */
const NO_AUTHORITY: ErbScanSourceFact[] = [fact('project', 1), fact('workspace', 0, true)];

describe('coverageOf：降级与成功不同形（判据只此一枚函数）', () => {
  it('工作区那类位置读不到 ⇒ partial（与扫全了的那一轮**不同形**）', () => {
    expect(coverageOf(DEGRADED, 1)).toBe('partial');
    expect(coverageOf(WHOLE, 3)).toBe('full');
    expect(coverageOf(DEGRADED, 1)).not.toBe(coverageOf(WHOLE, 3));
  });

  it('一个根都没走到 ⇒ none（优先级高于"读不读得到"）', () => {
    expect(coverageOf(WHOLE, 0)).toBe('none');
    expect(coverageOf(DEGRADED, 0)).toBe('none');
    expect(coverageOf([], 0)).toBe('none');
  });

  it('读到**空清单**不算降级：那是作者的盘上事实，不是"读不到"', () => {
    expect(coverageOf(NO_AUTHORITY, 1)).toBe('full');
  });

  it('口上那一类读不到时同样算降级（判据不偏向某一只来源）', () => {
    expect(coverageOf([fact('project', 0, false, 'boom'), fact('workspace', 2)], 2)).toBe('partial');
  });

  it('负数/非有限的根数判成 none（不把"没走到"写成"走到了"）', () => {
    expect(coverageOf(WHOLE, -1)).toBe('none');
    expect(coverageOf(WHOLE, Number.NaN)).toBe('none');
  });
});

describe('phaseOf：三态由数据形状判出，不由调用方猜', () => {
  it('收尾的三态互不相同：ready / nothing-to-scan / empty', () => {
    expect(phaseOf('settled', 'full', 12)).toBe('ready');
    expect(phaseOf('settled', 'none', 0)).toBe('nothing-to-scan');
    expect(phaseOf('settled', 'partial', 0)).toBe('empty');
  });

  it('「没扫到位置」与「扫了什么都没有」在 filesScanned 同为 0 时依然分得开', () => {
    const nowhere = indexStateOf({ outcome: 'settled', sources: [], rootsWalked: 0, filesScanned: 0, functions: 0 });
    const nothing = indexStateOf({
      outcome: 'settled',
      sources: [fact('project', 1)],
      rootsWalked: 1,
      filesScanned: 0,
      functions: 0,
    });
    expect(nowhere.phase).toBe('nothing-to-scan');
    expect(nothing.phase).toBe('empty');
    expect(nowhere.phase).not.toBe(nothing.phase);
    expect(nowhere.filesScanned).toBe(nothing.filesScanned); // 读数相同、事实不同 ⇒ 只能靠形状判
  });

  it('未收尾的四个时刻原样上报（idle / scanning / failed 不被"空"抢掉）', () => {
    expect(phaseOf('idle', 'none', 0)).toBe('idle');
    expect(phaseOf('scanning', 'none', 0)).toBe('scanning');
    expect(phaseOf('failed', 'partial', 0)).toBe('failed');
  });
});

describe('sourceFactsOf：把"读不到"写成事实而不是 0', () => {
  it('读不到的那一类 ⇒ available=false + offered=0 + 原始原因逐字留下', () => {
    const got = sourceFactsOf([
      { kind: 'project', roots: ['/a', '/b'] },
      { kind: 'workspace', roots: null, reason: 'Error: nope' },
    ]);
    expect(got).toEqual([
      { source: 'project', offered: 2, available: true },
      { source: 'workspace', offered: 0, available: false, reason: 'Error: nope' },
    ]);
  });

  it('顺序照输入（project 在前 ⇒ 消费方按位读的就是这两个来源）', () => {
    expect(sourceFactsOf([{ kind: 'workspace', roots: [] }, { kind: 'project', roots: [] }]).map((s) => s.source)).toEqual([
      'workspace',
      'project',
    ]);
  });

  it('读到空数组是 available=true（与"抛错"分形：一个有事实、一个没事实）', () => {
    const [only] = sourceFactsOf([{ kind: 'workspace', roots: [] }]);
    expect(only).toEqual({ source: 'workspace', offered: 0, available: true });
  });
});

describe('indexStateOf：唯一构造出口，同输入必同输出', () => {
  it('降级那一轮：coverage 与逐来源读数同时可读，error 键不出现在非失败态', () => {
    const s = indexStateOf({ outcome: 'settled', sources: DEGRADED, rootsWalked: 1, filesScanned: 42, functions: 7 });
    expect(s).toEqual({
      phase: 'ready',
      sources: DEGRADED,
      rootsWalked: 1,
      filesScanned: 42,
      functions: 7,
      coverage: 'partial',
      filesFailed: 0,
    });
    expect('error' in s).toBe(false);
    expect('failures' in s).toBe(false); // 没有失败 ⇒ 不写空数组（同 error 的缺省纪律）
  });

  it('失败那一轮：phase=failed 且原始原因留在 error（不静默吞掉）', () => {
    const s = indexStateOf({
      outcome: 'failed',
      sources: WHOLE,
      rootsWalked: 3,
      filesScanned: 10,
      functions: 0,
      error: 'Error: EACCES',
    });
    expect(s.phase).toBe('failed');
    expect(s.error).toBe('Error: EACCES');
  });

  it('纯函数：同一份 seed 两次构造逐字段相等（事实面不受调用次数影响）', () => {
    const seed = { outcome: 'scanning' as const, sources: WHOLE, rootsWalked: 3, filesScanned: 8, functions: 0 };
    expect(indexStateOf(seed)).toEqual(indexStateOf(seed));
  });

  it('未收尾时 functions=0 也**不会**被判成 empty（只有 settled 那一轮才裁"空"）', () => {
    const s = indexStateOf({ outcome: 'scanning', sources: WHOLE, rootsWalked: 3, filesScanned: 0, functions: 0 });
    expect(s.phase).toBe('scanning');
  });
});

/* ---------------- 失败面（IDX-SILENT，2026-10-20） ---------------- */

describe('indexStateOf：失败文件面与读数同源（IDX-SILENT）', () => {
  const failed = (path: string, reason: 'read' | 'parse' = 'read') => ({ path, reason });

  it('条数从失败全表派生，样本只切前若干条（不许"说 7 个、列 2 条"）', () => {
    const all = Array.from({ length: INDEX_FAILURE_SAMPLES + 2 }, (_, i) => failed(`/game/kojo/f${i}.ERB`));
    const s = indexStateOf({ outcome: 'settled', sources: WHOLE, rootsWalked: 1, filesScanned: 9, functions: 3, failures: all });
    expect(s.filesFailed).toBe(all.length);
    expect(s.failures).toHaveLength(INDEX_FAILURE_SAMPLES);
    expect(s.failures?.[0]).toEqual(all[0]);
  });

  it('失败与读数**不同形**：文件全进了索引（filesScanned 与名录照旧）也照样读得出失败', () => {
    const s = indexStateOf({
      outcome: 'settled',
      sources: WHOLE,
      rootsWalked: 1,
      filesScanned: 2,
      functions: 2,
      failures: [failed('/game/kojo/a.ERB')],
    });
    expect(s.phase).toBe('ready'); // 失败不改阶段（既有三态判据一字未动）
    expect(s.filesScanned).toBe(2); // 与"全成功"那一轮可以是同一组读数……
    expect(s.filesFailed).toBe(1); // ……而这一格把它分开了
    expect(s.failures).toEqual([{ path: '/game/kojo/a.ERB', reason: 'read' }]);
  });

  it('读失败与解析失败并存时两条都在（原因不许被糊成一个数）', () => {
    const s = indexStateOf({
      outcome: 'settled',
      sources: WHOLE,
      rootsWalked: 1,
      filesScanned: 3,
      functions: 1,
      failures: [failed('/a.ERB', 'read'), failed('/b.ERB', 'parse')],
    });
    expect(s.failures).toEqual([failed('/a.ERB', 'read'), failed('/b.ERB', 'parse')]);
  });
});
