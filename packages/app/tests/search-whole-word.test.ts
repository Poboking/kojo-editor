import { describe, expect, it } from 'vitest';
import {
  compileReplaceMatcher,
  planLineEdit,
  planLineMatches,
  planSingleReplacement,
} from '../src/ui/search-replace';

/**
 * 全词判据的跨语言对账（WW-1）。
 *
 * ## 尺子
 * 全词 = 命中区间两侧的相邻一格都**不是**标识字符 `[\p{L}\p{N}_]`（行首/行尾 = 没有
 * 相邻字符）。本文件钉的 `wholeWordOk` 是这把尺的**真源**（与 `erb-rename.ts` 的
 * `IDENT_RE` 同口径）；Rust 检索侧（`src-tauri/src/lib.rs`）改后与它同判。
 *
 * ## 改前 / 改后（同一批 38 例，两侧真实调用取证）
 * 改前 Rust = `\b(?:…)\b`；改前 TS = `wholeWordOk`（即改后两侧共用的唯一尺，TS 本次不改）。
 * 数字 = 全词命中数。
 *
 * | 查询 | 行文本 | 改前 Rust | 改前 TS | 改后 Rust=TS |
 * | --- | --- | --- | --- | --- |
 * | `测试` | `测试` | 1 | 1 | 1 |
 * | `测试` | `这是测试文本` | 0 | 0 | 0 |
 * | `测试` | `这是 测试 文本` | 1 | 1 | 1 |
 * | `测试` | `测试2` | 0 | 0 | 0 |
 * | `测试` | `A测试` | 0 | 0 | 0 |
 * | `测试` | `「测试」` | 1 | 1 | 1 |
 * | `测试` | `测试 测试` | 2 | 2 | 2 |
 * | `（测试）` | `（测试）` | **0** | **1** | 1 |
 * | `（测试）` | `这是（测试）文本` | **1** | **0** | 0 |
 * | `（测试）` | `这是 （测试） 文本` | **0** | **1** | 1 |
 * | `（测试）` | `（测试）。` | **0** | **1** | 1 |
 * | `（测试）` | `a（测试）b` | **1** | **0** | 0 |
 * | `test-case` | `test-case` | 1 | 1 | 1 |
 * | `test-case` | `a test-case b` | 1 | 1 | 1 |
 * | `test-case` | `mytest-case` | 0 | 0 | 0 |
 * | `test-case` | `test-cases` | 0 | 0 | 0 |
 * | `test-case` | `test-case2` | 0 | 0 | 0 |
 * | `test-case` | `test_case` | 0 | 0 | 0 |
 * | `test-case` | `test-case, test-case` | 2 | 2 | 2 |
 * | `好感度` | `好感度` | 1 | 1 | 1 |
 * | `好感度` | `好感度上升` | 0 | 0 | 0 |
 * | `好感度` | `提升好感度` | 0 | 0 | 0 |
 * | `好感度` | `好感度+1` | 1 | 1 | 1 |
 * | `好感度` | `「好感度」` | 1 | 1 | 1 |
 * | `C_FLAG` | `C_FLAG` | 1 | 1 | 1 |
 * | `C_FLAG` | `if C_FLAG then` | 1 | 1 | 1 |
 * | `C_FLAG` | `C_FLAG_X` | 0 | 0 | 0 |
 * | `C_FLAG` | `MYC_FLAG` | 0 | 0 | 0 |
 * | `C_FLAG` | `C_FLAG1` | 0 | 0 | 0 |
 * | `C_FLAG` | `(C_FLAG)` | 1 | 1 | 1 |
 * | `C_FLAG` | `C_FLAG²` | **1** | **0** | 0 |
 * | `C_FLAG` | `C_FLAG` + U+0301（组合尖音符） | **0** | **1** | 1 |
 * | `_x` | `_x` | 1 | 1 | 1 |
 * | `_x` | `a_x` | 0 | 0 | 0 |
 * | `_x` | `( _x )` | 1 | 1 | 1 |
 * | `_x` | `_x2` | 0 | 0 | 0 |
 * | `_x` | `x_x` | 0 | 0 | 0 |
 * | `_x` | `_x _x` | 2 | 2 | 2 |
 *
 * 改前只有两类分歧（粗体，改后全部对齐）：
 * 1. **模式首尾是非词字符**（`（测试）`，5 例）：`\b` 要求两侧是"词符↔非词符"过渡 ⇒
 *    行首/行尾与空格旁没有边界（Rust 0），行内贴着 CJK 反而有边界（Rust 1）——与
 *    相邻格判据正好相反（TS 分别为 1 / 0）。
 * 2. **词符集合不同**（2 例）：`\w` 含组合记号（`C_FLAG` + U+0301 ⇒ Rust 0 / TS 1）、
 *    但不含 `No` 类数字（`C_FLAG²` ⇒ Rust 1 / TS 0），而 `\p{L}\p{N}` 相反。
 *
 * ## 样例清单是跨语言契约的两端
 * `CASES` 与 Rust 侧 `src-tauri/src/search_tests.rs` 的 `WHOLE_WORD_CASES`
 * **逐字同源**（查询 / 行文本 / 期望命中数三项一字不差）。为什么各写一份、不引共享
 * 数据文件：两套测试各有自己的加载面（Rust 单测不读 node 侧文件，vitest 也不读 Rust
 * 源码），两份字面量就是契约文本。**改一处必须改两处**——漂一个字符，两侧对账必有
 * 一边红（两侧都不读对方，靠这条约定 + 双跑兜住）。
 */

type Case = readonly [query: string, line: string, hits: number];

const CASES: readonly Case[] = [
  ['测试', '测试', 1],
  ['测试', '这是测试文本', 0],
  ['测试', '这是 测试 文本', 1],
  ['测试', '测试2', 0],
  ['测试', 'A测试', 0],
  ['测试', '「测试」', 1],
  ['测试', '测试 测试', 2],
  ['（测试）', '（测试）', 1],
  ['（测试）', '这是（测试）文本', 0],
  ['（测试）', '这是 （测试） 文本', 1],
  ['（测试）', '（测试）。', 1],
  ['（测试）', 'a（测试）b', 0],
  ['test-case', 'test-case', 1],
  ['test-case', 'a test-case b', 1],
  ['test-case', 'mytest-case', 0],
  ['test-case', 'test-cases', 0],
  ['test-case', 'test-case2', 0],
  ['test-case', 'test_case', 0],
  ['test-case', 'test-case, test-case', 2],
  ['好感度', '好感度', 1],
  ['好感度', '好感度上升', 0],
  ['好感度', '提升好感度', 0],
  ['好感度', '好感度+1', 1],
  ['好感度', '「好感度」', 1],
  ['C_FLAG', 'C_FLAG', 1],
  ['C_FLAG', 'if C_FLAG then', 1],
  ['C_FLAG', 'C_FLAG_X', 0],
  ['C_FLAG', 'MYC_FLAG', 0],
  ['C_FLAG', 'C_FLAG1', 0],
  ['C_FLAG', '(C_FLAG)', 1],
  ['C_FLAG', 'C_FLAG²', 0],
  ['C_FLAG', 'C_FLAG\u0301', 1],
  ['_x', '_x', 1],
  ['_x', 'a_x', 0],
  ['_x', '( _x )', 1],
  ['_x', '_x2', 0],
  ['_x', 'x_x', 0],
  ['_x', '_x _x', 2],
];

/** 与 Rust 侧同一组开关：字面量 + 大小写敏感 + 全词。 */
const matcherFor = (query: string) =>
  compileReplaceMatcher(query, { isRegex: false, caseSensitive: true, wholeWord: true })!;

describe('全词判据跨语言对账（WW-1）', () => {
  it.each(CASES)('查询 %s / 行 %s → %i 处', (query, line, want) => {
    const hits = planLineMatches(line, matcherFor(query));
    expect(hits).toHaveLength(want);
    for (const h of hits) expect(h.whole).toBe(query);
  });

  it('命中区间是 0 基半开、按 UTF-16 单元（与 Rust 预览偏移同口径）', () => {
    const mm = matcherFor('（测试）');
    const edge = planLineMatches('（测试）。', mm);
    expect(edge).toHaveLength(1);
    expect([edge[0]!.start, edge[0]!.end]).toEqual([0, 4]);
    expect(planLineMatches('这是（测试）文本', mm)).toHaveLength(0);
  });

  it('单条替换与整行替换同一裁决（陈旧防线不另立尺子）', () => {
    const mm = matcherFor('（测试）');
    const line = '这是 （测试） 文本';
    const at = line.indexOf('（测试）');
    expect(planSingleReplacement(line, at, mm, 'X', '（测试）')).toMatchObject({
      kind: 'replace',
      start: at,
      end: at + 4,
      text: 'X',
    });
    expect(planSingleReplacement('这是（测试）文本', 2, mm, 'X', '（测试）').kind).toBe('skip');
    expect(planLineEdit(line, mm, 'X')).toHaveLength(1);
  });

  it('正则模式也走相邻格判据（全词不是字面量专用开关）', () => {
    const mm = compileReplaceMatcher('\\d+', {
      isRegex: true,
      caseSensitive: true,
      wholeWord: true,
    })!;
    expect(planLineMatches('12 a12 34', mm).map((h) => h.whole)).toEqual(['12', '34']);
  });
});
