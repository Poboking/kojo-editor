/**
 * 引擎内置·通用规则：同名函数多处定义。
 *
 * **零游戏知识**——只依赖 `ErbIndex` 结构，任何 ERB 项目都适用，
 * 因此住在引擎插件自身（游戏知识类规则一律住 game adapter）。
 *
 * 适配器可用 `conventionPolicy` 声明「哪些名字的重复是引擎语义的一部分」
 * （例如逐角色各写一份的分发函数）。命中项不逐条报，而是在本次结果里
 * **汇总成一条 info**——收敛噪声，但不抹掉发生过什么。
 */

import type { ConventionIssue, ConventionRule, ConventionSuppression } from '@kojo/plugin-api';

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
  description: '同名函数被多处定义（Emuera 只取其中一处；重复定义常见于多份剧本/补丁叠加）',
  severity: 'info',
  source: 'packages/plugins/erb-parser —— 结构索引 byName',
  check(ctx): ConventionIssue[] {
    const issues: ConventionIssue[] = [];
    const suppressions = compileSuppressions(ctx.policy);
    const suppressedTotals = new Map<string, { count: number; reason: string }>();

    for (const refs of ctx.index.byName.values()) {
      if (refs.length < 2) continue;
      const hit = matchSuppression(suppressions, refs[0]!.normalizedName);
      if (hit !== undefined) {
        const prev = suppressedTotals.get(hit.spec.reason);
        suppressedTotals.set(hit.spec.reason, {
          count: (prev?.count ?? 0) + (refs.length - 1),
          reason: hit.spec.reason,
        });
        continue;
      }
      // 首个定义留作"胜出者"，其余逐条提示（附全部定义位置便于人工判定）
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
