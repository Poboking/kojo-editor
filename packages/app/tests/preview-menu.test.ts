/**
 * 编辑区右键面（1023 覆盖面批 · WP1.2 / 1.5）的判据。
 *
 * 三层：
 * 1. **纯构建**——`buildPreviewMenu` / `buildEditorFrameMenu` 的项集合、中文 label、
 *    「能力不存在整项不显示」与「上下文暂不可用 = 禁用 + 原因」这两条不同的口径；
 * 2. **命令项与命令表一致**——标题与键位只能来自 `KEYBINDING_SPECS`，菜单不许编键位；
 * 3. **面路由与动作分发**——`data-context-surface` 就近命中，`onSelect` 真的把 id 送到了
 *    组句柄上（数组形态的"只展示不做事"陷阱在这里被钉住）。
 */
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { formatKeybinding } from '../src/ui/commands';
import { FALLBACK_MENU_ARIA_LABEL, isChineseMenuLabel } from '../src/ui/context-menu-model';
import { buildContextMenuRoute } from '../src/ui/context-surfaces';
import {
  buildEditorFrameMenu,
  buildPreviewMenu,
  EDITOR_FRAME_MENU_IDS,
  PREVIEW_MENU_IDS,
  setEditorFrameMenuRuntime,
  setPreviewMenuRuntime,
  type EditorFrameMenuContext,
  type PreviewMenuContext,
} from '../src/ui/editor-pane/preview-menu';
import { effectiveKeybindingOf, keybindingSpecOf } from '../src/ui/keybindings';

const event = (): MouseEvent =>
  new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 40 });

/** 预览面「样样都有」的基线上下文（各用例按需覆盖单个字段） */
const previewCtx = (patch: Partial<PreviewMenuContext> = {}): PreviewMenuContext => ({
  previewing: true,
  hasPreviewText: true,
  hasSelection: false,
  canJumpToSource: true,
  canToggleFold: true,
  canOpenSettings: true,
  ...patch,
});

const frameCtx = (patch: Partial<EditorFrameMenuContext> = {}): EditorFrameMenuContext => ({
  filePath: 'D:/games/eraTW/ERB/口上.ERB',
  canRunCommand: () => true,
  ...patch,
});

const idsOf = (items: readonly { id: string }[]): string[] => items.map((item) => item.id);
const labelsOf = (items: readonly { label: string }[]): string[] => items.map((item) => item.label);

afterEach(() => {
  // 面句柄是模块级状态：用例之间清干净，免得后一条读到前一条的组
  setEditorFrameMenuRuntime('g1', null);
  setPreviewMenuRuntime('g1', null);
});

describe('buildPreviewMenu · 项集合', () => {
  it('预览不在屏上 ⇒ 不表态（空数组，交给下一级）', () => {
    expect(buildPreviewMenu(previewCtx({ previewing: false }))).toEqual([]);
  });

  it('全能力：复制 / 切回源码 / 折叠展开 / 定位 / 设置，按分组顺序排', () => {
    const items = buildPreviewMenu(previewCtx());
    expect(labelsOf(items)).toEqual([
      '复制预览全文',
      '切回源码',
      '折叠全部',
      '展开全部',
      '在源码中定位当前行',
      '打开设置',
    ]);
    expect(idsOf(items)).toEqual([
      PREVIEW_MENU_IDS.copyAll,
      PREVIEW_MENU_IDS.backToSource,
      PREVIEW_MENU_IDS.foldAll,
      PREVIEW_MENU_IDS.unfoldAll,
      PREVIEW_MENU_IDS.jumpToSource,
      'layout.openSettings',
    ]);
  });

  it('label 全中文（宿主最后一道闸会丢弃非中文项 ⇒ 这里必须自证）', () => {
    for (const item of buildPreviewMenu(previewCtx({ hasSelection: true }))) {
      expect(isChineseMenuLabel(item.label), item.id).toBe(true);
    }
  });

  it('有选区才给「复制所选内容」（能力不存在 ⇒ 整项不显示）', () => {
    expect(idsOf(buildPreviewMenu(previewCtx()))).not.toContain(PREVIEW_MENU_IDS.copySelection);
    expect(idsOf(buildPreviewMenu(previewCtx({ hasSelection: true })))).toContain(
      PREVIEW_MENU_IDS.copySelection,
    );
  });

  it('预览文本为空 ⇒ 不给「复制预览全文」', () => {
    expect(idsOf(buildPreviewMenu(previewCtx({ hasPreviewText: false })))).not.toContain(
      PREVIEW_MENU_IDS.copyAll,
    );
  });

  it('折叠能力不在册 ⇒ 折叠与展开两项都不显示', () => {
    const ids = idsOf(buildPreviewMenu(previewCtx({ canToggleFold: false })));
    expect(ids).not.toContain(PREVIEW_MENU_IDS.foldAll);
    expect(ids).not.toContain(PREVIEW_MENU_IDS.unfoldAll);
  });

  it('这一行映射不到原文 ⇒ 定位项留着但禁用，并带上人话原因', () => {
    const item = buildPreviewMenu(previewCtx({ canJumpToSource: false })).find(
      (entry) => entry.id === PREVIEW_MENU_IDS.jumpToSource,
    );
    expect(item?.disabled).toBe(true);
    expect((item?.disabledReason ?? '').length).toBeGreaterThan(0);
    expect(isChineseMenuLabel(item?.disabledReason ?? '')).toBe(true);
    // 能跳时不带禁用位（两档口径不能混）
    const enabled = buildPreviewMenu(previewCtx()).find(
      (entry) => entry.id === PREVIEW_MENU_IDS.jumpToSource,
    );
    expect(enabled?.disabled).toBeUndefined();
  });

  it('命令通道跑不了设置 ⇒ 设置项禁用 + 原因（不假装能按）', () => {
    const item = buildPreviewMenu(previewCtx({ canOpenSettings: false })).find(
      (entry) => entry.id === 'layout.openSettings',
    );
    expect(item?.disabled).toBe(true);
    expect((item?.disabledReason ?? '').length).toBeGreaterThan(0);
  });

  it('只读面纪律：不出现保存 / 格式化 / 重命名这类写动作', () => {
    const labels = labelsOf(buildPreviewMenu(previewCtx({ hasSelection: true }))).join('|');
    for (const forbidden of ['保存', '格式化', '重命名', '撤销', '替换']) {
      expect(labels.includes(forbidden), forbidden).toBe(false);
    }
  });
});

describe('buildPreviewMenu · 命令项与命令表一致', () => {
  it('切回源码：标题是本面措辞，键位来自 `workbench.toggleSugarView` 真源', () => {
    const item = buildPreviewMenu(previewCtx()).find(
      (entry) => entry.id === PREVIEW_MENU_IDS.backToSource,
    );
    const keys = effectiveKeybindingOf('workbench.toggleSugarView');
    expect(item?.shortcut).toBe(formatKeybinding(keys ?? ''));
    // 键位表里这条命令的标题（切换 .kojo 预览）仍然在册，菜单只是按语境换了措辞
    expect(keybindingSpecOf('workbench.toggleSugarView')?.title).toBe('切换 .kojo 预览');
  });

  it('打开设置：标题与键位直接来自命令表（菜单不另造文案）', () => {
    const item = buildPreviewMenu(previewCtx()).find((entry) => entry.id === 'layout.openSettings');
    const spec = keybindingSpecOf('layout.openSettings');
    expect(item?.label).toBe(spec?.title);
    expect(item?.shortcut).toBe(
      effectiveKeybindingOf('layout.openSettings') === undefined
        ? undefined
        : formatKeybinding(effectiveKeybindingOf('layout.openSettings') ?? ''),
    );
  });
});

describe('buildEditorFrameMenu · 外框三项', () => {
  it('有文件：复制路径 + 命令面板 + 打开设置，全中文', () => {
    const items = buildEditorFrameMenu(frameCtx());
    expect(idsOf(items)).toEqual([EDITOR_FRAME_MENU_IDS.copyPath, 'workbench.commandPalette', 'layout.openSettings']);
    for (const item of items) expect(isChineseMenuLabel(item.label), item.id).toBe(true);
  });

  it('空态（没有活动文件）⇒ 没有"复制文件路径"这一项（能力不存在就不摆）', () => {
    expect(idsOf(buildEditorFrameMenu(frameCtx({ filePath: null })))).not.toContain(
      EDITOR_FRAME_MENU_IDS.copyPath,
    );
    expect(idsOf(buildEditorFrameMenu(frameCtx({ filePath: '' })))).not.toContain(
      EDITOR_FRAME_MENU_IDS.copyPath,
    );
  });

  it('命令通道不可用 ⇒ 命令项禁用并说明原因', () => {
    const items = buildEditorFrameMenu(frameCtx({ canRunCommand: () => false }));
    const commands = items.filter((item) => item.id !== EDITOR_FRAME_MENU_IDS.copyPath);
    expect(commands.length).toBe(2);
    for (const item of commands) {
      expect(item.disabled, item.id).toBe(true);
      expect((item.disabledReason ?? '').length, item.id).toBeGreaterThan(0);
    }
    // 复制路径是本地剪贴板动作，不受命令通道影响
    expect(items.find((item) => item.id === EDITOR_FRAME_MENU_IDS.copyPath)?.disabled).toBeUndefined();
  });
});

/** 搭一棵最小的真实结构：组 → 外框面 → 预览面（对应 EditorPane 的 DOM 形状） */
function mountPane(groupId: string): { frame: HTMLElement; banner: HTMLElement } {
  const group = document.createElement('div');
  group.setAttribute('data-editor-group', groupId);
  const frame = document.createElement('div');
  frame.setAttribute('data-context-surface', 'editor');
  const banner = document.createElement('div');
  banner.setAttribute('data-context-surface', 'sugar-preview');
  const bannerChild = document.createElement('span');
  const frameChild = document.createElement('span');
  banner.appendChild(bannerChild);
  frame.appendChild(banner);
  frame.appendChild(frameChild);
  group.appendChild(frame);
  document.body.appendChild(group);
  return { frame: frameChild, banner: bannerChild };
}

describe('面路由与动作分发', () => {
  it('预览横幅里右键 ⇒ sugar-preview 面，选中项送到该组的句柄', () => {
    const picked: string[] = [];
    setPreviewMenuRuntime('g1', { context: () => previewCtx(), run: (id) => picked.push(id) });
    const { banner } = mountPane('g1');
    const route = buildContextMenuRoute(banner, event());
    expect(route?.source).toBe('sugar-preview');
    expect(route?.ariaLabel).toBe('预览菜单');
    expect((route?.items.length ?? 0) > 0).toBe(true);
    route?.onSelect(PREVIEW_MENU_IDS.copyAll);
    expect(picked).toEqual([PREVIEW_MENU_IDS.copyAll]);
  });

  it('外框（非预览簇）右键 ⇒ editor 面，复制路径的动作同样落到组句柄', () => {
    const picked: string[] = [];
    setEditorFrameMenuRuntime('g1', { context: () => frameCtx(), run: (id) => picked.push(id) });
    const { frame } = mountPane('g1');
    const route = buildContextMenuRoute(frame, event());
    expect(route?.source).toBe('editor');
    expect(route?.ariaLabel).toBe('编辑器菜单');
    route?.onSelect(EDITOR_FRAME_MENU_IDS.copyPath);
    expect(picked).toEqual([EDITOR_FRAME_MENU_IDS.copyPath]);
  });

  it('没登记句柄的组 ⇒ 这一级不表态，落到兜底菜单（不弹空壳）', () => {
    const { frame } = mountPane('g-unknown');
    const route = buildContextMenuRoute(frame, event());
    expect(route?.source).toBe('app-fallback');
    expect(route?.ariaLabel).toBe(FALLBACK_MENU_ARIA_LABEL);
  });
});
