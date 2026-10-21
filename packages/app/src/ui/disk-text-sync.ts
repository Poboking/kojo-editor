/**
 * RELOAD-UNDO-KEEP（2026-10-21）：磁盘重载的**差量落地**——让盘上内容成为撤销栈上的**一个**元素。
 *
 * ## 事故（真壳读数 run4，rc=0）
 * 作者在 `.ERB` 第 4 行末打字 `AUTH_A1` → Ctrl+S 保存成功 → 外部程序改写头行 → 编辑器静默跟上
 * 盘上文本（状态栏「已从磁盘重新加载（文件在外部被修改）」、光标 `.sb-sel` 仍是 4:22）
 * → **连按 5 次 Ctrl+Z 屏上零变化**：重载把撤销栈清了，作者保存前的编辑再也回不去（数据丢失级）。
 *
 * ## 成因（代码事实，不是"模型被 dispose"那条候选）
 * `packages/app/src/ui/EditorPane.tsx` 的 `applyReload` 里走 `live.model.setValue(text)`；
 * monaco-editor 0.57.0 `esm/vs/editor/common/model/textModel.js` 的 `_setValueFromTextBuffer`
 * 第 343 行明写 `this._commandManager.clear()` ⇒ 整条撤销栈就地销毁。重载路径**复用同一个 model**
 * （`entriesRef` 里的 entry 不重建、不 dispose），所以栈不是随模型没的，是 `setValue` 自己清的。
 *
 * ## 正解
 * `model.pushEditOperations(...)`——monaco.d.ts L2629「**the preferred way of editing the model.
 * The edit operations will land on the undo stack**」。一次调用 = 撤销栈上一个元素，元素里装下
 * 本次全部差量 ⇒ 作者一次 Ctrl+Z 回到自己的改动，而"磁盘赢"（屏上＝盘上）在重载那一刻照样成立。
 *
 * ## 差量口径
 * 公共前缀 + 公共后缀之外的那一段（一条编辑、区间尽量小；行首/行尾各改一处会退化成一整段，
 * 仍是**一个**元素）。整篇不同 ⇒ 一条覆盖全区间的编辑。逐字相等 ⇒ 零编辑（`noop` 决策本就先拦，
 * 这里再兜一层，免得空编辑白占一个栈位）。
 *
 * ## 边界（本模块**不**碰）
 * - 换行：交给 monaco 自己归一（`EditData` 按 model EOL 折行），与 `setValue` 同源，不改 EOL 语义；
 * - 基线 / 脏判定 / 冲突通知：全部留在调用方（`EditorPane`），决策树一条分支都不动；
 * - 写域判定：只改内存 model，盘上一个字节都不写。
 */

/** 一条差量：`oldText.slice(start, end)` 换成 `text`（偏移按 `getValue()` 的字符序，0 基、含首不含末） */
export interface DiskSyncEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * 纯函数：把 `oldText` 原地变成 `newText` 的最小差量（公共前后缀之外恰好一段）。
 * 相等 ⇒ 空数组。零依赖、零 monaco，单测直接用字符串喂。
 */
export function diskSyncEdits(oldText: string, newText: string): readonly DiskSyncEdit[] {
  if (oldText === newText) return [];
  const shorter = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < shorter && oldText[start] === newText[start]) start += 1;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  return [{ start, end: endOld, text: newText.slice(start, endNew) }];
}

/** 一条差量的 model 侧形状（与 monaco `IIdentifiedSingleEditOperation` 结构兼容，不引 monaco 类型） */
export interface DiskSyncEditOperation {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  text: string;
  forceMoveMarkers?: boolean;
}

/** `applyDiskText` 需要的 ITextModel 结构面（桩即可测；真实 model 按方法双变性直接传入） */
export interface DiskSyncModel {
  getValue(): string;
  getPositionAt(offset: number): { readonly lineNumber: number; readonly column: number };
  /** 关掉当前 undo 格（monaco.d.ts L2619「Close the current undo-redo element」） */
  pushStackElement(): void;
  pushEditOperations(
    beforeCursorState: null,
    editOperations: DiskSyncEditOperation[],
    cursorStateComputer: () => null,
  ): unknown;
}

/**
 * 把 model 内容原地换成 `text`，**上撤销栈**（恰好一个元素）。返回落地的编辑条数（0 = 无差量、栈不动）。
 *
 * 停点（2026-10-21 实测：少了这两下，一次 Ctrl+Z 会把"作者打字 + 重载"一起吞掉）：
 * monaco 的 `EditStack._getOrCreateEditStackElement` 只要栈顶那格还"开着"（`canAppend`）就把新编辑
 * **并进同一格**，而编辑器的 `_executeEditOperation` 靠 `pushStackElement()` 建停点
 * （`cursor.js:286/308`＝before + after 各一下）。所以差量落地前后各补一下：
 * - before：给作者上一次的打字/粘贴封口 ⇒ 重载自成一格，一次 Ctrl+Z 只退重载；
 * - after：给重载自己封口 ⇒ 之后作者再打字另起一格，不会并进重载里。
 *
 * 光标：`beforeCursorState` 传 `null`、`cursorStateComputer` 返回 `null`（不替作者算新光标位）；
 * 活动标签那侧还照旧由调用方 `saveViewState`/`restoreViewState` 兜一层——那是前手量到 4:22 保住的东西。
 */
export function applyDiskText(model: DiskSyncModel, text: string): number {
  const edits = diskSyncEdits(model.getValue(), text);
  if (edits.length === 0) return 0;
  model.pushStackElement();
  const operations: DiskSyncEditOperation[] = edits.map((edit) => {
    const from = model.getPositionAt(edit.start);
    const to = model.getPositionAt(edit.end);
    return {
      range: {
        startLineNumber: from.lineNumber,
        startColumn: from.column,
        endLineNumber: to.lineNumber,
        endColumn: to.column,
      },
      text: edit.text,
      // 记号（诊断/装饰锚点）随差量走，别像 setValue 那样整篇抹平
      forceMoveMarkers: true,
    };
  });
  model.pushEditOperations(null, operations, () => null);
  model.pushStackElement();
  return edits.length;
}
