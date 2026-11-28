/**
 * 引擎内置·通用规则：同名函数多处定义。
 *
 * **零游戏知识**——只依赖 `ErbIndex` 结构，任何 ERB 项目都适用，
 * 因此住在引擎插件自身（游戏知识类规则一律住 game adapter）。
 *
 * **事件标签按结构豁免**（2026-11-28，4.981 `IdentifierDictionary.cs::IsEventLabelName`）：
 * 那 11 枚允许多处定义且**全部执行**（#ONLY → #PRI → 普通 → #LATER 四桶），
 * 逐条报"重复"是假问题——eraTW 真语料实测 6 枚 / 30 处定义，非事件重名 0。
 * 这类只汇总成一条 info，不再需要各适配器按名字列白名单。
 *
 * 非事件函数的胜出方向是**后装载者**（`SortLabel` 字典直接赋值；
 * `SortLabels` 排序取 [0] 那条路径全仓无调用、是死代码），见 `specs/loader.md` 附录 D。
 *
 * 适配器仍可用 `conventionPolicy` 声明游戏侧约定（例如逐角色各写一份的分发函数）。
 * 命中项同样**汇总成一条 info**——收敛噪声，但不抹掉发生过什么。
 */

import type { ConventionIssue, ConventionRule, ConventionSuppression } from '@kojo/plugin-api';
import { isErbEventLabelName, isLibraryOnlyPath } from '@kojo/plugin-api';

export const DUPLICATE_FUNCTION_RULE_ID = 'erb.duplicate-function';

interface CompiledSuppression {
  readonly spec: ConventionSuppression;
  readonly names: ReadonlySet<string>;
  readonly pattern?: RegExp;
}

function compileSuppressions(
  policy: readonly ConventionSuppression[] | undefined,
): CompiledSuppression[] {
  return (policy ?? [])
    .filter((s) => s.ruleId === DUPLICATE_FUNCTION_RULE_ID)
    .map((spec) => ({
      spec,
      names: new Set((spec.names ?? []).map((n) => n.toUpperCase())),
      pattern: spec.namePattern === undefined ? undefined : new RegExp(spec.namePattern, 'i'),
    }));
}

function matchSuppression(
  suppressions: readonly CompiledSuppression[],
  normalizedName: string,
): CompiledSuppression | undefined {
  return suppressions.find(
    (s) => s.names.has(normalizedName) || (s.pattern !== undefined && s.pattern.test(normalizedName)),
  );
}

export const duplicateFunctionRule: ConventionRule = {
  id: DUPLICATE_FUNCTION_RULE_ID,
  description: '同名函数被多处定义（非事件：后装载者生效；事件标签：全部执行、按结构豁免）',
  severity: 'info',
  source: 'packages/plugins/erb-parser —— 结构索引 byName',
  check(ctx): ConventionIssue[] {
    const issues: ConventionIssue[] = [];
    const suppressions = compileSuppressions(ctx.policy);
    const suppressedTotals = new Map<string, { count: number; reason: string }>();
    const eventTotals = new Map<string, number>();

    for (const allRefs of ctx.index.byName.values()) {
      // 只读基座库里的重复是游戏自带形态，不是作者要修的东西：只在作者范围内判重
      const refs = allRefs.filter((r) => !isLibraryOnlyPath(ctx.project, r.filePath));
      if (refs.length < 2) continue;
      const name = refs[0]!.normalizedName;
      // 事件标签允许多处定义且全部执行；逐条报只会制造假问题（eraTW 实测 6 名 / 30 处）
      if (isErbEventLabelName(name)) {
        eventTotals.set(name, (eventTotals.get(name) ?? 0) + refs.length);
        continue;
      }
      const hit = matchSuppression(suppressions, name);
      if (hit !== undefined) {
        const prev = suppressedTotals.get(hit.spec.reason);
        suppressedTotals.set(hit.spec.reason, {
          count: (prev?.count ?? 0) + (refs.length - 1),
          reason: hit.spec.reason,
        });
        continue;
      }
      // 非事件是「后装载者胜出」，这里不声称谁胜出（装载序还受路径排序影响），
      // 只逐条给出位置，附全部定义点便于人工判定；改哪一处由作者决定。
      const where = refs.map((r) => `${r.filePath}:${r.startLine}`).join(' | ');
      for (let i = 1; i < refs.length; i++) {
        const ref = refs[i]!;
        issues.push({
          ruleId: DUPLICATE_FUNCTION_RULE_ID,
          severity: 'info',
          message: `「${ref.name}」共 ${refs.length} 处定义，本处为第 ${i + 1} 处。全部：${where}`,
          filePath: ref.filePath,
          line: ref.startLine,
          key: `${DUPLICATE_FUNCTION_RULE_ID}|${ref.normalizedName}|${ref.filePath}|${ref.startLine}`,
        });
      }
    }

    // 事件族留一条汇总：不逐条刷屏，也不把「这里发生了什么」藏掉
    for (const [name, count] of eventTotals) {
      issues.push({
        ruleId: DUPLICATE_FUNCTION_RULE_ID,
        severity: 'info',
        message:
          `「${name}」共 ${count} 处定义：引擎事件标签允许多处定义且全部执行` +
          `（#ONLY → #PRI → 普通 → #LATER 四桶），不是缺陷。`,
        key: `${DUPLICATE_FUNCTION_RULE_ID}|event|${name}`,
      });
    }

    // 收敛也要留痕：一行汇总，说明「按谁的理由略过了多少处」
    for (const [reason, { count }] of suppressedTotals) {
      issues.push({
        ruleId: DUPLICATE_FUNCTION_RULE_ID,
        severity: 'info',
        message: `已按适配器策略收敛 ${count} 处预期重复：${reason}`,
        key: `${DUPLICATE_FUNCTION_RULE_ID}|suppressed|${reason}|${count}`,
      });
    }
    return issues;
  },
};
