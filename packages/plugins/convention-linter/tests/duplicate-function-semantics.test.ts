/**
 * `erb.duplicate-function` 的引擎语义口径（2026-11-28，4.981 `specs/loader.md` 附录 D）。
 *
 * - 非事件函数重名：**后装载者生效**（`SortLabel` 字典直接赋值；`SortLabels` 取 [0]
 *   那条路径全仓无调用、是死代码）；
 * - 事件函数重名：**允许且全部执行**（#ONLY → #PRI → 普通 → #LATER 四桶）；
 * - 同文件重复定义：不报错（`WarnNormalFunctionOverloading` 才告警）。
 *
 * eraTW 4.981 全量语料实测：引擎层重名 6 名 / 30 处定义**全是事件函数**、非事件 0；
 * 文本层「≈280 处」是没建模 `[SKIPSTART]` 的假象。本闸钉住：事件族按结构豁免，
 * 不再靠各适配器维护名字白名单。
 */
import { describe, expect, it } from 'vitest';
import type {
  ConventionCheckContext,
  ErbFunctionRef,
  ErbIndex,
  GameProject,
  Logger,
} from '@kojo/plugin-api';
import { ERB_EVENT_LABEL_NAMES, functionLookupOf } from '@kojo/plugin-api';
import { duplicateFunctionRule, DUPLICATE_FUNCTION_RULE_ID } from '../src/rules/duplicate-function';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const project = {
  rootDir: 'C:/game',
  adapterId: 'test',
  kojoPaths: [],
  writablePaths: [],
  charaIndex: new Map(),
} as unknown as GameProject;

function indexOf(defs: readonly (readonly [string, string, number])[]): ErbIndex {
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const [name, filePath, startLine] of defs) {
    const normalizedName = name.toUpperCase();
    const refs = byName.get(normalizedName) ?? [];
    refs.push({ name, normalizedName, filePath, startLine, endLine: startLine + 1 });
    byName.set(normalizedName, refs);
  }
  return { files: new Map(), byName: functionLookupOf(byName) } as unknown as ErbIndex;
}

async function run(defs: readonly (readonly [string, string, number])[], policy?: ConventionCheckContext['policy']) {
  const ctx = { project, index: indexOf(defs), policy, log: silentLog, readFile: async () => '' } as ConventionCheckContext;
  return (await duplicateFunctionRule.check!(ctx)) ?? [];
}

describe('duplicate-function · 事件族按结构豁免', () => {
  it('11 枚引擎事件标签各两处定义 ⇒ 每名一条汇总 info，不逐条刷屏', async () => {
    const defs = ERB_EVENT_LABEL_NAMES.flatMap((name, i) => [
      [name, `C:/game/A${i}.ERB`, 2] as const,
      [name, `C:/game/B${i}.ERB`, 3] as const,
    ]);
    const issues = await run(defs);
    expect(issues).toHaveLength(11);
    for (const issue of issues) {
      expect(issue.ruleId).toBe(DUPLICATE_FUNCTION_RULE_ID);
      expect(issue.severity).toBe('info');
      expect(issue.message).toContain('全部执行');
      expect(issue.message).toContain('不是缺陷');
    }
    expect(issues.map((i) => i.key).sort()).toEqual(
      ERB_EVENT_LABEL_NAMES.map((n) => `${DUPLICATE_FUNCTION_RULE_ID}|event|${n}`).sort(),
    );
  });

  it('eraTW 真语料的 6 名 / 30 处 ⇒ 6 条汇总，读数逐名对得上', async () => {
    const counts = new Map([
      ['EVENTFIRST', 2], ['EVENTLOAD', 9], ['EVENTTURNEND', 2],
      ['EVENTCOMEND', 6], ['EVENTTRAIN', 7], ['EVENTCOM', 4],
    ]);
    const defs = [...counts].flatMap(([name, n]) =>
      Array.from({ length: n }, (_, i) => [name, `C:/game/f${i}.ERB`, i + 1] as const),
    );
    expect(defs).toHaveLength(30);
    const issues = await run(defs);
    expect(issues).toHaveLength(6);
    for (const [name, n] of counts) {
      const issue = issues.find((i) => i.key === `${DUPLICATE_FUNCTION_RULE_ID}|event|${name}`);
      expect(issue, name).toBeDefined();
      expect(issue!.message).toContain(`共 ${n} 处定义`);
    }
  });
});

describe('duplicate-function · 非事件仍是 info', () => {
  it('普通同名函数逐条提示，且描述写明胜出方向是后装载者', async () => {
    const issues = await run([
      ['AAA', 'C:/game/a.ERB', 1],
      ['AAA', 'C:/game/b.ERB', 2],
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('info');
    expect(issues[0]!.message).toContain('共 2 处定义');
    expect(duplicateFunctionRule.description).toContain('后装载者生效');
  });

  it('事件族优先于适配器名字白名单——策略不再需要列事件名', async () => {
    const policy = [{
      ruleId: DUPLICATE_FUNCTION_RULE_ID,
      names: ['EVENTLOAD'],
      reason: '测试用旧口径白名单',
    }];
    const issues = await run([
      ['EVENTLOAD', 'C:/game/a.ERB', 1],
      ['EVENTLOAD', 'C:/game/b.ERB', 2],
    ], policy);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.key).toBe(`${DUPLICATE_FUNCTION_RULE_ID}|event|EVENTLOAD`);
    expect(issues[0]!.message).not.toContain('测试用旧口径白名单');
  });
});
