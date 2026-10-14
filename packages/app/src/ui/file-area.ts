/**
 * 「当前打开的文件落在哪一区」——编辑器只读分野与底部状态栏可写胶囊的**同一把尺子**。
 *
 * ## 为什么单独成模块
 *
 * 这条判定原本只活在 `EditorPane.inWorkspace` 里（编辑器拿它决定 Monaco 的 readOnly）。
 * 状态栏那颗可写胶囊改成**按所在区域**上色（工作项目区绿「可写」／口上区黄「只读」）之后，
 * 同一个问题有了第二个问口。两处各写一遍 `isUnderAnyRoot(workspaceRootsOf(kernel), p)`
 * 就是两个真源——本仓被"副本判定"咬过两次（FT-2 / PITFALLS 42：一处放宽另一处没跟上，
 * 症状是同一份文件在两个界面上互相打脸）。所以分野收进这一个纯函数，两处都只调它。
 *
 * ## 三态口径（ADR-0005 的两道正交轴，只看路径形状，零游戏知识）
 *
 * | 区域 | 依据 | 可写性 |
 * |---|---|---|
 * | `workspace` | 落在**全部工作区根**之内（默认根 + 作者自选的项目位置） | 恒可写：创作权威区，与项目授权状态无关 |
 * | `game-erb` | 工作区外的原生 ERB（`.erb` / `.erm`）＝游戏目录里的借阅件 | 默认只读；要改就逐份破例或走直连模式 |
 * | `other` | 没有打开文件／区域外的非 ERB 文件 | **不替区域作保**：回落到项目级授权状态 |
 *
 * `other` 那一格是故意的：区域只回答"在哪一区"，答不出"这一区的这份文件此刻能不能写"
 * （游戏目录里已批准写入的 `.kojo` 就是反例）。胶囊因此保留既有那条项目级口径，
 * 而不是把非 ERB 也硬染成只读。
 */

import type { Kernel } from '@kojo/kernel';
import { isErbLike } from './lift-preview';
import { isUnderAnyRoot, workspaceRootsOf } from './workspace-roots';

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
 * 现取工作区全部根再判（**不缓存**：`roots()` 是同步读内存数组、零 IO，缓存会把
 * 本会话刚自选的那个新根永远排除在外——口径同 `workspace-roots.ts`）。
 */
export function fileWritableArea(kernel: Pick<Kernel, 'workspaces'>, filePath: string | null): FileWritableArea {
  return fileWritableAreaOf(filePath, workspaceRootsOf(kernel));
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
