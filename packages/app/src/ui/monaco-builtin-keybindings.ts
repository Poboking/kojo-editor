/**
 * Monaco 内建键位（1020 编辑器体感批，用户反馈项 8）——快捷键页的**只读**分组。
 *
 * 为什么要单独列一份：`KEYBINDING_SPECS` 是"宿主自己处理的键"的清单，而编辑区内一大批
 * 能力（速览定义、跳到符号、跳到行、加选下一个匹配、删除整行、列选…）随 Monaco 的
 * contrib 一起装好了（取证：`packages/app/src/monaco/entry.ts` 的 contrib 段就是
 * `editor.main.js` 的非语言段），作者却只能在"键位页看不到"的份上靠记忆用。
 * 键位页因此补一组"看得到、改不了"的行——不改口径、不假装可改键（房规：不给一个点了没反应的控件，
 * 这一组的"操作"格整格不渲染）。
 *
 * **每条都在 monaco-editor@0.57.0 的 vendor 源码里逐字核过**（`KeyMod`/`KeyCode` 常量在
 * 打包产物里是裸数字，注释里的名字是取证依据）：Windows/Linux 走 `primary`，mac 走 `mac`，
 * 本表按 `primary` 记（本 app 的主战场是 Windows）。没有 `primary` 默认键的命令一律不进表。
 *
 * 判据不住在这里：行形状与 `KeybindingRow` 逐字同构，`buildKeybindingRows` 的宿主行
 * 与本表在快捷键页里拼成一列，搜索 / 分组 / 计数全部复用既有那条路径，不另写第二份。
 */
import { formatKeybinding } from './commands';
import type { KeybindingRow } from './keybindings';
// 1026 编辑器内核批：内核动作里有 Monaco 缺省键的那批从单源清单生成，不在这里手抄第二份
import { monacoCommandsWithBuiltinKey } from './monaco-command-specs';

/** Monaco 内建键位的分类名（快捷键页的分组标题；也是 `KEYBINDING_CATEGORY_ORDER` 未登记 ⇒ 恒排最后） */
export const MONACO_BUILTIN_CATEGORY = 'Monaco 内建';

interface BuiltinSpec {
  readonly id: string;
  readonly title: string;
  readonly keys: string;
  readonly note?: string;
}

/** vendor 核过的内建键（缺省键位 = Monaco 自己那份，宿主不劫持、不覆写） */
const BUILTIN_SPECS: readonly BuiltinSpec[] = [
  { id: 'monaco.editor.action.revealDefinition', title: '转到定义', keys: 'f12', note: 'Monaco 内建；本编辑器接到语言服务的定义供方' },
  { id: 'monaco.editor.action.peekDefinition', title: '速览定义（就地展开，不切走）', keys: 'alt+f12' },
  { id: 'monaco.editor.action.goToImplementation', title: '跳到实现', keys: 'ctrl+f12' },
  { id: 'monaco.editor.action.goToReferences', title: '查找引用', keys: 'shift+f12' },
  { id: 'monaco.editor.action.rename', title: '重命名符号', keys: 'f2', note: '只读文件上不给改' },
  { id: 'monaco.editor.action.gotoLine', title: '转到行', keys: 'ctrl+g' },
  { id: 'monaco.editor.action.quickOutline', title: '转到本文件符号', keys: 'ctrl+shift+o' },
  { id: 'monaco.editor.action.jumpToBracket', title: '跳到配对括号', keys: 'ctrl+shift+\\' },
  { id: 'monaco.editor.action.addSelectionToNextFindMatch', title: '把下一个相同词加进选区', keys: 'ctrl+d' },
  { id: 'monaco.editor.action.selectHighlights', title: '一次选中全文所有相同词', keys: 'ctrl+shift+l' },
  { id: 'monaco.editor.action.insertCursorAbove', title: '在上一行加一个光标', keys: 'ctrl+alt+arrowup' },
  { id: 'monaco.editor.action.insertCursorBelow', title: '在下一行加一个光标', keys: 'ctrl+alt+arrowdown' },
  { id: 'monaco.editor.action.deleteLines', title: '删除整行', keys: 'ctrl+shift+k' },
  { id: 'monaco.editor.action.moveLinesUpAction', title: '把这一行上移', keys: 'alt+arrowup' },
  { id: 'monaco.editor.action.moveLinesDownAction', title: '把这一行下移', keys: 'alt+arrowdown' },
  { id: 'monaco.editor.action.copyLinesUpAction', title: '向上复制这一行', keys: 'shift+alt+arrowup' },
  { id: 'monaco.editor.action.copyLinesDownAction', title: '向下复制这一行', keys: 'shift+alt+arrowdown' },
  { id: 'monaco.editor.action.indentLines', title: '增加缩进', keys: 'ctrl+]' },
  { id: 'monaco.editor.action.outdentLines', title: '减少缩进', keys: 'ctrl+[' },
  { id: 'monaco.editor.action.commentLine', title: '切换注释', keys: 'ctrl+/', note: '口上行文不是注释语义，这一条对 .ERB 的 ERB 注释段有效' },
  { id: 'monaco.editor.action.blockComment', title: '切换块注释', keys: 'shift+alt+a' },
  { id: 'monaco.editor.action.formatDocument', title: '整理全文空白', keys: 'shift+alt+f' },
  { id: 'monaco.editor.action.triggerSuggest', title: '手动弹出补全', keys: 'ctrl+space' },
  { id: 'monaco.editor.action.triggerParameterHints', title: '看这一处的形参提示', keys: 'ctrl+shift+space' },
  { id: 'monaco.editor.action.marker.next', title: '跳到下一个问题（本文件内）', keys: 'alt+f8' },
  { id: 'monaco.editor.action.marker.prev', title: '跳到上一个问题（本文件内）', keys: 'shift+alt+f8' },
  // F8 这一对由 Monaco 的 gotoError 贡献方注册（跨"有问题的文件"走，只在编辑器聚焦时生效）；
  // 「问题」面板里聚焦时那一拍由面板自己按过滤后的列表代跳（见 ProblemPanel 的 F8）。
  { id: 'monaco.editor.action.marker.nextInFiles', title: '跳到下一个问题（跨文件）', keys: 'f8', note: '焦点在编辑器里时由 Monaco 跳；焦点在「问题」面板里时按面板的过滤列表跳' },
  { id: 'monaco.editor.action.marker.prevInFiles', title: '跳到上一个问题（跨文件）', keys: 'shift+f8' },
];

/**
 * 内核动作里**有 Monaco 缺省键**的那批（1026 编辑器内核批）——从不手抄，
 * 直接从 `ui/monaco-command-specs.ts` 单源生成：`id` = `monaco.` + `monacoActionId`，
 * `title` 复用命令面板的中文名，`keys` 是 Monaco 的 Windows 缺省键（含 `Ctrl+K` 和弦）。
 * 取证与命令 id 的核证全在那边（`vendorFile` 字段），测试回 vendor 逐条对账。
 */
const BRIDGED_BUILTIN_SPECS: readonly BuiltinSpec[] = monacoCommandsWithBuiltinKey().map((s) => ({
  id: `monaco.${s.monacoActionId}`,
  title: s.title,
  keys: s.keybinding!,
}));

/** 只读页的完整清单：既有 1020 批 30 条 + 1026 批桥进来的内核动作 */
const ALL_BUILTIN_SPECS: readonly BuiltinSpec[] = [...BUILTIN_SPECS, ...BRIDGED_BUILTIN_SPECS];

/**
 * 只读行（`rebindable:false` ⇒ 页面上不出现"改键 / 解绑"的操作格；
 * `state:'default'` ⇒ 「已改」范围里不出现，因为作者根本改不了它）。
 *
 * `conflictWith` 一律 null：撞键判据只覆盖宿主注册表（那是唯一能被作者改键的一面），
 * 拿内建键去和宿主键互指会报出一堆"改不了却喊撞车"的行——那条口径由
 * `keybindings.ts` 的 `keybindingConflictWith` 守着，本表不参与。
 */
export function monacoBuiltinRows(): KeybindingRow[] {
  return ALL_BUILTIN_SPECS.map((s) => ({
    id: s.id,
    title: s.title,
    category: MONACO_BUILTIN_CATEGORY,
    keys: s.keys,
    display: formatKeybinding(s.keys),
    rebindable: false,
    note: s.note ?? 'Monaco 内建，不在此页改键',
    state: 'default',
    conflictWith: null,
  }));
}

/** 内建键位条数（测试与页面读数用，不手抄数字） */
export const MONACO_BUILTIN_COUNT = ALL_BUILTIN_SPECS.length;

/** 这条内建键的鼠标手势说明（列选择不是按键，不进表；设置页那一行仍归排版偏好管） */
export const COLUMN_SELECT_GESTURE =
  '按住 Alt 再拖动 = 列选（把多光标修饰键改成 Alt 时，用 Shift+Alt 拖动）；或在设置里打开「列选择」，直接拖动即列选';
