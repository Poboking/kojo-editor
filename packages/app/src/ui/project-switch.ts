import { pathKey } from '@kojo/plugin-api';

/**
 * 切项目脏确认的决策核心（SAFE-1，2026-10-16）。
 *
 * 换根开项目的三条入口（欢迎页 recent 点击 / chooseAndOpen / 项目态拖入新目录）
 * 此前只有拖入路径有一句拒切 toast，recent/chooseAndOpen 静默换根——脏 model
 * 随 EditorPane 卸载 dispose 掉。现在统一收口到 `App.openProject`：换根前先过
 * {@link planProjectSwitch}，有脏就弹与 requestCloseProject 同款三选一确认。
 * 判定全在这里（纯函数），App 与测试共用同一份口径。
 */

/** 换根守卫输出：go = 直接开；confirm = 弹确认（paths = 待处置的脏文件集合） */
export type ProjectSwitchPlan =
  | { readonly kind: 'go' }
  | { readonly kind: 'confirm'; readonly paths: ReadonlySet<string> };

export interface ProjectSwitchOpts {
  /** 同目录重载（keepView 语义）：没有"被丢弃的旧项目"，不拦 */
  readonly keepView?: boolean;
  /** 确认已过（决策回调续跑时置位）：不再二次弹框 */
  readonly skipDirtyConfirm?: boolean;
}

/** openProject 的换根守卫：无项目在开 / 同根 / 无脏 / 已确认 = 放行，其余弹确认 */
export function planProjectSwitch(
  currentRoot: string | null,
  targetDir: string,
  dirtyPaths: ReadonlySet<string>,
  opts?: ProjectSwitchOpts,
): ProjectSwitchPlan {
  if (opts?.keepView || opts?.skipDirtyConfirm) return { kind: 'go' };
  if (!currentRoot || pathKey(currentRoot) === pathKey(targetDir)) return { kind: 'go' };
  if (dirtyPaths.size === 0) return { kind: 'go' };
  return { kind: 'confirm', paths: dirtyPaths };
}

/** 确认框三选一（与 UnsavedFilesConfirmDialog 的 onDecide 同型） */
export type ProjectSwitchDecision = 'save-then-go' | 'discard' | 'cancel';

/**
 * 决策 → 下一步：
 * - 取消 = 留在原地（HK-2：键盘只落在"什么都没发生"那一格）；
 * - 保存失败 = 留在原地（错误已显式呈现，绝不静默丢）；
 * - 其余两个分支（保存成功 / 明确丢弃）= 继续打开目标根。调用方在 proceed 前
 *   必须先走 journal 的强制 discard 通道（与 decideProjectClose 同一条）：刚存完
 *   的陈旧快照与用户明确不要的内容，都不能再被崩溃恢复端回来。
 */
export type ProjectSwitchOutcome = { readonly kind: 'stay' } | { readonly kind: 'proceed' };

export function resolveProjectSwitch(decision: ProjectSwitchDecision, saveOk: boolean): ProjectSwitchOutcome {
  if (decision === 'cancel') return { kind: 'stay' };
  if (decision === 'save-then-go' && !saveOk) return { kind: 'stay' };
  return { kind: 'proceed' };
}
