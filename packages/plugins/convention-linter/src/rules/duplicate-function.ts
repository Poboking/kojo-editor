/**
 * 引擎内置·通用规则：同名函数多处定义。
 *
 * **零游戏知识**——只依赖 `ErbIndex` 结构，任何 ERB 项目都适用，
 * 因此住在引擎插件自身（游戏知识类规则一律住 game adapter）。
 */

import type { ConventionIssue, ConventionRule } from '@kojo/plugin-api';

export const DUPLICATE_FUNCTION_RULE_ID = 'erb.duplicate-function';

export const duplicateFunctionRule: ConventionRule = {
  id: DUPLICATE_FUNCTION_RULE_ID,
  description: '同名函数被多处定义（Emuera 只取其中一处；重复定义常见于多份剧本/补丁叠加）',
  severity: 'info',
  source: 'packages/plugins/erb-parser —— 结构索引 byName',
  check(ctx): ConventionIssue[] {
    const issues: ConventionIssue[] = [];
    for (const refs of ctx.index.byName.values()) {
      if (refs.length < 2) continue;
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
    return issues;
  },
};
