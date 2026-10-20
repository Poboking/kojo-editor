import { describe, expect, it } from 'vitest';
import {
  applyLineEdits,
  compileReplaceMatcher,
  planLineEdit,
  planLineMatches,
  planSingleReplacement,
} from '../src/ui/search-replace';

/**
 * 宽度折叠的跨语言对账（WF-1，2026-10-20）。
 *
 * ## 折叠表（只折宽度）
 * 全角 ASCII 区 U+FF01–U+FF5E ↔ 半角 U+0021–U+007E（位移 0xFEE0），
 * U+3000（全角空格）↔ U+0020。**不折**繁简（`髙`≠`高`）、不折假名（`ア`≠`ｱ`）、
 * 不折大小写（大小写是 `caseSensitive` 的事）。折叠只作用于**字面量**查询：
 * 正则模式下作者拥有 pattern 的解释权，本层原样编译（需要精确宽度时这是逃生口）。
 *
 * ## 两侧同一判据
 * 检索侧（Rust `src-tauri/src/lib.rs`）把字面量查询逐字符展开成"宽度等价类"
 * （`（` → `[（(]`）——命中偏移仍落在原文上；全词边界先折相邻一格再判标识字符。
 * 替换侧本文件钉的 `compileReplaceMatcher` / `wholeWordOk` 与它逐字同判。
 *
 * 恒开、无开关。影响面：搜 `Ａ` 也命中 `A`、搜 `(` 也命中 `（`（这正是本功能的目的）；
 * 代价是字面量检索不再"逐字节精确"，精确需求走正则模式。
 *
 * ## 样例清单是跨语言契约的两端
 * `WIDTH_FOLD_CASES` 与 Rust 侧 `src-tauri/src/search_tests.rs` 的 `WIDTH_FOLD_CASES`
 * **逐字同源**（查询 / 行文本 / 命中数 / 首个命中文本四项一字不差）。为什么各写一份、
 * 不引共享数据文件：两套测试各有自己的加载面（Rust 单测不读 node 侧文件，vitest 也不读
 * Rust 源码），两份字面量就是契约文本。**改一处必须改两处**——漂一个字符，两侧对账
 * 必有一边红（两侧都不读对方，靠这条约定 + 双跑兜住）。
 *
 * 样例均按 `字面量 + 大小写敏感 + 全词` 取值（与 Rust 侧 `build_matcher(query, false,
 * true, true)` 同一组开关）。
 */

type Case = readonly [query: string, line: string, hits: number, first: string];

const WIDTH_FOLD_CASES: readonly Case[] = [
  // 全角 ↔ 半角：括号 / 字母 / 标点
  ['（测试）', '(测试)', 1, '(测试)'],
  ['(测试)', '（测试）', 1, '（测试）'],
  ['（测试）', '（测试）', 1, '（测试）'],
  ['（测试）', '这是 (测试) 文本', 1, '(测试)'],
  ['（测试）', '这是（测试）文本', 0, ''],
  ['测试', '（测试）', 1, '测试'],
  ['ＡＢＣ', 'ABC', 1, 'ABC'],
  ['ABC', 'ＡＢＣ', 1, 'ＡＢＣ'],
  ['ＡＢＣ', 'x ABC y', 1, 'ABC'],
  ['ＡＢＣ', 'xABCy', 0, ''],
  ['ＡＢＣ', 'xＡＢＣy', 0, ''],
  ['ＡＢＣ', 'ABC ABC', 2, 'ABC'],
  ['abc', 'ＡＢＣ', 0, ''], // 宽度折、大小写不折（caseSensitive）
  ['！', '!', 1, '!'],
  ['～', '~', 1, '~'],
  ['＿', '_', 1, '_'],
  ['_', '＿', 1, '＿'],
  ['x', '＿x', 0, ''], // 全角下划线折成 `_` = 标识字符
  ['x', 'x＿', 0, ''],
  ['x', '（x）', 1, 'x'],
  ['（x）', '(x)', 1, '(x)'],
  ['Ｃ_FLAG', 'C_FLAG', 1, 'C_FLAG'],
  ['C_FLAG', 'Ｃ＿ＦＬＡＧ', 1, 'Ｃ＿ＦＬＡＧ'],
  ['（Ａ）', '(A)', 1, '(A)'],
  ['，', ',', 1, ','],
  // U+3000 ↔ 半角空格（整词判据下，空格贴着标识字符不算命中）
  ['\u3000', '\u3000', 1, '\u3000'],
  [' ', '\u3000', 1, '\u3000'],
  ['\u3000', '（ ）', 1, ' '],
  [' ', '（\u3000）', 1, '\u3000'],
  ['\u3000', '. . .', 2, ' '],
  ['\u3000', 'a b', 0, ''],
  ['a b', 'a\u3000b', 1, 'a\u3000b'],
  ['\u3000', 'a\u3000b', 0, ''],
  // 负例：表外字符一律不折
  ['①', '①', 1, '①'],
  ['①', '1', 0, ''],
  ['①', '１', 0, ''], // `１` 折成 `1`，但 `①` 不折
  ['髙', '高', 0, ''],
  ['髙', '髙', 1, '髙'],
  ['、', ',', 0, ''],
  [',', '、', 0, ''],
  ['ア', 'ｱ', 0, ''], // 半角片假名 U+FF71 在 U+FF5E 之外
];

/** 与 Rust 侧同一组开关：字面量 + 大小写敏感 + 全词。 */
const matcherFor = (query: string) =>
  compileReplaceMatcher(query, { isRegex: false, caseSensitive: true, wholeWord: true })!;

describe('宽度折叠跨语言对账（WF-1）', () => {
  it.each(WIDTH_FOLD_CASES)('查询 %s / 行 %s → %i 处', (query, line, want, first) => {
    const hits = planLineMatches(line, matcherFor(query));
    expect(hits).toHaveLength(want);
    if (want > 0) expect(hits[0]!.whole).toBe(first);
  });

  it('宽度与大小写是两个维度：折完仍受 caseSensitive 管', () => {
    const sensitive = compileReplaceMatcher('ＡＢＣ', {
      isRegex: false,
      caseSensitive: true,
      wholeWord: false,
    })!;
    expect(planLineMatches('ABC', sensitive)).toHaveLength(1);
    expect(planLineMatches('abc', sensitive)).toHaveLength(0);
    const loose = compileReplaceMatcher('ＡＢＣ', {
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
    })!;
    expect(planLineMatches('abc', loose)).toHaveLength(1);
    expect(planLineMatches('ａｂｃ', loose)).toHaveLength(1);
  });

  it('正则模式不折宽度（作者拥有 pattern；需要精确宽度时这是逃生口）', () => {
    const re = compileReplaceMatcher('（测试）', {
      isRegex: true,
      caseSensitive: true,
      wholeWord: false,
    })!;
    expect(planLineMatches('（测试）', re)).toHaveLength(1);
    expect(planLineMatches('(测试)', re)).toHaveLength(0);
    const re2 = compileReplaceMatcher('Ａ', { isRegex: true, caseSensitive: true, wholeWord: false })!;
    expect(planLineMatches('Ａ', re2)).toHaveLength(1);
    expect(planLineMatches('A', re2)).toHaveLength(0);
  });

  it('字符类元字符（`]` 等）的宽度等价类不破类', () => {
    const hits = planLineMatches('（］） （]）', matcherFor(']'));
    expect(hits.map((h) => h.whole)).toEqual(['］', ']']);
  });

  it('替换落点跟着实文走：命中全角/半角写法，编辑区间是原文区间', () => {
    const mm = matcherFor('（测试）');
    const line = '这是 (测试) 文本';
    const edits = planLineEdit(line, mm, 'X');
    expect(edits).toEqual([{ start: 3, end: 7, text: 'X' }]);
    expect(applyLineEdits([line], [{ lineNumber: 1, ...edits[0]! }])).toBe('这是 X 文本');
  });

  it('单条替换：expected 取实文写法（全角/半角不同也不算陈旧）', () => {
    const mm = matcherFor('ＡＢＣ');
    const line = 'x ABC y';
    const at = line.indexOf('ABC');
    expect(planSingleReplacement(line, at, mm, 'X', 'ABC')).toMatchObject({
      kind: 'replace',
      start: at,
      end: at + 3,
      text: 'X',
    });
    // 检索结果给的是实文（可能是全角写法）——与 sticky 命中的实文逐字相同，不该判陈旧
    expect(planSingleReplacement('x ＡＢＣ y', 2, mm, 'X', 'ＡＢＣ')).toMatchObject({
      kind: 'replace',
      start: 2,
      end: 5,
      text: 'X',
    });
  });
});
