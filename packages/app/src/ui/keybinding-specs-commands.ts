/**
 * **命令面板入口型**键位条目（1026 三批：编辑器内核 A / 体感 C / 状态栏 B）——
 * 只在懒面供给，不进开机图。
 *
 * ## 为什么单开这一层（PS-10 减面批）
 *
 * `./keybinding-specs` 是**开机图内的零 import 叶子**：`context-menu-model.ts`（同样在开机图）
 * 值引它，为右键菜单的每一项取中文标题与缺省键——那面必须同步可得。
 *
 * 本模块这 35 条**都不吃右键菜单那面**：内核动作（`editor.builtin.*`）由 Monaco 自己的
 * 右键菜单列，书签 / 状态栏开关也没有宿主菜单入口（三处的右键面清单里一枚都没有——
 * 见 `editor-context-actions.ts` / `context-menu-pages.ts` 的 commandId 列表）。它们的全部
 * 用途是「命令面板可搜 + 键位页可见可改」，而**命令面板与键位页都住在懒 chunk**里
 * （`palette-search` / `KeybindingsPage` / `keybindings.ts` 实测都不在开机图）。
 * 故本模块只被 `./keybindings` 值引，随它一起懒装载——开机图省下这 35 条的源码字节，
 * 功能面一枚不少（判据：命令面板仍搜得到全部内核动作、键位页仍列全、`alt+z` / `alt+f2`
 * 族仍生效——`effectiveKeybindingOf` 在 `./keybindings` 里对合并表查缺省）。
 *
 * ## 单源：内核动作 29 条不再抄第二份
 *
 * 这 29 条的 title / category / 「Monaco 内建键」说明一律从 `./monaco-command-specs`
 * **派生**（那是命令面板的同一真源）。从前 `keybinding-specs.ts` 手抄了同一批 id/title/category，
 * 两处各写一份就是本仓反复记的「双真源必然漂移」形状——本批顺手收口。
 */
import { formatKeybinding } from './commands';
import { MONACO_COMMAND_SPECS } from './monaco-command-specs';
import type { KeybindingSpec } from './keybinding-specs';

/**
 * 内核动作（A 批）——由 `MONACO_COMMAND_SPECS` 派生。
 *
 * 一律不给宿主缺省键（`keys` 留空）：这些动作的键由 Monaco 自己分发（内建键），宿主
 * 不覆写、不劫持；作者想另配宿主键可在键位页改。有 Monaco 内建键的那 18 条补一句
 * 只读说明（人读形走 `formatKeybinding`，与只读页同一把尺子）。
 */
const BUILTIN_ACTION_SPECS: readonly KeybindingSpec[] = MONACO_COMMAND_SPECS.map((s) => ({
  id: s.id,
  title: s.title,
  category: s.category,
  rebindable: true,
  ...(s.keybinding === undefined
    ? {}
    : { note: `编辑器内 ${formatKeybinding(s.keybinding)} 为 Monaco 内建` }),
}));

/**
 * 文档内书签（C 批）。
 *
 * 键位选择依据（登记之前逐条核过冲突）：F2 / Ctrl+F2 / Ctrl+Shift+F2 / Ctrl+K F2 均被
 * Monaco 占（重命名 / 多光标 / 联动编辑 / 速览引用），故取 F2 族唯一空位 Alt+F2 做切换；
 * F3 族被 Monaco 查找族占，取 Alt+F3 与 Ctrl+Alt+F3 做「下一个 / 上一个」——
 * 同键加减一个 Ctrl 表方向；刻意不用 Alt+Shift 组合（Windows 输入法语言切换高发，
 * 与 `layout-pref.ts` 避开 Alt 的取舍同源）。书签是纯内存态（不落盘、不越写盘闸）。
 */
const BOOKMARK_SPECS: readonly KeybindingSpec[] = [
  { id: 'bookmarks.toggle', title: '切换书签', category: '书签', keys: 'alt+f2', rebindable: true, note: '当前行；同键再按取消' },
  { id: 'bookmarks.next', title: '跳到下一个书签', category: '书签', keys: 'alt+f3', rebindable: true, note: '本文件内；到末尾回绕到第一个' },
  { id: 'bookmarks.prev', title: '跳到上一个书签', category: '书签', keys: 'ctrl+alt+f3', rebindable: true, note: '本文件内；到开头回绕到最后一个' },
  { id: 'bookmarks.clearFile', title: '清除本文件书签', category: '书签', rebindable: true },
];

/**
 * 状态栏即时开关（B 批）：自动换行 / 空白符显示——与状态栏那两格**同一个动作**
 * （`ShellLayout` 的 `applyToggleWordWrap` / `applyToggleRenderWhitespace`），
 * 落偏好真源、走既有订阅通路。`alt+z` 与 VSCode 一致；空白符**不给缺省键**：
 * 多占一个 Alt 组合会与 Windows 输入法语言切换抢键（与 `layout-pref.ts` 里多光标修饰键
 * 选 ctrlCmd 同一条理由），只做命令面板 + 状态栏入口，作者可在键位页自绑。
 */
const STATUS_BAR_SPECS: readonly KeybindingSpec[] = [
  { id: 'workbench.toggleWordWrap', title: '切换自动换行', category: '编辑器', keys: 'alt+z', rebindable: true },
  { id: 'workbench.toggleRenderWhitespace', title: '切换空白符显示', category: '编辑器', rebindable: true },
];

/** 命令面板入口型条目全集（`./keybindings` 把它拼在静态基础表后，构成键位页看到的完整表） */
export const COMMAND_PANEL_KEYBINDING_SPECS: readonly KeybindingSpec[] = [
  ...STATUS_BAR_SPECS,
  ...BOOKMARK_SPECS,
  ...BUILTIN_ACTION_SPECS,
];