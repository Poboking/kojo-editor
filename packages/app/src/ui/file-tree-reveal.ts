/**
 * 文件树「展开全部 / 收起全部」的判定与反馈（零 React，2026-10-13 UI 反馈 6）。
 *
 * 实机读数是这么回事：右键根节点的菜单项**确实生效**（0 → 193 个角色 / 2713 行文件），
 * 但当所有角色目录已经展开过一遍后，再点它**毫无变化也没有任何交代**——
 * 用户于是读成"点了没反应"。这不是断线，是**缺反馈**：一个批量动作既不可逆
 * （没有收起）、又不在"已经是全部展开"时告诉用户它什么都没做。
 *
 * 所以这个模块把动作做成**幂等可逆的开关**，并且每次按下都必须留下一句可读数。
 * 判据与文案都放这里，组件只管接线——这样"有没有反馈"才是可测的。
 */

/** 一个角色目录（组）及其下的作者包目录名 */
export interface RevealGroup {
  readonly label: string;
  /** 包目录名；不含"直接挂在角色根下的散文件"（它们没有包层，无需展开） */
  readonly packages: readonly string[];
}

/** 当前展开态（两组键，语义与 FileTree 既有实现一致） */
export interface RevealState {
  readonly openedGroups: ReadonlySet<string>;
  readonly openedPackages: ReadonlySet<string>;
}

/** 结果集（写回 React state 用） */
export interface RevealResult {
  readonly mode: 'expand' | 'collapse';
  readonly openedGroups: Set<string>;
  readonly openedPackages: Set<string>;
  readonly groupCount: number;
  readonly packageCount: number;
  /** 一句可读数：用户按下去之后必须知道发生了什么 */
  readonly feedback: string;
}

/** 包键唯一真源：`FileTree` 的渲染计划、展开集合读写与定位计划全部走这里（FE-REF 收口，
 *  此前组件里有三处手写同形模板、注释还得叮嘱"改这里必须同时改那边"） */
export function packageKey(groupLabel: string, pkgLabel: string): string {
  return `${groupLabel}::${pkgLabel}`;
}

/** 是否已经是"全部展开"——决定这次按下去是展开还是收起 */
export function isFullyRevealed(groups: readonly RevealGroup[], state: RevealState): boolean {
  if (groups.length === 0) return false;
  for (const g of groups) {
    if (!state.openedGroups.has(g.label)) return false;
    for (const p of g.packages) {
      if (!state.openedPackages.has(packageKey(g.label, p))) return false;
    }
  }
  return true;
}

/**
 * 菜单项文案：**先告诉用户这次按下去会发生什么**。
 * 全展开时它不再是"显示所有文件和文件夹"（那会让人以为点了应该有东西冒出来）。
 */
export function revealMenuLabel(groups: readonly RevealGroup[], state: RevealState): string {
  return isFullyRevealed(groups, state) ? '收起全部文件和文件夹' : '显示所有文件和文件夹（全部角色）';
}

/**
 * 展开全部：结果是**并集**（不丢掉用户手工展开过的别处），并给出这次新增了多少。
 *
 * 「展开角色组」与「展开组里的作者包」是**两件事**——旧实现里工具条那颗「展开全部」
 * 只做了前者，于是点了之后包还是折叠的，用户读作"没生效"。这里恒把两层一起处理。
 */
export function expandAll(groups: readonly RevealGroup[], state: RevealState): RevealResult {
  const openedGroups = new Set(state.openedGroups);
  const openedPackages = new Set(state.openedPackages);
  let addedGroups = 0;
  let addedPackages = 0;
  for (const g of groups) {
    if (!openedGroups.has(g.label)) {
      openedGroups.add(g.label);
      addedGroups++;
    }
    for (const p of g.packages) {
      const key = packageKey(g.label, p);
      if (!openedPackages.has(key)) {
        openedPackages.add(key);
        addedPackages++;
      }
    }
  }
  return {
    mode: 'expand',
    openedGroups,
    openedPackages,
    groupCount: addedGroups,
    packageCount: addedPackages,
    feedback:
      addedGroups === 0 && addedPackages === 0
        ? '已经是全部展开（没有新内容可显示）'
        : `已展开 ${addedGroups} 个角色目录、${addedPackages} 个作者包`,
  };
}

/** 收起全部：清空两组键（组内折叠与真实文件夹内容都回默认态） */
export function collapseAll(): RevealResult {
  return {
    mode: 'collapse',
    openedGroups: new Set(),
    openedPackages: new Set(),
    groupCount: 0,
    packageCount: 0,
    feedback: '已收起全部角色目录与作者包',
  };
}

/**
 * 一键展开 / 一键收起——**按下去的方向由当前状态决定**，因此它可逆，
 * 也永远不会出现"已经是全展开、再点一次毫无交代"那种读感。
 */
export function toggleReveal(groups: readonly RevealGroup[], state: RevealState): RevealResult {
  return isFullyRevealed(groups, state) ? collapseAll() : expandAll(groups, state);
}
