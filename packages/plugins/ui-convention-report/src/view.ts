/**
 * 面板分组视图的**构造**（纯函数：视角 + 条目 → 有序分组 + 那一句总账）。
 *
 * 面板组件只做状态搬运（订阅报告、展开/收起、渲染上限），一切"怎么分组、按什么排"
 * 的判据都在这里 —— 与 `ownership.ts` 同一条纪律：能在 React 外面测的，一律不放进去。
 */

import type { CharaInfo, ConventionIssue } from '@kojo/plugin-api';
import {
  characterLabel,
  rollupByCharacter,
  rollupByFamily,
  rollupSummary,
  type OwnershipDeps,
  type RollupGroup,
  type RollupMode,
} from './ownership';

/** 作者面上的三个切换项（默认 `rule` = 本批之前的视图，一字未动） */
export type GroupMode = 'rule' | RollupMode;

export const GROUP_MODES: readonly GroupMode[] = ['rule', 'character', 'family'];

export const GROUP_MODE_LABEL: Record<GroupMode, string> = {
  rule: '按规则看',
  character: '按角色看',
  family: '按家族看',
};

export interface PanelGroup {
  /** 渲染 key 与展开状态的键（切换视角时各自独立，互不串台） */
  readonly key: string;
  /** 主标签：规则视角=规则标识，角色/家族视角=归属名 */
  readonly title: string;
  /** 次行说明：规则视角=规则描述，其余=严重度构成 */
  readonly desc: string;
  readonly count: number;
  readonly issues: readonly ConventionIssue[];
  /** 角色/家族视角里条目行要带规则标识（一组里混着多条规则）；规则视角不需要 */
  readonly showRuleTag: boolean;
}

export interface GroupView {
  readonly groups: readonly PanelGroup[];
  /** 归属总账那句话（规则视角为 null —— 那个视角不需要账） */
  readonly summary: string | null;
}

export interface GroupViewDeps {
  /** 规则标识 → 人类描述（规则清单里没有的 id 原样显示，不编造） */
  readonly ruleDescription: (ruleId: string) => string;
  readonly ownership: OwnershipDeps;
  readonly charaIndex: ReadonlyMap<number, CharaInfo> | null;
}

/** 严重度构成（0 的档位不写，免得一行里全是"错误 0"） */
function severityBreakdown(g: RollupGroup): string {
  const parts: string[] = [];
  if (g.counts.error > 0) parts.push(`错误 ${g.counts.error}`);
  if (g.counts.warning > 0) parts.push(`警告 ${g.counts.warning}`);
  if (g.counts.info > 0) parts.push(`提示 ${g.counts.info}`);
  return parts.join(' / ');
}

/** 码点比较（与 `ownership.ts` 同口径：不用 localeCompare，跨主机不抖） */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byRule(issues: readonly ConventionIssue[], ruleDescription: (id: string) => string): PanelGroup[] {
  const map = new Map<string, ConventionIssue[]>();
  for (const issue of issues) {
    const arr = map.get(issue.ruleId);
    if (arr) arr.push(issue);
    else map.set(issue.ruleId, [issue]);
  }
  return [...map.entries()]
    .sort((a, b) => b[1].length - a[1].length || cmp(a[0], b[0]))
    .map(([ruleId, list]) => ({
      key: `R\u0000${ruleId}`,
      title: ruleId,
      desc: ruleDescription(ruleId),
      count: list.length,
      issues: list,
      showRuleTag: false,
    }));
}

/**
 * 构建当前视角的分组。
 * 角色/家族视角才付归属判定的代价（`functionAt` 走索引、家族规则走适配器 memo）——
 * 默认视角（规则）走不到那一行，零成本纪律由此保证。
 */
export function buildGroupView(mode: GroupMode, issues: readonly ConventionIssue[], deps: GroupViewDeps): GroupView {
  if (mode === 'rule') {
    return { groups: byRule(issues, deps.ruleDescription), summary: null };
  }
  const labelOf = (no: number): string => characterLabel(no, deps.charaIndex);
  const result = mode === 'character' ? rollupByCharacter(issues, deps.ownership, labelOf) : rollupByFamily(issues, deps.ownership, labelOf);
  return {
    groups: result.groups.map((g) => ({
      key: g.key,
      title: g.label,
      desc: severityBreakdown(g),
      count: g.count,
      issues: g.issues,
      showRuleTag: true,
    })),
    summary: rollupSummary(mode, result),
  };
}
