/**
 * 编辑器「应用动作」表（1023 右键覆盖面批 · WP1.1 / 1.3 / 1.4）——**纯数据 + 可用性判定**。
 *
 * ## 为什么是独立一层
 *
 * 编辑区右键菜单长什么样（有哪些项、哪些按不下、为什么按不下）是**语义**，而
 * "把项注册给 Monaco"是**接线**。两者混在一处的话，任何一条可用性判据都只能靠
 * 挂一整个 Monaco 实例才测得到；拆开后本文件零 React、零 Monaco import，
 * `packages/app/tests/editor-context-actions.test.ts` 直接打纯函数就能钉住：
 * 五类上下文的 id 集合、禁用原因、中文文案、与命令表的一致性。
 *
 * ## 三条硬口径（与 `context-menu-model.ts` 同源）
 *
 * 1. **能力不存在 ⇒ 整项不返回**（不塞一个灰项占位）：`canReveal` / `canFileHistory` /
 *    `canClipboardCompare` / `canRequestWrite` / 语言门 都是"这项菜单有没有话说"，
 *    不是"按不按得下"；
 * 2. **上下文暂不可用 ⇒ `enabled: false` + `disabledReason` 人话**（铁律 4）：
 *    预览面 / 只读目录 / 有未保存修改 / 没有选中内容，四种情形各说各的话；
 * 3. **`label` 全中文，且命令类项与 `KEYBINDING_SPECS` 的标题逐字一致**：本文件不 import
 *    键位表（那是 React 侧模块），一致性由测试对拍（`commandId` 是那条线）。
 *
 * ## 与 Monaco 原生菜单的分工
 *
 * 这里的 `EditorContextAction` 由 `use-monaco-instance.ts` 换成
 * `ed.addAction({ id: 'kojo.ctx.<id>', label, contextMenuGroupId, contextMenuOrder, precondition, run })`，
 * 落进 **Monaco 自己那份中文右键菜单**（`.monaco-editor` 内一律放行，见公共规程铁律 4）。
 * Monaco 的菜单**不支持"灰着 + 说原因"**（`precondition` 为假 = 整项不出现），所以
 * `enabled: false` 的项在接线侧一律**照常显示、按下去把 `disabledReason` 说出来**
 * （与 `workbench.fixAll`「刻意不灰掉」同一条产品口径：按得下去才说得出为什么不行）。
 */

/** 动作分组（决定 Monaco 菜单里的分组段与段内次序） */
export type EditorContextActionGroup = 'basic' | 'code' | 'file' | 'danger';

/** 分组的固定次序（测试与接线共用一张表，别在两处各排一次） */
export const EDITOR_CONTEXT_GROUP_SEQUENCE: readonly EditorContextActionGroup[] = [
  'basic',
  'code',
  'file',
  'danger',
];

/**
 * 分组 → Monaco 的 `contextMenuGroupId`。
 *
 * 前缀 `0_` / `1_` / `2_` 让我们的分组排在 Monaco 内建段（`navigation` /
 * `1_modification` / `9_cutcopypaste`）之前——作者点开菜单先看见"应用动作"，
 * 剪切复制粘贴这类通用动作仍在最下面，与原生观感一致。
 */
export const EDITOR_CONTEXT_GROUP_MENU_ID: Readonly<Record<EditorContextActionGroup, string>> = {
  basic: '0_kojo',
  code: '1_kojo_code',
  file: '2_kojo_file',
  danger: '3_kojo_danger',
};

/** 动作 id 前缀（**不占** Monaco 的 `editor.action.*` 命名空间） */
export const EDITOR_CONTEXT_ACTION_PREFIX = 'kojo.ctx.';

/** 动作 id → Monaco 动作 id（`kojo.ctx.save` 之类） */
export function monacoActionIdOf(id: string): string {
  return `${EDITOR_CONTEXT_ACTION_PREFIX}${id}`;
}

/** 三条人话原因（导出是为了让接线侧与测试读同一份字面量，不各抄一遍） */
export const PREVIEW_SAVE_REASON = '当前是预览面，切回源码后可保存';
export const PREVIEW_EDIT_REASON = '当前是预览面，切回源码后可修改';
export const PREVIEW_RELOAD_REASON = '当前是预览面，切回源码后可重新加载';
export const READ_ONLY_WRITE_REASON = '当前目录只读，先申请写权限';
export const DIRTY_RELOAD_REASON = '有未保存修改';

/** 一条编辑区应用动作 */
export interface EditorContextAction {
  /** 稳定 id（`'save'` / `'format-document'` / ...；表内唯一） */
  readonly id: string;
  /** 中文文案 */
  readonly label: string;
  readonly group: EditorContextActionGroup;
  /** 同组内的展示次序（全表递增；跨组由分组序决定） */
  readonly order: number;
  readonly enabled: boolean;
  /** `enabled === false` 必填（渲染侧/接线侧据此说话） */
  readonly disabledReason?: string;
  /**
   * 对应的宿主命令 id（有则 `label` 必须与 `KEYBINDING_SPECS` 的中文标题逐字一致——
   * 测试对拍这一条，菜单与命令面板因此不会两个词）。没有对应命令的动作（复制路径 /
   * 重新加载 / 格式化选区…）刻意留空：它们不是命令，不冒充命令。
   */
  readonly commandId?: string;
  /** 落地通道（由宿主注入；本层不 import 任何实现） */
  readonly run: () => void;
}

/**
 * 求值上下文：**一切可用性判据都在这里进、在 `buildEditorContextActions` 里出**。
 *
 * 做「能力」与「状态」两分：
 * - `can*` = 这条动作有没有落地通道（能力缺失 ⇒ 整项不显示，铁律 4）；
 * - `readOnly` / `sugarPreview` / `dirty` / `hasSelection` = 通道在、但此刻不可用
 *   （⇒ 禁用 + 原因）。
 */
export interface EditorContextActionContext {
  /** 有活动文件（没有文件 = 没有任何应用动作） */
  readonly hasFile: boolean;
  /** 编辑器只读（含 .kojo 预览面 / 未授权写的游戏目录） */
  readonly readOnly: boolean;
  /** 当前是 .kojo 预览面（只读派生 model） */
  readonly sugarPreview: boolean;
  readonly dirty: boolean;
  /** 当前有非空选区（"格式化选区"的可用性判据） */
  readonly hasSelection: boolean;
  /** 当前 model 是否 Kojo / ERB 方言族（语言专属项的门） */
  readonly kojoFamily: boolean;
  /** 「切换 .kojo 预览」对这份文件有没有意义（宿主按糖视图可用门现算） */
  readonly canToggleSugar: boolean;
  /** 桌面壳才有「在资源管理器中显示」 */
  readonly canReveal: boolean;
  /** 文件历史通道是否在场（命令 `kojo.showFileHistory` 已注册） */
  readonly canFileHistory: boolean;
  /** 「与剪贴板比较」通道是否在场（能读剪贴板 + 有文件） */
  readonly canClipboardCompare: boolean;
  /** 有「申请写权限」通道（只读面才显示） */
  readonly canRequestWrite: boolean;

  /* ---- 落地通道（宿主注入；本层只管调） ---- */
  readonly runSave: () => void;
  readonly runSaveAll: () => void;
  readonly runFormatDocument: () => void;
  readonly runFormatSelection: () => void;
  readonly runQuickFix: () => void;
  readonly runFixAll: () => void;
  readonly runFindReferences: () => void;
  readonly runRename: () => void;
  readonly runJumpToState: () => void;
  readonly runToggleSugar: () => void;
  readonly runFileHistory: () => void;
  readonly runCopyPath: () => void;
  readonly runCopyRelPath: () => void;
  readonly runReveal: () => void;
  readonly runReloadFromDisk: () => void;
  readonly runCompareClipboard: () => void;
  readonly runRequestWrite: () => void;
}

/** 写类动作的"为什么按不下"（`null` = 可写） */
function writeBlockReason(
  ctx: Pick<EditorContextActionContext, 'readOnly' | 'sugarPreview'>,
  previewReason: string,
): string | null {
  // 预览面在前：预览面同时也是只读的，先说的必须是作者真正需要的那句（切回源码）
  if (ctx.sugarPreview) return previewReason;
  if (ctx.readOnly) return READ_ONLY_WRITE_REASON;
  return null;
}

/** 启用/禁用两位一体（禁用一定带原因，构造上就不给出"灰着不说话"的形态） */
function gate(reason: string | null): Pick<EditorContextAction, 'enabled' | 'disabledReason'> {
  return reason === null ? { enabled: true } : { enabled: false, disabledReason: reason };
}

/**
 * 当前上下文 ⇒ 应用动作表（**按展示次序**返回，调用方不必再排）。
 *
 * 没有活动文件 ⇒ 空表（连"保存"都没有意义）；语言专属项在非方言族上下文里整项不返回。
 */
export function buildEditorContextActions(
  ctx: EditorContextActionContext,
): EditorContextAction[] {
  if (!ctx.hasFile) return [];
  const actions: EditorContextAction[] = [];

  /* ------------------------------ 基础组 ------------------------------ */
  actions.push({
    id: 'save',
    label: '保存当前文件',
    group: 'basic',
    order: 10,
    commandId: 'editor.internal.save',
    ...gate(writeBlockReason(ctx, PREVIEW_SAVE_REASON)),
    run: ctx.runSave,
  });
  actions.push({
    id: 'save-all',
    label: '全部保存',
    group: 'basic',
    order: 20,
    commandId: 'workbench.saveAll',
    ...gate(writeBlockReason(ctx, PREVIEW_SAVE_REASON)),
    run: ctx.runSaveAll,
  });

  /* ------------------------------ 代码组 ------------------------------ */
  actions.push({
    id: 'format-document',
    label: '格式化文档',
    group: 'code',
    order: 30,
    commandId: 'editor.action.formatDocument',
    ...gate(writeBlockReason(ctx, PREVIEW_EDIT_REASON)),
    run: ctx.runFormatDocument,
  });
  actions.push({
    id: 'format-selection',
    label: '格式化选区',
    group: 'code',
    order: 34,
    // 没有对应命令：这是 Monaco 内建动作（editor.action.formatSelection），不进命令面板
    ...gate(
      writeBlockReason(ctx, PREVIEW_EDIT_REASON) ??
        (ctx.hasSelection ? null : '没有选中内容'),
    ),
    run: ctx.runFormatSelection,
  });
  if (ctx.kojoFamily) {
    actions.push({
      id: 'quick-fix',
      label: '快速修复…',
      group: 'code',
      order: 38,
      ...gate(writeBlockReason(ctx, PREVIEW_EDIT_REASON)),
      run: ctx.runQuickFix,
    });
  }
  actions.push({
    id: 'find-references',
    label: '查找引用',
    group: 'code',
    order: 42,
    commandId: 'editor.action.references',
    // 只读动作：预览面 / 只读目录照样能查
    enabled: true,
    run: ctx.runFindReferences,
  });
  actions.push({
    id: 'rename',
    label: '重命名符号',
    group: 'code',
    order: 46,
    commandId: 'editor.action.rename',
    ...gate(writeBlockReason(ctx, PREVIEW_EDIT_REASON)),
    run: ctx.runRename,
  });
  if (ctx.kojoFamily) {
    actions.push({
      id: 'jump-to-state',
      label: '看这一行的状态',
      group: 'code',
      order: 50,
      commandId: 'workbench.jumpToState',
      // 只读动作；命中与否由落地通道自己说（跳转探针的既有口径）
      enabled: true,
      run: ctx.runJumpToState,
    });
    actions.push({
      id: 'fix-all',
      label: '一键修复当前文件',
      group: 'code',
      order: 54,
      commandId: 'workbench.fixAll',
      // 刻意不灰：一键修复自己把三种"没落"（预览面 / 外部改动未处置 / 无可修法）
      // 各说各话，且预览面那条带「切回原文」出路——比这里一句通用原因有用得多
      enabled: true,
      run: ctx.runFixAll,
    });
  }
  if (ctx.canToggleSugar) {
    actions.push({
      id: 'toggle-sugar',
      label: '切换 .kojo 预览',
      group: 'code',
      order: 58,
      commandId: 'workbench.toggleSugarView',
      enabled: true,
      run: ctx.runToggleSugar,
    });
  }

  /* ------------------------------ 文件组 ------------------------------ */
  if (ctx.canFileHistory) {
    actions.push({
      id: 'file-history',
      label: '文件历史',
      group: 'file',
      order: 70,
      enabled: true,
      run: ctx.runFileHistory,
    });
  }
  actions.push({
    id: 'copy-path',
    label: '复制路径',
    group: 'file',
    order: 74,
    enabled: true,
    run: ctx.runCopyPath,
  });
  actions.push({
    id: 'copy-rel-path',
    label: '复制相对路径',
    group: 'file',
    order: 78,
    enabled: true,
    run: ctx.runCopyRelPath,
  });
  if (ctx.canReveal) {
    actions.push({
      id: 'reveal',
      label: '在资源管理器中显示',
      group: 'file',
      order: 82,
      enabled: true,
      run: ctx.runReveal,
    });
  }
  actions.push({
    id: 'reload-from-disk',
    label: '重新加载磁盘版本',
    group: 'file',
    order: 86,
    ...gate(
      ctx.sugarPreview
        ? PREVIEW_RELOAD_REASON
        : ctx.dirty
          ? DIRTY_RELOAD_REASON
          : null,
    ),
    run: ctx.runReloadFromDisk,
  });
  if (ctx.canClipboardCompare) {
    actions.push({
      id: 'compare-clipboard',
      label: '与剪贴板比较',
      group: 'file',
      order: 90,
      enabled: true,
      run: ctx.runCompareClipboard,
    });
  }
  if (ctx.canRequestWrite) {
    actions.push({
      id: 'request-write',
      label: '申请写权限…',
      group: 'file',
      order: 94,
      enabled: true,
      run: ctx.runRequestWrite,
    });
  }

  return actions;
}

/** 表内查一条（接线侧的 run 分发入口：找不到 = 这一项在当前上下文已不适用） */
export function findEditorContextAction(
  actions: readonly EditorContextAction[],
  id: string,
): EditorContextAction | undefined {
  return actions.find((action) => action.id === id);
}

/** 全可用上下文（`listAllEditorContextActions` 的地基：只描述一件事——通道全在） */
const noop = (): void => undefined;
const ALL_AVAILABLE_CONTEXT: EditorContextActionContext = {
  hasFile: true,
  readOnly: false,
  sugarPreview: false,
  dirty: false,
  hasSelection: true,
  kojoFamily: true,
  canToggleSugar: true,
  canReveal: true,
  canFileHistory: true,
  canClipboardCompare: true,
  canRequestWrite: true,
  runSave: noop,
  runSaveAll: noop,
  runFormatDocument: noop,
  runFormatSelection: noop,
  runQuickFix: noop,
  runFixAll: noop,
  runFindReferences: noop,
  runRename: noop,
  runJumpToState: noop,
  runToggleSugar: noop,
  runFileHistory: noop,
  runCopyPath: noop,
  runCopyRelPath: noop,
  runReveal: noop,
  runReloadFromDisk: noop,
  runCompareClipboard: noop,
  runRequestWrite: noop,
};

/**
 * **全量**动作清单（接线侧的注册面）。
 *
 * 为什么需要它：Monaco 的 `addAction` 只在实例创建时注册一次，而"这一刻能不能点"
 * 每次右键都可能不同。两者必须分开——注册面取本函数（有哪些项、叫什么、排第几），
 * 可用性取 `buildEditorContextActions(当下上下文)`（派发时判）。合成一个"全部能力都在"
 * 的上下文复用同一条构建路径，动作的 id / 文案 / 分组 / 次序因此只有一份。
 */
export function listAllEditorContextActions(): EditorContextAction[] {
  return buildEditorContextActions(ALL_AVAILABLE_CONTEXT);
}
