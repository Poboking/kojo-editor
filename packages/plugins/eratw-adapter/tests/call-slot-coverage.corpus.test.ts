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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CharaInfo, ConventionCheckContext, ErbFile, ErbFunctionRef, ErbIndex, FileIO, Logger } from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { loadEratwCallProtocol } from '../src/call-protocol';
import { createCallSlotCoverageRule } from '../src/conventions';

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
    const index: ErbIndex = { files, byName };
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

    // 基线：36 条，全部 warning 且形如「数值槽 声明 1 / 转发 0」。
    expect(issues).toHaveLength(36);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(issues.every((i) => i.message.includes('数值槽 声明 1 / 转发 0'))).toBe(true);
    // 官方模板 ORTHODOX_K49 亦在其列（说明这是**口上模板**层面的既有约定，而非孤例）
    expect(issues.some((i) => i.message.includes('M_KOJO_ORTHODOX_MESSAGE_PALAMCNG_F_K49'))).toBe(true);
  });
});