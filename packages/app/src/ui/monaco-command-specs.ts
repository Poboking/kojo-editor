/**
 * Monaco 内建动作清单（1026 编辑器内核批）——命令面板「内核动作」的**唯一数据源**。
 *
 * 这些能力随 Monaco 的 contrib 一起装好了（折叠、文本变换、排序去重、智能选择、增删注释、
 * 剪贴板…），此前却只能在编辑器里靠右键菜单或记住的键位按到——命令面板搜不到、键位页看不见，
 * 等于「装好了但不可达」。本清单把它们补进「宿主命令」这一面：命令面板可搜可跑、键位页可看可改。
 *
 * **纯数据 + 纯查询，零 React、零 Monaco import**：`monacoActionId` 只是字符串，执行在
 * `ShellLayout` 侧走 `focusedCtx()?.editorRef.current?.getAction(id)`（与
 * `use-monaco-instance.ts` 的 `runEditorAction` 同一条通道）。清单本身不碰编辑器运行时，
 * 单测与任何渲染前读取都安全。
 *
 * ## monacoActionId 的取证口径（不许凭记忆写）
 *
 * 每条都在 `packages/app/node_modules/monaco-editor/esm/vs/` 的 vendor 源码里**逐字核过**：
 * `vendorFile` + `monacoActionId` 就是证据（`monaco-builtin-keybindings.test.ts` 回源码对账，
 * 剥掉枚举名注释后比对命令 id 与 `primary` 数字串）。
 * `keybinding` 记该动作在 Windows/Linux 下的 `primary`（Monaco 自己那份）——
 * **宿主不覆写、不劫持**，它只进只读页给你看。**没有 `primary` 默认键的动作 `keybinding` 留空**
 * （变换大小写 / 排序 / 去重都是这一类），那种动作只做命令面板入口，键位交给作者自定。
 *
 * ## 与 `keybinding-specs.ts` 的关系
 *
 * 本清单的 `id`（`editor.builtin.*` 形态）**全部**登记进宿主键位表（`rebindable:true`、无缺省键）：
 * 键位页于是看得见、作者可自行绑键；撞键判据仍只覆盖「有缺省键」那一面，本族的空键不参与。
 * 有 `primary` 默认键的另在只读页（`monaco-builtin-keybindings.ts`）记一行「Monaco 内建」。
 */

/** 分类名（中文）——命令面板分组用；可改键族的两类另在 `keybinding-specs.ts` 的序表里登记 */
export const MONACO_COMMAND_CATEGORY = {
  fold: '折叠',
  transform: '文本变换',
  line: '行操作',
  selection: '选择',
  comment: '注释',
  clipboard: '剪贴板',
} as const;

/** 一条内核动作 */
export interface MonacoCommandSpec {
  /** 宿主命令 id（命令面板/键位表同 key） */
  readonly id: string;
  /** 中文展示名 */
  readonly title: string;
  /** 中文分类（命令面板分组） */
  readonly category: string;
  /** Monaco 内部动作 id（`getAction` 的入参；vendor 逐字核过） */
  readonly monacoActionId: string;
  /** 这一条需要「有活动编辑器」才可用（折叠/选择/剪贴板在没有打开文件时全无意义） */
  readonly requiresFile: boolean;
  /** Monaco 的 Windows/Linux 缺省键；无缺省键的动作留空（undefined） */
  readonly keybinding?: string;
  /** 取证：`monacoActionId` / `keybinding` 在这个 vendor 文件里（相对 `esm/vs/`）核到 */
  readonly vendorFile: string;
}

const FOLDING = 'editor/contrib/folding/browser/folding.js';
const LINES = 'editor/contrib/linesOperations/browser/linesOperations.js';
const SMART_SELECT = 'editor/contrib/smartSelect/browser/smartSelect.js';
const COMMENT = 'editor/contrib/comment/browser/comment.js';
const CLIPBOARD = 'editor/contrib/clipboard/browser/clipboard.js';
const EDITOR_EXT = 'editor/browser/editorExtensions.js';

/**
 * 全部内核动作。
 *
 * 分块按族排列；折叠族里 `foldLevel1..7` 是 vendor 用
 * `for (let i = 1; i <= 7; i++) new FoldLevelAction({ id: FoldLevelAction.ID(i), ... })`
 * （`ID_PREFIX = 'editor.foldLevel'`）批量注册的 7 档，逐档收全。
 */
export const MONACO_COMMAND_SPECS: readonly MonacoCommandSpec[] = [
  // ---- 折叠（vendor: folding.js；键 = Ctrl+K 起头的和弦，Monaco 自己分发） ----
  { id: 'editor.builtin.foldAll', title: '全部折叠', category: MONACO_COMMAND_CATEGORY.fold, monacoActionId: 'editor.foldAll', keybinding: 'ctrl+k ctrl+0', requiresFile: true, vendorFile: FOLDING },
  { id: 'editor.builtin.unfoldAll', title: '全部展开', category: MONACO_COMMAND_CATEGORY.fold, monacoActionId: 'editor.unfoldAll', keybinding: 'ctrl+k ctrl+j', requiresFile: true, vendorFile: FOLDING },
  { id: 'editor.builtin.foldRecursively', title: '递归折叠（连子层一起）', category: MONACO_COMMAND_CATEGORY.fold, monacoActionId: 'editor.foldRecursively', keybinding: 'ctrl+k ctrl+[', requiresFile: true, vendorFile: FOLDING },
  { id: 'editor.builtin.unfoldRecursively', title: '递归展开', category: MONACO_COMMAND_CATEGORY.fold, monacoActionId: 'editor.unfoldRecursively', keybinding: 'ctrl+k ctrl+]', requiresFile: true, vendorFile: FOLDING },
  { id: 'editor.builtin.toggleFold', title: '切换当前折叠', category: MONACO_COMMAND_CATEGORY.fold, monacoActionId: 'editor.toggleFold', keybinding: 'ctrl+k ctrl+l', requiresFile: true, vendorFile: FOLDING },
  { id: 'editor.builtin.foldLevel1', title: '折叠到第 1 层', category: MONACO_COMMAND_CATEGORY.fold, monacoActionId: 'editor.foldLevel1', keybinding: 'ctrl+k ctrl+1', requiresFile: true, vendorFile: FOLDING },
  { id: 'editor.builtin.foldLevel2', title: '折叠到第 2 层', category: MONACO_COMMAND_CATEGORY.fold, monacoActionId: 'editor.foldLevel2', keybinding: 'ctrl+k ctrl+2', requiresFile: true, vendorFile: FOLDING },
  { id: 'editor.builtin.foldLevel3', title: '折叠到第 3 层', category: MONACO_COMMAND_CATEGORY.fold, monacoActionId: 'editor.foldLevel3', keybinding: 'ctrl+k ctrl+3', requiresFile: true, vendorFile: FOLDING },
  { id: 'editor.builtin.foldLevel4', title: '折叠到第 4 层', category: MONACO_COMMAND_CATEGORY.fold, monacoActionId: 'editor.foldLevel4', keybinding: 'ctrl+k ctrl+4', requiresFile: true, vendorFile: FOLDING },
  { id: 'editor.builtin.foldLevel5', title: '折叠到第 5 层', category: MONACO_COMMAND_CATEGORY.fold, monacoActionId: 'editor.foldLevel5', keybinding: 'ctrl+k ctrl+5', requiresFile: true, vendorFile: FOLDING },
  { id: 'editor.builtin.foldLevel6', title: '折叠到第 6 层', category: MONACO_COMMAND_CATEGORY.fold, monacoActionId: 'editor.foldLevel6', keybinding: 'ctrl+k ctrl+6', requiresFile: true, vendorFile: FOLDING },
  { id: 'editor.builtin.foldLevel7', title: '折叠到第 7 层', category: MONACO_COMMAND_CATEGORY.fold, monacoActionId: 'editor.foldLevel7', keybinding: 'ctrl+k ctrl+7', requiresFile: true, vendorFile: FOLDING },

  // ---- 文本变换（vendor: linesOperations.js；无 primary 默认键——键位留给作者自定） ----
  { id: 'editor.builtin.transformToUppercase', title: '转为大写', category: MONACO_COMMAND_CATEGORY.transform, monacoActionId: 'editor.action.transformToUppercase', requiresFile: true, vendorFile: LINES },
  { id: 'editor.builtin.transformToLowercase', title: '转为小写', category: MONACO_COMMAND_CATEGORY.transform, monacoActionId: 'editor.action.transformToLowercase', requiresFile: true, vendorFile: LINES },
  { id: 'editor.builtin.transformToTitlecase', title: '转为标题大小写', category: MONACO_COMMAND_CATEGORY.transform, monacoActionId: 'editor.action.transformToTitlecase', requiresFile: true, vendorFile: LINES },

  // ---- 行操作（vendor: linesOperations.js） ----
  { id: 'editor.builtin.sortLinesAscending', title: '选中行升序排序', category: MONACO_COMMAND_CATEGORY.line, monacoActionId: 'editor.action.sortLinesAscending', requiresFile: true, vendorFile: LINES },
  { id: 'editor.builtin.sortLinesDescending', title: '选中行降序排序', category: MONACO_COMMAND_CATEGORY.line, monacoActionId: 'editor.action.sortLinesDescending', requiresFile: true, vendorFile: LINES },
  { id: 'editor.builtin.removeDuplicateLines', title: '删除重复行', category: MONACO_COMMAND_CATEGORY.line, monacoActionId: 'editor.action.removeDuplicateLines', requiresFile: true, vendorFile: LINES },
  { id: 'editor.builtin.trimTrailingWhitespace', title: '去掉行尾空白', category: MONACO_COMMAND_CATEGORY.line, monacoActionId: 'editor.action.trimTrailingWhitespace', keybinding: 'ctrl+k ctrl+x', requiresFile: true, vendorFile: LINES },
  { id: 'editor.builtin.insertLineAfter', title: '在下方插入一行', category: MONACO_COMMAND_CATEGORY.line, monacoActionId: 'editor.action.insertLineAfter', keybinding: 'ctrl+enter', requiresFile: true, vendorFile: LINES },
  { id: 'editor.builtin.insertLineBefore', title: '在上方插入一行', category: MONACO_COMMAND_CATEGORY.line, monacoActionId: 'editor.action.insertLineBefore', keybinding: 'ctrl+shift+enter', requiresFile: true, vendorFile: LINES },

  // ---- 选择（smartSelect vendor: smartSelect.js；selectAll vendor: editorExtensions.js） ----
  { id: 'editor.builtin.smartSelectExpand', title: '扩大选择范围', category: MONACO_COMMAND_CATEGORY.selection, monacoActionId: 'editor.action.smartSelect.expand', keybinding: 'shift+alt+arrowright', requiresFile: true, vendorFile: SMART_SELECT },
  { id: 'editor.builtin.smartSelectShrink', title: '缩小选择范围', category: MONACO_COMMAND_CATEGORY.selection, monacoActionId: 'editor.action.smartSelect.shrink', keybinding: 'shift+alt+arrowleft', requiresFile: true, vendorFile: SMART_SELECT },
  { id: 'editor.builtin.selectAll', title: '全选', category: MONACO_COMMAND_CATEGORY.selection, monacoActionId: 'editor.action.selectAll', keybinding: 'ctrl+a', requiresFile: true, vendorFile: EDITOR_EXT },

  // ---- 注释（vendor: comment.js） ----
  { id: 'editor.builtin.addCommentLine', title: '添加行注释', category: MONACO_COMMAND_CATEGORY.comment, monacoActionId: 'editor.action.addCommentLine', keybinding: 'ctrl+k ctrl+c', requiresFile: true, vendorFile: COMMENT },
  { id: 'editor.builtin.removeCommentLine', title: '移除行注释', category: MONACO_COMMAND_CATEGORY.comment, monacoActionId: 'editor.action.removeCommentLine', keybinding: 'ctrl+k ctrl+u', requiresFile: true, vendorFile: COMMENT },

  // ---- 剪贴板（vendor: clipboard.js；primary 与 win 变体同值，按 primary 记） ----
  { id: 'editor.builtin.clipboardCut', title: '剪切', category: MONACO_COMMAND_CATEGORY.clipboard, monacoActionId: 'editor.action.clipboardCutAction', keybinding: 'ctrl+x', requiresFile: true, vendorFile: CLIPBOARD },
  { id: 'editor.builtin.clipboardCopy', title: '复制', category: MONACO_COMMAND_CATEGORY.clipboard, monacoActionId: 'editor.action.clipboardCopyAction', keybinding: 'ctrl+c', requiresFile: true, vendorFile: CLIPBOARD },
  { id: 'editor.builtin.clipboardPaste', title: '粘贴', category: MONACO_COMMAND_CATEGORY.clipboard, monacoActionId: 'editor.action.clipboardPasteAction', keybinding: 'ctrl+v', requiresFile: true, vendorFile: CLIPBOARD },
];

/** 条数（测试与读数用，不手抄数字） */
export const MONACO_COMMAND_SPEC_COUNT = MONACO_COMMAND_SPECS.length;

/** 按宿主命令 id 查一条 */
export function monacoCommandSpecOf(id: string): MonacoCommandSpec | undefined {
  return MONACO_COMMAND_SPECS.find((s) => s.id === id);
}

/** 有 Monaco 缺省键的（进只读页展示内建键；宿主不覆写） */
export function monacoCommandsWithBuiltinKey(): readonly MonacoCommandSpec[] {
  return MONACO_COMMAND_SPECS.filter((s) => s.keybinding !== undefined);
}

/** 无 Monaco 缺省键的（只做命令面板入口，键位交给作者自定——登记为可改键、无缺省键） */
export function monacoCommandsWithoutBuiltinKey(): readonly MonacoCommandSpec[] {
  return MONACO_COMMAND_SPECS.filter((s) => s.keybinding === undefined);
}