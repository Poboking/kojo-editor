/**
 * 协议覆盖校验规则 —— 真实语料基线（KOJO_SMOKE_PROJECT 守门，无游戏目录自动跳过）。
 *
 * 目标：把「签名槽 vs 路由转发」在 eraTW 4.980 汉化整合版上的实测结果固化为回归基线，
 * 与 kernel 集成冒烟的回放基线（未知 3741 / exact 836）同一性质——**逐字不变**。
 *
 * 实测（2026-10-11，eraTW 4.980 汉化整合版）：
 * - 口上域 2285 个 ERB / 99101 个不同函数名；协议识别 25398 个函数名；
 * - 覆盖规则命中 **36** 条，全部为「数值槽 声明 1 / 转发 0」——即某口上函数在
 *   `MESSAGE_PALAMCNG_{D,F}` / `COLOR` 等**无参转发**的家族上多声明了一个 ARG，
 *   该槽在任何路由路径上都收不到转发值（含官方模板 ORTHODOX_K49）。
 *
 * 若此基线变动：要么语料更换，要么协议解析 / 覆盖语义发生回归——两者都需人工确认。
 */
import { functionLookupOf } from '@kojo/plugin-api';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CharaInfo, ConventionCheckContext, ErbFile, ErbFunctionRef, ErbIndex, FileIO, Logger } from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { loadEratwCallProtocol } from '../src/call-protocol';
import { createCallSlotCoverageRule } from '../src/conventions';
import {
  corpusFingerprint,
  discoverCorpusFingerprints,
  resolvePinnedRow,
  type PinnedRow,
} from '../../../../tools/corpus-fingerprint.mjs';

const SMOKE = process.env.KOJO_SMOKE_PROJECT;
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 递归收集 *.erb/*.erm */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.er[bm]$/i.test(e.name)) out.push(p);
  }
  return out;
}

interface CallSlotReadings {
  hits: number;
}

/**
 * 登记表（每枚盘一行；`fp` 是那份盘的内容指纹，`label` 只是人话注记、不参与匹配）。
 * - `digest cddca01d8d2c`：2026-10-11 取证那份 4.980 汉化整合版内容 ⇒ 命中 36（本文件头注的原始读数）。
 * - 其余在盘版本 ⇒ 未登记的盘一律红，红消息里带该盘实测命中数供新增一行。
 */
const CALL_SLOT_PINNED: readonly PinnedRow<CallSlotReadings>[] = [
  {
    label: 'digest cddca01d8d2c（erb 4,385 / erh 157 / als 19）= 2026-10-11 取证的 4.980 汉化整合版内容',
    fp: { erb: 4385, erh: 157, als: 19, digest: 'cddca01d8d2c' },
    expect: { hits: 36 },
  },
  {
    // 2026-11-07 实测登记（红消息「当前盘实测读数」= `{"hits":40,"kojoFiles":2406,"functionNames":104514}`）：
    // 同一条规则在这份盘上命中 40 条，形制不变（仍全 warning、全「数值槽 声明 1 / 转发 0」，K49 模板在场）。
    label: 'digest 39c2310a060d（erb 4,640 / erh 191 / als 23）= 2026-11-07 实测登记的盘',
    fp: { erb: 4640, erh: 191, als: 23, digest: '39c2310a060d' },
    expect: { hits: 40 },
  },
];

describe.skipIf(!SMOKE)('协议覆盖校验规则 —— 真实语料基线', () => {
  it('口上域全量：覆盖规则命中数与结构稳定', async () => {
    const root = SMOKE!;
    const kojoRoot = join(root, 'ERB', '口上・メッセージ関連', '個人口上');
    const routeFile = join(root, 'ERB', '口上・メッセージ関連', 'KOJO_MESSAGE.ERB');

    const io = {
      readText: async (p: string) => ({ path: p, text: readFileSync(p, 'utf-8'), encoding: 'utf-8', eol: 'lf', mtimeMs: null }),
    } as unknown as FileIO;

    const protocol = await loadEratwCallProtocol({ io, routeFile, log: silentLog });
    expect(protocol).toBeTruthy();

    const files = new Map<string, ErbFile>();
    const byName = new Map<string, ErbFunctionRef[]>();
    for (const p of walk(kojoRoot)) {
      const f = parseErbText(readFileSync(p, 'utf-8'), p);
      files.set(p, f);
      for (const fn of f.functions) {
        const refs = byName.get(fn.normalizedName) ?? [];
        refs.push({ name: fn.name, normalizedName: fn.normalizedName, filePath: fn.filePath, startLine: fn.startLine, endLine: fn.endLine });
        byName.set(fn.normalizedName, refs);
      }
    }
    const index: ErbIndex = { files, byName: functionLookupOf(byName) };
    const ctx: ConventionCheckContext = {
      project: { rootDir: root, adapterId: 'eratw', kojoPaths: [kojoRoot], writablePaths: [], charaIndex: new Map<number, CharaInfo>() },
      index,
      readFile: async (p: string) => readFileSync(p, 'utf-8'),
      log: silentLog,
    };

    const issues = (await createCallSlotCoverageRule(() => protocol!).check!(ctx)) as {
      severity: string;
      message: string;
    }[];

    // 基线：**按盘登记**（2026-11-06 指纹批）。一行 = 一份内容指纹的盘 + 那份盘上实测的命中数。
    // 匹配只走指纹（`tools/corpus-fingerprint.mjs`，认内容不认目录名）；登记表外的盘 ⇒ **红**，
    // 红消息带「期望指纹 / 当前盘指纹 / 当前盘实测命中数」，不 skip、不放宽。
    const gate = resolvePinnedRow(
      '口上域全量：覆盖规则命中数（call-slot-coverage.corpus.test.ts）',
      CALL_SLOT_PINNED,
      corpusFingerprint(root),
      { hits: issues.length, kojoFiles: files.size, functionNames: byName.size },
      () => discoverCorpusFingerprints(),
    );
    expect(gate.ok, gate.message).toBe(true);

    expect(issues).toHaveLength(gate.row?.expect.hits);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(issues.every((i) => i.message.includes('数值槽 声明 1 / 转发 0'))).toBe(true);
    // 官方模板 ORTHODOX_K49 亦在其列（说明这是**口上模板**层面的既有约定，而非孤例）
    expect(issues.some((i) => i.message.includes('M_KOJO_ORTHODOX_MESSAGE_PALAMCNG_F_K49'))).toBe(true);
  });
});