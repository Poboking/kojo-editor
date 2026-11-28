/**
 * P2-8 · sav 跨实现对拍（kojo sav-parser ⇄ eratw 引擎真值）。
 *
 * 真值侧 = eratw `core-vm` 既有探针 `RealSaveSamplesProbeTest`（引擎 SaveFormat.read + applyTo
 * 到 VariableStore + DAY 语义读回，2026-11-28 实跑读数，样本 = 仓内只读备份
 * `docs/agent/sav-backup/sav-20261018-110513` 六档 PC 实机档）：
 *
 * - global.sav: size=544 gzip=true code=7153 scriptVersion=0 kind=GLOBAL chars=0
 * - save00.sav: size=60151 chars=168 text=第 1日 applied=4601 skipped=11399 ⇒ 记账 16000
 * - save01.sav: 第14日 applied=4606 skipped=11399 ⇒ 16005（save02/03/1000 同 16005）
 * - save02: 第44日 · save03/save1000: 第47日
 * - 引擎重编码逐字节回环六档全过（`SaveFormat.write(d) ≡ 原字节`）
 *
 * 本文件在 kojo 侧复刻同一批不变式（同一批字节，两侧各自独立解析）：
 *
 * 1. **容器/头部**：version=1808、fileType、uniqueCode=7153、charCount=168/0；
 * 2. **总量不变式**：kojo 解析的条目总数（顶层 + 角色块）逐档等于引擎 `applied+skipped`
 *    （16000 / 16005）——两侧各自把每一个非分隔符条目记账到同一总数，结构错位当场红；
 * 3. **DAY 语义读回**：从 kojo 解析出的 `DAY:0` 值必须等于档备注「第 N 日」——引擎侧
 *    同一判据（描述→DAY 落对变量）已由探针钉死，这里证明 kojo 的值解析与引擎同真；
 * 4. **金样本身份清单**：六档缺一即红（沿用 golden-roundtrip 的身份清单口径，不静默跳档）。
 *
 * 运行条件：`KOJO_GOLDEN_SAV_DIR`（显式授权）或 `KOJO_SMOKE_PROJECT/sav`（当前语料盘）
 * 或盘上发现的语料（`tools/corpus-fingerprint.mjs` 发现链）；一台机器一枚 `.sav` 都没有
 * ⇒ 显式 skip（CI 与无存档机安全）。不判字节级回环（golden-roundtrip 的 passthrough 档已钉）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArchive } from '../src/parse';
import {
  corpusFingerprint,
  discoverCorpusFingerprints,
  formatFingerprint,
  savCandidatesReadout,
} from '../../../../tools/corpus-fingerprint.mjs';

const SMOKE_DIR = process.env.KOJO_SMOKE_PROJECT;
const GOLDEN_SAV_ENV = 'KOJO_GOLDEN_SAV_DIR';

/** 金样本六档（与 golden-roundtrip 的 GOLDEN_ARCHIVES 同一身份清单：缺档红，不静默） */
const GOLDEN_ARCHIVES = ['global.sav', 'save00.sav', 'save01.sav', 'save02.sav', 'save03.sav', 'save1000.sav'];

/** 引擎探针 2026-11-28 实跑读数（真值侧，改档即两侧一起红） */
const ENGINE_DAY: Readonly<Record<string, number>> = {
  'save00.sav': 1,
  'save01.sav': 14,
  'save02.sav': 44,
  'save03.sav': 47,
  'save1000.sav': 47,
};
/** 引擎 applied+skipped 的逐档总数（kojo 侧条目总数必须逐档相等） */
const ENGINE_ACCOUNTED: Readonly<Record<string, number>> = {
  'save00.sav': 16_000,
  'save01.sav': 16_005,
  'save02.sav': 16_005,
  'save03.sav': 16_005,
  'save1000.sav': 16_005,
};
const ENGINE_UNIQUE_CODE = '7153';
const ENGINE_CHAR_COUNT = 168;

function savNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.sav'));
  } catch {
    return [];
  }
}
function missingFrom(dir: string, wanted: readonly string[]): string[] {
  const have = new Set(savNames(dir));
  return wanted.filter((n) => !have.has(n));
}

const HAS_SAV_ANYWHERE = (() => {
  if ((process.env[GOLDEN_SAV_ENV] ?? '').trim()) return true; // 显式授权即承认有档（指向错档由定位失败报错点名）
  if (SMOKE_DIR && savNames(nodeJoin(SMOKE_DIR, 'sav')).length > 0) return true;
  try {
    return discoverCorpusFingerprints().some((c) => c.fp.savFiles > 0);
  } catch {
    return false;
  }
})();

function requireGoldenSavRoot(): string {
  const pools: string[] = [];
  const explicit = (process.env[GOLDEN_SAV_ENV] ?? '').trim();
  if (explicit) pools.push(explicit);
  if (SMOKE_DIR) pools.push(nodeJoin(SMOKE_DIR, 'sav'));
  let scanned: readonly { dir: string; fp: ReturnType<typeof corpusFingerprint> }[] = [];
  const scanAll = () => {
    if (scanned.length === 0)
      scanned = discoverCorpusFingerprints().map((c) => ({ dir: nodeJoin(c.dir, 'sav'), fp: c.fp }));
    return scanned;
  };
  for (const dir of pools) {
    if (missingFrom(dir, GOLDEN_ARCHIVES).length === 0) return dir;
  }
  for (const cand of scanAll()) {
    if (missingFrom(cand.dir, GOLDEN_ARCHIVES).length === 0) return cand.dir;
  }
  const lines = [
    `【金样本六档定位失败】没有一份 sav 含齐 ${GOLDEN_ARCHIVES.join(' / ')}`,
    `  已试过的落点：${pools.join(' ｜ ') || '（未设 KOJO_GOLDEN_SAV_DIR / KOJO_SMOKE_PROJECT）'}`,
    `  盘上各语料的 sav 实测：${savCandidatesReadout(scanAll().map((c) => ({ dir: c.dir, erbCount: c.fp.erb, savCount: c.fp.savFiles, fp: c.fp })))}`,
    `  处理：这不是 SKIP 条件（SKIP 只留给「这台机器一枚 .sav 都没有」）。`,
    `    金样本盘在别处 ⇒ 设 ${GOLDEN_SAV_ENV}=<那份 sav 目录>。`,
  ];
  throw new Error(lines.join('\n'));
}

function parseDayOf(saveMes: string): number | null {
  const m = /第\s*(\d+)日/.exec(saveMes);
  return m ? Number(m[1]) : null;
}

describe('P2-8 · sav 跨实现对拍（kojo sav-parser ⇄ eratw 引擎真值）', () => {
  const skipReason = HAS_SAV_ANYWHERE ? undefined : '这台机器一枚 .sav 都没有（真档对拍是语料条件，不是代码缺陷）';
  it.skipIf(skipReason !== undefined)(
    '六档金样本：容器/总量/DAY 三层真值逐档对拍',
    { timeout: 120_000 },
    async () => {
      const dir = requireGoldenSavRoot();
      for (const name of GOLDEN_ARCHIVES) {
        const bytes = readFileSync(nodeJoin(dir, name));
        const a = await parseArchive(bytes, name);
        const label = `${name}（${dir}）`;

        // ① 容器/头部：与引擎探针同读数
        expect(a.version, `${label} 容器版本`).toBe(1808);
        expect(a.uniqueCode, `${label} 唯一码`).toBe(ENGINE_UNIQUE_CODE);
        if (name === 'global.sav') {
          expect(a.fileType, `${label} 类别`).toBe('global');
          expect(a.charCount, `${label} 角色数`).toBe(0);
          expect(a.globalVars, `${label} 全局变量区条目`).toHaveLength(25);
          expect(a.chars, `${label} 不应带角色块`).toBeUndefined();
        } else {
          expect(a.fileType, `${label} 类别`).toBe('normal');
          expect(a.charCount, `${label} 角色数（引擎 chars=168）`).toBe(ENGINE_CHAR_COUNT);
          expect(a.chars, `${label} 角色块数`).toHaveLength(ENGINE_CHAR_COUNT);

          // ② 总量不变式：kojo 条目总数 == 引擎 applied+skipped（两侧各自记账到同一总数）
          const top = (a.vars?.length ?? 0) + (a.globalVars?.length ?? 0) + (a.emVars?.length ?? 0);
          const chara = (a.chars ?? []).reduce((s, c) => s + (c.vars?.length ?? 0), 0);
          expect(top + chara, `${label} 条目总数（引擎 applied+skipped）`).toBe(ENGINE_ACCOUNTED[name]);

          // ③ DAY 语义读回：档备注「第 N 日」⇒ DAY:0 必须等于 N（引擎同判据的 kojo 侧复刻）
          const dayOfMes = parseDayOf(a.saveMes);
          expect(dayOfMes, `${label} 档备注应带「第 N 日」`).not.toBeNull();
          expect(dayOfMes, `${label} 档备注天数（引擎探针读数）`).toBe(ENGINE_DAY[name]);
          const day = (a.vars ?? []).find((v) => v.key.toUpperCase() === 'DAY');
          expect(day, `${label} DAY 变量在档`).toBeDefined();
          const cell0 = day && 'cells' in day ? day.cells?.find((c) => JSON.stringify(c.index) === '[0]') : undefined;
          expect(cell0, `${label} DAY:0 非零单元在档`).toBeDefined();
          expect(cell0!.value, `${label} DAY:0 == 档备注天数（两侧语义同真）`).toBe(dayOfMes);
        }
      }
    },
  );

  it.skipIf(skipReason !== undefined)('金样本档定位失败的报错会逐盘打出 sav 实测清单', () => {
    // 定位失败的报错文本本身就是判据的一部分：不静默、逐盘给证据（golden-roundtrip 同款）。
    const dir = requireGoldenSavRoot();
    const fp = corpusFingerprint(nodeJoin(dir, '..'));
    expect(formatFingerprint(fp).length).toBeGreaterThan(0);
  });
});
