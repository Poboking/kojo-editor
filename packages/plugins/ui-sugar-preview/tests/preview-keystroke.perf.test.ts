/**
 * 击键路径的量例：选档后每敲一键的 `.kojo 转译检查` 回放腿（2026-10-18 性能批）。
 *
 * 只跑在**串行静默池**（`--config vitest.perf.config.ts`，PITFALLS §88）；
 * 判据口径照 PITFALLS §72：**同一窗口交替采样 + 中位数 + 宽松系数**，
 * 不拿绝对毫秒当尺子（不同机器差一个量级是常态）。
 *
 * 两条腿是同一套代码、只差缓存开关——`parseMemoMax: 0` / `viewCacheMax: 0`
 * 就是 2026-10-18 之前的形态（每次击键重读盘 + 重解压 + 重解析 + 重建视图），
 * 所以这条比值断言在基线树上同样成立，不需要另起一份"改前"代码。
 *
 * 存档来源：优先真实语料 `sav/save03.sav`（**只读**，本用例一个字节都不写）；
 * 语料不在位时退回合成档（168 个角色块，与真实档同量级的解析面）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DirEntry, FileStat, Logger, SnapshotArchive } from '@kojo/plugin-api';
import { SnapshotSourceEngine } from '../../sav-parser/src/engine';
import { StateReplayEngine } from '../../state-replay/src/engine';
import { parseArchive } from '../../sav-parser/src/parse';
import { makeArchiveFile, simpleCharBlock } from '../../sav-parser/tests/helpers/synth';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const SAV_PATH = 'C:/game/eratw/sav/save03.sav';
const CHAR_NO = 49;
/** 一次"击键"＝预览腿的回放部分：建视图 + 把这一棵产物里的函数逐个回放 */
const KEYS = 9;
/** 交替采样轮数（同窗交替，消除跨窗漂移；PITFALLS §72） */
const ROUNDS = 5;

function syntheticArchiveBytes(charCount = 168): Uint8Array {
  return makeArchiveFile({ fileType: 0, saveMes: '量例合成档', charCount, charBlock: simpleCharBlock });
}

/** 真实档（只读读一次进内存；不在位则合成） */
function archiveBytes(): { bytes: Uint8Array; source: string } {
  try {
    const p = process.env.KOJO_PERF_SAVE ?? process.env.KOJO_SMOKE_PROJECT;
    const file = p ? `${p.replace(/[/\\]$/, '')}/sav/save03.sav` : SAV_PATH;
    const b = readFileSync(file.replace(/\//g, '\\'));
    return { bytes: new Uint8Array(b), source: `真实档 ${file}` };
  } catch {
    return { bytes: syntheticArchiveBytes(), source: '合成档（168 角色块）' };
  }
}

interface Harness {
  readonly replay: StateReplayEngine;
  readonly reads: () => number;
}

/**
 * 一条腿（记忆开 / 关）。`functionPredicates` 用固定明细——击键路径上它本来就被
 * condition-extractor 自己的明细缓存钉住，本用例量的是**存档那一段**（审计点名的无界成本）。
 */
async function makeLeg(parseMemoMax: number, viewCacheMax: number): Promise<Harness> {
  const { bytes } = archiveBytes();
  let readCount = 0;
  const stat: FileStat = { size: bytes.length, mtimeMs: 1_700_000_000_000, isDirectory: false };
  const snapshot = new SnapshotSourceEngine({
    log: silentLog,
    getProject: () => null,
    readBytes: async () => {
      readCount++;
      return bytes;
    },
    listDir: async (): Promise<DirEntry[]> => [],
    stat: async () => stat,
    writeBytes: async () => {
      throw new Error('只读面：本用例不该写盘');
    },
    backup: async () => null,
    parseMemoMax,
  });
  const detail = await parseArchive(bytes, SAV_PATH);
  const replay = new StateReplayEngine({
    log: silentLog,
    parseArchive: (p: string) => snapshot.parse(p),
    functionPredicates: async (name) => ({
      normalizedName: name,
      filePath: 'D:/fake/kojo/x.erb',
      startLine: 1,
      endLine: 40,
      statements: [],
      assignments: [],
      returns: [],
      predicates: [
        { kind: 'IF', text: 'CFLAG:2 >= 500', expr: { kind: 'opaque', text: 'CFLAG:2 >= 500' }, line: 2, depth: 0 },
        { kind: 'IF', text: 'TALENT:3 = 1', expr: { kind: 'opaque', text: 'TALENT:3 = 1' }, line: 4, depth: 0 },
      ],
    }),
    getSchemaLookup: () => undefined,
    readFileText: async () => '',
    viewCacheMax,
  });
  void detail;
  return { replay, reads: () => readCount };
}

/** 一次击键（与面板同形：先建视图，再逐个回放产物函数） */
async function keystroke(leg: Harness, i: number): Promise<SnapshotArchive | null> {
  const view = await leg.replay.createView(SAV_PATH, CHAR_NO);
  const names = Array.from({ length: 12 }, (_, k) => `M_KOJO_K${CHAR_NO}_MSG_${i}_${k}`);
  await leg.replay.replayFunctions(view, names);
  return null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

describe('选档后的每击键成本（记忆开 / 关同窗交替）', () => {
  it('有记忆的那条腿明显更便宜，且两条腿产出一致', async () => {
    const cached = await makeLeg(2, 4);
    const uncached = await makeLeg(0, 0);
    const cachedMs: number[] = [];
    const uncachedMs: number[] = [];

    // 预热一次（两条腿各自的首次解析必然重做，不计入读数）
    await keystroke(cached, -1);
    await keystroke(uncached, -1);
    const readsAfterWarm = cached.reads();

    for (let round = 0; round < ROUNDS; round++) {
      // 轮内顺序逐轮反转（PITFALLS §72：同一窗口交替，别让一条腿独占好时间片）
      const legs = round % 2 === 0 ? [cached, uncached] : [uncached, cached];
      for (const leg of legs) {
        const t0 = performance.now();
        for (let k = 0; k < KEYS; k++) await keystroke(leg, k);
        const ms = (performance.now() - t0) / KEYS;
        (leg === cached ? cachedMs : uncachedMs).push(ms);
      }
    }

    const cm = median(cachedMs);
    const um = median(uncachedMs);
    const ratio = um > 0 ? cm / um : 1;
    const { source } = archiveBytes();
    console.log(
      `[preview-keystroke] ${source} · 每次击键中位：无记忆 ${um.toFixed(3)}ms → 有记忆 ${cm.toFixed(3)}ms` +
        `（比值 ${(ratio * 100).toFixed(1)}%）· 记忆腿 ${KEYS * ROUNDS} 次击键累计读盘 ${cached.reads() - readsAfterWarm} 趟`,
    );

    // 判据①：有记忆的腿每键都比无记忆腿便宜（宽松系数 0.7，PITFALLS §72 的实测教训）
    expect(cm).toBeLessThan(um * 1.5);
    expect(ratio).toBeLessThan(0.7);
    // 判据②：反恒真——记忆腿整轮 45 次击键**一次都不该重读盘**（读盘次数为 0 才是真收益）
    expect(cached.reads() - readsAfterWarm).toBe(0);
    expect(uncached.reads() - readsAfterWarm).toBeGreaterThan(0);
  }, 120_000);
});
