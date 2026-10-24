/**
 * 光标位点的**文本面判读**：`{ … }` 插值内 / 字符串与注释内。
 *
 * ## 为什么这两条住在这里（而不是继续待在宿主的 `kojo-completion-position.ts`）
 *
 * 它们是**语言事实**，不是补全的私产：补全（`kojo2-completion`）、悬停、转定义、
 * 语义着色、调用层级五条腿都要问同一个问题——"这一格是代码、是台词、还是字符串里
 * 的插值"。这些腿正在陆续搬进 `@kojo/plugin-kojo-lang`，而包**不能**反过来 import
 * 宿主（`packages/app/src/**` 对包不可见），所以判据必须先在包里。
 *
 * 宿主侧 `kojo-completion-position.ts` 原样 re-export 这两个名字，15 个既有 import 点
 * 一行不动——与 `isNameChar` / `isCjk` 搬迁时同一条纪律。
 *
 * ## 口径（与搬迁前逐字相同，一个字都不改）
 *
 * - 判据只看**行内文本 + 0 基列**，不做跨行扫描、不看文件类型、不抛错；
 * - 引号配平用**奇偶**（不处理转义）——这是 v1 起就有的口径，改它等于改所有腿的
 *   行为；真要支持转义是另一批（`\` 转义在这门语言里目前不产生引号语义）。
 */

/**
 * 光标是否在 `{ … }` 插值内（向左找 `{`，途中遇 `}` 即已在插值外）——插值里是变量名的地盘。
 *
 * `col0` 越界不抛：小于 0 当行首、大于行长当行尾（与全部调用点的既有容忍度一致）。
 */
export function insideInterpolation(line: string, col0: number): boolean {
  for (let i = col0 - 1; i >= 0; i--) {
    const ch = line[i]!;
    if (ch === '}') return false;
    if (ch === '{') return true;
  }
  return false;
}

/**
 * 光标是否落在行内**字符串 / 注释**里（与 `kojo-sugar` 的 `inlineCommentIndex` 同口径：
 * 引号配平后第一个 `;` 起至行尾）。字符串内 / 注释内不给候选、不跳定义。
 */
export function insideStringOrComment(line: string, col0: number): boolean {
  let inString = false;
  const stop = Math.min(col0, line.length);
  for (let i = 0; i < stop; i++) {
    const ch = line[i]!;
    if (ch === '"') inString = !inString;
    else if (!inString && ch === ';') return true;
  }
  return inString;
}
