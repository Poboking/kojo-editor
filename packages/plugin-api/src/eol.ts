/**
 * 换行归一与切行的**唯一实现**（契约层叶子；零运行时 import，裸 node 可解析）。
 *
 * ## 为什么住在契约层
 *
 * "`\r\n` 与裸 `\r` 各算一个换行"是**一个事实**，而消费方横跨每一层：kernel 的
 * `FileIO` 读盘后归一（`TextFile.text` 的契约形态）、`erb-parser` 的解析 / 引用 /
 * 补全 / 声明 / 符号 / 结构六条腿、`condition-extractor` 与 `convention-linter` 的行级
 * 判据、`plugin-api` 自己的 `splitModelLines`、`state-replay` 的回放切行，以及宿主
 * （`app/src/ui` / `app/src/monaco`）的迁移与片段。**收口前仓里写着 26 份**
 * （`packages/` 下 `src/` 非测试文件里 `replace(/\r\n?/g, '\n')` 的出现次数），
 * 改一处不改另一处就是"同一份正文在两个消费者眼里行号不同"——而那种漂移只能靠肉眼发现。
 *
 * 唯一的**例外**是 `@kojo/kojo-conformance` 的 `normalizeEolToLf`：那个包是**对照实现**
 * （它与 Rust 侧互相对拍），刻意不从产品侧拿判据，所以它那份保留原样、不进本口径。
 *
 * ## 为什么不用 `replace`
 *
 * MEM-16（2026-10-09）在 kernel 侧实测过：`String.prototype.replace` 在"真发生替换
 * 且结果够长"时产出 **ConsString（绳索）**，实测驻留 **5.68 B/字符**，而这串会被
 * `readTexts` 长期持在会话文本缓存里。`split` + `join` 走 `StringBuilderConcat`
 * （先算总长再分配一条平铺串），驻留 2.01 B/字符。
 *
 * 本文件在 MEM-16 的基础上再补两条（2026-10-31 R7B 批实测，1.17 亿码元真语料）：
 * - **`indexOf('\r')` 先行**：全文无 `\r` 时**零拷贝**返回入参（连 `split` 都省）；
 * - **切行不再先归一**：`splitEolLines` 直接按同一个分隔符集合切一次，消掉
 *   "先 `join('\n')` 拼回整串、再 `split('\n')` 拆开"这一往一来的两次全文遍历。
 *   全量实测：`replace` 2,415ms → `splitEolLines` 836ms（见 PITFALLS 296）。
 *
 * ## 等价性
 *
 * `/\r\n?/` 只把 `\r\n` 与孤立 `\r` 各算一个分隔符；`/\r\n|\r|\n/` 的切分点与之逐位
 * 相同，`join('\n')` 的产物与旧实现逐字相等（含首尾/连续分隔符产生的空段）。
 * `splitEolLines(text)` 与 `normalizeEol(text).split('\n')` **逐元素相等**：切分后每段
 * 都不含 `\r`/`\n`，故 `join('\n')` 再 `split('\n')` 是恒等变换。三条都由
 * `packages/plugin-api/tests/eol.test.ts` 以旧写法为参照实现钉死。
 */

/**
 * 归一化为内部表示（`\n`）——编辑器模型 / 逐行比较 / 索引的规范形态。
 *
 * 无 `\r` 时**返回入参本身**（零拷贝，与旧写法 no-match 时的行为一致）。
 */
export function normalizeEol(text: string): string {
  if (text.indexOf('\r') < 0) return text;
  return text.split(/\r\n|\r|\n/).join('\n');
}

/**
 * 归一化并切成行数组（`\r\n` / `\r` / `\n` 各算一个换行）。
 *
 * 结果与 `normalizeEol(text).split('\n')` 逐元素相等，但**只遍历一遍正文**
 * （见文件头"等价性"）。空串 → `['']`（与 `''.split('\n')` 同）。
 */
export function splitEolLines(text: string): string[] {
  if (text.indexOf('\r') < 0) return text.split('\n');
  return text.split(/\r\n|\r|\n/);
}
