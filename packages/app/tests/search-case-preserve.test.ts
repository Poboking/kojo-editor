import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compileReplaceMatcher,
  expandReplacement,
  planLineEdit,
  planSingleReplacement,
  preserveReplacementCase,
} from '../src/ui/search-replace';
import {
  CASE_PRESERVE_DEFAULT,
  loadCasePreservePref,
  saveCasePreservePref,
} from '../src/ui/search-query';

/**
 * 「替换保留大小写」单测（P2-15 体验差距批）。
 *
 * 钉的是四件事（对应 BOARD 判据的四种形态）：
 * ①全小写替换词遇全大写命中 ⇒ 全大写（`FOO` + `bar` ⇒ `BAR`）；
 * ②首字母大写命中 ⇒ 首字母大写（`Foo` + `bar` ⇒ `Bar`）；
 * ③混合大小写命中 ⇒ 逐位形态映射（`fOo` + `bar` ⇒ `bAr`）；
 * ④形态映射不了 ⇒ 回落替换词原文（替换词更长 / 命中无可辨形态 / 替换词自带大写），
 *   理由写在 `search-replace.ts` 的 `preserveReplacementCase` 注释里（不静默）。
 * 另钉长度口径（短于照常映射、长于整条回落）与偏好存取（默认开、localStorage）。
 */

const m = (q: string) =>
  compileReplaceMatcher(q, { isRegex: false, caseSensitive: false, wholeWord: false })!;

const hitOf = (whole: string) => ({ whole, groups: [] as string[] });
const on = { preserveCase: true } as const;

describe('保留大小写 · 四种形态', () => {
  it('形态 1：全小写替换词遇全大写命中 ⇒ 全大写（FOO + bar ⇒ BAR）', () => {
    expect(expandReplacement('bar', hitOf('FOO'), on)).toBe('BAR');
  });

  it('形态 2：首字母大写命中 ⇒ 首字母大写（Foo + bar ⇒ Bar）', () => {
    expect(expandReplacement('bar', hitOf('Foo'), on)).toBe('Bar');
  });

  it('形态 3：混合大小写命中 ⇒ 逐位映射（fOo + bar ⇒ bAr）', () => {
    expect(expandReplacement('bar', hitOf('fOo'), on)).toBe('bAr');
  });

  it('形态 4a：替换词长于命中 ⇒ 回落替换词原文（形态宽度不够，不半截映射）', () => {
    expect(expandReplacement('barbar', hitOf('fOo'), on)).toBe('barbar');
  });

  it('形态 4b：命中无可辨形态（纯符号/数字）⇒ 回落替换词原文', () => {
    expect(expandReplacement('bar', hitOf('123'), on)).toBe('bar');
    expect(expandReplacement('bar', hitOf('---'), on)).toBe('bar');
  });

  it('形态 4c：替换词自带大写 ⇒ 显式意图，原样尊重（foo + BAR ⇒ BAR）', () => {
    expect(expandReplacement('BAR', hitOf('foo'), on)).toBe('BAR');
    expect(expandReplacement('Bar', hitOf('FOO'), on)).toBe('Bar');
  });
});

describe('保留大小写 · 长度与边角', () => {
  it('替换词短于命中照常映射（超出的命中位反正被换掉）', () => {
    expect(expandReplacement('ba', hitOf('FOO'), on)).toBe('BA');
    expect(expandReplacement('baz', hitOf('fOoBar'), on)).toBe('bAz');
  });

  it('混合形态里命中非大小写字符位保留替换词自身形态', () => {
    // 逐位映射按**码点下标**对齐：命中第 2 位是 `-`（无形态）⇒ 替换词那一位原样站桩
    expect(expandReplacement('b-a', hitOf('f-O'), on)).toBe('b-A');
  });

  it('CJK 命中（无大小开形态）⇒ 原样，不把替换词硬掰成大写', () => {
    expect(expandReplacement('bar', hitOf('恋慕'), on)).toBe('bar');
    expect(expandReplacement('防御', hitOf('ATTACK'), on)).toBe('防御');
  });

  it('空替换词（删除命中）⇒ 空串，不抛', () => {
    expect(expandReplacement('', hitOf('FOO'), on)).toBe('');
  });

  it('开关缺省 = 关（老调用方零改动，行为逐字不变）', () => {
    expect(expandReplacement('bar', hitOf('FOO'))).toBe('bar');
    expect(expandReplacement('bar', hitOf('fOo'), { preserveCase: false })).toBe('bar');
  });

  it('$& 模板 + 保留大小写 = 恒等（展开结果就是命中本身）', () => {
    expect(expandReplacement('$&', hitOf('FOO'), on)).toBe('FOO');
  });

  it('pure helper 与 expandReplacement 同判据', () => {
    expect(preserveReplacementCase('FOO', 'bar')).toBe('BAR');
    expect(preserveReplacementCase('Foo', 'bar')).toBe('Bar');
    expect(preserveReplacementCase('fOo', 'bar')).toBe('bAr');
    expect(preserveReplacementCase('fOo', 'barbar')).toBe('barbar');
  });
});

describe('保留大小写 · 透传到计划层', () => {
  it('planLineEdit：一行内多处各自按命中形态映射', () => {
    const edits = planLineEdit('CALL FOO then Foo then fOo', m('foo'), 'bar', on);
    expect(edits.map((e) => e.text)).toEqual(['BAR', 'Bar', 'bAr']);
  });

  it('planLineEdit：不开开关时原样（与历史行为逐字一致）', () => {
    const edits = planLineEdit('CALL FOO then Foo', m('foo'), 'bar');
    expect(edits.map((e) => e.text)).toEqual(['bar', 'bar']);
  });

  it('planSingleReplacement：单条替换也借形态（ATTACK + 防御 ⇒ 防御，CJK 无形态可借）', () => {
    const v = planSingleReplacement('CALL ATTACK', 5, m('attack'), '防御', 'ATTACK', on);
    expect(v).toEqual({ kind: 'replace', start: 5, end: 11, text: '防御' });
    const v2 = planSingleReplacement('CALL FOO', 5, m('foo'), 'bar', 'FOO', on);
    expect(v2).toMatchObject({ kind: 'replace', text: 'BAR' });
  });
});

/* ------------------------------ 偏好存取（localStorage） ------------------------------ */

const KEY = 'kojo.ui.search.preserveReplaceCase.v1';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

function stubWindow(storage: Storage | undefined): void {
  vi.stubGlobal('window', storage === undefined ? {} : { localStorage: storage });
}

afterEach(() => vi.unstubAllGlobals());

describe('保留大小写偏好 · 默认开（与常见编辑器一致）', () => {
  it('缺省是开', () => {
    expect(CASE_PRESERVE_DEFAULT).toBe(true);
  });

  it('没 window / 没 localStorage / 键不存在 ⇒ 都是开（不抛）', () => {
    stubWindow(undefined);
    expect(loadCasePreservePref()).toBe(true);
    stubWindow(fakeStorage());
    expect(loadCasePreservePref()).toBe(true);
  });

  it('只有明确存过 "off" 才算关；别的值（含 "true"/空串/脏值）按默认开', () => {
    for (const v of ['true', '1', '', 'on', 'off-off']) {
      stubWindow(fakeStorage({ [KEY]: v }));
      expect(loadCasePreservePref(), `值=${JSON.stringify(v)}`).toBe(true);
    }
    stubWindow(fakeStorage({ [KEY]: 'off' }));
    expect(loadCasePreservePref()).toBe(false);
  });

  it('存开 = 移除键（回到"从未设过"态，与 format-pref 的 on/off 存取同款）', () => {
    stubWindow(fakeStorage({ [KEY]: 'off' }));
    saveCasePreservePref(true);
    expect(loadCasePreservePref()).toBe(true);
    saveCasePreservePref(false);
    expect(loadCasePreservePref()).toBe(false);
  });

  it('getItem 抛错（隐私模式）⇒ 回默认，不抛', () => {
    const s = fakeStorage();
    s.getItem = () => {
      throw new Error('boom');
    };
    stubWindow(s);
    expect(loadCasePreservePref()).toBe(true);
  });
});
