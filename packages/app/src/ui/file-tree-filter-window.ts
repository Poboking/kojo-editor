/**
 * 过滤态渲染窗口（PERF-6，2026-10-16 树即时批）——零 React 的预算计算层
 * （FE-REF ⑤ 自 `FileTree.tsx` 逐字搬出）。
 *
 * 计划与渲染共用同一份预算 ⇒ "计划说渲染多少"与"实际挂了多少行"不可能各算各的。
 */
import { rowKeyOf } from './file-tree-model';
import type { Group } from './file-tree-types';

/**
 * 过滤态首帧渲染的文件行上界（PERF-6，2026-10-16 树即时批）。
 *
 * **为什么过滤态要单独设窗**：过滤会把**每个命中组强制展开**
 * （`isOpen = opened.has(label) || filter`——这是"打了字就看见结果"的既有语义，不许改）。
 * 语料口径 155 组 / 2,325 文件：一个短词（如 `k1`）命中上千文件 ⇒ 一次 deferred 提交
 * 就把上千行全挂进 DOM，输入框依旧卡。deferred 只让**打字**不卡，救不了**提交**那一帧。
 * 这里给提交帧上界：首帧 120 行，点「继续显示后续命中」每次 +240（单调、可达全量——
 * 不是"截了就不给看"的死上限）。函数树侧同理，见 navigator 的 `FaceList` 窗口。
 */
export const FILTER_WINDOW_INITIAL = 120;
/** 每次「继续显示后续命中」追加的文件行数 */
export const FILTER_WINDOW_STEP = 240;

/** 过滤态渲染计划（见 `filterRenderPlan`） */
export interface FilterRenderPlan {
  /** 每个包本次渲染的行数（缺键 = 0 行） */
  readonly perPackage: ReadonlyMap<string, number>;
  /** 本次真正渲染的文件行数 */
  readonly rendered: number;
  /** 命中总数（真实计数——组头/包头的计数用它，不用渲染数） */
  readonly matched: number;
  /** 本次未渲染的命中数（>0 时树尾挂「继续显示」哨兵） */
  readonly hidden: number;
}

/**
 * 过滤态的渲染计划（纯函数，可单测）。
 *
 * 预算按「组序 → 包序 → 包内路径序」贪心切分（即树本身的显示顺序 ⇒ 前两窗的内容
 * 与不截断时**逐字同构**，不会出现"先显示的后面消失"）。
 * **组与包结构一律保留**：组头/包头的计数始终是真实命中数，被裁的只是行 DOM
 * ⇒ 计划不撒谎，也不改变命中集合（只是分帧显示）。
 */
export function filterRenderPlan(groups: readonly Group[], limit: number | undefined): FilterRenderPlan {
  const budget = limit ?? FILTER_WINDOW_INITIAL;
  let left = Math.max(0, budget);
  const perPackage = new Map<string, number>();
  let rendered = 0;
  let matched = 0;
  for (const g of groups) {
    for (const s of g.subs) {
      matched += s.files.length;
      const take = Math.min(s.files.length, left);
      if (take > 0) {
        perPackage.set(rowKeyOf(g.label, s.label), take);
        left -= take;
        rendered += take;
      }
    }
  }
  return { perPackage, rendered, matched, hidden: matched - rendered };
}

/**
 * 过滤窗口下一步（纯函数）：`min(matched, max(INITIAL, 当前 + STEP))`。
 * 单调不减、单步增量 ≤ STEP、终值 = matched（全量可达）。
 */
export function nextFilterWindow(current: number | undefined, matched: number): number {
  const base = current ?? FILTER_WINDOW_INITIAL;
  return Math.min(matched, Math.max(FILTER_WINDOW_INITIAL, base + FILTER_WINDOW_STEP));
}
