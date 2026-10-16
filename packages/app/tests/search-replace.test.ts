import { describe, expect, it } from 'vitest';
import {
  applyLineEdits,
  compileReplaceMatcher,
  escapeRegExp,
  expandReplacement,
  planLineEdit,
  planLineMatches,
  planSingleReplacement,
} from '../src/ui/search-replace';

/**
 * 全文替换的纯逻辑单测（R7 搜索替换批）。
 *
 * 替换是**写盘操作**，判据必须钉死：①命中判定与检索开关（正则/大小写/全词）对齐，
 * 全词边界是 Unicode 口径（CJK 不许被 ASCII `\b` 静默漏掉）；②`$1`/`$&`/`$$` 展开
 * 不猜（越界组 = 空串、未知 `$x` = 原样）；③单条替换的陈旧防线——sticky 定列匹配
 * + 原文比对，验证不过一律拒绝；④同行多处编辑降序应用不位移。
 */

const m = (q: string, opts: { isRegex?: boolean; caseSensitive?: boolean; wholeWord?: boolean } = {}) =>
  compileReplaceMatcher(q, {
    isRegex: opts.isRegex ?? false,
    caseSensitive: opts.caseSensitive ?? false,
    wholeWord: opts.wholeWord ?? false,
  })!;

describe('compileReplaceMatcher', () => {
  it('空查询拒绝（空串匹配每一处 = 灾难）', () => {
    expect(compileReplaceMatcher('', { isRegex: false, caseSensitive: false, wholeWord: false })).toBeNull();
  });

  it('非正则模式按字面匹配（元字符转义）', () => {
    const mm = m('C$1(a)');
    expect(planLineMatches('x = C$1(a) + C$1(a)', mm)).toHaveLength(2);
  });

  it('大小写不敏感是缺省，caseSensitive 收紧', () => {
    expect(planLineMatches('CALL Foo', m('foo'))).toHaveLength(1);
    expect(planLineMatches('CALL Foo', m('foo', { caseSensitive: true }))).toHaveLength(0);
  });

  it('CJK 全词边界：贴着 CJK 的同字串不算全词（Unicode 口径，不是 ASCII \\b）', () => {
    const mm = m('恋慕', { wholeWord: true });
    expect(planLineMatches('TALENT:恋慕', mm)).toHaveLength(1);
    expect(planLineMatches('TALENT:恋慕深', mm)).toHaveLength(0);
    expect(planLineMatches('无自觉恋慕', mm)).toHaveLength(0);
  });

  it('正则模式：作者的正则原样进引擎', () => {
    const mm = m('LOCAL:(\\d+)', { isRegex: true });
    const hits = planLineMatches('A = LOCAL:2 + LOCAL:33', mm);
    expect(hits.map((h) => h.groups)).toEqual([['2'], ['33']]);
  });

  it('正则模式非法时抛错（由执行层明示，不静默吞）', () => {
    expect(() =>
      compileReplaceMatcher('a(', { isRegex: true, caseSensitive: false, wholeWord: false }),
    ).toThrow();
  });
});

describe('expandReplacement', () => {
  const hit = { whole: 'LOCAL:2', groups: ['2'] };
  it('$1 引用捕获组', () => {
    expect(expandReplacement('NUM:$1', hit)).toBe('NUM:2');
  });
  it('$& 引用整个命中', () => {
    expect(expandReplacement('[$&]', hit)).toBe('[LOCAL:2]');
  });
  it('$$ 转义为字面 $', () => {
    expect(expandReplacement('$$1', hit)).toBe('$1');
  });
  it('越界组 = 空串（不猜）', () => {
    expect(expandReplacement('$9', hit)).toBe('');
  });
  it('两位数组号优先：$12 是第 12 组，不存在则回落 $1 + 字面 2（与 JS String.replace 同语义）', () => {
    const many = { whole: 'x', groups: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'L'] };
    expect(expandReplacement('$12', many)).toBe('L');
    expect(expandReplacement('$12', hit)).toBe('22');
  });
  it('未知 $x 原样保留（不吞字符）', () => {
    expect(expandReplacement('$x$', hit)).toBe('$x$');
  });
});

describe('planSingleReplacement（陈旧坐标防线）', () => {
  it('定列命中：展开替换文本', () => {
    const v = planSingleReplacement('CALL ATTACK', 5, m('attack'), '防御', 'ATTACK');
    expect(v).toEqual({ kind: 'replace', start: 5, end: 11, text: '防御' });
  });

  it('文本已移走（坐标陈旧）→ 拒绝', () => {
    const v = planSingleReplacement('CALL DEFEND', 5, m('attack'), 'x', 'ATTACK');
    expect(v.kind).toBe('skip');
  });

  it('该处文本与检索结果不一致 → 拒绝（大小写不敏感比对，非正文差异不误伤）', () => {
    const v = planSingleReplacement('CALL ATTACK', 5, m('attack'), 'x', 'DEFEND');
    expect(v.kind).toBe('skip');
    const ok = planSingleReplacement('CALL aTTaCk', 5, m('attack'), 'x', 'ATTACK');
    expect(ok.kind).toBe('replace');
  });

  it('全词开关下命中处不再是全词 → 拒绝', () => {
    const v = planSingleReplacement('CALL ATTACKED', 5, m('attack', { wholeWord: true }), 'x', null);
    expect(v.kind).toBe('skip');
  });

  it('列号越界 → 拒绝', () => {
    expect(planSingleReplacement('abc', 99, m('a'), 'x', null).kind).toBe('skip');
  });
});

describe('planLineEdit / applyLineEdits', () => {
  it('一行内多处命中全部计划', () => {
    const edits = planLineEdit('a-b-a', m('a'), 'X');
    expect(edits).toEqual([
      { start: 0, end: 1, text: 'X' },
      { start: 4, end: 5, text: 'X' },
    ]);
  });

  it('降序应用不位移（同文件同行的替换串以原偏移落地）', () => {
    expect(applyLineEdits(['a-b-a'], [{ lineNumber: 1, start: 0, end: 1, text: 'X' }, { lineNumber: 1, start: 4, end: 5, text: 'Y' }])).toBe('X-b-Y');
  });

  it('跨行编辑各归各行，换行结构保持', () => {
    const out = applyLineEdits(
      ['LOCAL:2', 'LOCAL:33'],
      [
        { lineNumber: 1, start: 0, end: 8, text: 'ARG:2' },
        { lineNumber: 2, start: 0, end: 9, text: 'ARG:33' },
      ],
    );
    expect(out).toBe('ARG:2\nARG:33');
  });
});

describe('escapeRegExp', () => {
  it('元字符全部转义', () => {
    expect(escapeRegExp('a.b*c?d^')).toBe('a\\.b\\*c\\?d\\^');
  });
});
