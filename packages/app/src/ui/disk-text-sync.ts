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
 * - 基线 / 脏判定 / 冲突通知：全部留在调用方（`EditorPane`），决策树一条分支都不动；
 * - 写域判定：只改内存 model，盘上一个字节都不写。
 *
 * ## RELOAD-EOL-PIN（2026-10-21 补·对拍读数）
 * 上面曾写「换行交给 monaco 自己归一，与 `setValue` 同源」——实测**不成立**，两处不等价：
 * - 旧路径 `setValue` 经 `PieceTreeTextBufferBuilder._getEOL`（monaco 0.57.0）按**多数派重探整档 EOL**
 *   并归一全部行尾（CRLF 盘进 LF model ⇒ model 档位随之翻转）；原差量路径不改档 ⇒ 文本与档位都不同果。
 *   ⇒ 现补前置档位对齐（`applyDiskText` 首部、口径 = `detectMajorityEol`）：按同一多数派口径 `setEOL`
 *   对齐后再落差量（`setEOL` 是 raw 变更、
 *   不进撤销栈 ⇒ 重载仍恰占**一个**栈元素）。
 * - 按字符公共前后缀会把**孤立 `\r` 留在差量边界**，monaco 把插入文本里的 `\r` 归一成换行
 *   ⇒ 凭空多一行空行（实测 `甲\n乙\n丙` ←盘 `甲\r\n乙改\r\n丙` 得 `甲\n乙改\n\n丙`）。
 *   ⇒ `diskSyncEdits` 改**按行分段**（行=内容+行尾原子单位），边界永不切在 `\r\n` 中间。
 * 钉死用例：`packages/app/tests/disk-text-sync-eol.test.ts`（五条对拍 + 反向自证）。
 *
 * ## DISK-SYNC-EOL-EDGE（2026-10-21 补·两条边角对拍读数）
 * 头注曾把两处列为"已知残余"。实测**都不等价**，改因与读数见下（口径 = 与 `setValue` 四项读数
 * 逐字同果：`getValue` / `getEOL` / `getLineCount` / `getValueLength`）：
 * - **孤 `\r`（老式 Mac 行尾）判档**：`_getEOL` 把**孤 `\r` 也计入行尾总数**（`total = cr+lf+crlf`、
 *   `crSide = cr+crlf`），原实现只数 `\n` 结尾 ⇒ 纯 CR 盘文被判成"无行尾"、保持现档。
 *   改前实测：盘 `甲\r乙改\r丙` 进 LF 档 model ⇒ 新路径 [`甲\n乙改\n丙`,档`\n`,行3,长6]，
 *   旧路径 setValue ⇒ [`甲\r\n乙改\r\n丙`,档`\r\n`,行3,长8]（行数和得著、档位与文本差著——
 *   只有档位在先，monaco 的 `EditData` 才会把插入段里的孤 `\r` 折成**现档**行尾）。
 *   ⇒ `detectMajorityEol` 改为 `_getEOL` 的逐字镜像（三计数 + `cr+crlf > total/2`）；`cr = 0` 时
 *   与原式**完全同值**，故既有五条对拍零影响。分段口径不动：`splitLinesKeepEol` 本就把孤 `\r`
 *   当行尾收进段内，档位对齐后 `EditData` 归一即与 setValue 同果（实测 7 条 CR 样本全绿）。
 * - **整篇无行尾（单行文件）**：`setValue` 取的是**创建时的 `defaultEOL`**、不是现档，而
 *   monaco standalone `createModel` 的兜底是 **CRLF**（实测 `getOptions().defaultEOL === 2`，
 *   与 `TextModel.DEFAULT_CREATION_OPTIONS` 的 LF 不同）。改前实测：LF 档 model + 盘 `甲改`
 *   ⇒ 新路径档 `\n`、旧路径档 `\r\n`（文本/行数/长度三项等，只档位差）。
 *   ⇒ 无行尾分支现取 `model.getOptions().defaultEOL`（公开面、与 `setValue` 同一个入参），
 *   桩 model 无该方法时回退保持现档。**不改签名、不改调用方**：`DiskSyncModel` 加的是可选成员。
 */

/** 一条差量：`oldText.slice(start, end)` 换成 `text`（偏移按 `getValue()` 的字符序，0 基、含首不含末） */
export interface DiskSyncEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** 行 = 内容 + 行尾的原子段（`\r\n` 与 `\n` 算行尾；末段可无行尾）。差量分段的基本单位，边界永不切开 `\r\n`。 */
function splitLinesKeepEol(text: string): string[] {
  const lines: string[] = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j += 1;
    if (j < text.length) {
      if (text[j] === '\r' && text[j + 1] === '\n') {
        j += 2;
      } else {
        j += 1; // 孤 `\r`：段到此收（`\r` 留在段内当行尾），后面的 `\n` 归下一行——与 monaco 的换行计数同口径
        lines.push(text.slice(i, j));
        i = j;
        continue;
      }
    }
    lines.push(text.slice(i, j));
    i = j;
  }
  if (text.endsWith('\n') || text.endsWith('\r\n')) lines.push('');
  return lines;
}

/**
 * 盘文以**孤 `\r` 收尾**时（老式 Mac 文件常这样结尾），monaco 的 `setValue` 把它当一个行尾 ⇒
 * 末尾多出一个空行；而 `applyEdits` 的校验里有一条 `removeTrailingCR`（`textModel.js:959`：
 * CRLF 档 + 差量段以孤 `\r` 收尾 + 区间末正好落在该行末列 ⇒ 直接丢掉那个 `\r`），
 * 差量通道因此少一行、长度也差一（实测盘 `a\r\nb改\r\nc\r`：新 `[a\r\nb改\r\nc,行3,长8]`
 * vs 旧 `[a\r\nb改\r\nc\r\n,行4,长10]`）。
 * ⇒ 落差量前把这一个 `\r` 写成**已对齐的档位**，两条通道同果（LF 档下 `\r`→`\n` 本就同解，零风险）。
 */
function trailingLoneCrAsEol(text: string, eol: string): string {
  if (text.length === 0 || !text.endsWith('\r')) return text; // 以 `\r\n` 收尾的结尾是 `\n`，不动
  return `${text.slice(0, -1)}${eol}`;
}

/**
 * 纯函数：把 `oldText` 原地变成 `newText` 的最小差量（**按行**公共前后缀之外恰好一段，
 * RELOAD-EOL-PIN 起不再是按字符——字符前后缀会把 `\r\n` 切开成孤立 `\r`，monaco 归一后凭空多空行）。
 * 相等 ⇒ 空数组。零依赖、零 monaco，单测直接用字符串喂。
 */
export function diskSyncEdits(oldText: string, newText: string): readonly DiskSyncEdit[] {
  if (oldText === newText) return [];
  const oldLines = splitLinesKeepEol(oldText);
  const newLines = splitLinesKeepEol(newText);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  let startOffset = 0;
  for (let k = 0; k < start; k += 1) startOffset += oldLines[k]!.length;
  let endOffset = startOffset;
  for (let k = start; k < endOld; k += 1) endOffset += oldLines[k]!.length;
  return [{ start: startOffset, end: endOffset, text: newLines.slice(start, endNew).join('') }];
}

/**
 * `setValue` 同款多数派口径——monaco 0.57.0 `PieceTreeTextBufferBuilder._getEOL` 的逐字镜像：
 * 三计数 `cr / lf / crlf`，`cr + crlf > (cr + lf + crlf) / 2` ⇒ CRLF，否则 LF；
 * 整篇无行尾 ⇒ 取**创建时的 defaultEOL**（`noEol`，standalone `createModel` 兜的是 CRLF 不是 LF），
 * 拿不到创建档位时（桩 model）才保持现档。`cr = 0` 时与旧式 `crlf > (crlf+lf)/2` 完全同值。
 */
export function detectMajorityEol(text: string, current: string, noEol?: string): string {
  let lf = 0;
  let cr = 0;
  let crlf = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        crlf += 1;
        i += 1; // `\r\n` 是一个行尾，不重复计 cr
      } else {
        cr += 1; // 孤 CR 在 monaco 的判档里同样算换行（DISK-SYNC-EOL-EDGE）
      }
    } else if (ch === '\n') {
      lf += 1;
    }
  }
  if (cr + lf + crlf === 0) return noEol ?? current;
  return cr + crlf > (cr + lf + crlf) / 2 ? '\r\n' : '\n';
}

/**
 * `setValue` 在整篇无行尾时落的那一档 = 模型创建时的 `defaultEOL`（monaco 里 `_getEOL` 的入参）。
 * 走公开面 `ITextModel.getOptions()`（`DefaultEndOfLine`：LF=1、其余按 CRLF 处理，同 `_getEOL` 的三元）；
 * 桩 model 没这个方法 ⇒ 返回 `undefined`，调用方回退保持现档。
 */
function creationDefaultEol(model: DiskSyncModel): string | undefined {
  const options = model.getOptions?.();
  if (!options) return undefined;
  return options.defaultEOL === 1 ? '\n' : '\r\n';
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
  /** 现档行尾（RELOAD-EOL-PIN：对拍 `setValue` 的多数派重探需先读档） */
  getEOL(): string;
  /** 整档换行（monaco `EndOfLineSequence`：0=LF、1=CRLF；raw 变更、不进撤销栈） */
  setEOL(eol: 0 | 1): void;
  /**
   * 创建时的档位来源（真身 = monaco 公开面 `ITextModel.getOptions()`，只读 `defaultEOL` 一个字段）。
   * **可选**：桩 model 不提供 ⇒ `setValue` 的"无行尾 ⇒ 落创建档"这步退化为保持现档。
   */
  getOptions?(): { readonly defaultEOL: number };
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
  // RELOAD-EOL-PIN：先按 `setValue` 同款多数派口径对齐整档（raw 变更、不上栈、不改栈元素数），
  // 再落差量——否则 CRLF 盘进 LF model 时新路径文本/档位都与旧路径不同果（对拍实测，见头注）。
  // DISK-SYNC-EOL-EDGE：口径含孤 CR 计数与"整篇无行尾 ⇒ 落创建档"两支，缺一支就少一路同果。
  const eol = detectMajorityEol(text, model.getEOL(), creationDefaultEol(model));
  if (eol !== model.getEOL()) model.setEOL(eol === '\r\n' ? 1 : 0);
  // DISK-SYNC-EOL-EDGE：孤 CR 收尾的盘文先按已对齐档位改写末一个行尾，再算差量（见该函数注记）。
  const edits = diskSyncEdits(model.getValue(), trailingLoneCrAsEol(text, eol));
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
