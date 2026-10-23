/**
 * 约定校验面板右键菜单（1023 覆盖面批 · WP5.2）。
 *
 * 判据：条目 / 分组头 / 面板空白处三类菜单的项集合、无定位问题的禁用原因、
 * 分组视角的勾选态、在跑时才出现的「叫停」、动作分发与宿主缺席降级。
 */
import { describe, expect, it } from 'vitest';
import { hasCjkLabel, type PluginContextMenuRequest } from '@kojo/plugin-api';
import {
  CONVENTION_GROUP_MENU_ARIA,
  CONVENTION_ISSUE_MENU_ARIA,
  CONVENTION_MODE_LABEL,
  CONVENTION_PANEL_MENU_ARIA,
  buildConventionPanelMenu,
  buildGroupMenu,
  buildIssueMenu,
  issueCopyText,
  openConventionPanelMenu,
  openGroupMenu,
  openIssueMenu,
  runIssueAction,
  runPanelAction,
  type ConventionMenuHost,
  type IssueMenuTarget,
} from '../src/context-menu';

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

function issue(overrides: Partial<IssueMenuTarget> = {}): IssueMenuTarget {
  return {
    message: '角色 ID 用全角数字',
    filePath: 'src/erb/角色.erb',
    line: 12,
    ruleId: 'chara-id-width',
    severityLabel: '错误',
    ...overrides,
  };
}

function hostSpy(): ConventionMenuHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    openIssue: (t) => void calls.push(`open:${t.filePath ?? ''}:${t.line ?? ''}`),
    copy: (text) => void calls.push(`copy:${text}`),
    rerun: () => void calls.push('rerun'),
    stop: () => void calls.push('stop'),
    setMode: (m) => void calls.push(`mode:${m}`),
  };
}

describe('条目行菜单', () => {
  it('有定位：跳到位置 + 复制问题', () => {
    expect(ids(buildIssueMenu(issue()))).toEqual(['issue.open', 'issue.copy']);
    expect(buildIssueMenu(issue()).every((i) => hasCjkLabel(i.label))).toBe(true);
  });

  it('没有文件定位：跳转项禁用并说清原因（整项目结论仍可复制）', () => {
    for (const filePath of [null, undefined, '']) {
      const items = buildIssueMenu(issue({ filePath, line: undefined }));
      const open = items.find((i) => i.id === 'issue.open');
      expect(open?.disabled).toBe(true);
      expect(open?.disabledReason).toContain('没有文件定位');
      expect(items.find((i) => i.id === 'issue.copy')?.disabled).toBeUndefined();
    }
  });

  it('复制文本含位置 / 严重度 / 规则 / 正文', () => {
    expect(issueCopyText(issue())).toBe(
      'src/erb/角色.erb:12 [错误] chara-id-width — 角色 ID 用全角数字',
    );
    expect(issueCopyText(issue({ filePath: null, line: undefined }))).toBe(
      '[错误] chara-id-width — 角色 ID 用全角数字',
    );
  });
});

describe('分组头菜单', () => {
  it('展开态换文案（同一个 id）', () => {
    expect(buildGroupMenu({ title: 'chara-id-width', expanded: false, count: 3 })[0]?.label).toBe(
      '展开本组',
    );
    expect(buildGroupMenu({ title: 'chara-id-width', expanded: true, count: 3 })[0]?.label).toBe(
      '收起本组',
    );
  });

  it('项集合：展开/收起 · 复制分组名 · 重新校验；全中文', () => {
    const items = buildGroupMenu({ title: '规则', expanded: false, count: 3 });
    expect(ids(items)).toEqual(['group.toggle', 'group.copyTitle', 'panel.rerun']);
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
  });
});

describe('面板空白处菜单 · 分组视角', () => {
  it('三个视角都在，当前那个打勾（同一个 id 不做两个入口）', () => {
    const items = buildConventionPanelMenu('character', false);
    const modes = items.filter((i) => i.id.startsWith('mode.'));
    expect(modes.map((i) => i.id)).toEqual(['mode.rule', 'mode.character', 'mode.family']);
    expect(modes.map((i) => i.checked)).toEqual([false, true, false]);
    expect(modes.map((i) => i.label)).toEqual([
      CONVENTION_MODE_LABEL.rule,
      CONVENTION_MODE_LABEL.character,
      CONVENTION_MODE_LABEL.family,
    ]);
  });

  it('没在跑时不给「叫停」（没有可叫停的对象时不摆空按钮）', () => {
    expect(ids(buildConventionPanelMenu('rule', false))).not.toContain('panel.stop');
    expect(ids(buildConventionPanelMenu('rule', true))).toContain('panel.stop');
  });

  it('项集合全中文、id 唯一', () => {
    for (const running of [false, true]) {
      const items = buildConventionPanelMenu('rule', running);
      expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
      expect(new Set(ids(items)).size).toBe(items.length);
    }
  });
});

describe('动作分发', () => {
  it('条目两条动作', () => {
    const host = hostSpy();
    expect(runIssueAction('issue.open', issue(), host)).toBe(true);
    expect(runIssueAction('issue.copy', issue(), host)).toBe(true);
    expect(host.calls[0]).toBe('open:src/erb/角色.erb:12');
    expect(host.calls[1]?.startsWith('copy:src/erb/角色.erb:12')).toBe(true);
  });

  it('无定位的问题即使被点名也不跳', () => {
    const host = hostSpy();
    expect(runIssueAction('issue.open', issue({ filePath: null }), host)).toBe(false);
    expect(host.calls).toEqual([]);
  });

  it('面板三条动作（三个视角 + 重跑 + 叫停）', () => {
    const host = hostSpy();
    expect(runPanelAction('mode.family', host)).toBe(true);
    expect(runPanelAction('panel.rerun', host)).toBe(true);
    expect(runPanelAction('panel.stop', host)).toBe(true);
    expect(host.calls).toEqual(['mode:family', 'rerun', 'stop']);
  });

  it('不认识的 id ⇒ false', () => {
    expect(runPanelAction('nope', hostSpy())).toBe(false);
    expect(runIssueAction('nope', issue(), hostSpy())).toBe(false);
  });
});

describe('接线与降级', () => {
  it('条目：坐标 + 无障碍名 + 回调分发', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    expect(
      openIssueMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 7, clientY: 8 }, issue(), host),
    ).toBe(true);
    expect(seen[0]?.x).toBe(7);
    expect(seen[0]?.ariaLabel).toBe(CONVENTION_ISSUE_MENU_ARIA);
    seen[0]?.onSelect('issue.copy');
    expect(host.calls[0]?.startsWith('copy:')).toBe(true);
  });

  it('分组头：展开/收起由接线层直接落地（不经 host）', () => {
    const seen: PluginContextMenuRequest[] = [];
    let toggled = 0;
    openGroupMenu(
      { openContextMenu: (r) => seen.push(r) },
      { clientX: 1, clientY: 2 },
      { title: '规则甲', expanded: false, count: 2 },
      hostSpy(),
      () => (toggled += 1),
    );
    expect(seen[0]?.ariaLabel).toBe(CONVENTION_GROUP_MENU_ARIA);
    seen[0]?.onSelect('group.toggle');
    expect(toggled).toBe(1);
  });

  it('面板空白处：无障碍名 + 视角切换分发', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    openConventionPanelMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 1, clientY: 2 }, 'rule', true, host);
    expect(seen[0]?.ariaLabel).toBe(CONVENTION_PANEL_MENU_ARIA);
    seen[0]?.onSelect('mode.character');
    expect(host.calls).toEqual(['mode:character']);
  });

  it('宿主缺席 ⇒ false，不抛错', () => {
    expect(openIssueMenu({}, { clientX: 1, clientY: 2 }, issue(), hostSpy())).toBe(false);
    expect(openConventionPanelMenu({}, { clientX: 1, clientY: 2 }, 'rule', false, hostSpy())).toBe(false);
  });
});
