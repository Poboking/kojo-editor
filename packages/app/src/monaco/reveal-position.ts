/**
 * 编辑器定位落点的**行列口径**（R1 列接线批，2026-10-15）。
 *
 * 事件契约 `editor.revealLocation` 从来就带 `column?`，宿主此前只消费行：列被丢弃、
 * 光标一律停行首。本模块把「一次定位请求 → 编辑器里合法的落点」收成**一个纯函数**，
 * Monaco 绑定处只做取值与落地。
 *
 * **列口径不在这里二次实现**：一行的最大合法列由 Monaco model 自己给
 * （`getLineMaxColumn` = 行长度 + 1，UTF-16 码元、1 基），与糖线源映射（S6，
 * `packages/plugins/kojo-sugar/src/column-map.ts`）声明的同一条口径——所以源映射给出的列
 * 可以直接当 Monaco 列用，两端都不必换算，也不许在这里 `length` / 数码点。
 */

/** 一次定位请求（模型坐标，1 基；`column` 缺席 = 发起方没给列，落行首，**不猜列**） */
export interface RevealTarget {
  readonly line: number;
  /** 1 基、UTF-16 码元（口径见文件头） */
  readonly column?: number;
  /** 同一文件重复定位时用于触发重新滚动（nonce 变化即重新定位） */
  readonly nonce: number;
}

/** 落地后的光标位置（Monaco `Position` 的两个成员，这里不依赖 Monaco 类型以便纯测） */
export interface RevealPosition {
  readonly lineNumber: number;
  readonly column: number;
}

/** 夹取需要知道的**行数与行长**：由调用方从 model 现取（本模块不持有 model） */
export interface RevealGeometry {
  readonly lineCount: number;
  /** 该行最后一个合法列（Monaco `getLineMaxColumn`） */
  maxColumn(lineNumber: number): number;
}

/** 可用的列：有限数；其余（缺省 / NaN / Infinity）一律当"没给列" */
function usableColumn(column: number | undefined): number | undefined {
  return typeof column === 'number' && Number.isFinite(column) ? column : undefined;
}

/**
 * `editor.revealLocation` 载荷 → 编辑器定位目标。
 *
 * `line` 缺省按第 1 行（接线前逐字一致）；列**只在给得出手时才带上**，
 * 非法值（NaN / Infinity）当没给，而不是夹到某端假装作者要那儿。
 */
export function revealTargetOf(
  event: { readonly line?: number; readonly column?: number },
  nonce: number,
): RevealTarget {
  const column = usableColumn(event.column);
  return {
    line: event.line ?? 1,
    ...(column !== undefined ? { column } : {}),
    nonce,
  };
}

/**
 * 越界值夹到模型里真实存在的落点。
 *
 * 行夹取沿用改动前的表达式（不许顺手改判据）；列同样两头夹：下限 1，上限取
 * `geometry.maxColumn(已夹取的行)`——**先夹行再取行长**，否则行越界时行长根本不存在。
 */
export function clampRevealPosition(
  target: { readonly line: number; readonly column?: number },
  geometry: RevealGeometry,
): RevealPosition {
  const lineNumber = Math.min(Math.max(1, target.line), geometry.lineCount);
  const column = Math.min(Math.max(1, Math.trunc(usableColumn(target.column) ?? 1)), geometry.maxColumn(lineNumber));
  return { lineNumber, column };
}
