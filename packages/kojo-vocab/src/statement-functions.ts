/**
 * 行首「语句形」中文函数调用白名单（规格 §4.1 / 附录 A；v1.7 增量；「位糖 = 方案 E」）。
 *
 * Emuera 位原语四件套里 **三件是语句形**（`SETBIT` / `CLEARBIT` / `INVERTBIT`：
 * **无括号、无返回值**），只有 `GETBIT`（`获取标记`）是表达式形（有括号）。
 * 本表把「行首 中文名 + 空白 + `<变量引用>, <表达式>`」的表层收成对应语句：
 *
 * | 表层 | 产物 |
 * | --- | --- |
 * | `设置标记 X, n` | `SETBIT X, n` |
 * | `清除标记 X, n` | `CLEARBIT X, n` |
 * | `反转标记 X, n` | `INVERTBIT X, n` |
 *
 * 与系统函数名表（`system-functions.ts`）**并列但分离**：
 * - **行首语句形**：本表（严格 3 枚）；
 * - **表达式形**：`SYSTEM_FUNCTION_ALIASES`（`获取标记(X, n)` → `GETBIT(X, n)`，
 *   随名字后随 `(` 触发——见 `system-functions.lowerSystemFunctions`）。
 *
 * ## 为什么白名单必须严格 3 枚、不许泛化到系统函数全表
 * 系统函数表里有 `随机`（→ `RAND`），而 `随机` 又是 `KEYWORDS` 的块关键字
 * （`block.random`）——把整表当语句白名单会让 `随机` 与既有行内随机简写 / 块头
 * 判定抢道（`tryInlineRandom`）。**本表与 `KEYWORDS` 的交集为空**（测试钉死）。
 *
 * ## 单一真源
 * 本文件是「哪些中文名准以语句形出现 + 它们的引擎名」的**单一真源**；引擎名的取值
 * 与 `SYSTEM_FUNCTION_ALIASES` 的一致性由测试对表（防两表漂移），**运行期不再另抄**。
 */

/** 白名单：中文名 → 原生 ERB 语句形函数名（严格 3 枚；禁止扩到系统函数全表） */
export const STATEMENT_FUNCTIONS: ReadonlyMap<string, string> = new Map<string, string>([
  ['设置标记', 'SETBIT'],
  ['清除标记', 'CLEARBIT'],
  ['反转标记', 'INVERTBIT'],
]);
