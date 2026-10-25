/**
 * 键位**规格表**（纯数据 + 纯查询）——全仓中文标题与缺省键位的唯一一份。
 *
 * ## 为什么要从 `keybindings.ts` 里拆出来
 *
 * `keybindings.ts` 是**运行期**：localStorage 覆盖表、持久化、订阅广播、React 钩子。
 * 右键菜单的 `context-menu-model.ts` 只用它做一件事——查一条命令的中文标题与键位展示。
 * 为两根展示字符串把整包运行期拖进开机图（`main.tsx → tutorial-context-menu.ts →
 * context-menu-model.ts → keybindings.ts`）不值。
 *
 * 拆法刻意是「数据下沉、运行期留在原处」：
 *
 * - 本模块**零 import**（真正的叶子）——表与查表函数不依赖 storage、不依赖 React、
 *   不依赖命令注册表，谁都能安全 import；
 * - `keybindings.ts` 反过来从这里取表并**原样再导出**，既有 `import { keybindingSpecOf }
 *   from './keybindings'` 的调用方一行不用改；
 * - 表只有这一份：`keybindings.ts` 里不再留 `KEYBINDING_SPECS` 字面量（守门见
 *   `packages/app/tests/keybindings-specs-split.test.ts`）。
 *
 * ## 边界
 *
 * - 不在这里读覆盖表：作者改键属于运行期状态，只有 `keybindings.ts` 知道「生效键位」。
 *   菜单要显示生效键位时走注入缝（`context-menu-model.ts` 的
 *   `registerMenuKeybindingLookup`），不在这里猜。
 * - 不在这里格式化：`formatKeybinding` 与键位解析（`parseKeybinding`）同住
 *   `ui/commands.ts`——那是零依赖纯函数模块，且**本来就在开机图里**（App.tsx 的命令注册表
 *   用它）。搬一次只会把六个调用方的 import 搅一遍，图一个字节也不省，故不搬。
 */

/** 键位注册表条目（宿主键位清单；展示名一律中文） */
export interface KeybindingSpec {
  /** 命令 id（与统一命令注册表同 key；Monaco 内部键位用 `editor.internal.` 前缀） */
  readonly id: string;
  /** 中文展示名（命令面板/键位表同词） */
  readonly title: string;
  /** 中文分类 */
  readonly category: string;
  /** 缺省键位（`undefined` = 无缺省键，仅命令面板入口；和弦含空格） */
  readonly keys?: string;
  /** 是否允许改键（和弦与 Monaco 内部键为 false） */
  readonly rebindable: boolean;
  /** 键位表里的备注（如「编辑器内生效」） */
  readonly note?: string;
}

/** 全部宿主键位（新增快捷键必须在这里登记，否则键位表看不见它） */
export const KEYBINDING_SPECS: readonly KeybindingSpec[] = [
  // ---- 布局（壳层容器语义） ----
  { id: 'layout.toggleSidebar', title: '切换主侧栏', category: '布局', keys: 'ctrl+b', rebindable: true },
  { id: 'layout.toggleBottom', title: '切换底部区', category: '布局', keys: 'ctrl+j', rebindable: true },
  { id: 'layout.toggleAux', title: '切换副侧栏', category: '布局', keys: 'ctrl+alt+b', rebindable: true },
  { id: 'layout.toggleZen', title: '切换写作模式', category: '布局', keys: 'ctrl+k z', rebindable: false, note: '和弦，暂不支持改键' },
  { id: 'layout.openSettings', title: '打开设置', category: '布局', rebindable: true },
  { id: 'layout.reset', title: '重置布局', category: '布局', rebindable: true },
  // ---- 工作台 ----
  { id: 'workbench.commandPalette', title: '命令面板', category: '工作台', keys: 'ctrl+shift+p', rebindable: true, note: 'F1 亦可' },
  { id: 'workbench.quickOpen', title: '快速打开文件', category: '工作台', keys: 'ctrl+p', rebindable: true },
  { id: 'workbench.workspaceSymbols', title: '转到工作区符号', category: '工作台', keys: 'ctrl+t', rebindable: true },
  { id: 'workbench.searchInFiles', title: '在文件中搜索', category: '工作台', keys: 'ctrl+shift+f', rebindable: true },
  { id: 'workbench.replaceInFiles', title: '在文件中替换', category: '工作台', keys: 'ctrl+shift+h', rebindable: true },
  { id: 'workbench.problems', title: '问题面板', category: '工作台', keys: 'ctrl+shift+m', rebindable: true },
  { id: 'workbench.keybindings', title: '打开键盘快捷键', category: '工作台', rebindable: true },
  // 兜底右键菜单的「检查更新」入口（1023 覆盖面批）：无缺省键位，登记在此只为让
  // 菜单与命令面板共用同一份中文名（`menuItemFromCommand` 从这里取标题）。
  { id: 'workbench.checkUpdates', title: '检查更新', category: '工作台', rebindable: true },
  // 文字缩放（A1 批给的缺省键位，本批入表 = 可查可改可显示）
  { id: 'editor.fontZoomIn', title: '放大文字', category: '编辑器', keys: 'ctrl+=', rebindable: true },
  { id: 'editor.fontZoomOut', title: '缩小文字', category: '编辑器', keys: 'ctrl+-', rebindable: true },
  { id: 'editor.fontZoomReset', title: '重置文字缩放', category: '编辑器', keys: 'ctrl+0', rebindable: true },
  // 状态栏即时开关（B 批）：自动换行 / 空白符显示——与状态栏那两格**同一个动作**
  // （`ShellLayout` 的 `applyToggleWordWrap` / `applyToggleRenderWhitespace`），
  // 落偏好真源、走既有订阅通路。`alt+z` 与 VSCode 一致；空白符**不给缺省键**：
  // 多占一个 Alt 组合会与 Windows 输入法切换抢键（与 `layout-pref.ts` 里多光标修饰键
  // 选 ctrlCmd 同一条理由），只做命令面板 + 状态栏入口，作者可在键位页自绑。
  { id: 'workbench.toggleWordWrap', title: '切换自动换行', category: '编辑器', keys: 'alt+z', rebindable: true },
  { id: 'workbench.toggleRenderWhitespace', title: '切换空白符显示', category: '编辑器', rebindable: true },
  { id: 'workbench.closeActiveTab', title: '关闭当前标签', category: '工作台', keys: 'ctrl+w', rebindable: true },
  { id: 'workbench.saveAll', title: '全部保存', category: '工作台', keys: 'ctrl+shift+s', rebindable: true },
  { id: 'workbench.fixAll', title: '一键修复当前文件', category: '工作台', keys: 'ctrl+shift+y', rebindable: true },
  { id: 'workbench.toggleSugarView', title: '切换 .kojo 预览', category: '工作台', keys: 'ctrl+alt+t', rebindable: true },
  { id: 'workbench.jumpToState', title: '看这一行的状态', category: '工作台', keys: 'ctrl+alt+s', rebindable: true },
  // 导航历史（MM-6 前进/后退 + MM-10 恢复关闭的标签）：编辑器肌肉记忆批。
  // Alt+←/→ 与 Ctrl+Shift+T 都是单键 chord，走全局分发（ShellLayout 注册表匹配）。
  { id: 'workbench.navBack', title: '后退', category: '工作台', keys: 'alt+arrowleft', rebindable: true },
  { id: 'workbench.navForward', title: '前进', category: '工作台', keys: 'alt+arrowright', rebindable: true },
  { id: 'workbench.reopenClosedTab', title: '恢复关闭的标签', category: '工作台', keys: 'ctrl+shift+t', rebindable: true },
  // 标签最近使用切换（1020 编辑器体感批）：Ctrl+Tab 在**焦点组**的 MRU 序里往后走。
  // Monaco 没有占这条键（vendor 里 `CtrlCmd|Tab` 零命中），宿主直接吃；连按语义在 App 的 cycleTab。
  { id: 'workbench.nextTab', title: '切到上一个用过的标签', category: '工作台', keys: 'ctrl+tab', rebindable: true, note: '连按继续在后用序里走；仅本组' },
  { id: 'workbench.prevTab', title: '切到下一个用过的标签', category: '工作台', keys: 'ctrl+shift+tab', rebindable: true, note: '与上一条方向相反；仅本组' },
  // ---- 分屏（SPLIT-1 编辑器组批 + MM-9 布局持久化批） ----
  { id: 'workbench.splitEditor', title: '向右拆分编辑器', category: '工作台', keys: 'ctrl+\\', rebindable: true },
  // MM-9：向下拆分同时把排列钉为上下（column）——命令名说什么就给什么；
  // 翻方向两条仅分屏时生效（单组翻了看不出来，命令侧先给人话）
  { id: 'workbench.splitEditorDown', title: '向下拆分编辑器', category: '工作台', rebindable: true, note: '拆分并切换为上下排列' },
  { id: 'workbench.setGroupsColumn', title: '编辑器组上下排列', category: '工作台', rebindable: true, note: '仅分屏时生效；单组先拆分' },
  { id: 'workbench.setGroupsRow', title: '编辑器组左右排列', category: '工作台', rebindable: true, note: '仅分屏时生效；单组先拆分' },
  { id: 'workbench.closeEditorGroup', title: '关闭编辑器组', category: '工作台', rebindable: true, note: '仅分屏时生效；单组不可关' },
  // ---- 编辑器动作（命令面板入口；不带缺省键位 = 不劫持 Monaco 内建键） ----
  { id: 'editor.action.find', title: '查找', category: '编辑器', rebindable: true, note: '编辑器内 Ctrl+F 为 Monaco 内建' },
  { id: 'editor.action.replace', title: '替换', category: '编辑器', rebindable: true, note: '编辑器内 Ctrl+H 为 Monaco 内建' },
  { id: 'editor.action.formatDocument', title: '格式化文档', category: '编辑器', rebindable: true, note: '编辑器内 Shift+Alt+F 为 Monaco 内建' },
  { id: 'editor.action.rename', title: '重命名符号', category: '编辑器', rebindable: true, note: '编辑器内 F2 为 Monaco 内建' },
  { id: 'editor.action.references', title: '查找引用', category: '编辑器', rebindable: true, note: '编辑器内 Shift+F12 为 Monaco 内建' },
  { id: 'editor.action.gotoLine', title: '转到行', category: '编辑器', rebindable: true, note: '编辑器内 Ctrl+G 为 Monaco 内建' },
  // ---- 编辑器内部（Monaco addCommand，仅展示） ----
  { id: 'editor.internal.save', title: '保存当前文件', category: '编辑器', keys: 'ctrl+s', rebindable: false, note: '编辑器内生效，暂不支持改键' },
  // A7「在选定内容中查找」：有选区时把选中文本灌进 find 并把搜索域钉在选区（无选区不动作）
  { id: 'editor.internal.findInSelection', title: '在选定内容中查找', category: '编辑器', keys: 'ctrl+alt+f', rebindable: false, note: '编辑器内生效；先选中文本再按' },
  // ---- 内核动作（1026 编辑器内核批）----
  // id 与 `ui/monaco-command-specs.ts` 一一对应（测试钉住）；本表只登记「命令面板入口」——
  // 这些动作的键由 Monaco 自己处理（内建键），宿主**不覆写、不劫持**，故一律不给缺省键
  // （keys 留空）。作者想另配宿主键可在此页改键；不改就照 Monaco 内建键用（只读页另列一份）。
  // 分类名与 monaco-command-specs 的中文名逐字相同（命令面板同分组）。
  { id: 'editor.builtin.foldAll', title: '全部折叠', category: '折叠', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+0 为 Monaco 内建' },
  { id: 'editor.builtin.unfoldAll', title: '全部展开', category: '折叠', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+J 为 Monaco 内建' },
  { id: 'editor.builtin.foldRecursively', title: '递归折叠（连子层一起）', category: '折叠', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+[ 为 Monaco 内建' },
  { id: 'editor.builtin.unfoldRecursively', title: '递归展开', category: '折叠', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+] 为 Monaco 内建' },
  { id: 'editor.builtin.toggleFold', title: '切换当前折叠', category: '折叠', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+L 为 Monaco 内建' },
  { id: 'editor.builtin.foldLevel1', title: '折叠到第 1 层', category: '折叠', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+1 为 Monaco 内建' },
  { id: 'editor.builtin.foldLevel2', title: '折叠到第 2 层', category: '折叠', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+2 为 Monaco 内建' },
  { id: 'editor.builtin.foldLevel3', title: '折叠到第 3 层', category: '折叠', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+3 为 Monaco 内建' },
  { id: 'editor.builtin.foldLevel4', title: '折叠到第 4 层', category: '折叠', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+4 为 Monaco 内建' },
  { id: 'editor.builtin.foldLevel5', title: '折叠到第 5 层', category: '折叠', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+5 为 Monaco 内建' },
  { id: 'editor.builtin.foldLevel6', title: '折叠到第 6 层', category: '折叠', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+6 为 Monaco 内建' },
  { id: 'editor.builtin.foldLevel7', title: '折叠到第 7 层', category: '折叠', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+7 为 Monaco 内建' },
  { id: 'editor.builtin.transformToUppercase', title: '转为大写', category: '文本变换', rebindable: true },
  { id: 'editor.builtin.transformToLowercase', title: '转为小写', category: '文本变换', rebindable: true },
  { id: 'editor.builtin.transformToTitlecase', title: '转为标题大小写', category: '文本变换', rebindable: true },
  { id: 'editor.builtin.sortLinesAscending', title: '选中行升序排序', category: '行操作', rebindable: true },
  { id: 'editor.builtin.sortLinesDescending', title: '选中行降序排序', category: '行操作', rebindable: true },
  { id: 'editor.builtin.removeDuplicateLines', title: '删除重复行', category: '行操作', rebindable: true },
  { id: 'editor.builtin.trimTrailingWhitespace', title: '去掉行尾空白', category: '行操作', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+X 为 Monaco 内建' },
  { id: 'editor.builtin.insertLineAfter', title: '在下方插入一行', category: '行操作', rebindable: true, note: '编辑器内 Ctrl+Enter 为 Monaco 内建' },
  { id: 'editor.builtin.insertLineBefore', title: '在上方插入一行', category: '行操作', rebindable: true, note: '编辑器内 Ctrl+Shift+Enter 为 Monaco 内建' },
  { id: 'editor.builtin.smartSelectExpand', title: '扩大选择范围', category: '选择', rebindable: true, note: '编辑器内 Shift+Alt+→ 为 Monaco 内建' },
  { id: 'editor.builtin.smartSelectShrink', title: '缩小选择范围', category: '选择', rebindable: true, note: '编辑器内 Shift+Alt+← 为 Monaco 内建' },
  { id: 'editor.builtin.selectAll', title: '全选', category: '选择', rebindable: true, note: '编辑器内 Ctrl+A 为 Monaco 内建' },
  { id: 'editor.builtin.addCommentLine', title: '添加行注释', category: '注释', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+C 为 Monaco 内建' },
  { id: 'editor.builtin.removeCommentLine', title: '移除行注释', category: '注释', rebindable: true, note: '编辑器内 Ctrl+K Ctrl+U 为 Monaco 内建' },
  { id: 'editor.builtin.clipboardCut', title: '剪切', category: '剪贴板', rebindable: true, note: '编辑器内 Ctrl+X 为 Monaco 内建' },
  { id: 'editor.builtin.clipboardCopy', title: '复制', category: '剪贴板', rebindable: true, note: '编辑器内 Ctrl+C 为 Monaco 内建' },
  { id: 'editor.builtin.clipboardPaste', title: '粘贴', category: '剪贴板', rebindable: true, note: '编辑器内 Ctrl+V 为 Monaco 内建' },
];

/** 缺省键位索引（只收有缺省键的条目） */
const DEFAULTS: ReadonlyMap<string, string> = new Map(
  KEYBINDING_SPECS.filter((s) => s.keys !== undefined).map((s) => [s.id, s.keys!]),
);

/**
 * 分类的展示顺序（快捷键页左导航据此排）。
 *
 * 为什么要显式一张序表而不是 `localeCompare`：分类名是中文，字典序随运行环境的区域设置漂移，
 * 同一张表在两台机器上两种顺序 ⇒ 作者记住「编辑器在第三位」就不可靠。
 * 新增分类**必须同时**加进这里，否则该分类会被排到最后（漏了也不会炸，只是靠后）。
 */
export const KEYBINDING_CATEGORY_ORDER: readonly string[] = [
  '工作台',
  '布局',
  '编辑器',
  // 内核动作（1026 编辑器内核批）：命令面板与 `ui/monaco-command-specs.ts` 的中文分类逐字相同
  '折叠',
  '文本变换',
  '行操作',
  '选择',
  '注释',
  '剪贴板',
];

/** 缺省键位（不在注册表 = undefined）；只回答「出厂是什么」，不回答「现在生效什么」 */
export function defaultKeybindingOf(id: string): string | undefined {
  return DEFAULTS.get(id);
}

/** 注册表条目（展示用）；未登记 = undefined */
export function keybindingSpecOf(id: string): KeybindingSpec | undefined {
  return KEYBINDING_SPECS.find((s) => s.id === id);
}
