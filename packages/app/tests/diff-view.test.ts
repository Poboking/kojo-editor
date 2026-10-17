import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KernelEventMap } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  bindDiffView,
  clearDiff,
  DIFF_VIEW_OVERLAY_ID,
  diffPaneKeyOf,
  getDiffPanes,
  getDiffState,
  languageIdForSide,
  setDiffState,
  subscribeDiff,
  validateDiffRequest,
  closeDiffPane,
  type DiffRequest,
} from '../src/ui/diff-view';

/**
 * 通用 diff 视图的宿主纯逻辑（2026-10-15 比对/历史批；W10 第 2 点改多开栈）。
 *
 * 判钉四件：无效请求的拒绝原因（不静默）、语言推断的保守口径（不许猜错高亮）、
 * 意图事件 → **入栈一格** + overlay 打开的落地时序、多开时后开者不顶掉前开者。
 * 渲染本体（Monaco diff 编辑器）在浏览器 effect 里动态 import，node 环境不触达。
 */

const req = (over: Partial<DiffRequest> = {}): DiffRequest => ({
  title: 't',
  original: { label: 'a', text: 'x' },
  modified: { label: 'b', text: 'y' },
  ...over,
});

describe('validateDiffRequest', () => {
  it('两侧都有内容 → 放行', () => {
    expect(validateDiffRequest(req())).toBeNull();
    expect(validateDiffRequest(req({ original: { label: 'a', path: 'C:/x/y.ERB' } }))).toBeNull();
  });

  it('一侧既无 text 又无 path → 拒绝并指认是哪一侧', () => {
    expect(validateDiffRequest(req({ original: { label: 'a' } }))).toContain('左');
    expect(validateDiffRequest(req({ modified: { label: 'b', path: '' } }))).toContain('右');
  });

  it('text 为空串仍算有内容（"一侧不存在"的对比正需要空侧）', () => {
    expect(validateDiffRequest(req({ modified: { label: 'b', text: '' } }))).toBeNull();
  });
});

describe('languageIdForSide', () => {
  it('.kojo → 语法糖语言；路径优先于标签', () => {
    expect(languageIdForSide({ label: 'x.ERB', path: 'C:/p/事件.kojo' })).toBe(KOJO_LANGUAGE_ID);
  });
  it('.ERB/.erh → ERB 语言（大小写不敏感）', () => {
    expect(languageIdForSide({ label: 'M_KOJO.ERB' })).toBe(ERB_LANGUAGE_ID);
    expect(languageIdForSide({ label: '库名.erh' })).toBe(ERB_LANGUAGE_ID);
  });
  it('认不出的一律 plaintext（高亮是锦上添花，不许猜错）', () => {
    expect(languageIdForSide({ label: '历史版本 2026-10-15', path: 'C:/appdata/backup/x.123.bak' })).toBe('plaintext');
    expect(languageIdForSide({ label: '读不出的路径' })).toBe('plaintext');
  });
});

describe('比对状态（经 diff-view 的导出面）', () => {
  afterEach(() => clearDiff());

  it('set → 订阅者收到；null → 栈清空（关闭后不留旧请求）', () => {
    const cb = vi.fn();
    const un = subscribeDiff(cb);
    setDiffState({ kind: 'request', request: req() });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(getDiffState()).toMatchObject({ kind: 'request' });
    setDiffState(null);
    expect(getDiffState()).toBeNull();
    un();
    setDiffState({ kind: 'request', request: req() });
    expect(cb).toHaveBeenCalledTimes(2); // 此前两次变更已计满；退订后不再被打扰
    setDiffState(null);
  });

  it('导出面就是栈的导出面：diffPaneKeyOf / getDiffPanes / closeDiffPane 都在', () => {
    const request = req({ title: '甲' });
    setDiffState({ kind: 'request', request });
    expect(getDiffPanes()[0]!.key).toBe(diffPaneKeyOf(request));
    expect(closeDiffPane(diffPaneKeyOf(request))).toBe(true);
    expect(getDiffPanes()).toHaveLength(0);
  });
});

type OpenPayload = KernelEventMap['ui.diffView.open'];

function fakeKernel() {
  const handlers = new Map<string, (p: never) => void>();
  const emitted: Array<[string, unknown]> = [];
  const kernel = {
    bus: {
      on(name: string, cb: (p: never) => void) {
        handlers.set(name, cb);
        return () => handlers.delete(name);
      },
      emit(name: string, payload: unknown) {
        emitted.push([name, payload]);
      },
    },
  };
  return { kernel: kernel as never, emitted, fire: (p: OpenPayload) => handlers.get('ui.diffView.open')?.(p as never) };
}

describe('bindDiffView：意图落地时序', () => {
  afterEach(() => clearDiff());

  it('合法请求 → 入栈一格并转发 ui.overlay.open（组件此刻才读得到状态）', () => {
    const { kernel, emitted, fire } = fakeKernel();
    const un = bindDiffView(kernel);
    fire({ title: 'A vs B', original: { label: 'a', text: '1' }, modified: { label: 'b', path: 'C:/x.ERB' } });
    expect(getDiffState()).toMatchObject({ kind: 'request' });
    expect(getDiffPanes()).toHaveLength(1);
    expect(emitted).toEqual([['ui.overlay.open', { id: DIFF_VIEW_OVERLAY_ID, source: 'host:diff-view' }]]);
    un();
  });

  it('无效请求 → 照样开窗但那一格是可见的拒绝原因（拒绝不许只进控制台）', () => {
    const { kernel, fire } = fakeKernel();
    bindDiffView(kernel);
    fire({ title: '坏请求', original: { label: 'a' }, modified: { label: 'b', text: '' } });
    expect(getDiffState()).toMatchObject({ kind: 'rejected' });
    expect(getDiffPanes()).toHaveLength(1);
  });

  it('多开：第二枚意图不顶掉第一枚，两格并存；关掉栈顶回到第一枚', () => {
    const { kernel, emitted, fire } = fakeKernel();
    bindDiffView(kernel);
    fire({ title: '第一组', original: { label: 'a', text: '1' }, modified: { label: 'b', text: '2' } });
    fire({ title: '第二组', original: { label: 'c', text: '3' }, modified: { label: 'd', text: '4' } });

    expect(getDiffPanes()).toHaveLength(2);
    expect(getDiffState()).toMatchObject({ kind: 'request' });
    expect((getDiffState() as { request: DiffRequest }).request.title).toBe('第二组');
    expect(emitted).toHaveLength(2);

    expect(closeDiffPane()).toBe(false); // 还剩第一组 ⇒ 不该收模态
    expect((getDiffState() as { request: DiffRequest }).request.title).toBe('第一组');
    expect(closeDiffPane()).toBe(true);
    expect(getDiffState()).toBeNull();
  });

  it('同一对内容重复发意图 ⇒ 只有一格（重开是切回来，不是堆一层）', () => {
    const { kernel, fire } = fakeKernel();
    bindDiffView(kernel);
    const payload: OpenPayload = { title: '重复', original: { label: 'a', path: 'C:/x.ERB' }, modified: { label: 'b', path: 'C:/y.ERB' } };
    fire(payload);
    fire({ ...payload });
    expect(getDiffPanes()).toHaveLength(1);
  });
});
