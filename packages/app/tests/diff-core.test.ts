import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearDiff,
  closeDiffPane,
  diffPaneKeyOf,
  focusDiffPane,
  getDiffPanes,
  getDiffState,
  pushDiff,
  setDiffState,
  subscribeDiff,
  topDiffPane,
  type DiffRequest,
  type DiffViewState,
} from '../src/ui/diff-core';

/**
 * 比对栈（W10 第 2 点：单例改栈）。
 *
 * 钉四件：①多开互不覆盖（两格并存，各自内容原样）；②关掉正确的一个不弄乱其余
 * （含"关栈顶回到上一格"与"关中间那格"）；③同内容重开只置顶不复制；
 * ④旧单格写口 `setDiffState` 仍可读写（null 收摊 = 清栈）。
 */

const req = (title: string, leftText: string, rightText: string): DiffRequest => ({
  title,
  original: { label: `L·${title}`, text: leftText },
  modified: { label: `R·${title}`, text: rightText },
});

const state = (request: DiffRequest): DiffViewState => ({
  kind: 'request',
  key: diffPaneKeyOf(request),
  request,
});

const titles = (): string[] => getDiffPanes().map((p) => (p.state.kind === 'request' ? p.state.request.title : '（无法对比）'));

afterEach(() => clearDiff());

describe('diffPaneKeyOf：格子身份由内容派生', () => {
  it('同一对内容 ⇒ 同一个 key（路径大小写不敏感，与 Windows 落点同口径）', () => {
    const a = { title: 'T', original: { label: 'l', path: 'C:/Game/A.ERB' }, modified: { label: 'm', path: 'c:/game/a.erb' } };
    const b = { title: 'T', original: { label: 'l', path: 'C:/GAME/a.erb' }, modified: { label: 'm', path: 'C:/game/A.ERB' } };
    expect(diffPaneKeyOf(a)).toBe(diffPaneKeyOf(b));
  });

  it('同名但内联文本不同 ⇒ 不同 key（不许把两份不同比对并成一格）', () => {
    expect(diffPaneKeyOf(req('同一标题', 'a', 'b'))).not.toBe(diffPaneKeyOf(req('同一标题', 'a', 'c')));
  });

  it('标题不同 ⇒ 不同 key', () => {
    expect(diffPaneKeyOf(req('甲', 'a', 'b'))).not.toBe(diffPaneKeyOf(req('乙', 'a', 'b')));
  });
});

describe('比对栈：多开互不覆盖', () => {
  it('两格并存，栈顶是后开的那格；先开那格内容一字不改', () => {
    const first = state(req('第一组', 'a', 'b'));
    const second = state(req('第二组', 'c', 'd'));
    pushDiff(first);
    pushDiff(second);

    expect(getDiffPanes()).toHaveLength(2);
    expect(titles()).toEqual(['第一组', '第二组']);
    expect(getDiffState()).toMatchObject({ kind: 'request', key: second.key });
    expect(getDiffPanes()[0]!.state).toEqual(first);
    expect(topDiffPane()?.key).toBe(second.key);
  });

  it('三格并存时关掉中间那格，其余两格顺序与内容都不动', () => {
    const a = state(req('甲', '1', '2'));
    const b = state(req('乙', '3', '4'));
    const c = state(req('丙', '5', '6'));
    pushDiff(a);
    pushDiff(b);
    pushDiff(c);

    const emptied = closeDiffPane(b.key);
    expect(emptied).toBe(false); // 还有别的比对 ⇒ 不该收模态
    expect(titles()).toEqual(['甲', '丙']);
    expect(getDiffPanes()[0]!.state).toEqual(a);
    expect(getDiffPanes()[1]!.state).toEqual(c);
    expect(getDiffState()?.key).toBe(c.key);
  });

  it('关栈顶 ⇒ 回到上一格；再关到空栈才报"该收摊"', () => {
    const a = state(req('甲', '1', '2'));
    const b = state(req('乙', '3', '4'));
    pushDiff(a);
    pushDiff(b);

    expect(closeDiffPane()).toBe(false);
    expect(getDiffState()?.key).toBe(a.key);
    expect(closeDiffPane(a.key)).toBe(true);
    expect(getDiffState()).toBeNull();
    expect(topDiffPane()).toBeNull();
  });

  it('空栈上关一格不报错，只报"已空"', () => {
    expect(closeDiffPane('不存在')).toBe(true);
    expect(getDiffPanes()).toHaveLength(0);
  });

  it('同 key 重开：只替换那一格并置顶，不复制第二条比对', () => {
    const request = req('重复', 'old', 'x');
    pushDiff(state(request));
    pushDiff(state(req('另一组', 'p', 'q')));

    const reopened = state(req('重复', 'new', 'x'));
    expect(reopened.key).not.toBe(diffPaneKeyOf(request)); // 文本改了就是另一格（不许覆盖旧格读数）
    pushDiff(state(request)); // 完全同一对内容再开一次
    expect(titles()).toEqual(['另一组', '重复']);
    expect(getDiffPanes()).toHaveLength(2);

    pushDiff(reopened);
    expect(getDiffPanes()).toHaveLength(3);
    expect(getDiffState()?.key).toBe(reopened.key);
  });

  it('focusDiffPane 把指定格置顶（切回去看），未知 key 静默不动栈', () => {
    const a = state(req('甲', '1', '2'));
    const b = state(req('乙', '3', '4'));
    pushDiff(a);
    pushDiff(b);

    focusDiffPane(a.key);
    expect(titles()).toEqual(['乙', '甲']);
    focusDiffPane('不存在');
    expect(getDiffPanes()).toHaveLength(2);
  });
});

describe('订阅与旧写口', () => {
  it('栈变更（入栈/关格/清空/置顶）都通知订阅者；退订后不再被打扰', () => {
    const cb = vi.fn();
    const un = subscribeDiff(cb);
    const a = state(req('甲', '1', '2'));
    pushDiff(a);
    expect(cb).toHaveBeenCalledTimes(1);
    closeDiffPane(a.key);
    expect(cb).toHaveBeenCalledTimes(2);
    pushDiff(state(req('乙', '3', '4')));
    clearDiff();
    expect(cb).toHaveBeenCalledTimes(4);
    un();
    pushDiff(a);
    expect(cb).toHaveBeenCalledTimes(4);
    clearDiff();
  });

  it('setDiffState 旧写口：写入即栈顶可读回，传 null 收整条栈', () => {
    const request = req('旧口径', 'a', 'b');
    setDiffState({ kind: 'request', request });
    expect(getDiffState()).toMatchObject({ kind: 'request', key: diffPaneKeyOf(request) });
    expect(getDiffPanes()).toHaveLength(1);

    // 旧口径"后写者顶掉前者"在栈里 = 前者仍在，只是不是栈顶
    setDiffState({ kind: 'request', request: req('另一组', 'c', 'd') });
    expect(getDiffPanes()).toHaveLength(2);
    expect(getDiffState()).toMatchObject({ kind: 'request', key: diffPaneKeyOf(req('另一组', 'c', 'd')) });

    setDiffState(null);
    expect(getDiffState()).toBeNull();
    expect(getDiffPanes()).toHaveLength(0);
  });

  it('rejected 态也占一格（拒绝可见），并按原因分格', () => {
    pushDiff({ kind: 'rejected', key: 'rejected||左缺内容', reason: '左缺内容' });
    pushDiff({ kind: 'rejected', key: 'rejected||右缺内容', reason: '右缺内容' });
    expect(getDiffPanes()).toHaveLength(2);
    expect(getDiffState()).toMatchObject({ kind: 'rejected', reason: '右缺内容' });
    expect(closeDiffPane()).toBe(false);
    expect(getDiffState()).toMatchObject({ kind: 'rejected', reason: '左缺内容' });
  });
});
