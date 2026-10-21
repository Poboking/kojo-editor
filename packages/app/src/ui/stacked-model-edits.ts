/**
 * STACKED-MODEL-EDITS（2026-10-21 收口）：**程序化写 model 的唯一上栈通道**。
 *
 * ## 为什么要有这一个函数
 * monaco.d.ts 把 `applyEdits` / `setEOL` 这类归为 **raw 变更、不上撤销栈**（原文
 * 「Edit the model **without adding the edits to the undo stack**. This can have dire
 * consequences on the undo stack! See @pushEditOperations for the preferred way.」）。
 * 而 `pushEditOperations` **本身也不推停点**：`EditStack._getOrCreateEditStackElement`
 * （`esm/vs/editor/common/model/editStack.js`）只要栈顶那格还"开着"（`canAppend`）就把新编辑
 * **并进同一格**——机器改写于是吃进作者上一次打字那一格里。作者按一次 Ctrl+Z 同时退掉
 * "自己刚打的字 + 机器改动"，产品口径明确**不许**这个退化（同类缺陷在本仓已被证了五次：
 * 重载腿 / merge 腿 / 全角替换腿 / 替换腿 / code action 腿 / 切档腿）。
 *
 * ## 口径（与 `disk-text-sync.applyDiskText`、`search-replace-exec` 的替换腿逐字同形）
 * `pushStackElement()` → `pushEditOperations(null, ops, () => null)` → `pushStackElement()`：
 * - **before**：给作者上一次的打字/粘贴封口 ⇒ 本次改写自成一格，一次 Ctrl+Z 只退本次；
 * - **after**：给本次改写自己封口 ⇒ 之后作者再打字另起一格，不会并进机器改动里。
 * 两颗停点各自单独缺、各自单独红（实测见 `stacked-model-edits.test.ts` ①②）。
 *
 * 光标：`beforeCursorState` 传 `null`、`cursorStateComputer` 返回 `null`——机器改写不替作者
 * 算新光标位（活动标签那侧由调用方 `saveViewState`/`restoreViewState` 兜一层）。
 *
 * 零编辑 ⇒ **一个停点都不打、一个栈位都不占**（空段会白白挡掉作者一步撤销）。
 *
 * ## 守门
 * `stacked-model-edits.test.ts` 钉住：`packages/**\/src/**` 里 `pushEditOperations(` 只许出现在
 * 本模块（+ 逐字点名的既有第二通道 `disk-text-sync.ts`，本批不动它）。新增"写 model"的能力
 * 一律从这里取，不许再手搓第三套。
 */

/** 一条落点：与 monaco `IIdentifiedSingleEditOperation` 结构兼容（本模块要在 node 侧被单测直接 import，不引 monaco 类型） */
export interface StackedEditOperation {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  text: string;
  forceMoveMarkers?: boolean;
}

/** 通道需要的 ITextModel 结构面（真实 model 按方法双变性直接传入；桩即可测） */
export interface StackedEditModel {
  /** 关掉当前 undo 格（monaco.d.ts「Close the current undo-redo element」） */
  pushStackElement(): void;
  pushEditOperations(
    beforeCursorState: null,
    editOperations: StackedEditOperation[],
    cursorStateComputer: () => null,
  ): unknown;
}

/**
 * 把 `ops` 一次性写进 model，并在撤销栈上**恰好占一个元素**。返回落地的编辑条数（0 = 栈不动）。
 */
export function applyStackedModelEdits(
  model: StackedEditModel,
  ops: StackedEditOperation[],
): number {
  if (ops.length === 0) return 0;
  model.pushStackElement(); // 前停点：封作者那一格
  model.pushEditOperations(null, ops, () => null);
  model.pushStackElement(); // 后停点：封本次改写这一格
  return ops.length;
}
