import type { ControlFlowStatement, EditorFoldingRange, ErbFile } from '@kojo/plugin-api';
import { forEachControlFlowLine, parseErbText, classifyControlFlow, scanControlFlow } from './scanner';

/**
 * ERB 折叠区间（D3，2026-10-15 折叠/面包屑批）。
 *
 * 真实口上 ERB 普遍**不缩进**（引擎不看缩进），Monaco 默认的按缩进折叠在其上几乎无效——
 * 折叠层级必须从块结构本身算出来。数据源刻意只有三枚**既有纯函数**：
 * - `parseErbText` → 函数边界（`@` 块）与函数起始行（结构重置点）；
 * - `scanControlFlow` → 控制流骨架（`IF…ENDIF` / `PRINTDATA…ENDDATA` / TRY 系…），
 *   开块/分支/闭合的角色与配对类别经 `classifyControlFlow` 取自 scanner 的**单一真源**——
 *   绝不写第二份正则扫描器（本仓教训：两处各算必然漂移，漂移表现为"波浪线指的行骨架里没有"）。
 * - 预处理器 `[IF …]` / `[ELSE]` / `[ENDIF]` 的角色（K7，2026-10-25 体感批 v2：本卡把这条
 *   折叠接上真正上屏的那一路）。判据真源只有一个：契约层 `@kojo/plugin-api` 的
 *   `ERB_PREPROC_PATTERNS`（波浪线侧 `structure.ts` 的 `preprocRoleOf` 就是它的委托面）。
 *   本文件**够不到那条委托**——它被 `packages/erb-syntax-tree/tools/fold-compare.mjs` 用
 *   **裸 node** 直读，是 `scanner.ts` 同族的"零运行期值导入"装载面（`PITFALLS.md` §151：
 *   值导入 `@kojo/plugin-api` 会连带装载 `io.ts` 的参数属性 ⇒ `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。
 *   所以这里按 §151 的既定纪律放一份**字形镜像** `FOLD_PREPROC_PATTERNS`，
 *   由 `tests/folding.test.ts` 的字节闸 + 逐样本角色对拍钉成"不可能漂开的一份"。
 *
 * 容错口径（结构错误文件，与 `structure.ts` 体检同一套语义）：
 * - **未闭合的开块不产出区间**——残缺块不许吞掉整篇折叠，别的正常块照常可折；
 * - **函数边界（`@` 行）清空栈**（照抄体检的 flush 语义）：上一函数欠的 `ENDIF`
 *   不许把下一函数整段折走；
 * - **孤儿闭合 / 无主分支不动栈、不产区间**（宁少报、不错报）；
 * - `CATCH` 归属判据同体检：`TRYCALLLIST` 一族（funclist）与 TRYC 族共用 `CATCH`
 *   分支词，栈里没有 `try` 层时认最近的 `funclist` 层。
 */

/** 配对栈帧：一个开块 + 当前分支段的起点 */
interface Frame {
  readonly pair: string;
  /** 开块语句行（整个块的折叠起点） */
  readonly openLine: number;
  /** 当前段起点（开块行或最近一个分支行） */
  segmentStart: number;
  /** 是否出现过分支（无分支块的"段区间"与整块区间只差闭合行，重复给没有意义） */
  sawBranch: boolean;
}

/**
 * 控制流骨架 → 折叠区间（纯函数，单遍）。
 * 产出两类：整块区间（开块行 → 闭合行）；有分支的块再产出逐段区间
 * （分支行 → 下一分支/闭合前一行），让 `CASE` / `ELSE` 的体能单独折。
 * `functionStartLines`（升序，来自 `parseErbText`）仅作结构重置点，可空。
 */
export function controlFlowFoldingRanges(
  statements: readonly ControlFlowStatement[],
  functionStartLines: readonly number[] = [],
): EditorFoldingRange[] {
  const out: EditorFoldingRange[] = [];
  const stack: Frame[] = [];
  let boundaryIndex = 0;
  const boundaryClear = (line: number): void => {
    while (boundaryIndex < functionStartLines.length && functionStartLines[boundaryIndex]! < line) {
      if (stack.length > 0) stack.length = 0;
      boundaryIndex++;
    }
  };

  for (const st of statements) {
    // 越过函数边界：上一函数欠的开块一律作废（不发区间、不影响后续函数的正常块）
    boundaryClear(st.line);
    const classified = classifyControlFlow(st.kind);
    if (!classified) continue;
    const { role, pair } = classified;
    if (role === 'leaf') continue; // SIF 单行语句，不配对
    if (role === 'open') {
      stack.push({ pair, openLine: st.line, segmentStart: st.line, sawBranch: false });
      continue;
    }
    // 与 scanControlFlow 同款恢复：向栈内找最近匹配项（自顶向下）
    let found = -1;
    for (let s = stack.length - 1; s >= 0; s--) {
      if (stack[s]!.pair === pair) {
        found = s;
        break;
      }
    }
    // CATCH 归属例外（同 structure.ts:152）：funclist 族也吃 CATCH
    let segmentOnly = false;
    if (found < 0 && role === 'branch' && st.kind === 'CATCH') {
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s]!.pair === 'funclist') {
          found = s;
          segmentOnly = true;
          break;
        }
      }
    }
    if (found < 0) continue; // 孤儿闭合 / 无主分支：不动栈、不产区间
    // 比 found 更深的帧 = "没等到闭合就被跨过/吞掉"的残缺块：摘掉但不产区间
    if (!segmentOnly) stack.length = found + 1;
    const frame = stack[found]!;
    if (role === 'branch') {
      // 段起点 → 分支前一行：首个分支到来时这一段就是"块头段"（`IF` 体），之后是各分支体
      if (st.line - 1 > frame.segmentStart) out.push({ startLine: frame.segmentStart, endLine: st.line - 1 });
      frame.segmentStart = st.line;
      frame.sawBranch = true;
    } else {
      // 末段只在真出现过分支时补给（无分支块的段区间与整块只差闭合行，重复给没有意义）
      if (frame.sawBranch && st.line - 1 > frame.segmentStart) {
        out.push({ startLine: frame.segmentStart, endLine: st.line - 1 });
      }
      if (st.line > frame.openLine) out.push({ startLine: frame.openLine, endLine: st.line });
      stack.splice(found, 1);
    }
  }
  // 走到结尾仍在栈上的帧 = 未闭合开块：**不产出**（不许折到文件尾吞掉全篇）
  return out;
}

/** `@` 函数块 → 折叠区间（与大纲同源：`parseErbText` 的函数边界） */
export function functionFoldingRanges(file: ErbFile): EditorFoldingRange[] {
  const out: EditorFoldingRange[] = [];
  for (const fn of file.functions) {
    if (fn.endLine > fn.startLine) out.push({ startLine: fn.startLine, endLine: fn.endLine });
  }
  return out;
}

/** 预处理块栈帧：一个开块 + 当前分支段的起点（与 `collectPreprocFolds` 同形，见其头注） */
interface PreprocFrame {
  readonly openLine: number;
  segmentStart: number;
  sawBranch: boolean;
}

/** 折叠面用的预处理器角色（与契约层 `ErbPreprocRole` 同三值） */
export type FoldingPreprocRole = 'open' | 'branch' | 'close';

/**
 * 预处理器三枚整行判据的**字形镜像**（真源＝契约层 `ERB_PREPROC_PATTERNS`；为什么必须放一份、
 * 以及"这份不可能漂开"的钉法见文件头注与 `tests/folding.test.ts` 的 `FOLD_PREPROC_*` 两节）。
 *
 * 导出**只为测试**：`tests/folding.test.ts` 逐枚比对 `source` 与 `flags` 是否逐字等于真源，
 * 再拿 `preproc-block.test.ts` 的同一张样本表对拍角色——任一处漂开当场红。
 * 三枚正则**无 `g`/`y`**（有状态的 `test()` 共享即错），顺序 **close → branch → open**
 * （与契约层、语言包侧同序）。
 */
export const FOLD_PREPROC_PATTERNS: Readonly<Record<FoldingPreprocRole, RegExp>> = Object.freeze({
  open: /^\[(?:IF\s+[^\]]*\S|IF_DEBUG|IF_NDEBUG)\]\s*$/i,
  branch: /^\[(?:ELSEIF\s+[^\]]*\S|ELSE)\]\s*$/i,
  close: /^\[ENDIF\]\s*$/i,
});

/** `[` 行的预处理器角色；不是预处理器标记 ⇒ null（判据见 `FOLD_PREPROC_PATTERNS` 头注） */
export function foldPreprocRoleOf(lineText: string): FoldingPreprocRole | null {
  const text = lineText.trim();
  if (FOLD_PREPROC_PATTERNS.close.test(text)) return 'close';
  if (FOLD_PREPROC_PATTERNS.branch.test(text)) return 'branch';
  if (FOLD_PREPROC_PATTERNS.open.test(text)) return 'open';
  return null;
}

/**
 * 预处理器条件块 `[IF …]` / `[IF_DEBUG]` / `[IF_NDEBUG]` … `[ELSE]` / `[ELSEIF …]` … `[ENDIF]`
 * → 折叠区间（K7，2026-10-25 体感批 v2；纯函数，单遍线性，只读整行标记）。
 *
 * **为什么这条路面**：编辑器侧的 ERB 折叠走的是本插件的 `erb-folding` 贡献
 * （`plugin.ts` → `erbFoldingRanges` → `kojo-folding.ts` 的共享 provider），
 * 而语言包 `packages/erb-syntax-tree` 的 `foldRanges()` / `collectPreprocFolds()` 只被
 * 读数工具与测试消费，`folds.scm` 里也没有预处理器配对 ⇒ 自 P0-3 起这类块在真壳里从来没折过。
 * 本函数把同一份区间形状接到真正上屏的那条路上。
 *
 * 口径三条（**没有一条是自己新发明的**）：
 * - **哪些行算数**取 `scanner.ts` 的 `forEachControlFlowLine`——`[SKIPSTART]`…`[SKIPEND]`
 *   死区整段屏蔽（引擎根本不编译那段）与行首代码前缀 `;!;` / `;#;` 的剥离都由这道门给出，
 *   而 `checkPreprocStructure` 与骨架扫描吃的就是同一套屏蔽语义（`structure.ts` 头注）；
 *   折叠与波浪线分叉的表现是"能折的块报未闭合"，所以这里**不自己写第二套屏蔽循环**；
 * - **角色**取 `foldPreprocRoleOf`（整行严格等值 + 大小写不敏感；`[IF]` 裸形、`[ENDIF] 尾巴`、
 *   ASCII 画的 `[ 1 2 3 ]` 一律不认）；
 * - 未配对一律**不产区间**：栈空时的 `[ELSE]` / `[ENDIF]` 不动栈不发区间，
 *   走到文件尾仍开着的块不产（不许折到文末把整篇吞掉）。
 *
 * 与控制流那张栈的**两处刻意不同**（理由写在 `structure.ts` 头注，此处照做）：
 * 1. **不按 `@` 函数行清栈**——预处理器是**文件级**裁剪，块可以合法地横跨函数定义，
 *    照抄控制流的边界清空会把正常的跨函数块折没（这道门的 `boundary` 标志因此直接忽略）；
 * 2. `[ENDIF]` 收**栈顶**（三个开块形共用一枚收束词，配对按族认），不做 `findPair` 式的
 *    向栈内查找——这一点与 `checkPreprocStructure` 的 `open.pop()` 同款。
 *
 * 区间形状与语言包侧 `collectPreprocFolds` **逐条同形**（整块 + 分支段 + 末段；段止于
 * 下一分支/收束**前一行**；零跨度不产；无分支块不补末段）——两侧不同形会直接把
 * `packages/erb-syntax-tree/tools/fold-compare.mjs --gate` 的"服务侧未包含"打红，
 * 那条对拍是本卡的验收腿之一（真语料 `[ELSE]` 0 枚 ⇒ 分支段在语料上不产，形状由
 * `tests/folding.test.ts` 的夹具钉，夹具直接抄 K3 在 `parse-structure.test.ts` 里的样本）。
 */
export function preprocFoldingRanges(text: string): EditorFoldingRange[] {
  const out: EditorFoldingRange[] = [];
  const stack: PreprocFrame[] = [];

  forEachControlFlowLine(text, ({ line, text: body }) => {
    // 预处理标记只可能是 `[` 起手整行：其余行连正则都不碰（与体检同一道省算力的门）
    if (!body.startsWith('[')) return;
    const role = foldPreprocRoleOf(body);
    if (role === null) return;
    if (role === 'open') {
      stack.push({ openLine: line, segmentStart: line, sawBranch: false });
      return;
    }
    if (role === 'branch') {
      const frame = stack[stack.length - 1];
      if (frame === undefined) return; // 无主分支：不动栈、不产区间
      // 上一段起点 → 分支前一行：首个分支到来时这一段就是块头段（`[IF …]` 的体）
      if (line - 1 > frame.segmentStart) out.push({ startLine: frame.segmentStart, endLine: line - 1 });
      frame.segmentStart = line;
      frame.sawBranch = true;
      return;
    }
    const frame = stack.pop();
    if (frame === undefined) return; // 孤儿收束：不动栈、不产区间
    // 末段只在真出现过分支时补（无分支块的段区间与整块只差收束行，重复给没有意义）
    if (frame.sawBranch && line - 1 > frame.segmentStart) {
      out.push({ startLine: frame.segmentStart, endLine: line - 1 });
    }
    if (line > frame.openLine) out.push({ startLine: frame.openLine, endLine: line });
  });
  // 结尾仍在栈上的帧 = 未闭合开块：**不产出**（与控制流同一条"不许吞全篇"纪律）
  return out;
}

/**
 * 整篇 ERB 文本 → 折叠区间（函数块 + 控制流块 + 预处理块）。
 * 纯函数，**三遍线性扫描**（`parseErbText` / `scanControlFlow` / 预处理那一遍的
 * `forEachControlFlowLine`），每遍都是"逐行 trim + 至多几次整行锚定正则"，
 * 没有第二次全文正则回溯；预处理那一遍不重扫控制流、只做 `[` 行的角色判定（K7）。
 */
export function erbFoldingRanges(text: string): EditorFoldingRange[] {
  if (text.length === 0) return [];
  const file = parseErbText(text);
  const starts = file.functions.map((fn) => fn.startLine); // parseErbText 按源序 → 天然升序
  return [
    ...functionFoldingRanges(file),
    ...controlFlowFoldingRanges(scanControlFlow(text), starts),
    ...preprocFoldingRanges(text),
  ];
}
