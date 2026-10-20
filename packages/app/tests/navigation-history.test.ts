/**
 * MM-6 / MM-10 · 导航历史纯逻辑单测：前进/后退（去重 / 前进分支截断 / 边界不改态）、
 * 恢复关闭的标签（批量压入顺序 / 上限淘汰 / 空栈拒绝）、跨项目清空、列/区间随条目往返
 * （NAV-1：回跳落到原列而不是行首）。
 * 零 React、零 Monaco——App 是唯一状态所有者，这里的每条纯函数就是它写入历史的唯一通道。
 */

import { describe, expect, it } from 'vitest';
import {
  CLOSED_TABS_LIMIT,
  clearNav,
  createNavState,
  navBack,
  navEntrySpan,
  navForward,
  popClosed,
  pushClosed,
  pushNav,
  type NavEntry,
  type NavState,
} from '../src/ui/navigation-history';

const at = (path: string, line = 1): NavEntry => ({ path, line });
/** 带列/区间的条目：缺席的键不落进对象（既有 toEqual 断言逐字不受影响） */
const pos = (path: string, line: number, column?: number, endColumn?: number): NavEntry => ({
  path,
  line,
  ...(column !== undefined ? { column } : {}),
  ...(endColumn !== undefined ? { endColumn } : {}),
});
const paths = (s: NavState): string => s.stack.map((e) => `${e.path}:${e.line}`).join(' ');

/** 连着 push 一串条目（同 project 根；返回终态） */
function pushAll(s: NavState, entries: readonly NavEntry[], root: string | null = null): NavState {
  return entries.reduce((acc, e) => pushNav(acc, e, root), s);
}

describe('导航历史 · 入栈', () => {
  it('初始态 = 两块空栈、光标 -1、无项目', () => {
    const s = createNavState();
    expect(s.stack).toEqual([]);
    expect(s.cursor).toBe(-1);
    expect(s.closed).toEqual([]);
    expect(s.rootDir).toBeNull();
  });

  it('依次入栈：栈按时间正序，光标恒指栈尾', () => {
    const s = pushAll(createNavState(), [at('a.erb'), at('b.erb'), at('c.erb', 12)]);
    expect(paths(s)).toBe('a.erb:1 b.erb:1 c.erb:12');
    expect(s.cursor).toBe(2);
  });

  it('同 path 同 line 不重复入栈：连打两次同一定位，栈不涨、光标不动', () => {
    let s = pushAll(createNavState(), [at('a.erb'), at('b.erb', 7)]);
    const before = s;
    s = pushNav(s, at('b.erb', 7), null);
    expect(s).toBe(before); // 同引用：命中当前光标处 ⇒ 纯 no-op
    expect(s.stack).toHaveLength(2);
    expect(s.cursor).toBe(1);
  });

  it('同 path 不同 line 算不同位置（问题面板里同文件的两行是两个家）', () => {
    let s = pushAll(createNavState(), [at('a.erb'), at('b.erb', 3)]);
    s = pushNav(s, at('b.erb', 9), null);
    expect(paths(s)).toBe('a.erb:1 b.erb:3 b.erb:9');
    expect(s.cursor).toBe(2);
  });

  it('重复到访时间线里的旧位置：只挪光标回去，栈不涨（同一位置至多出现一次）', () => {
    let s = pushAll(createNavState(), [at('a.erb'), at('b.erb'), at('c.erb')]);
    s = pushNav(s, at('a.erb'), null); // 从文件树重新点到 a
    expect(paths(s)).toBe('a.erb:1 b.erb:1 c.erb:1'); // 没有第二个 a
    expect(s.cursor).toBe(0);
    // 光标在 a 处，前进分支（b、c）仍在——重复到访不是「跳到新位置」
    const fwd = navForward(s);
    expect(fwd.entry).toEqual(at('b.erb'));
  });
});

describe('导航历史 · 前进分支截断（VSCode 语义）', () => {
  it('back 到中段后 push 新位置：光标之后的「前进」分支整段作废', () => {
    let s = pushAll(createNavState(), [at('a.erb'), at('b.erb'), at('c.erb')]);
    s = navBack(s).state; // 光标 1（b）
    s = navBack(s).state; // 光标 0（a）
    expect(navForward(s).entry).toEqual(at('b.erb')); // 此刻前进还够得着 b
    s = pushNav(s, at('d.erb'), null); // 从 a 跳到新位置 d
    expect(paths(s)).toBe('a.erb:1 d.erb:1'); // b、c 被截断
    expect(s.cursor).toBe(1);
    expect(navForward(s).entry).toBeNull(); // 前进到顶
  });

  it('在栈尾 push 新位置：栈只追加，无截断', () => {
    let s = pushAll(createNavState(), [at('a.erb'), at('b.erb')]);
    s = pushNav(s, at('c.erb'), null);
    expect(paths(s)).toBe('a.erb:1 b.erb:1 c.erb:1');
    expect(s.cursor).toBe(2);
  });
});

describe('导航历史 · 前进/后退与边界（不静默的底气）', () => {
  it('back 逐个回退到最早，再 back ⇒ 原 state + null（不改态）', () => {
    let s = pushAll(createNavState(), [at('a.erb'), at('b.erb'), at('c.erb')]);
    const b1 = navBack(s);
    expect(b1.entry).toEqual(at('b.erb'));
    expect(b1.state.cursor).toBe(1);
    s = b1.state;
    const b2 = navBack(s);
    expect(b2.entry).toEqual(at('a.erb'));
    s = b2.state;
    const b3 = navBack(s); // 已在最早
    expect(b3.entry).toBeNull();
    expect(b3.state).toBe(s); // 同一引用：边界不改 state
    expect(s.cursor).toBe(0);
  });

  it('forward 逐个前进到最新，再 forward ⇒ 原 state + null（不改态）', () => {
    let s = pushAll(createNavState(), [at('a.erb'), at('b.erb'), at('c.erb')]);
    s = navBack(s).state; // b
    s = navBack(s).state; // a
    const f1 = navForward(s);
    expect(f1.entry).toEqual(at('b.erb'));
    s = f1.state;
    const f2 = navForward(s);
    expect(f2.entry).toEqual(at('c.erb'));
    s = f2.state;
    const f3 = navForward(s); // 已在最新
    expect(f3.entry).toBeNull();
    expect(f3.state).toBe(s);
  });

  it('空栈上 back / forward 都 ⇒ 原 state + null', () => {
    const s = createNavState();
    expect(navBack(s)).toEqual({ state: s, entry: null });
    expect(navForward(s)).toEqual({ state: s, entry: null });
  });

  it('back 落地后同拍 pushNav（App 的 commitOpenFile 同款）：历史不涨、光标不漂', () => {
    let s = pushAll(createNavState(), [at('a.erb'), at('b.erb'), at('c.erb')]);
    const back = navBack(s); // 目标 b
    s = pushNav(back.state, back.entry!, null); // commitOpenFile(b) 同拍再入栈
    expect(paths(s)).toBe('a.erb:1 b.erb:1 c.erb:1');
    expect(s.cursor).toBe(1);
    const fwd = navForward(s); // 从 b 还能前进回 c
    expect(fwd.entry).toEqual(at('c.erb'));
  });
});

describe('导航历史 · 列/区间（NAV-1：回跳落回原列，不是行首）', () => {
  it('入栈保列：从 (path,12,7) 出发、导航到别处，back 回到 (path,12,7) 而不是 (path,12,1)', () => {
    const s = pushAll(createNavState(), [pos('a.erb', 12, 7), pos('b.erb', 3, 2)]);
    const back = navBack(s);
    expect(back.entry).toEqual(pos('a.erb', 12, 7));
    expect(back.entry!.column).toBe(7); // 不是行首 1
  });

  it('入栈保区间：endColumn 随条目往返（back 拿回原区间，forward 也不丢）', () => {
    const s = pushAll(createNavState(), [pos('a.erb', 12, 7, 11), pos('b.erb', 3)]);
    const back = navBack(s);
    expect(back.entry).toEqual(pos('a.erb', 12, 7, 11));
    const fwd = navForward(back.state);
    expect(fwd.entry).toEqual(pos('b.erb', 3));
  });

  it('去重仍按 path+line：同行的列不同不重复入栈，首条条目的列改写不掉（既有语义）', () => {
    let s = pushNav(createNavState(), pos('a.erb', 12, 7), null);
    s = pushNav(s, pos('a.erb', 12, 20), null); // 同一行、不同列 ⇒ 同一个位置
    expect(s.stack).toHaveLength(1);
    expect(s.stack[0]).toEqual(pos('a.erb', 12, 7)); // 首次到访的列胜出
    // 光标在别处时命中同 path+line：只挪光标，条目原样（列不改写）
    s = pushNav(s, pos('b.erb', 1), null);
    s = pushNav(s, pos('a.erb', 12, 20), null);
    expect(s.stack).toHaveLength(2);
    expect(s.cursor).toBe(0);
    expect(s.stack[0]).toEqual(pos('a.erb', 12, 7));
  });

  it('没给列的旧条目原样保留：不凭空补列（退化口径逐字不变）', () => {
    const s = pushAll(createNavState(), [at('a.erb', 12), at('b.erb', 3)]);
    const back = navBack(s);
    expect(back.entry).toEqual(at('a.erb', 12));
    expect(back.entry!.column).toBeUndefined();
  });

  it('back 落地同拍 pushNav（App 的 commitOpenFile 同款）带列/区间：历史不涨、列不丢', () => {
    let s = pushAll(createNavState(), [pos('a.erb', 12, 7, 11), pos('b.erb', 3, 2)]);
    const back = navBack(s);
    s = pushNav(back.state, back.entry!, null);
    expect(s.stack).toHaveLength(2);
    expect(s.cursor).toBe(0);
    expect(s.stack[0]).toEqual(pos('a.erb', 12, 7, 11)); // 区间还在
  });
});

describe('导航历史 · 条目 → 打开路径的 span（navEntrySpan）', () => {
  it('真给了宽度才升级成区间（与两条 editor opener 同一判据）', () => {
    expect(navEntrySpan(pos('a.erb', 12, 7, 11))).toEqual({ columnStart: 7, columnEnd: 11 });
  });

  it('只有列 / 零宽 / 没列 / 反向区间 ⇒ undefined（由 reveal-position 统一退化，不在这里猜）', () => {
    expect(navEntrySpan(pos('a.erb', 12, 7))).toBeUndefined();
    expect(navEntrySpan(pos('a.erb', 12, 7, 7))).toBeUndefined();
    expect(navEntrySpan(at('a.erb', 12))).toBeUndefined();
    expect(navEntrySpan(pos('a.erb', 12, 9, 3))).toBeUndefined();
  });
});

describe('导航历史 · 跨项目清空（导航/恢复栈不跨项目）', () => {
  it('rootDir 从 null 变出（开第一个项目）：null 期也记，但项目一出现即整段作废', () => {
    let s = pushNav(createNavState(), at('a.erb'), null); // 无项目期：照记不跳过
    expect(paths(s)).toBe('a.erb:1'); // 记是记了（没项目时也能导航）
    s = pushNav(s, at('b.erb'), 'D:/proj'); // null ≠ 'D:/proj' ⇒ 先清后入
    expect(paths(s)).toBe('b.erb:1');
    expect(s.rootDir).toBe('D:/proj');
  });

  it('rootDir 换项目：push 前先整栈作废，再入新条目', () => {
    let s = pushAll(createNavState(), [at('a.erb'), at('b.erb')], 'D:/projA');
    s = navBack(s).state; // 光标 0，前进分支还挂着 b
    s = pushNav(s, at('x.erb'), 'D:/projB'); // 切项目后的第一次跳转
    expect(paths(s)).toBe('x.erb:1'); // A 项目的整段历史（含前进分支）没了
    expect(s.cursor).toBe(0);
    expect(s.rootDir).toBe('D:/projB');
    expect(navBack(s).entry).toBeNull();
    expect(navForward(s).entry).toBeNull();
  });

  it('恢复栈同样不跨项目：换 rootDir 后只认新项目的关闭记录', () => {
    let s = pushClosed(createNavState(), ['a.erb'], 'D:/projA');
    s = pushClosed(s, ['b.erb'], 'D:/projB');
    expect(s.closed).toEqual(['b.erb']); // A 项目压入的被作废
    expect(s.rootDir).toBe('D:/projB');
    const first = popClosed(s);
    expect(first.path).toBe('b.erb');
    expect(popClosed(first.state).path).toBeNull();
  });

  it('同 rootDir 连续操作：不触发清空，历史延续', () => {
    let s = pushAll(createNavState(), [at('a.erb')], 'D:/proj');
    s = pushNav(s, at('b.erb'), 'D:/proj');
    expect(paths(s)).toBe('a.erb:1 b.erb:1');
  });
});

describe('恢复关闭的标签 · 压入与弹出', () => {
  it('单张压入 + 弹出：后进先出', () => {
    let s = pushClosed(createNavState(), ['a.erb'], null);
    s = pushClosed(s, ['b.erb'], null);
    expect(s.closed).toEqual(['b.erb', 'a.erb']); // closed[0] = 最近关闭
    expect(popClosed(s).path).toBe('b.erb');
  });

  it('批量压入按给定顺序整体压入（批次内后关的在栈顶，先恢复）', () => {
    let s = pushClosed(createNavState(), ['old.erb'], null);
    s = pushClosed(s, ['b.erb', 'c.erb', 'd.erb'], null); // 一次关三张，给定顺序 b→c→d
    expect(s.closed).toEqual(['d.erb', 'c.erb', 'b.erb', 'old.erb']);
    const p1 = popClosed(s);
    expect(p1.path).toBe('d.erb'); // 批次里最后关的最先恢复
    expect(popClosed(p1.state).path).toBe('c.erb');
  });

  it('空批次 ⇒ 原样返回（同引用）', () => {
    const s = pushClosed(createNavState(), ['a.erb'], null);
    expect(pushClosed(s, [], null)).toBe(s);
  });

  it('空栈弹出 ⇒ 原 state + null（App 据此发「没有可恢复的标签」）', () => {
    const s = createNavState();
    expect(popClosed(s)).toEqual({ state: s, path: null });
  });

  it('上限淘汰：超过 CLOSED_TABS_LIMIT 丢最旧的，保留最近的', () => {
    const many = Array.from({ length: CLOSED_TABS_LIMIT + 5 }, (_, i) => `f${i}.erb`);
    const s = pushClosed(createNavState(), many, null);
    expect(s.closed).toHaveLength(CLOSED_TABS_LIMIT);
    // 批次内后压的在栈顶 ⇒ f24 最亮，f0…f4 被丢
    expect(s.closed[0]).toBe(`f${CLOSED_TABS_LIMIT + 4}.erb`);
    expect(s.closed[CLOSED_TABS_LIMIT - 1]).toBe('f5.erb');
    expect(s.closed).not.toContain('f0.erb');
  });

  it('分批压入也守上限：老的持续被挤掉', () => {
    let s = createNavState();
    for (let i = 0; i < CLOSED_TABS_LIMIT + 3; i++) s = pushClosed(s, [`f${i}.erb`], null);
    expect(s.closed).toHaveLength(CLOSED_TABS_LIMIT);
    expect(s.closed[0]).toBe(`f${CLOSED_TABS_LIMIT + 2}.erb`); // 最近关闭
    expect(s.closed[CLOSED_TABS_LIMIT - 1]).toBe('f3.erb'); // 最旧的幸存者
    expect(s.closed).not.toContain('f2.erb'); // 被淘汰
  });

  it('弹到空：逐张恢复后回到空栈', () => {
    let s = pushClosed(createNavState(), ['a.erb', 'b.erb'], null);
    s = popClosed(s).state;
    s = popClosed(s).state;
    expect(s.closed).toEqual([]);
    expect(popClosed(s).path).toBeNull();
  });
});

describe('导航历史 · clearNav', () => {
  it('两块栈连同光标一起作废；rootDir 不动', () => {
    let s = pushAll(createNavState(), [at('a.erb'), at('b.erb')], 'D:/proj');
    s = navBack(s).state;
    s = pushClosed(s, ['c.erb'], 'D:/proj');
    s = clearNav(s);
    expect(s.stack).toEqual([]);
    expect(s.cursor).toBe(-1);
    expect(s.closed).toEqual([]);
    expect(s.rootDir).toBe('D:/proj');
    expect(navBack(s).entry).toBeNull();
    expect(navForward(s).entry).toBeNull();
    expect(popClosed(s).path).toBeNull();
  });

  it('本来就空 ⇒ 原样返回（同引用）', () => {
    const s = createNavState();
    expect(clearNav(s)).toBe(s);
  });
});
