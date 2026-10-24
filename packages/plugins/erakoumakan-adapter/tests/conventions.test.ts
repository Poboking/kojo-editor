/**
 * 两条口上约定规则（`scope: 'file'`）的合成判据 + 真盘读数守卫。
 *
 * 合成用例钉「只在口上域的直接编号子目录里判」「KU 泛用不算孤儿」「K 编号与目录
 * 不符必须报」；真盘用例钉本机实测：错位 **1 处**（6_フラン/対あなた口上.ERB:766
 * 写 K7）、孤儿文件 **0 份**。
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
import { createKoumakanConventions } from '../src/conventions';
import { GAME_ROOT, listFilesRecursive, relOf } from './harness';

const hasCorpus = existsSync(GAME_ROOT);
const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const ROOT = 'D:/mem/eraKoumakan';
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

function rules(): { mismatch: ConventionRule; orphan: ConventionRule } {
  const list = createKoumakanConventions();
  return { mismatch: list[0]!, orphan: list[1]! };
}

/** 同步跑一条逐文件规则（契约允许 Promise，本组实现均为同步） */
function run(rule: ConventionRule, ctx: ConventionCheckContext, file: ErbFile): ConventionIssue[] {
  return rule.checkFile!(ctx, file) as ConventionIssue[];
}

describe('规则 1：K 编号与目录不符', () => {
  it('6_フラン 里写 K7 → 1 条 warning，行号指向函数头', () => {
    const path = `${KOJO}/6_フラン/対あなた口上.ERB`;
    const issues = run(
      rules().mismatch,
      ctxOf(),
      erbFile(path, ['KOJO_MESSAGE_COM_K6_300', 'KOJO_MESSAGE_COM_K7_463_1']),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleId: 'erakoumakan.kojo.chara-mismatch',
      severity: 'warning',
      filePath: path,
      line: 3,
      characterNo: 6,
    });
    expect(issues[0]!.message).toContain('K7');
    expect(issues[0]!.message).toContain('K6');
  });

  it('编号一致 / KU 泛用 / U_汎用 目录 / 更深子目录 / 根层文件 → 不报', () => {
    const { mismatch } = rules();
    const cases: Array<[string, string[]]> = [
      [`${KOJO}/4_咲夜/KOJO_K4.ERB`, ['KOJO_K4', 'KOJO_MESSAGE_COM_K4_300']],
      [`${KOJO}/4_咲夜/KOJO_KU.ERB`, ['KOJO_MESSAGE_COM_KU_300']],
      [`${KOJO}/U_汎用/NTR口上.ERB`, ['NTR_KOJO_K4_1']],
      [`${KOJO}/4_咲夜/sub/深い.ERB`, ['KOJO_MESSAGE_COM_K7_300']],
      [`${KOJO}/_KOJO_SYSTEM.ERB`, ['KOJO_MESSAGE_COM_K7_300']],
    ];
    for (const [path, names] of cases) {
      expect(run(mismatch, ctxOf(), erbFile(path, names)), path).toEqual([]);
    }
  });

  it('NTR_ 前缀的 KW 变体：角色号仍按 K 后的数字比', () => {
    const path = `${KOJO}/5_レミリア/NTR口上.ERB`;
    const bad = run(rules().mismatch, ctxOf(), erbFile(path, ['NTR_KOJO_KW6_8_0_0']));
    expect(bad).toHaveLength(1);
    const ok = run(rules().mismatch, ctxOf(), erbFile(path, ['NTR_KOJO_KW5_8_0_0']));
    expect(ok).toEqual([]);
  });
});

describe('规则 2：整份文件没有可路由的口上函数', () => {
  it('只有 MSG_* 辅助函数 → 1 条 warning（指向首个函数行）', () => {
    const path = `${KOJO}/6_フラン/helpers.ERB`;
    const issues = run(rules().orphan, ctxOf(), erbFile(path, ['MSG_THING', 'MSG_OTHER']));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleId: 'erakoumakan.kojo.orphan-file',
      severity: 'warning',
      filePath: path,
      line: 2,
    });
  });

  it('有任意可解析形态（含 KU）→ 不算孤儿；U_汎用 / 根层 / 空文件不审', () => {
    const { orphan } = rules();
    expect(run(orphan, ctxOf(), erbFile(`${KOJO}/4_咲夜/a.ERB`, ['KOJO_MESSAGE_COM_KU_300']))).toEqual([]);
    expect(run(orphan, ctxOf(), erbFile(`${KOJO}/U_汎用/a.ERB`, ['MSG_THING']))).toEqual([]);
    expect(run(orphan, ctxOf(), erbFile(`${KOJO}/_KOJO_SYSTEM.ERB`, ['MSG_THING']))).toEqual([]);
    expect(run(orphan, ctxOf(), erbFile(`${KOJO}/4_咲夜/empty.ERB`, []))).toEqual([]);
  });
});

describe('真盘实测（守卫：D:/Game/eraKoumakan 存在才跑）', () => {
  it.skipIf(!hasCorpus)('错位 1 处（6_フラン/対あなた口上.ERB:766 K7），孤儿 0 份', () => {
    const { mismatch, orphan } = rules();
    const ctx = ctxOf(GAME_ROOT);
    const mismatches: ConventionIssue[] = [];
    const orphans: ConventionIssue[] = [];
    for (const path of listFilesRecursive(`${GAME_ROOT}/ERB/口上`, /\.erb$/i)) {
      const text = readFileSync(path, 'utf8');
      const names: string[] = [];
      for (const m of text.matchAll(/^\s*@([^\s,;(]+)/gm)) names.push(m[1]!);
      const file = erbFile(path, names);
      // 行号按真实文本校正（erbFile 给的是占位行；真盘断言需要 766）
      for (const fn of file.functions) {
        const re = new RegExp(`^\\s*@${fn.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
        const hit = re.exec(text);
        if (hit) fn.startLine = text.slice(0, hit.index).split('\n').length;
      }
      mismatches.push(...run(mismatch, ctx, file));
      orphans.push(...run(orphan, ctx, file));
    }
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ line: 766, characterNo: 6 });
    expect(relOf(GAME_ROOT, mismatches[0]!.filePath!)).toBe('ERB/口上/6_フラン/対あなた口上.ERB');
    expect(orphans).toEqual([]);
  });
});
