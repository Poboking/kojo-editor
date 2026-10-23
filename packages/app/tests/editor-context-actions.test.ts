/**
 * 编辑器「应用动作」表（1023 右键覆盖面批 · WP1.1 / 1.3 / 1.4）。
 *
 * 打的是纯函数 `buildEditorContextActions`——不挂 Monaco、不渲染 React，
 * 判据（有哪些项 / 能不能点 / 为什么不能点 / 文案是否中文）因此能被逐条钉住。
 *
 * 五类上下文（任务书要求）：
 * ① 普通可写（工作区 .kojo）；② .kojo 预览面；③ 只读未授权（游戏目录 ERB）；
 * ④ 没有活动文件；⑤ 通道缺席（无桌面壳 / 无文件历史）。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  EDITOR_CONTEXT_GROUP_MENU_ID,
  EDITOR_CONTEXT_GROUP_SEQUENCE,
  DIRTY_RELOAD_REASON,
  PREVIEW_EDIT_REASON,
  PREVIEW_RELOAD_REASON,
  PREVIEW_SAVE_REASON,
  READ_ONLY_WRITE_REASON,
  buildEditorContextActions,
  findEditorContextAction,
  listAllEditorContextActions,
  monacoActionIdOf,
  type EditorContextAction,
  type EditorContextActionContext,
} from '../src/ui/editor-pane/editor-context-actions';
import { isChineseMenuLabel } from '../src/ui/context-menu-model';
import { keybindingSpecOf } from '../src/ui/keybindings';

/** 一个"什么通道都在、什么都能点"的上下文（各用例只覆写自己关心的几位） */
function makeContext(overrides: Partial<EditorContextActionContext> = {}): EditorContextActionContext {
  return {
    hasFile: true,
    readOnly: false,
    sugarPreview: false,
    dirty: false,
    hasSelection: true,
    kojoFamily: true,
    canToggleSugar: false,
    canReveal: true,
    canFileHistory: true,
    canClipboardCompare: true,
    canRequestWrite: false,
    runSave: vi.fn(),
    runSaveAll: vi.fn(),
    runFormatDocument: vi.fn(),
    runFormatSelection: vi.fn(),
    runQuickFix: vi.fn(),
    runFixAll: vi.fn(),
    runFindReferences: vi.fn(),
    runRename: vi.fn(),
    runJumpToState: vi.fn(),
    runToggleSugar: vi.fn(),
    runFileHistory: vi.fn(),
    runCopyPath: vi.fn(),
    runCopyRelPath: vi.fn(),
    runReveal: vi.fn(),
    runReloadFromDisk: vi.fn(),
    runCompareClipboard: vi.fn(),
    runRequestWrite: vi.fn(),
    ...overrides,
  };
}

/** 普通可写 + 方言族 + 桌面壳：基础集合（后面各用例都是它的子集/变体） */
function plain(): EditorContextActionContext {
  return makeContext({
    readOnly: false,
    sugarPreview: false,
    dirty: false,
    hasSelection: true,
    kojoFamily: true,
    canToggleSugar: false,
    canReveal: true,
    canFileHistory: true,
    canClipboardCompare: true,
    canRequestWrite: false,
  });
}

function ids(actions: readonly EditorContextAction[]): string[] {
  return actions.map((a) => a.id);
}

function disabledOf(actions: readonly EditorContextAction[], id: string): EditorContextAction {
  const found = findEditorContextAction(actions, id);
  if (found === undefined) throw new Error(`动作表里没有「${id}」`);
  return found;
}

describe('buildEditorContextActions：五类上下文的项集合', () => {
  it('普通可写：基础组 / 代码组 / 文件组齐备，且按 order 递增', () => {
    const actions = buildEditorContextActions(plain());
    expect(ids(actions)).toEqual([
      'save',
      'save-all',
      'format-document',
      'format-selection',
      'quick-fix',
      'find-references',
      'rename',
      'jump-to-state',
      'fix-all',
      'file-history',
      'copy-path',
      'copy-rel-path',
      'reveal',
      'reload-from-disk',
      'compare-clipboard',
    ]);
    // order 严格递增（同一条数组就是展示次序，调用方不必再排）
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i]!.order).toBeGreaterThan(actions[i - 1]!.order);
    }
    // 普通可写面：**一条禁用都没有**
    expect(actions.filter((a) => !a.enabled)).toEqual([]);
  });

  it('预览面：写类项禁用且都说「切回源码」，只读探测项仍在', () => {
    const actions = buildEditorContextActions(
      makeContext({ readOnly: true, sugarPreview: true, canToggleSugar: true, canRequestWrite: false }),
    );
    expect(disabledOf(actions, 'save')).toMatchObject({
      enabled: false,
      disabledReason: PREVIEW_SAVE_REASON,
    });
    expect(disabledOf(actions, 'save-all')).toMatchObject({
      enabled: false,
      disabledReason: PREVIEW_SAVE_REASON,
    });
    for (const id of ['format-document', 'format-selection', 'quick-fix', 'rename']) {
      expect(disabledOf(actions, id)).toMatchObject({
        enabled: false,
        disabledReason: PREVIEW_EDIT_REASON,
      });
    }
    expect(disabledOf(actions, 'reload-from-disk')).toMatchObject({
      enabled: false,
      disabledReason: PREVIEW_RELOAD_REASON,
    });
    // 只读动作照旧可用；预览面自己那枚开关也在（作者要能切回去）
    expect(disabledOf(actions, 'find-references').enabled).toBe(true);
    expect(disabledOf(actions, 'copy-path').enabled).toBe(true);
    expect(disabledOf(actions, 'toggle-sugar').enabled).toBe(true);
  });

  it('只读未授权：写类项禁用并指向「申请写权限」，该通道此时才出现', () => {
    const actions = buildEditorContextActions(
      makeContext({ readOnly: true, sugarPreview: false, canRequestWrite: true }),
    );
    for (const id of ['save', 'save-all', 'format-document', 'rename']) {
      expect(disabledOf(actions, id)).toMatchObject({
        enabled: false,
        disabledReason: READ_ONLY_WRITE_REASON,
      });
    }
    expect(ids(actions)).toContain('request-write');
    // 只读面没有预览面，重载仍可用
    expect(disabledOf(actions, 'reload-from-disk').enabled).toBe(true);
  });

  it('没有活动文件：一条都没有（不给空壳菜单）', () => {
    expect(buildEditorContextActions(makeContext({ hasFile: false }))).toEqual([]);
  });

  it('通道缺席：桌面壳 / 文件历史 / 剪贴板比较整项不返回（不是灰着）', () => {
    const actions = buildEditorContextActions(
      makeContext({ canReveal: false, canFileHistory: false, canClipboardCompare: false }),
    );
    expect(ids(actions)).not.toContain('reveal');
    expect(ids(actions)).not.toContain('file-history');
    expect(ids(actions)).not.toContain('compare-clipboard');
    // 其余项不受牵连
    expect(ids(actions)).toContain('copy-path');
    expect(ids(actions)).toContain('reload-from-disk');
  });

  it('非方言语言：语言专属项整项不返回，通用项一条不少', () => {
    const actions = buildEditorContextActions(makeContext({ kojoFamily: false }));
    expect(ids(actions)).not.toContain('quick-fix');
    expect(ids(actions)).not.toContain('jump-to-state');
    expect(ids(actions)).not.toContain('fix-all');
    expect(ids(actions)).toContain('format-document');
    expect(ids(actions)).toContain('find-references');
  });

  it('有未保存修改：重新加载禁用并说人话；没有选中内容：格式化选区禁用', () => {
    const dirty = buildEditorContextActions(makeContext({ dirty: true }));
    expect(disabledOf(dirty, 'reload-from-disk')).toMatchObject({
      enabled: false,
      disabledReason: DIRTY_RELOAD_REASON,
    });
    const noSelection = buildEditorContextActions(makeContext({ hasSelection: false }));
    expect(disabledOf(noSelection, 'format-selection')).toMatchObject({
      enabled: false,
      disabledReason: '没有选中内容',
    });
    // 选区为空不影响别的项
    expect(disabledOf(noSelection, 'format-document').enabled).toBe(true);
  });
});

describe('buildEditorContextActions：文案与结构不变量', () => {
  it('label 全中文（含 CJK），id 全表唯一', () => {
    const actions = listAllEditorContextActions();
    for (const action of actions) {
      expect(isChineseMenuLabel(action.label), `「${action.label}」不是中文文案`).toBe(true);
    }
    expect(new Set(ids(actions)).size).toBe(actions.length);
  });

  it('禁用项一定带中文原因（不出现"灰着不说话"）', () => {
    const contexts = [
      plain(),
      makeContext({ readOnly: true, sugarPreview: true }),
      makeContext({ readOnly: true, canRequestWrite: true }),
      makeContext({ dirty: true, hasSelection: false }),
      makeContext({ kojoFamily: false, canReveal: false, canFileHistory: false }),
    ];
    for (const ctx of contexts) {
      for (const action of buildEditorContextActions(ctx)) {
        if (action.enabled) {
          expect(action.disabledReason).toBeUndefined();
          continue;
        }
        expect(action.disabledReason).toBeTruthy();
        expect(isChineseMenuLabel(action.disabledReason ?? '')).toBe(true);
      }
    }
  });

  it('分组与 Monaco 分组 id 一一对应，且分组次序单调（基础 → 代码 → 文件）', () => {
    const actions = listAllEditorContextActions();
    let lastRank = -1;
    for (const action of actions) {
      const rank = EDITOR_CONTEXT_GROUP_SEQUENCE.indexOf(action.group);
      expect(rank).toBeGreaterThanOrEqual(lastRank);
      lastRank = rank;
      expect(EDITOR_CONTEXT_GROUP_MENU_ID[action.group]).toMatch(/^\d_kojo/);
    }
    // 危险组本批为空：保存/格式化都不算危险动作
    expect(actions.some((a) => a.group === 'danger')).toBe(false);
  });

  it('Monaco 动作 id 在自有命名空间里（不占 editor.action.*）', () => {
    expect(monacoActionIdOf('save')).toBe('kojo.ctx.save');
    for (const action of listAllEditorContextActions()) {
      const id = monacoActionIdOf(action.id);
      expect(id.startsWith('kojo.ctx.')).toBe(true);
      expect(id.startsWith('editor.action.')).toBe(false);
    }
  });

  it('命令类项的中文标题与键位注册表逐字一致（菜单与命令面板不两个词）', () => {
    const withCommand = listAllEditorContextActions().filter((a) => a.commandId !== undefined);
    expect(withCommand.length).toBeGreaterThan(0);
    for (const action of withCommand) {
      const spec = keybindingSpecOf(action.commandId!);
      expect(spec, `命令 ${action.commandId} 没在 KEYBINDING_SPECS 登记`).toBeDefined();
      expect(action.label).toBe(spec!.title);
    }
  });

  it('五类上下文都能求值、不抛错，且 run 只调注入的通道', () => {
    const contexts = [
      plain(),
      makeContext({ readOnly: true, sugarPreview: true, canToggleSugar: true }),
      makeContext({ readOnly: true, canRequestWrite: true }),
      makeContext({ hasFile: false }),
      makeContext({ canReveal: false, canFileHistory: false, kojoFamily: false }),
    ];
    for (const ctx of contexts) {
      expect(() => buildEditorContextActions(ctx)).not.toThrow();
    }
    const ctx = plain();
    const actions = buildEditorContextActions(ctx);
    findEditorContextAction(actions, 'save')!.run();
    expect(ctx.runSave).toHaveBeenCalledTimes(1);
    findEditorContextAction(actions, 'copy-rel-path')!.run();
    expect(ctx.runCopyRelPath).toHaveBeenCalledTimes(1);
    findEditorContextAction(actions, 'file-history')!.run();
    expect(ctx.runFileHistory).toHaveBeenCalledTimes(1);
  });

  it('全量清单（注册面）是各上下文并集：每个 id 都来自同一条构建路径', () => {
    const all = new Set(ids(listAllEditorContextActions()));
    const union = new Set<string>();
    for (const ctx of [
      plain(),
      makeContext({ readOnly: true, sugarPreview: true, canToggleSugar: true, canRequestWrite: true }),
      makeContext({ canReveal: false, canFileHistory: false, canClipboardCompare: false }),
    ]) {
      for (const id of ids(buildEditorContextActions(ctx))) union.add(id);
    }
    for (const id of union) expect(all.has(id)).toBe(true);
    // 并集里没有的 id 也不会凭空出现在注册面（防止注册面单方面膨胀）
    expect([...all].filter((id) => !union.has(id))).toEqual([]);
  });
});

/**
 * 接线（`use-monaco-instance.ts`）：源码切片取证——这三条都不是纯函数能表达的，
 * 而它们的失效方式都是"静默"（菜单不出现 / 卸载后残留 / 选区被清），必须钉住。
 */
describe('接线：注册面 / 退场 / 右键位置语义', () => {
  const INSTANCE = readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'ui', 'editor-pane', 'use-monaco-instance.ts'),
    'utf8',
  );

  it('注册面用动作表的 id / 分组 / 次序（不另抄一份 metadata）', () => {
    expect(INSTANCE).toContain('ed.addAction({');
    expect(INSTANCE).toContain('id: monacoActionIdOf(action.id)');
    expect(INSTANCE).toContain('contextMenuGroupId: EDITOR_CONTEXT_GROUP_MENU_ID[action.group]');
    expect(INSTANCE).toContain('contextMenuOrder: action.order');
    // 不占 Monaco 的 editor.action.* 命名空间
    expect(INSTANCE).not.toMatch(/id: 'editor\.action\./);
  });

  it('菜单项句柄随实例退场逐个 dispose（全局注册不会被 ed.dispose 收走）', () => {
    expect(INSTANCE).toContain('for (const disposable of contextActionDisposables) disposable.dispose();');
    // dispose 必须在 ed.dispose() 之前（之后的句柄操作落在已销毁的编辑器上）
    expect(INSTANCE.indexOf('contextActionDisposables) disposable.dispose()')).toBeLessThan(
      INSTANCE.indexOf('ed.dispose();'),
    );
  });

  it('右键落在选区内时不动选区（只 setPosition，绝不 setSelection）', () => {
    const start = INSTANCE.indexOf('const contextMenuPositionSub = ed.onContextMenu(');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = INSTANCE.slice(start, INSTANCE.indexOf('});', start) + 3);
    expect(block).toContain('selection.containsPosition(position)');
    expect(block).toContain('ed.setPosition(position)');
    expect(block).not.toContain('setSelection');
    expect(block).not.toContain('setSelections');
  });
});
