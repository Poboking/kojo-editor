/**
 * 编辑器**可写性的唯一一把尺子**（KW16 标签色轨批，2026-11-02）。
 *
 * ## 为什么要有这个模块
 *
 * 改前，"这一份文件此刻能不能动手"这句判据只活在 `EditorPane` 内部：同一条表达式
 * `unlockedPathsRef.current.has(path) || directEditable(path)` 在那一个文件里手写了**八遍**
 * （EOL 切换门 / 撤预览还原 / 预览可用门两处 / 直连开关 effect / 换文件 effect / 解锁回锁 /
 * 只读输入询问 / 一键修复否决），而标签页这一侧**读不到**——解锁集合住在组件的 ref 里，
 * 没有出口。于是任何"第二处要问同一个问题"的需求都只能抄一份，抄本就是第二真源。
 * 本模块把那一句收成一处，消费两处：`EditorPane`（原八格）与标签栏（色轨）。
 *
 * ## 两道正交轴（ADR-0005，口径一字不改）
 *
 * - **轴一 · 目录分野**＝默认可写性：作者工作区（常驻可写根）里的源文件恒可编辑，游戏目录默认只读。
 *   分野判定转调 `file-area.ts`（状态栏胶囊问的是同一个问题，两处共用一把尺子）。
 * - **轴二 · 显式解锁**＝游戏目录里"这一份、这一次"的破例，按文件按会话、**不落盘**。
 *   解锁集合的真源仍是 `EditorPane` 实例自己的 ref（生命周期＝实例，退场即清，与搬家前逐字相同）；
 *   本模块只**读**它——经 `editor-pane-registry.ts` 那批**同一 ref 壳**（复制 ref＝让消费方读到
 *   影子，口径见该文件头注）。
 * - **直连模式**是轴二的一条旁路（开关开 + 内核写允许域放行 ⇒ 免逐个解锁），**不扩权**：
 *   能不能真落盘始终由 `kernel.io.isWritable` 决定。
 *
 * ## 档位（色轨的输入，不新增概念）
 *
 * | 档 | 成立条件 | 色轨 |
 * |---|---|---|
 * | `author` | 落在作者工作区根内（轴一恒可写） | 主色 |
 * | `unlocked` | 工作区外且此刻可编辑（轴二破例 / 直连开门） | 警示（琥珀族） |
 * | `derived` | 屏上是 `.kojo` 预览挂的**派生** model，不是盘上那一份 | 中性 |
 * | `untitled` | 未落盘草稿（`untitled:N`）：不在任何目录里，两道轴都问不到它 | 信息 |
 * | `read-only` | 其余（游戏目录、未解锁） | **不给色**——"没有额外颜色"本身就是"没有特权"的信号 |
 *
 * `canEdit` / `inWorkspace` 两枚字段是搬家口径的锚：档位**只由它们派生**，`read-only` 档
 * 不参与任何既有判定 ⇒ 搬家前后 `EditorPane` 的行为逐字相同。
 *
 * ## 标签侧为什么读"并集"
 *
 * 分屏后同一份文件可能开在两个组里，而每一格各自持一份解锁 ref。色轨按"任一实例已解锁"
 * 给警示：解锁的语义是"这一份、这一次"（ADR-0005 轴二），不是"这一格里这一次"；
 * 警示色宁可多给一档、不可漏给——漏色等于把破例改游戏库说成常态。
 *
 * ## 变更门铃
 *
 * 解锁/回锁、预览面挂上/撤下都只动 ref，不会惊动 React ⇒ 标签侧要另起一拍才能翻色。
 * 这里给一枚**纯计数**的外部信号（形态照 `direct-mode.ts`：模块级订阅表、无 window 也不抛）。
 * 它不持有任何判定结果，只说"再来问一次"，所以不是第二真源。
 */

import { useSyncExternalStore } from 'react';
import type { Kernel } from '@kojo/kernel';
import { isDirectMode } from './direct-mode';
import { fileWritableAreaOf, WRITABLE_HINTS } from './file-area';
import { livePanes } from './editor-pane-registry';
import { workspaceProjectDirsOf } from './workspace-roots';
import { isUntitledPath } from './tabs-ops';

/** 本模块接线所认的内核切片（`io` 管写允许域、`workspaces` 管常驻可写根） */
type EditabilityKernel = Pick<Kernel, 'io' | 'workspaces'>;

/** 可写性语义档位（标签色轨的输入；`read-only` 刻意不给色） */
export type EditorEditabilityGrade = 'author' | 'unlocked' | 'derived' | 'untitled' | 'read-only';

/** 会给色的三档（`read-only` 不在其内） */
export type EditorRailGrade = Exclude<EditorEditabilityGrade, 'read-only'>;

/** {@link editabilityOf} 的输入：三份环境全由调用方给，判定本体零全局读取 */
export interface EditabilityAxes {
  readonly path: string;
  /** 轴二：本会话已显式解锁的路径集合（真源在实例 ref，这里只读） */
  readonly unlockedPaths: ReadonlySet<string>;
  /** 轴一：常驻可写根（`workspaces.projectDirs()` 原样；口径同 `file-area.ts`） */
  readonly workspaceRoots: readonly string[];
  /** 直连模式开关此刻开没开 */
  readonly directMode: boolean;
  /** 内核写允许域（`kernel.io.isWritable` 的转调） */
  readonly writable: (path: string) => boolean;
  /** 屏上是派生只读面（`.kojo` 预览挂的 model）——只影响档位，不影响 `canEdit` */
  readonly derivedView?: boolean;
}

/** 一次判定的输出：两枚轴字段 + 一枚档位 */
export interface Editability {
  /** 今日那句 `unlocked || directEditable`（搬家前后逐字同义） */
  readonly canEdit: boolean;
  /** 轴一：这份文件是否落在作者工作区（创作权威区） */
  readonly inWorkspace: boolean;
  readonly grade: EditorEditabilityGrade;
}

/**
 * 纯判据（可单测）：路径 + 已解锁集合 + 根表 + 直连/写允许域 → 同一把尺子的答案。
 *
 * 短路顺序与改前一致（先问解锁集合、再问直连），`writable` 的调用次数因此与改前逐字相同。
 */
export function editabilityOf(axes: EditabilityAxes): Editability {
  // 未落盘草稿不在任何目录里：两道轴都问不到它，就地回答。`canEdit` 只说"能动笔"（内存
  // model），**不扩权**——真落盘那刻仍过 `file-save-as` 的写域双闸，游戏根照样写不进去。
  if (isUntitledPath(axes.path)) return { canEdit: true, inWorkspace: false, grade: 'untitled' };
  const inWorkspace = fileWritableAreaOf(axes.path, axes.workspaceRoots) === 'workspace';
  const canEdit = axes.unlockedPaths.has(axes.path) || (axes.directMode && axes.writable(axes.path));
  const grade: EditorEditabilityGrade =
    axes.derivedView === true ? 'derived' : inWorkspace ? 'author' : canEdit ? 'unlocked' : 'read-only';
  return { canEdit, inWorkspace, grade };
}

/** 接线层要递给 {@link editabilityOf} 的环境：内核（两把工具）+ 本实例的解锁集合 */
export interface EditabilityEnv {
  readonly kernel: EditabilityKernel;
  readonly unlockedPaths: ReadonlySet<string>;
}

/**
 * 现取现判（根表与开关每次重读——口径同 `workspace-roots.ts` / `file-area.ts`：
 * 缓存会把"本会话刚新建的作品目录 / 刚翻上去的直连开关"永远排除在外）。
 */
export function editabilityNow(
  path: string,
  env: EditabilityEnv,
  opts: { readonly derivedView?: boolean } = {},
): Editability {
  return editabilityOf({
    path,
    unlockedPaths: env.unlockedPaths,
    workspaceRoots: workspaceProjectDirsOf(env.kernel),
    directMode: isDirectMode(),
    writable: (p: string): boolean => env.kernel.io.isWritable(p),
    derivedView: opts.derivedView === true,
  });
}

/**
 * 改前那一句 `unlockedPathsRef.current.has(path) || directEditable(path)` 的替身。
 * `EditorPane` 八格全吃这一枚；别处不许再写一遍同一条表达式。
 */
export function canEditNow(path: string, env: EditabilityEnv): boolean {
  return editabilityNow(path, env).canEdit;
}

/* ------------------------------ 标签侧（消费方之二） ------------------------------ */

/** 一枚标签的色轨（档位 + 悬停说明 + 落地 class；标签侧**只吃这一枚**，不再自己映射） */
export interface TabRail {
  readonly grade: EditorRailGrade;
  /** 悬停说明：与状态栏胶囊同一口径（`file-area.ts` 的 `WRITABLE_HINTS`），不造第二套说法 */
  readonly hint: string;
  /** 挂在标签行上的语义轨 class（`rail-author` / `rail-unlocked` / `rail-derived` / `rail-untitled`） */
  readonly railClass: string;
}

/** 档位 → 说明文案（`author` 那档直接取胶囊同一句） */
const RAIL_HINTS: Record<EditorRailGrade, string> = {
  author: WRITABLE_HINTS.workspace,
  unlocked: `${WRITABLE_HINTS.gameErb}本会话已为这一份破例解锁——你现在改的就是游戏库里的东西。`,
  derived: '这一格挂的是 .kojo 预览的派生只读面，不是盘上那一份文件本身；在它上面改不到磁盘。',
  untitled: '未落盘草稿：内容只在内存里，盘上还没有它。保存会弹系统对话框定落点与文件名（仍受写允许域约束）。',
};

/** 档位 → class（`read-only` 不进这张表：没有额外颜色就是它的颜色） */
export const RAIL_CLASS: Record<EditorRailGrade, string> = {
  author: 'rail-author',
  unlocked: 'rail-unlocked',
  derived: 'rail-derived',
  untitled: 'rail-untitled',
};

/**
 * 一批标签的色轨表（ProjectView 一帧算一次，键 = 路径，**只收有轨的**）。
 *
 * 解锁集合与派生面各扫登记簿**一遍**（不是逐格扫）：一帧里读到两种状态就会给出自相矛盾的
 * 色轨。判定仍走 {@link editabilityOf} 那一条——这里只是把它的输入凑齐。
 */
export function tabRailsOf(kernel: EditabilityKernel, paths: readonly string[]): ReadonlyMap<string, TabRail> {
  const unlocked = new Set<string>();
  const derived = new Set<string>();
  for (const ctx of livePanes.values()) {
    for (const path of ctx.unlockedPathsRef.current) unlocked.add(path);
    if (ctx.sugarModelRef.current !== null && ctx.filePathRef.current !== '') derived.add(ctx.filePathRef.current);
  }
  const roots = workspaceProjectDirsOf(kernel);
  const directMode = isDirectMode();
  const rails = new Map<string, TabRail>();
  for (const path of paths) {
    const grade = editabilityOf({
      path,
      unlockedPaths: unlocked,
      workspaceRoots: roots,
      directMode,
      writable: (p: string): boolean => kernel.io.isWritable(p),
      derivedView: derived.has(path),
    }).grade;
    if (grade === 'read-only') continue;
    rails.set(path, { grade, hint: RAIL_HINTS[grade], railClass: RAIL_CLASS[grade] });
  }
  return rails;
}

/* ------------------------------ 变更门铃（只发"再问一次"，不存判定结果） ------------------------------ */

let revision = 0;
const listeners = new Set<() => void>();

/** 抬一次计数并通知订阅者（解锁/回锁、预览面挂上/撤下这类只动 ref 的动作之后调用） */
export function notifyEditabilityChange(): void {
  revision++;
  for (const listener of [...listeners]) listener();
}

/** 当前计数（`useSyncExternalStore` 的快照：纯数字，稳定可比） */
export function editabilityRevision(): number {
  return revision;
}

/** 订阅变更（返回取消订阅函数；形态照 `direct-mode.ts`） */
export function subscribeEditability(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React 侧的变更订阅（消费方之二用它把色轨翻准）：快照是纯计数 ⇒ 服务端渲染也拿得到同一个值。
 *
 * 订阅方**不**在这里读判定结果（那需要环境），只读"该再问一次了"这一件事；
 * 判定仍由 `tabRailsOf` 在渲染时现算。
 */
export function useEditabilityRevision(): number {
  return useSyncExternalStore(subscribeEditability, editabilityRevision, editabilityRevision);
}
