import { describe, expect, it } from 'vitest';
import {
  isFullyRevealed,
  packageKey,
  revealMenuLabel,
  toggleReveal,
  type RevealGroup,
  type RevealState,
} from '../src/ui/file-tree-reveal';

/**
 * 文件树「展开全部 / 收起全部」的判定与反馈单测（2026-10-13 UI 反馈 6）。
 *
 * 实机读数：菜单项**确实生效**（0 → 193 个角色 / 2713 行文件），但在全已展开时再点
 * 就没有任何变化、也没有任何交代 ⇒ 用户读作"点了没反应"。所以这里钉的是两件事：
 * ①动作必须**可逆**（全展开时它是收起）；②每次按下去都必须留下**可读数反馈**。
 */

const GROUPS: RevealGroup[] = [
  { label: '#1 Reimu', packages: ['of_new_kojo', 'extra_pack'] },
  { label: '#49 觉', packages: ['dreaming'] },
  { label: '#159 先代', packages: [] }, // 散文件直接挂角色根下，无包层
];

const EMPTY: RevealState = { openedGroups: new Set(), openedPackages: new Set() };

describe('包键', () => {
  it('与 FileTree 既有键形 `${组}::${包}` 一致（改了这边不改那边＝张冠李戴）', () => {
    expect(packageKey('#49 觉', 'dreaming')).toBe('#49 觉::dreaming');
  });
});

describe('全展开判定', () => {
  it('一棵树都没有 ⇒ false（没有东西可收起，菜单不该反向）', () => {
    expect(isFullyRevealed([], EMPTY)).toBe(false);
    expect(revealMenuLabel([], EMPTY)).toBe('显示所有文件和文件夹（全部角色）');
  });

  it('什么都没展开 ⇒ false；只展开组、没展开包 ⇒ 仍 false', () => {
    expect(isFullyRevealed(GROUPS, EMPTY)).toBe(false);
    const onlyGroups: RevealState = { openedGroups: new Set(GROUPS.map((g) => g.label)), openedPackages: new Set() };
    expect(isFullyRevealed(GROUPS, onlyGroups)).toBe(false);
  });

  it('组与每个包都展开 ⇒ true；漏一个包 ⇒ false（逐个数，不做近似）', () => {
    const all: RevealState = {
      openedGroups: new Set(GROUPS.map((g) => g.label)),
      openedPackages: new Set(['#1 Reimu::of_new_kojo', '#1 Reimu::extra_pack', '#49 觉::dreaming']),
    };
    expect(isFullyRevealed(GROUPS, all)).toBe(true);
    const missingOne: RevealState = {
      openedGroups: all.openedGroups,
      openedPackages: new Set(['#1 Reimu::of_new_kojo', '#49 觉::dreaming']),
    };
    expect(isFullyRevealed(GROUPS, missingOne)).toBe(false);
  });

  it('无包层的角色目录不参与判定（散文件本来就看得见）', () => {
    const st: RevealState = {
      openedGroups: new Set(GROUPS.map((g) => g.label)),
      openedPackages: new Set(['#1 Reimu::of_new_kojo', '#1 Reimu::extra_pack', '#49 觉::dreaming']),
    };
    expect(isFullyRevealed([{ label: '#159 先代', packages: [] }], st)).toBe(true);
  });

  it('全展开 ⇒ 菜单反向成「收起全部」（这就是反馈缺失的正面解法）', () => {
    const all: RevealState = {
      openedGroups: new Set(GROUPS.map((g) => g.label)),
      openedPackages: new Set(['#1 Reimu::of_new_kojo', '#1 Reimu::extra_pack', '#49 觉::dreaming']),
    };
    expect(revealMenuLabel(GROUPS, all)).toBe('收起全部文件和文件夹');
  });
});

describe('一键展开 / 收起', () => {
  it('初始态按下 ⇒ 展开，并给出条数反馈（不许回一句空话）', () => {
    const r = toggleReveal(GROUPS, EMPTY);
    expect(r.mode).toBe('expand');
    expect(r.openedGroups.size).toBe(3);
    expect(r.openedPackages.size).toBe(3);
    expect(r.feedback).toContain('3');
  });

  it('展开是**并集**：用户手工展开过的别处不被覆盖', () => {
    const partial: RevealState = { openedGroups: new Set(['别组的展开']), openedPackages: new Set(['#49 觉::dreaming']) };
    const r = toggleReveal(GROUPS, partial);
    expect(r.mode).toBe('expand');
    expect(r.openedGroups.has('别组的展开')).toBe(true);
    expect(r.openedPackages.has('#1 Reimu::of_new_kojo')).toBe(true);
  });

  it('全展开后再按 ⇒ 收起（清空两组键），而不是"又展开一遍、看起来没反应"', () => {
    const expanded = toggleReveal(GROUPS, EMPTY);
    const again = toggleReveal(GROUPS, {
      openedGroups: expanded.openedGroups,
      openedPackages: expanded.openedPackages,
    });
    expect(again.mode).toBe('collapse');
    expect(again.openedGroups.size).toBe(0);
    expect(again.openedPackages.size).toBe(0);
    expect(again.feedback).toContain('收起');
  });

  it('两次按下回到原点（幂等可逆，用户不会把自己锁在展开态里）', () => {
    const once = toggleReveal(GROUPS, EMPTY);
    const twice = toggleReveal(GROUPS, { openedGroups: once.openedGroups, openedPackages: once.openedPackages });
    expect(isFullyRevealed(GROUPS, { openedGroups: twice.openedGroups, openedPackages: twice.openedPackages })).toBe(false);
  });

  it('反馈永不为空串——按下去必须有一句可交代', () => {
    for (const st of [EMPTY, { openedGroups: new Set(['a']), openedPackages: new Set(['a::b']) }] as RevealState[]) {
      expect(toggleReveal(GROUPS, st).feedback.trim().length).toBeGreaterThan(0);
    }
  });
});
