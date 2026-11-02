/**
 * 「当前打开的文件落在哪一区」——编辑器只读分野与底部状态栏可写胶囊的**同一把尺子**。
 *
 * ## 为什么单独成模块
 *
 * 这条判定原本只活在 `EditorPane.inWorkspace` 里（编辑器拿它决定 Monaco 的 readOnly）。
 * 状态栏那颗可写胶囊改成**按所在区域**上色（工作项目区绿「可写」／口上区黄「只读」）之后，
 * 同一个问题有了第二个问口。两处各写一遍 `isUnderAnyRoot(workspaceProjectDirsOf(kernel), p)`
 * 就是两个真源——本仓被"副本判定"咬过两次（FT-2 / PITFALLS 42：一处放宽另一处没跟上，
 * 症状是同一份文件在两个界面上互相打脸）。所以分野收进这一个纯函数，两处都只调它。
 *
 * ## 三态口径（ADR-0005 的两道正交轴，只看路径形状，零游戏知识）
 *
 * | 区域 | 依据 | 可写性 |
 * |---|---|---|
 * | `workspace` | 落在**常驻可写目录**之内（默认根 + 已解析的作品目录） | 恒可写：创作权威区，与项目授权状态无关 |
 * | `game-erb` | 工作区外的原生 ERB（`.erb` / `.erm`）＝游戏目录里的借阅件 | 默认只读；要改就逐份破例或走直连模式 |
 * | `other` | 没有打开文件／区域外的非 ERB 文件 | **不替区域作保**：回落到项目级授权状态 |
 *
 * 2026-10-27 收窄批：`workspace` 的判据从 `roots()`（含自选根根身）换成
 * `workspaces.projectDirs()`（只含作品目录）。作者把游戏目录选成"项目位置"时，
 * 旧判据会把游戏目录里的 ERB 判成"工作区可写"——编辑器拿掉只读、胶囊亮绿，
 * 而写闸照旧拒绝（状态与事实打脸的另一半）。
 *
 * `other` 那一格是故意的：区域只回答"在哪一区"，答不出"这一区的这份文件此刻能不能写"
 * （游戏目录里已批准写入的 `.kojo` 就是反例）。胶囊因此保留既有那条项目级口径，
 * 而不是把非 ERB 也硬染成只读。
 */

import type { Kernel } from '@kojo/kernel';
import { isErbLike } from './lift-preview';
import { isUnderAnyRoot, workspaceProjectDirsOf } from './workspace-roots';

/** 可写性分野的三区（状态栏胶囊与编辑器 readOnly 共用的坐标） */
export type FileWritableArea = 'workspace' | 'game-erb' | 'other';

/**
 * 纯判定：路径落在哪一区。根列表由调用方给（便于单测钉死口径）。
 *
 * 无路径（没有打开的文件）→ `other`，不是 `workspace`：空态不许替任何文件作保。
 */
export function fileWritableAreaOf(filePath: string | null, roots: readonly string[]): FileWritableArea {
  if (!filePath) return 'other';
  if (isUnderAnyRoot(roots, filePath)) return 'workspace';
  return isErbLike(filePath) ? 'game-erb' : 'other';
}

/**
 * 现取常驻可写目录再判（**不缓存**：`projectDirs()` 是同步读内存数组、零 IO，缓存会把
 * 本会话刚建出来的作品目录永远排除在外——口径同 `workspace-roots.ts`）。
 */
export function fileWritableArea(kernel: Pick<Kernel, 'workspaces'>, filePath: string | null): FileWritableArea {
  return fileWritableAreaOf(filePath, workspaceProjectDirsOf(kernel));
}

/**
 * 这份文件是否在工作区（创作权威区）——`EditorPane` 的 `inWorkspace` 走这一条。
 *
 * 刻意不给"顺手抄一份 `isUnderAnyRoot`"留余地：判定只有一个名字，改口径只能改这里。
 */
export function isInWorkspaceFile(kernel: Pick<Kernel, 'workspaces'>, filePath: string): boolean {
  return fileWritableArea(kernel, filePath) === 'workspace';
}

/** 状态栏可写胶囊的两档配色（`.sb-writable.ok` 绿 / `.sb-writable.ro` 琥珀） */
export type WritablePillTone = 'ok' | 'ro';

/**
 * 胶囊该显示哪一档：**区域优先，区域答不出才回落到项目级授权状态**。
 *
 * 口上区那颗始终可点（点击 = 重新批准写权限），工作区那颗只是说明（本就恒可写，
 * 点了没有授权动作可做）——这一层差别留在渲染处，不在这里用布尔冒充两个语义。
 */
export function writablePillTone(area: FileWritableArea, projectWritable: boolean): WritablePillTone {
  if (area === 'workspace') return 'ok';
  if (area === 'game-erb') return 'ro';
  return projectWritable ? 'ok' : 'ro';
}

/**
 * 可写性说明文案的**唯一一处**（KW16 标签色轨批，2026-11-02）。
 *
 * 改前这三句只长在 `ShellLayout` 的状态栏胶囊里。标签页的语义色轨问的是同一件事，
 * 再写一套说法就是第二口径——所以把句子搬到区域判定的家门口，胶囊原样取用（屏上一字不变），
 * 色轨的悬停说明在它上面加自己的那一档。
 */
export const WRITABLE_HINTS = {
  /** 轴一 · 作者工作区：恒可写，不解释授权 */
  workspace: '这份文件在你的工作项目区（你自己写的口上文件），可以直接保存。',
  /** 轴一 · 游戏目录里的原生文件：默认只读 + 出路（胶囊那颗也是这一句） */
  gameErb:
    '口上区（游戏目录）里的原生文件：默认只读——直接改它等于改别人装好的游戏内容。开始输入时编辑器会询问你是否破例；点击这里可重新批准写权限。',
  /** 区域答不出时回落的项目级授权读数（两档） */
  projectWritable: '写权限已批准',
  projectReadOnly: '只读：写权限未批准，点击重新授权',
} as const;

/**
 * 胶囊那句说明（纯函数，口径与 `writablePillTone` 同一条：区域优先、回落项目级）。
 *
 * `ShellLayout` 只负责把这枚文案挂到 `title` 上，判定与文案都不再住在组件里。
 */
export function writablePillTitle(area: FileWritableArea, projectWritable: boolean): string {
  if (area === 'workspace') return WRITABLE_HINTS.workspace;
  if (area === 'game-erb') return WRITABLE_HINTS.gameErb;
  return projectWritable ? WRITABLE_HINTS.projectWritable : WRITABLE_HINTS.projectReadOnly;
}
