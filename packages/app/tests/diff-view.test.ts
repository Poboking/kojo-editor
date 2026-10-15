import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KernelEventMap } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  bindDiffView,
  DIFF_VIEW_OVERLAY_ID,
  getDiffState,
  languageIdForSide,
  setDiffState,
  subscribeDiff,
  validateDiffRequest,
  type DiffRequest,
} from '../src/ui/diff-view';

/**
 * 通用 diff 视图的宿主纯逻辑（2026-10-15 比对/历史批）。
 *
 * 判钉三件：无效请求的拒绝原因（不静默）、语言推断的保守口径（不许猜错高亮）、
 * 意图事件 → 状态 + overlay 打开的落地时序。渲染本体（Monaco diff 编辑器）
 * 在浏览器 effect 里动态 import，node 环境不触达。
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

describe('diff 状态单源', () => {
  afterEach(() => setDiffState(null));

  it('set → 订阅者收到；clear → null（关闭后不留旧请求）', () => {
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
  afterEach(() => setDiffState(null));

  it('合法请求 → 状态就位并转发 ui.overlay.open（组件此刻才读得到状态）', () => {
    const { kernel, emitted, fire } = fakeKernel();
    const un = bindDiffView(kernel);
    fire({ title: 'A vs B', original: { label: 'a', text: '1' }, modified: { label: 'b', path: 'C:/x.ERB' } });
    expect(getDiffState()).toMatchObject({ kind: 'request' });
    expect(emitted).toEqual([['ui.overlay.open', { id: DIFF_VIEW_OVERLAY_ID, source: 'host:diff-view' }]]);
    un();
  });

  it('无效请求 → 照样开窗但状态是可见的拒绝原因（拒绝不许只进控制台）', () => {
    const { kernel, emitted, fire } = fakeKernel();
    bindDiffView(kernel);
    fire({ title: '坏请求', original: { label: 'a' }, modified: { label: 'b', text: '' } });
    expect(getDiffState()).toMatchObject({ kind: 'rejected' });
    expect(emitted.length).toBe(1);
  });
});
