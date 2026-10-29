/**
 * `selectionRange` 供方：包里的扩选判据（`@kojo/kojo-lang/selection-range`）→
 * 契约的 `EditorSelectionRangeResult`（B3f，2026-10-29）。
 *
 * ## 一次问多个位点，整包作答
 *
 * Monaco 的多光标就是一次多位置请求。契约要求 `selections` 与请求的 `positions`
 * **同序同长**，所以这里用包里的 `kojo2SelectionRangeChainsAt`（对齐版）而不是过滤版：
 *
 * - **某位点空链**（空文件 / 越界行列 / 非法坐标）⇒ 该格 `null`，**不夹取、不猜**；
 *   宿主安装层把它摊成 0.57 的 `[]`，于是"这一位点没有扩选"与别的位点互不影响；
 * - **整条能力无人应答** ⇒ `undefined`（弃权，宿主交回空数组）——这是**另外一件事**。
 *   两者不可混：把"某位点空链"写成弃权，宿主会去问下一家、或让整次扩选消失；
 *   把弃权写成"整排 null"，那门语言自己的扩选 provider 就永远轮不到。
 *
 * ## 三态（同 hover / references）
 *
 * 非 kojo2 ⇒ `undefined`；认这门语言 ⇒ 总是作答（哪怕全是空链）；判据抛错 ⇒ 与输入
 * 同长的全空链（不让异常穿回宿主，也不把"算不出来"伪装成"没有扩选"之外的形状）。
 */
import type {
  EditorLanguageServiceRequest,
  EditorSelectionChain,
  EditorSelectionRangeResult,
} from '@kojo/plugin-api';
import {
  kojo2SelectionRangeChainsAt,
  type Kojo2SelectionRange,
} from '@kojo/kojo-lang/selection-range';
import { isKojo2Request } from './request';

/** 包内链 → 契约链（形状同构，逐级重建；`range` 四个字段名两边一致） */
function toContractChain(chain: Kojo2SelectionRange): EditorSelectionChain {
  return {
    range: {
      startLine: chain.range.startLine,
      startColumn: chain.range.startColumn,
      endLine: chain.range.endLine,
      endColumn: chain.range.endColumn,
    },
    ...(chain.parent === undefined ? {} : { parent: toContractChain(chain.parent) }),
  };
}

/** 交回 `{ kind: 'selectionRange', selections }`，或 `undefined`（弃权：不是这个 kind / 不是 kojo2） */
export function provideSelectionRanges(
  request: EditorLanguageServiceRequest,
): EditorSelectionRangeResult | undefined {
  if (request.kind !== 'selectionRange') return undefined;
  if (!isKojo2Request(request)) return undefined;
  try {
    const selections = kojo2SelectionRangeChainsAt(request.text, request.positions).map(
      (chain) => (chain === null ? null : toContractChain(chain)),
    );
    return { kind: 'selectionRange', selections };
  } catch {
    // 判据抛错：与输入同长的全空链（对齐不许破——少一格就是宿主侧错位）。
    return { kind: 'selectionRange', selections: request.positions.map(() => null) };
  }
}
