import type { ErbFunction, ErbFunctionRef, ErbIndex } from '@kojo/plugin-api';
import { symbolTokenAt } from '@kojo/plugin-api';

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
  let hit: ErbFunction | undefined;
  for (const fn of file.functions) {
    if (fn.startLine <= n && n <= fn.endLine && (hit === undefined || fn.startLine > hit.startLine)) {
      hit = fn;
    }
  }
  return hit;
}

/**
 * 光标下的函数**引用** → 定义位置列表（转到定义的数据面）。
 *
 * 判据只有一条：光标处的标识符整串（`symbolTokenAt`，与 EMuera 函数名同一字符集）
 * 在项目索引 `byName` 里存在 → 返回它的**全部**定义（重名函数多处定义都给，
 * 由宿主/Monaco 呈现；此处不替作者裁决哪一个是"对的那个"）。
 *
 * **未收录 → 空数组**（"未定义函数"的判据就是 `byName` 缺失，不猜、不新造表）。
 * 因此本函数对"变量名 / 关键字 / 散文"一律不给答案：那些记号根本不在 `byName` 里。
 *
 * 纯函数：只读入参索引，`text` 只用来切出光标所在那一行。
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
