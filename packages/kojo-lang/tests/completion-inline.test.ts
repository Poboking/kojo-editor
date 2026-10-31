/**
 * LAU-KOJO2-INLINE（2026-10-31）· 2.0 **行内续写判据**（`kojo2InlineCompletionAt`）行为闸。
 *
 * 这一枚文件钉的是**一件事**：幽灵文本的候选与位置门与弹窗补全是**同一把尺子**
 * （`kojo2CompletionAt`），本层只往上加"几乎唯一才给"与"窗口切片时源文名录不算数"两条。
 * 所以文件里既有直接断言（唯一 / 歧义 / 退让），也有一条**对拍用例**：把同一份 query
 * 分别喂给两枚函数，结论必须由 `kojo2CompletionAt` 的候选条数决定——判据一旦分叉，
 * 那条当场红。
 *
 * 覆盖面（与派工单口径逐条对上）：
 * - 唯一命中 ⇒ `unique` + 列区间（1 基 / 尾列半开）；
 * - 名录多条 ⇒ `ambiguous`；空行行首的五锚点 ⇒ `ambiguous`；
 * - 已写完那一格 ⇒ `none`（幽灵文本要替换的就是它自己，弹出来只是噪声）；
 * - 抑制面：注释 / 台词与旁白正文 / 串内 / `@原生` 围栏 ⇒ `none`（**不另写判据**，
 *   退让发生在 `kojo2CompletionAt` 里）；
 * - 窗口切片 + 源文证明的那两档（`declaration` / `templateParam`）⇒ 一律 `ambiguous`
 *   （窗外可能还有同名声明，窗内数出来的"只剩一条"是假唯一）。
 */
import { describe, expect, it } from 'vitest';
import {
  kojo2CompletionAt,
  kojo2InlineCompletionAt,
  type Kojo2InlineResult,
} from '../src/completion';
import { KOJO_DECL_WORDS } from '@kojo/kojo-core';

/** 把 `|` 当光标标记：摘掉标记，换成 1 基行列（与 `completion.test.ts` 同一份夹具口径）。 */
function queryAt(text: string): { source: string; line: number; column: number } {
  const at = text.indexOf('|');
  if (at < 0) throw new Error('夹具里没有光标标记');
  const source = text.slice(0, at) + text.slice(at + 1);
  const before = source.slice(0, at);
  const lastBreak = before.lastIndexOf('\n');
  return { source, line: before.split('\n').length, column: at - lastBreak };
}

/** 整篇源文（幽灵文本那条腿默认拿不到整篇，测试里显式给 true 才允许源文证明的档上屏）。 */
const WHOLE = { wholeDocument: true };

const stateOf = (result: Kojo2InlineResult): string => result.state;

describe('唯一命中才给', () => {
  it('`# 视|` ⇒ 声明词表里只剩「视角」一条 ⇒ unique，且列区间覆盖已打的那一枚字', () => {
    const query = queryAt('# 视|');
    const result = kojo2InlineCompletionAt(query, {}, WHOLE);
    expect(result.state).toBe('unique');
    if (result.state !== 'unique') return;
    expect(result.candidate.label).toBe('视角');
    expect(result.candidate.kind).toBe('declarationWord');
    // 「视」在第 3 列（1 基），尾列半开 ⇒ 4：接受键把「视」整枚换成「视角」，不拼出「视视角」
    expect(result.startColumn).toBe(3);
    expect(result.endColumn).toBe(4);
  });

  it('`# |` ⇒ 完整声明词表（去重后仍多条）⇒ ambiguous（给哪一条都没有依据）', () => {
    const deduped = new Set(KOJO_DECL_WORDS);
    expect(deduped.size).toBeGreaterThan(1);
    const result = kojo2InlineCompletionAt(queryAt('# |'), {}, WHOLE);
    expect(stateOf(result)).toBe('ambiguous');
    if (result.state === 'ambiguous') expect(result.count).toBe(deduped.size);
  });

  it('空行行首 ⇒ 五锚点 ⇒ ambiguous（锚点是"作者自己挑"的那一族，不替他按）', () => {
    const result = kojo2InlineCompletionAt(queryAt('|'), {}, WHOLE);
    expect(stateOf(result)).toBe('ambiguous');
  });

  it('名字已写完 ⇒ none：那一条候选与光标处那枚名字段逐字相同', () => {
    const result = kojo2InlineCompletionAt(queryAt('# 视角|'), {}, WHOLE);
    expect(stateOf(result)).toBe('none');
  });
});

describe('抑制面：与弹窗同一把尺子（本层一格判据都不重写）', () => {
  it.each([
    ['注释行', '// 这里想说|'],
    ['旁白正文', '> 今天天气不|'],
    ['串内', '? 心意 == "很|'],
    ['@原生 围栏体内', '@原生\n    CALL HPH_PRINT "w|'],
    ['裸台词（缩进正文）', '# 幕 开场\n    你今天来得真早|'],
  ])('%s ⇒ kojo2CompletionAt 交回空候选 ⇒ inline 也答 none', (_label, text) => {
    const query = queryAt(text);
    expect(kojo2CompletionAt(query)).toEqual([]);
    expect(stateOf(kojo2InlineCompletionAt(query, {}, WHOLE))).toBe('none');
  });
});

describe('窗口切片：源文证明的名录不算数', () => {
  const FULL = '# 池 甲雨\n# 池 甲雪\n! 甲|';
  /** 只剩后两行的窗口（上一条 `# 池` 声明在窗外）——窗内数出来"只剩一条" */
  const SLICE = '# 池 甲雪\n! 甲|';

  it('整篇时「甲」有两池候选 ⇒ ambiguous', () => {
    expect(kojo2CompletionAt(queryAt(FULL)).length).toBe(2);
    expect(stateOf(kojo2InlineCompletionAt(queryAt(FULL), {}, WHOLE))).toBe('ambiguous');
  });

  it('切片里只剩一条 ⇒ 仍**不许**当唯一：判成 ambiguous（宁可漏报不可错报）', () => {
    const query = queryAt(SLICE);
    const candidates = kojo2CompletionAt(query);
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.kind).toBe('declaration');
    expect(stateOf(kojo2InlineCompletionAt(query, {}, {}))).toBe('ambiguous');
    // 同一份切片显式声明"这就是整篇"⇒ 才允许上屏（缺省方向是保守的 false）
    expect(stateOf(kojo2InlineCompletionAt(query, {}, WHOLE))).toBe('unique');
  });

  it('切片不影响"闭表那一族"：声明词位照样唯一（名录不住源文里）', () => {
    expect(stateOf(kojo2InlineCompletionAt(queryAt('# 视|'), {}, {}))).toBe('unique');
  });
});

describe('与 kojo2CompletionAt 逐字同源（判据只有一把）', () => {
  it.each(['# |', '# 视|', '# 机 |', '> 台词|', '|', '? 心意 == "很|'])(
    '同一份 query %s：结论由候选条数决定，不多不少',
    (text) => {
      const query = queryAt(text);
      const ruler = kojo2CompletionAt(query);
      const expected =
        ruler.length === 0 ? 'none' : ruler.length === 1 ? 'unique' : 'ambiguous';
      expect(stateOf(kojo2InlineCompletionAt(query, {}, WHOLE))).toBe(expected);
    },
  );
});
