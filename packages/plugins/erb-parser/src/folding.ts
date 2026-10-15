import type { ControlFlowStatement, EditorFoldingRange, ErbFile } from '@kojo/plugin-api';
import { parseErbText, classifyControlFlow, scanControlFlow } from './scanner';

/**
 * ERB 折叠区间（D3，2026-10-15 折叠/面包屑批）。
 *
 * 真实口上 ERB 普遍**不缩进**（引擎不看缩进），Monaco 默认的按缩进折叠在其上几乎无效——
 * 折叠层级必须从块结构本身算出来。数据源刻意只有两枚**既有纯函数**：
 * - `parseErbText` → 函数边界（`@` 块）与函数起始行（结构重置点）；
 * - `scanControlFlow` → 控制流骨架（`IF…ENDIF` / `PRINTDATA…ENDDATA` / TRY 系…），
 *   开块/分支/闭合的角色与配对类别经 `classifyControlFlow` 取自 scanner 的**单一真源**——
 *   绝不写第二份正则扫描器（本仓教训：两处各算必然漂移，漂移表现为"波浪线指的行骨架里没有"）。
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

/** 整篇 ERB 文本 → 折叠区间（函数块 + 控制流块；纯函数，两遍线性扫描，无第二次全文正则） */
export function erbFoldingRanges(text: string): EditorFoldingRange[] {
  if (text.length === 0) return [];
  const file = parseErbText(text);
  const starts = file.functions.map((fn) => fn.startLine); // parseErbText 按源序 → 天然升序
  return [...functionFoldingRanges(file), ...controlFlowFoldingRanges(scanControlFlow(text), starts)];
}
