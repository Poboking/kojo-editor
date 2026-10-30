/**
 * `foldingRange` 供方：把请求里**宿主预取好的结构快照**（`folds`，模型坐标 1 基）裁成
 * 可折区间（B3h，2026-10-30）。
 *
 * ## 为什么这一格是"搬运 + 最后一道闸"而不是"自己算"
 *
 * 2.0 的可折区间来自结构 worker 的 `folds` 查询（`queries/v2/folds.scm`），那是**异步**的；
 * 而槽 `ui.editor.languageService` 的 `provide(request)` 是**同步**的。B3h 的解法是把等待
 * 留在宿主（打开 / 改动时预取，按 model 版本缓存），请求里带 `folds` 快照，供方只做两件事：
 *
 * 1. **语言分派**：非 kojo2 ⇒ `undefined`（弃权）；
 * 2. **最后一道闸**：快照属于某一版文本，宿主的"同版"是承诺不是事实 ⇒ 按请求里的
 *    `lineCount` 把越界 / 倒置 / 重复再裁一遍（判据在 `@kojo/kojo-lang/folding`，
 *    与宿主建快照时用的是**同一份实现**）。
 *
 * ## 三态
 *
 * - **非 kojo2 ⇒ `undefined`（弃权）**：宿主这枚 provider 也挂在 ERB / kojo1 上（共享收口按
 *   descriptor 铺语言），弃权让那门语言自己的折叠供方接手；
 * - **kojo2 且有快照 ⇒ 区间**（可能为空：这一版确实没有可折块）；
 * - **kojo2 但**没有快照（`folds` 缺席 = 还没预取到）⇒ `ranges: []`（作答，不是弃权）。
 *   头注写明口径：**不异步等待**，下一次预取 / 下一版内容变化后可见。
 *
 * 判据抛错（坏输入）⇒ 空结果，不让异常穿回宿主。请求连 `lineCount` 都没带 ⇒ **同档空**
 * （没有行数事实就判不了越界；空是"这一版没有折叠"，不是"整篇不可折"的结论）。
 */
import type {
  EditorFoldingRange,
  EditorFoldingRangeResult,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import { kojo2FoldingSnapshotRanges } from '@kojo/kojo-lang/folding';
import { isKojo2Request } from './request';

/** 交回 `{ kind: 'foldingRange', ranges }`，或 `undefined`（弃权：不是这个 kind / 不是 kojo2） */
export function provideFoldingRanges(
  request: EditorLanguageServiceRequest,
): EditorFoldingRangeResult | undefined {
  if (request.kind !== 'foldingRange') return undefined;
  if (!isKojo2Request(request)) return undefined;
  try {
    const ranges: EditorFoldingRange[] = kojo2FoldingSnapshotRanges(
      request.folds,
      request.lineCount ?? 0,
    );
    return { kind: 'foldingRange', ranges };
  } catch {
    // 快照形状不对 ⇒ 空结果（作者看到的是"这一版没有折叠"，看得见、不崩）
    return { kind: 'foldingRange', ranges: [] };
  }
}
