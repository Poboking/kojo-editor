/**
 * 未落盘草稿（KW-16B，对标 VSCode 的 `untitled-N` / IDEA 的 scratch）。
 *
 * ## 为什么要有这一枚，而不是复用「新建文件」
 *
 * 今天仓里两条新建通道都要求**先命名 / 先选落点**才能写下第一个字：向导
 * `kojo.newKojoFile` 要选项目 + 作者包 + 文件名，文件树『新建文件』要右键目录 + 敲名，
 * 并且当场在盘上留一枚空文件。作者要的"试一段写法、临时记个台词"恰恰是
 * **新建即可写、落盘才命名**——那一步之前不存在，因为没有载体。
 *
 * ## 三条不变量（每条都有判据钉着）
 *
 * 1. **盘上零足迹**：标签键 `untitled:N` 不是路径（前缀与判据的单源在 `tabs-ops.ts`），
 *    建 model 走"注入空正文"那条腿，一个字节都不读盘也不写盘；
 * 2. **落点只在保存那一刻由作者定**：首次保存复用 1028 那条**已审的另存为腿**
 *    （`file-save-as.ts`——系统对话框只交回路径，落盘仍过内核写域双闸）。
 *    刻意**不**新开 `exportFile` 通道：那条允许域外落点，拿它当草稿的常规保存
 *    等于给"把口上写进游戏目录"开第四条路（铁律 5/6）；走另存为，作者就算把落点
 *    选进游戏根也写不进去，并被诚实指回『导出』；
 * 3. **不静默**：草稿恒脏（基线钉 0）⇒ 关标签 / 关项目 / 关窗三条退出路径的既有
 *    确认链都会点名它；会话快照**不存**它（`serializeGroups` 那侧剔掉），因为
 *    "上次有一枚草稿"这件事在没有内容的前提下是句假话。
 *
 * 零游戏名词：本模块只认"未落盘"这一件事，不认识 `.kojo` / `.ERB` / 角色号。
 */

import { UNTITLED_PREFIX, isUntitledPath, tabName } from './tabs-ops';

/** 新建草稿的壳层命令 id（命令面板与两处按钮共用；标题单源在 `ProjectView` 的命令表） */
export const NEW_UNTITLED_DRAFT_COMMAND = 'workbench.newUntitledDraft';

/**
 * 下一枚草稿的标签键：取**当前开着的**草稿序号的最大值 + 1。
 *
 * 序号从 1 起（作者看到的是「未命名草稿 1」），且刻意不持模块级计数器：真源就是
 * 标签表本身——关掉一枚再新建，序号复用与否由当下事实决定，绝不因"计数器还在涨"
 * 而凭空跳号（模块级 `let` 在分屏/多会话下还是第二真源）。非数值的脏键跳过，不参与
 * 取最大（损坏容忍，不抛）。
 */
export function nextUntitledPath(openTabs: readonly string[]): string {
  let max = 0;
  for (const p of openTabs) {
    if (!isUntitledPath(p)) continue;
    const n = Number(p.slice(UNTITLED_PREFIX.length));
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return `${UNTITLED_PREFIX}${max + 1}`;
}

/**
 * 草稿首次落盘时给系统对话框的预填名（`file-save-as.ts` 据此造标题与默认名）。
 *
 * `.txt` 是**刻意的**：草稿没有扩展名 ⇒ 语言面是纯文本（`languageForPath` 按扩展名选），
 * 预填 `.txt` 说的就是"此刻它什么都还不是"；作者想要口上源 / ERB 就在对话框里把
 * 扩展名改了——落名是作者的决定，工具不替他猜哪一种。
 */
export function untitledDraftFileName(path: string): string {
  const n = path.slice(UNTITLED_PREFIX.length);
  return `未命名草稿${n === '' ? '' : `-${n}`}.txt`;
}

/**
 * 草稿落成的那句人话（「另存为」这个词对草稿不成立：它原来没有落点，无从"另"存）。
 * 与 `file-save-as.ts` 的另存成功句同一口径——说清落点、说清编辑转到哪里继续。
 */
export function untitledSavedMessage(path: string, to: string): string {
  return `${tabName(path)} 已落成 ${to}——这一格从此是盘上的文件，编辑转到新路径继续。`;
}

/**
 * 草稿落盘途中又有新输入的那句人话（竞态窗口）。
 * 与保存链 `kept-dirty` 同一口径——**没落成就不许报"已保存"**。
 */
export function untitledKeptDirtyMessage(path: string): string {
  return `${tabName(path)} 已落盘，但写盘窗口内又有新输入——这一格仍标记未保存。`;
}

/** 平台没有原生落点对话框时的那句人话（浏览器宿 / Node 桥：不假装成功） */
export const UNTITLED_NO_DIALOG_MESSAGE =
  '这台机器上没有系统落点对话框（需要桌面壳）——草稿一个字节都没写，内容还在这一格里。';
