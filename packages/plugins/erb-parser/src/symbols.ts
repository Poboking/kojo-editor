import type { ErbFile, ErbFunction, ErbFunctionRef, ErbIndex } from '@kojo/plugin-api';
import { symbolTokenAt } from '@kojo/plugin-api';
import { parseErbText } from './scanner';

/**
 * 位置 → 符号（B0，2026-10-15 语言服务批）。
 *
 * 全仓此前**没有任何**"位置 → 符号"的方法——definition / hover / highlight 三条线
 * 都得先回答"光标处是哪个函数"。本模块把这件事做成**纯函数**：索引进、符号出，
 * 不读盘、不碰工程状态，因此可被单测钉死，也可同时跑在 Node 与 WebView。
 *
 * 两条口径都刻意**复用 `ErbIndex` 既有结构**（不新造第二张表——第二张表就是漂移源）：
 * - 包围反查走 `files[path].functions` 的 `startLine/endLine`（`endLine` 由 scanner
 *   收紧成"下一个定义前一行"，故区间**互不重叠**）；
 * - 引用反查走 `byName`（"未定义函数"的判据 = `byName` 缺失，不另立标准）。
 */

/**
 * 包围该行的函数定义（1 基行号）。找不到 → `undefined`。
 *
 * 边界（逐条有测试）：
 * - `line` 非有限数 / 小于 1 → `undefined`（**不夹取**：把过期行号静默夹到附近，
 *   会把"位置失效"伪装成"命中旁边那个函数"，比不给答案更危险）；
 * - 行号超过文件行数 / 文件不在索引里 / 空文件（无 `@`）→ `undefined`；
 * - 一行落在两个区间上（理论上不发生——区间互不重叠）时取 `startLine` **较大**者
 *   （最近的 enclosing 定义），保留为防御性口径。
 */
export function functionAt(index: ErbIndex, path: string, line: number): ErbFunction | undefined {
  if (!Number.isFinite(line)) return undefined;
  const n = Math.trunc(line);
  if (n < 1) return undefined;
  const file = index.files.get(path);
  if (!file) return undefined;
  return functionInFile(file, n);
}

/**
 * 单个解析结果内包围该行的函数（`functionAt` 的**唯一**内核，2026-10-16 语言服务批
 * 起同时服务标签导航——`definitionTargetsAt` 的输入是**缓冲区文本**（脏缓冲也要给
 * 正确答案），包围判定对"索引里的那份"与"刚 parse 出来的这份"必须是同一条逻辑）。
 */
export function functionInFile(file: ErbFile, line: number): ErbFunction | undefined {
  let hit: ErbFunction | undefined;
  for (const fn of file.functions) {
    if (fn.startLine <= line && line <= fn.endLine && (hit === undefined || fn.startLine > hit.startLine)) {
      hit = fn;
    }
  }
  return hit;
}

/** 跳转系语句：行首关键字后的**第一个记号**是标签目标（`*CALLFORM` 与变量世界不在此列） */
const JUMP_FAMILY: ReadonlySet<string> = new Set(['JUMP', 'GOTO', 'TRYJUMP', 'TRYGOTO']);

/**
 * 行首跳转系关键字的结束偏移（0 基；非跳转行 = -1）。
 * 缩进口径与 `scanFileRefs` 的 `keywordEnd` 同一条（行首空白 + 关键字长度）。
 */
function jumpKeywordEndOf(lineText: string): number {
  const indent = lineText.length - lineText.trimStart().length;
  const lead = /^[A-Za-z_]+/.exec(lineText.slice(indent));
  if (!lead || !JUMP_FAMILY.has(lead[0]!.toUpperCase())) return -1;
  return indent + lead[0]!.length;
}

/**
 * 光标处的记号是 JUMP/GOTO 系语句的**裸**标签目标 → 返回当前函数内同名 `$` 标签的
 * 定义位置（包成 `ErbFunctionRef` 复用既有 definition 通道，不新增判别成员）。
 * 找不到（无当前函数 / 无同名标签）→ `null`——调用方收到**空数组**，不猜、
 * 也**不落到函数名那把尺子上**（`GOTO ALPHA` 是跳转不是调用，哪怕 ALPHA 恰好是函数名）。
 *
 * 数据面只有缓冲区文本（`parseErbText` 的 `labels`，脏缓冲跟着编辑走），项目索引零参与
 * ——与文档大纲同款口径：标签是本文件事实，不该依赖项目开闭。
 */
function labelTargetAt(text: string, path: string, line: number, lineText: string, tokenText: string, tokenStartCol: number): ErbFunctionRef | null {
  const keywordEnd = jumpKeywordEndOf(lineText);
  if (keywordEnd < 0 || tokenStartCol - 1 < keywordEnd) return null;
  // 裸标识符：关键字与记号之间只许空白（`(`、`"`、`{`、`%` 等动态/表达式形态不猜）
  if (!/^[\t \u3000]*$/.test(lineText.slice(keywordEnd, tokenStartCol - 1))) return null;
  const file = parseErbText(text, path);
  const fn = functionInFile(file, line);
  if (!fn) return null;
  const upper = tokenText.toUpperCase();
  const label = file.labels?.find((l) => l.functionStartLine === fn.startLine && l.name.toUpperCase() === upper);
  if (!label) return null;
  return {
    name: label.name,
    normalizedName: upper,
    filePath: path,
    startLine: label.line,
    endLine: label.line,
  };
}

/**
 * 光标下的函数**引用** → 定义位置列表（转到定义的数据面）。
 *
 * 两条腿（2026-10-16 语言服务批起）：
 * - **标签腿**：记号在 JUMP/GOTO 系语句的名字槽里（裸标识符）→ 当前函数内的同名
 *   `$` 标签（函数局部作用域；找不到 = 空数组，不猜、也不落函数名——`GOTO ALPHA`
 *   是跳转不是调用）；
 * - **函数腿**（原有）：记号整串在项目索引 `byName` 里 → 它的**全部**定义（重名函数
 *   多处定义都给，由宿主/Monaco 呈现；此处不替作者裁决哪一个是"对的那个"）。
 *
 * **未收录 → 空数组**（"未定义函数"的判据就是 `byName` 缺失，不猜、不新造表）。
 * 因此本函数对"变量名 / 关键字 / 散文"一律不给答案：那些记号根本不在 `byName` 里。
 *
 * 纯函数：只读入参索引，`text` 只用来切行与（仅跳转槽命中时）parse 出标签表。
 */
export function definitionTargetsAt(
  index: ErbIndex,
  path: string,
  text: string,
  line: number,
  column: number,
): ErbFunctionRef[] {
  const lineText = lineTextOf(text, line);
  if (lineText === undefined) return [];
  const token = symbolTokenAt(lineText, column);
  if (!token) return [];
  // 标签腿：只在"行首是跳转系关键字 + 记号在其名字槽里"时走（此刻不走 parse，
  // 普通函数名查询零额外成本）；命中槽位但标签找不到 = 空数组，不落函数名
  const keywordEnd = jumpKeywordEndOf(lineText);
  if (keywordEnd >= 0 && token.startColumn - 1 >= keywordEnd) {
    const label = labelTargetAt(text, path, line, lineText, token.text, token.startColumn);
    return label ? [label] : [];
  }
  return index.byName.get(token.text.toUpperCase()) ?? [];
}

/** 取 1 基行号的原文（越界 → undefined；不做补空格之类的"宽容"假数据） */
function lineTextOf(text: string, line: number): string | undefined {
  if (!Number.isFinite(line)) return undefined;
  const n = Math.trunc(line);
  if (n < 1) return undefined;
  const lines = text.split(/\r\n?|\n/);
  return lines[n - 1];
}
