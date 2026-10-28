import type { EditorSemanticTokenSpan, ErbFile, ErbFunction, ErbIndex } from '@kojo/plugin-api';
import { locateIdentifier, modelLineAt, splitModelLines } from '@kojo/plugin-api';
import { parseErbText } from './scanner';
import { scanFileRefs, skipBlockAt, splitErbLines, windowSliceOf, type VisibleLineWindow } from './references';

/**
 * ERB 结构化着色（B6，2026-10-16 结构化着色批）。
 *
 * ## 只画"词法判不出来"的四件事
 *
 * Monarch 的正则词法看得见形状，看不见**角色**：`@M_KOJO_X` 与 `CALL M_KOJO_X` 里
 * 那串字符在词法上一模一样。本模块交出的每个 span 都得是"只有结构（解析器）或
 * 名录（项目索引）才知道的东西"——把词法已经着色的区间重画一遍，就是造第二真相源
 * （契约 `EditorSemanticTokenRequest` 头注把这条定为分工边界；Monaco 在覆盖区间上
 * 让语义 token 优先，重画的后果是"同一个名字今天这个色、明天那个色"，无人能解释）。
 *
 * | 产出 | 类别 | 判据来源 |
 * |---|---|---|
 * | `@NAME` 定义行上的名字 | `function` + `declaration` | `parseErbText`（缓冲区，**不需要项目**） |
 * | 定义行括号里的引擎槽 | `parameter` | 同一份 `ErbFunction.params` |
 * | `#DIM NAME` 声明的名字 | `variable` + `declaration` | `parseErbText`（同上） |
 * | 引用点（`CALL` 槽位 / 其他可见记号） | `function` | `scanFileRefs` + `ErbIndex.byName` |
 *
 * 刻意**不做**的（宁缺勿编，理由各自成立）：
 * - **`$` 标签自己一套定义/引用**：标签名与行号在 `JUMP` 后不可区分，本模块**不另开判据**。
 *   但 `$LABEL` 里的名字若**恰好是**项目里的函数名，`scanFileRefs` 怎么判、这里就怎么画
 *   ——判据继承，不本地加减（否则着色与引用面板又会各说各话）。
 * - **`#DIM` 名字的后续使用点**：引用扫描的名录判据（`hasName`）只覆盖**函数名**，
 *   给声明名另开一套全文扫记号 = 在解析器里长出一条与反向索引平行的第二判据。
 * - **变量族多段引用**（`CFLAG:ARG:1`）：形状可判 = 词法的活，已经在 `erb-language.ts`。
 *
 * ## 索引缺席时给多少
 *
 * `index === null`（未开项目 / 索引未建）⇒ 只交声明那三行，引用点一条不画——
 * **不是**返回 `undefined`（那等于说"这文件我不认"，而 `@` 定义与 `#DIM` 声明本就与
 * 项目无关）。少画的是"谁在调它"，画错的一条都没有。
 */

/** 1 基半开区间 → span（`endColumn` 越界由宿主夹取，此处只保证 `start < end`） */
const span = (
  line: number,
  startColumn: number,
  length: number,
  tokenType: EditorSemanticTokenSpan['tokenType'],
  modifiers?: EditorSemanticTokenSpan['modifiers'],
): EditorSemanticTokenSpan => ({
  line,
  startColumn,
  endColumn: startColumn + length,
  tokenType,
  ...(modifiers && modifiers.length > 0 ? { modifiers } : {}),
});

/**
 * 定义行括号里的**形参槽**（`parameter`）。
 *
 * 只在 `@` 那一行、且只在 `(…)` 之内定位（形参表不跨行；跨行的续行形态本批不认，
 * 与 B5 签名帮助同口径），按声明顺序滚动游标——同名重复段（`ARG:1, ARG:1` 这类写法）
 * 各得各的位置。名字取 `ErbFunction.params` 的 `name`（`ref ARG` 交 `ARG`、
 * `ARG:1 = 3` 交 `ARG:1`），默认值段不着色（那是字面量，词法的活）。
 */
function paramSpansOf(fn: ErbFunction, defLine: string): EditorSemanticTokenSpan[] {
  if (fn.params.length === 0) return [];
  const open = defLine.indexOf('(');
  const close = defLine.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const inside = defLine.slice(0, close); // 前缀切片：下标与 defLine 逐位对齐，列号不用二次换算
  const out: EditorSemanticTokenSpan[] = [];
  let cursor = open + 1;
  for (const param of fn.params) {
    const at = locateIdentifier(inside, param.name, cursor);
    if (at < 0) continue; // 这一段定位不了（剥字 / 续行）⇒ 不画
    out.push(span(fn.startLine, at, param.name.length, 'parameter'));
    cursor = at - 1 + param.name.length;
  }
  return out;
}

/** 函数定义行上的名字（`@` 之后到终止符之前）：不依赖索引，缓冲区说了就算 */
function definitionSpans(file: ErbFile, lines: readonly string[]): EditorSemanticTokenSpan[] {
  const out: EditorSemanticTokenSpan[] = [];
  for (const fn of file.functions) {
    const defLine = modelLineAt(lines, fn.startLine);
    if (defLine === undefined) continue;
    const at = defLine.indexOf('@');
    if (at < 0) continue;
    const nameAt = locateIdentifier(defLine, fn.name, at);
    if (nameAt >= 0) out.push(span(fn.startLine, nameAt, fn.name.length, 'function', ['declaration']));
    out.push(...paramSpansOf(fn, defLine));
  }
  return out;
}

/** `#DIM` 一族声明的名字（`variable` + `declaration`） */
function dimSpans(file: ErbFile, lines: readonly string[]): EditorSemanticTokenSpan[] {
  const out: EditorSemanticTokenSpan[] = [];
  for (const dim of file.dims) {
    const line = modelLineAt(lines, dim.line);
    if (line === undefined) continue;
    const at = locateIdentifier(line, dim.name, 0);
    if (at >= 0) out.push(span(dim.line, at, dim.name.length, 'variable', ['declaration']));
  }
  return out;
}

/**
 * 引用点（`function`，无 `declaration` 修饰）：判据**逐字复用** `scanFileRefs`——
 * 它与"查找引用 / 重命名"用的是同一把尺子（注释、字符串、`[SKIPSTART]` 区、
 * `@` 定义行的形参一律不算）。在这里另写一条正则，就是让"哪里算引用"这件事
 * 在同一个包里长出第二个答案，早晚和引用面板对不上。
 *
 * `kind === 'definition'` 那条**跳过**：定义点由 `definitionSpans` 负责（缓冲区口径，
 * 项目索引里还没有的新函数也照样有色）。
 */
function referenceSpans(text: string, index: ErbIndex, window?: VisibleLineWindow): EditorSemanticTokenSpan[] {
  const hasName = (upper: string): boolean => index.byName.has(upper);
  const out: EditorSemanticTokenSpan[] = [];
  // 换行归一由 `scanFileRefs` 自己做（与 `parseErbText` 同一条规则），行号两侧天然对齐
  for (const [name, line, column, kind] of scanFileRefs(text, hasName, undefined, window)) {
    if (kind === 0) continue; // definition：已由声明那条腿负责
    out.push(span(line, column, name.length, 'function'));
  }
  return out;
}

/** 整篇 ERB 缓冲区 → 结构化着色 span（**纯函数**；产出序 = 声明 → 形参 → 声明名 → 引用）。
 *  拼接不许用 `push(...arr)`：169k 行那份 span 数超 V8 实参上限，会 `RangeError` 爆栈。
 *
 *  `window`（R3，2026-10-28）给了就只答这一段的行（宿主给的是**变更行窗口**）。判据一字
 *  不动，省掉的是窗口外那些行的两遍扫描：24,197 行实测整腿 **73.5 ms**（引用腿 64.7 /
 *  解析 2.95 / 宿主编码 0.58）→ 400 行窗口 **0.5 ms** 量级。
 *  等价性由 `semantic-tokens-window.test.ts` 的"全部窗口 ≡ 整篇按行过滤"钉着。
 */
export function erbSemanticTokens(
  text: string,
  index: ErbIndex | null,
  window?: VisibleLineWindow,
): EditorSemanticTokenSpan[] {
  if (text.length === 0) return [];
  if (window !== undefined) return windowedSemanticTokens(text, index, window);
  const lines = splitErbLines(text);
  const file = parseErbText(text, '<semantic-tokens>', lines);
  const out = [...definitionSpans(file, lines), ...dimSpans(file, lines)];
  if (index) for (const s of referenceSpans(text, index)) out.push(s);
  return out;
}

/**
 * 窗口路径：声明腿在**切片**上重跑 `parseErbText`（判据单源），引用腿走 `scanFileRefs`
 * 的窗口分支（`visibleCodeLines` 自己把 `[SKIPSTART]` 状态从第 1 行算到窗口起点）。
 *
 * 切片丢掉了前缀，而前缀里可能正开着 `[SKIPSTART]` ⇒ 补一行**合成标记**再把行号平移回来。
 * 这是唯一一处"造一行不存在的文本"，代价是前缀里那趟标记搜索一点都不少做——
 * 换来的是 `parseErbText` / `definitionSpans` / `dimSpans` 一行都不用改（也就不会漂移）。
 */
function windowedSemanticTokens(
  text: string,
  index: ErbIndex | null,
  window: VisibleLineWindow,
): EditorSemanticTokenSpan[] {
  const slice = windowSliceOf(text, window);
  if (slice === null) return [];
  const insideSkip = skipBlockAt(text, slice.offset);
  const body = insideSkip ? `[SKIPSTART]\n${slice.text}` : slice.text;
  const lines = splitErbLines(body);
  const file = parseErbText(body, '<semantic-tokens>', lines);
  // 合成标记多出来的一行：切片的第 1 行在 body 里是第 2 行
  const shift = slice.firstLine - 1 - (insideSkip ? 1 : 0);
  const out = [
    ...shiftSpans(definitionSpans(file, lines), shift),
    ...shiftSpans(dimSpans(file, lines), shift),
  ];
  if (index) for (const s of referenceSpans(text, index, { ...window, skipState: insideSkip })) out.push(s);
  return out;
}

/** 切片坐标 → 全文坐标（`delta === 0` 时原样返回，不白拷一份） */
function shiftSpans(
  spans: readonly EditorSemanticTokenSpan[],
  delta: number,
): EditorSemanticTokenSpan[] {
  if (delta === 0) return [...spans];
  return spans.map((s) => ({ ...s, line: s.line + delta }));
}
