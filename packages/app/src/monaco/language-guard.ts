/**
 * 编辑器只读门的**语言面判据**（ADR-0005 的两轴只差这一格；ERB-PARITY G6）。
 *
 * 门本身仍是"两轴合一"：目录分野（作者工作区恒可编辑）+ 显式解锁（会话内解锁 / 直连
 * 已获写权限）。这里只回答第一件事——**哪些文件属于"要保护起来的作者源文件"**，而那件事
 * 是各门语言自己的声明（`LanguageDescriptor.gameDirReadOnly`）。
 *
 * 为什么判据从 `isErbDialectPath` 换成 descriptor 声明：只认 ERB 时，2.0 的 `.kojo` /
 * `.kojo2` 与封存档的 `.kojo1` 漏在门外——游戏目录里它们默认**可编辑**，可保存又必然被
 * 写允许域拒掉（作者改了一屏、按保存才发现存不出去）。门现在按声明铺开：新增一门作者
 * 语言只需在 descriptor 上加一格，宿主目录零改动。
 *
 * 为什么本模块必须**自己**把语言表装载进来（`import './languages'`）：它由
 * `ui/EditorPane` 静态引，而 EditorPane 与语言面在**同一条懒边**内；把表装在
 * `lift-preview`（开机图内，ShellLayout → file-area 那条边）会把整张 descriptor 表拖上
 * 首屏。module 装载即登记，于是本模块第一次被调用时表必已就位。
 */
import './languages';
import { languageDescriptors } from './language-registry';

/** 这条路径是不是"游戏目录里默认只读"的作者源文件（声明面 = descriptor 的 `gameDirReadOnly`） */
export function isGuardedGameSourcePath(filePath: string): boolean {
  return languageDescriptors().some(
    (descriptor) => descriptor.gameDirReadOnly === true && descriptor.matchesPath(filePath),
  );
}

/**
 * 编辑器只读门（**两轴合一**，纯函数便于单测；ADR-0005）：
 *
 * - 轴一 · 目录分野：作者工作区（常驻可写根）里的源文件是创作源文件，恒可编辑；
 *   游戏目录里的默认只读。
 * - 轴二 · 显式解锁：`canEdit` = 本次会话已解锁该文件 **或** 直连模式开门且该路径已获写权限。
 *
 * 只有"受保护的源文件 ∧ 不在工作区 ∧ 没拿到可编辑"三者同时成立才锁。能不能真落盘仍由
 * 内核 io 的写允许域决定（本门只决定"屏幕上让不让动手"）。
 */
export function sourceReadOnlyGate(
  path: string,
  axes: { inWorkspace: boolean; canEdit: boolean },
): boolean {
  return isGuardedGameSourcePath(path) && !axes.inWorkspace && !axes.canEdit;
}