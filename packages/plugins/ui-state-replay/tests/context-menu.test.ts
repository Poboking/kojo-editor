/**
 * 状态回放面板右键菜单（1023 覆盖面批 · WP5.2）。
 *
 * 判据：谓词行的三条动作与两种复制文本（未知态把原因带上）、面板空白处在
 * 回放中 / 无结果时的禁用原因、分发与降级。
 */
import { describe, expect, it } from 'vitest';
import { hasCjkLabel, type PluginContextMenuRequest } from '@kojo/plugin-api';
import {
  REPLAY_PANEL_MENU_ARIA,
  REPLAY_PREDICATE_MENU_ARIA,
  buildReplayPanelMenu,
  buildReplayPredicateMenu,
  openReplayPanelMenu,
  openReplayPredicateMenu,
  predicateCopyText,
  predicateStateText,
  runReplayPanelAction,
  runReplayPredicateAction,
  type ReplayMenuHost,
  type ReplayPredicateMenuTarget,
} from '../src/context-menu';

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

function pred(overrides: Partial<ReplayPredicateMenuTarget> = {}): ReplayPredicateMenuTarget {
  return {
    line: 88,
    kind: 'IF',
    text: 'IF TALENT:10 >= 5',
    outcome: 'true',
    filePath: 'src/erb/K1.erb',
    normalizedName: 'KOJO_MESSAGE_COM',
    ...overrides,
  };
}

function hostSpy(): ReplayMenuHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reveal: (filePath, line, source) => void calls.push(`reveal:${filePath}:${line}:${source}`),
    rerun: () => void calls.push('rerun'),
    copy: (text) => void calls.push(`copy:${text}`),
  };
}

describe('谓词行菜单', () => {
  it('两处菜单的 id 都唯一（宿主按 id 分发，重号会点错动作）', () => {
    const predIds = ids(buildReplayPredicateMenu(pred()));
    const panelIds = ids(buildReplayPanelMenu({ hasView: true, busy: false }));
    expect(new Set(predIds).size).toBe(predIds.length);
    expect(new Set(panelIds).size).toBe(panelIds.length);
  });

  it('项集合：跳到这一行 / 复制谓词 / 复制求值状态；全中文', () => {
    const items = buildReplayPredicateMenu(pred());
    expect(ids(items)).toEqual(['rp.pred.reveal', 'rp.pred.copyText', 'rp.pred.copyState']);
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
  });

  it('复制谓词 = 位置 + 原文', () => {
    expect(predicateCopyText(pred())).toBe('src/erb/K1.erb:88 IF TALENT:10 >= 5');
  });

  it('复制求值状态：三态中文名 + 行号；未知态带上原因', () => {
    expect(predicateStateText(pred())).toBe('命中（IF）第 88 行');
    expect(predicateStateText(pred({ outcome: 'false' }))).toBe('未命中（IF）第 88 行');
    expect(predicateStateText(pred({ outcome: 'unknown', unknownMessage: '表达式未解析' }))).toBe(
      '未知（IF）第 88 行：表达式未解析',
    );
  });
});

describe('面板空白处菜单', () => {
  it('有结果且不忙：重新回放可点', () => {
    const items = buildReplayPanelMenu({ hasView: true, busy: false });
    expect(ids(items)).toEqual(['rp.panel.rerun']);
    expect(items[0]?.disabled).toBeUndefined();
  });

  it('回放中 / 没有结果：禁用并各说各的原因', () => {
    const busy = buildReplayPanelMenu({ hasView: true, busy: true })[0];
    expect(busy?.disabled).toBe(true);
    expect(busy?.disabledReason).toContain('还没结束');
    const empty = buildReplayPanelMenu({ hasView: false, busy: false })[0];
    expect(empty?.disabled).toBe(true);
    expect(empty?.disabledReason).toContain('还没有可回放的结果');
  });
});

describe('动作分发', () => {
  it('谓词三条', () => {
    const host = hostSpy();
    const target = pred();
    for (const id of ids(buildReplayPredicateMenu(target))) {
      expect(runReplayPredicateAction(id, target, host)).toBe(true);
    }
    expect(host.calls).toEqual([
      'reveal:src/erb/K1.erb:88:KOJO_MESSAGE_COM',
      'copy:src/erb/K1.erb:88 IF TALENT:10 >= 5',
      'copy:命中（IF）第 88 行',
    ]);
  });

  it('面板：忙或无结果时不重放', () => {
    const host = hostSpy();
    expect(runReplayPanelAction('rp.panel.rerun', { hasView: true, busy: true }, host)).toBe(false);
    expect(runReplayPanelAction('rp.panel.rerun', { hasView: false, busy: false }, host)).toBe(false);
    expect(runReplayPanelAction('rp.panel.rerun', { hasView: true, busy: false }, host)).toBe(true);
    expect(host.calls).toEqual(['rerun']);
  });

  it('不认识的 id ⇒ false', () => {
    expect(runReplayPredicateAction('nope', pred(), hostSpy())).toBe(false);
    expect(runReplayPanelAction('nope', { hasView: true, busy: false }, hostSpy())).toBe(false);
  });
});

describe('接线与降级', () => {
  it('谓词行：坐标 + 无障碍名 + 回调', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    openReplayPredicateMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 11, clientY: 12 }, pred(), host);
    expect(seen[0]?.x).toBe(11);
    expect(seen[0]?.ariaLabel).toBe(REPLAY_PREDICATE_MENU_ARIA);
    seen[0]?.onSelect('rp.pred.copyText');
    expect(host.calls).toHaveLength(1);
  });

  it('面板空白处：无障碍名 + 重放分发', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    openReplayPanelMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 1, clientY: 2 }, { hasView: true, busy: false }, host);
    expect(seen[0]?.ariaLabel).toBe(REPLAY_PANEL_MENU_ARIA);
    seen[0]?.onSelect('rp.panel.rerun');
    expect(host.calls).toEqual(['rerun']);
  });

  it('宿主缺席 ⇒ false，不抛错', () => {
    expect(openReplayPredicateMenu({}, { clientX: 1, clientY: 2 }, pred(), hostSpy())).toBe(false);
    expect(openReplayPanelMenu({}, { clientX: 1, clientY: 2 }, { hasView: true, busy: false }, hostSpy())).toBe(false);
  });
});
