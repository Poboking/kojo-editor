/**
 * 约定规则：函数名角色号 vs 文件编号。
 *
 * 合成用例钉判据（只审口上域、只比可归属函数、无编号路由不报）；
 * 真盘用例钉本机实测 0 处错位——规则是改文件后的守卫，不是历史欠账。
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
import { createErasqcConventions, RULE_CHARA_MISMATCH } from '../src/conventions';
import { GAME_ROOT, listFilesRecursive } from './harness';

const hasCorpus = existsSync(GAME_ROOT);
const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const ROOT = 'C:/mem/eraSQC';
const KOJO = `${ROOT}/ERB/EVENT_K`;

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

describe('规则：函数名角色号与文件编号不符', () => {
  it('EVENT_K07 里写 `_6_1` → 1 条 warning，行号指向函数头', () => {
    const path = `${KOJO}/EVENT_K07.ERB`;
    const issues = run(
      createErasqcConventions()[0]!,
      ctxOf(),
      erbFile(path, ['KOJO_MESSAGE_COM_7_1', 'KOJO_MESSAGE_COM_6_1']),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleId: RULE_CHARA_MISMATCH,
      severity: 'warning',
      filePath: path,
      line: 3,
      characterNo: 7,
    });
    expect(issues[0]!.message).toContain('角色 6');
    expect(issues[0]!.message).toContain('7 号');
  });

  it('编号一致 / 无编号路由 / 非口上文件 → 不报', () => {
    const rule = createErasqcConventions()[0]!;
    const cases: Array<[string, string[]]> = [
      [`${KOJO}/EVENT_K04_2.ERB`, ['KOJO_MESSAGE_COM_4_2', 'SELF_KOJO_K4_2']],
      [`${KOJO}/EVENT_K04.ERB`, ['KOJO_MESSAGE_COM', 'SELF_KOJO', 'EVENTTRAIN']],
      [`${KOJO}/CALL_NAME.ERB`, ['CNAME', 'CNAMET']],
      [`${KOJO}/EVENT_K.ERB`, ['KOJO_MESSAGE_COM_6_1']],
      [`${ROOT}/ERB/EVENT/EVENT_RANKOU.ERB`, ['KOJO_MESSAGE_COM_6_1']],
    ];
    for (const [path, names] of cases) {
      expect(run(rule, ctxOf(), erbFile(path, names)), path).toEqual([]);
    }
  });

  it('DEVENT 文件同样按文件名编号比', () => {
    const path = `${KOJO}/DEVENT_K08.ERB`;
    const bad = run(createErasqcConventions()[0]!, ctxOf(), erbFile(path, ['DAILY_LIFE_MESSAGE_9_1']));
    expect(bad).toHaveLength(1);
    const ok = run(createErasqcConventions()[0]!, ctxOf(), erbFile(path, ['DAILY_LIFE_MESSAGE_8_1']));
    expect(ok).toEqual([]);
  });
});

describe('真盘全量（守卫：C:/game/eraSQC 存在才跑）', () => {
  it.skipIf(!hasCorpus)('111 份口上文件 0 处编号错位', () => {
    const rule = createErasqcConventions()[0]!;
    const files = listFilesRecursive(KOJO.replace(ROOT, GAME_ROOT), /\.ERB$/i);
    const issues: ConventionIssue[] = [];
    for (const file of files) {
      const names: string[] = [];
      for (const m of readFileSync(file, 'utf8').matchAll(/^@([^\r\n]+)/gm)) {
        const name = (m[1] ?? '').split(/[\s,(;]/)[0]!.trim();
        if (name.length > 0) names.push(name);
      }
      issues.push(...run(rule, ctxOf(GAME_ROOT), erbFile(file, names)));
    }
    expect(issues).toEqual([]);
  });
});
