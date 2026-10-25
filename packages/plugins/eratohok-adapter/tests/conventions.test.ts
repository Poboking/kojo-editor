/**
 * 唯一一条口上约定规则（`scope: 'file'`）的合成判据 + 真盘读数守卫。
 *
 * 合成用例钉「只在该口上域编号目录（含 `DAILY/` 一层）里判」「_KXXX 模板不算错位」
 * 「目录外的文件不判」；真盘用例钉本机实测：错位 **1 处**
 * （22 紫口上/KOJO_C_K22.ERB:40 写 K8）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  ConventionCheckContext,
  ConventionIssue,
  ConventionRule,
  ErbFile,
  GameProject,
} from '@kojo/plugin-api';
import { createTohokConventions } from '../src/conventions';
import { GAME_ROOT, listFilesRecursive, relOf } from './harness';

const hasCorpus = existsSync(GAME_ROOT);
const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const ROOT = 'D:/mem/eratohoK';
const KOJO = `${ROOT}/ERB/口上`;

function ctxOf(rootDir = ROOT): ConventionCheckContext {
  return {
    project: { rootDir } as GameProject,
    index: {} as never,
    readFile: async () => '',
    log: silentLog,
  };
}

function erbFile(path: string, names: readonly string[]): ErbFile {
  return {
    path,
    functions: names.map((name, i) => ({
      name,
      normalizedName: name.toUpperCase(),
      params: [],
      startLine: i + 2,
      endLine: i + 3,
      filePath: path,
    })),
    dims: [],
    hasFunctionDirective: false,
    lineCount: names.length + 2,
  };
}

function run(rule: ConventionRule, ctx: ConventionCheckContext, file: ErbFile): ConventionIssue[] {
  return rule.checkFile!(ctx, file) as ConventionIssue[];
}

describe('chara-mismatch —— 合成判据', () => {
  const rule = createTohokConventions()[0]!;
  const ctx = ctxOf();

  it('目录 22 写 K8 → 报 1 条 warning', () => {
    const issues = run(rule, ctx, erbFile(`${KOJO}/22 紫口上/KOJO_C_K22.ERB`, [
      'KOJO_COM_AFTER_C_K22',
      'KOJO_COM_AFTER_C_K8',
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ ruleId: 'eratohok.kojo.chara-mismatch', severity: 'warning' });
    expect(issues[0]!.message).toContain('K8');
    expect(issues[0]!.characterNo).toBe(22);
  });

  it(`DAILY/ 一层照判（目录 9 的每日事件写 K10）`, () => {
    const issues = run(rule, ctx, erbFile(`${KOJO}/09 咲夜口上/DAILY/KOJO_DAILY_K10_X.ERB`, [
      'KOJO_DAILY_K10_X',
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.characterNo).toBe(9);
  });

  it('`_KXXX` 模板占位不报（随机角色目录的合法形态）', () => {
    const issues = run(rule, ctx, erbFile(`${KOJO}/1205 ランダムキャラ軍師/KOJO_B_K1205.ERB`, [
      'KOJO_TRAIN_START_B_KXXX',
      'KOJO_COM_B_KXXX',
    ]));
    expect(issues).toEqual([]);
  });

  it('口上域**之外**的文件不判（公共文件 / 深层自建目录）', () => {
    expect(run(rule, ctx, erbFile(`${KOJO}/_KOJO_SYSTEM.ERB`, ['KOJO_COM_AFTER_K8']))).toEqual([]);
    expect(
      run(rule, ctx, erbFile(`${KOJO}/01 霊夢口上/自建/深い/ファイル.ERB`, ['KOJO_COM_K999'])),
    ).toEqual([]);
  });

  it('无角色号的公共函数不判（`KOJO_HAIR_NAME` / `KOJO_ASK`）', () => {
    expect(
      run(rule, ctx, erbFile(`${KOJO}/09 咲夜口上/KOJO_FUNCTION_K9_K10.ERB`, ['KOJO_HAIR_NAME'])),
    ).toEqual([]);
  });
});

describe('chara-mismatch —— 真盘读数（守卫：D:/game/eratohoK 存在才跑）', () => {
  it.skipIf(!hasCorpus)('全口上域只有 22 号目录那一处错位', () => {
    const rule = createTohokConventions()[0]!;
    const ctx = ctxOf(GAME_ROOT);
    const files = listFilesRecursive(`${GAME_ROOT}/ERB/口上`, /\.ERB$/i);

    const issues: ConventionIssue[] = [];
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      const names: string[] = [];
      const starts: number[] = [];
      let lineNo = 0;
      for (const line of text.split(/\r\n|\n/)) {
        lineNo++;
        if (!line.startsWith('@')) continue;
        let name = line.slice(1).trim();
        const paren = name.indexOf('(');
        if (paren >= 0) name = name.slice(0, paren);
        names.push(name);
        starts.push(lineNo);
      }
      if (names.length === 0) continue;
      // 真盘用例必须用**真实行号**（合成 helper 的 i+2 会让行号断言失真）
      const realFile: ErbFile = {
        path,
        functions: names.map((name, i) => ({
          name,
          normalizedName: name.toUpperCase(),
          params: [],
          startLine: starts[i]!,
          endLine: starts[i]!,
          filePath: path,
        })),
        dims: [],
        hasFunctionDirective: false,
        lineCount: lineNo,
      };
      for (const issue of run(rule, ctx, realFile)) issues.push(issue);
    }

    expect(issues).toHaveLength(1);
    expect(relOf(`${GAME_ROOT}/ERB/口上`, issues[0]!.filePath!)).toBe('22 紫口上/KOJO_C_K22.ERB');
    expect(issues[0]!.line).toBe(40);
    expect(issues[0]!.message).toContain('KOJO_COM_AFTER_C_K8');
  });
});
