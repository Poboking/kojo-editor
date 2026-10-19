import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KernelEventMap } from '@kojo/plugin-api';
import { ERB_DIALECT_EXTENSIONS } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { languageFor } from '../src/ui/editor-model-pool';
import {
  bindDiffView,
  clearDiff,
  DIFF_VIEW_OVERLAY_ID,
  diffEqualityBanner,
  diffEqualityOf,
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

/**
 * DRIFT-APP 1 对拍（2026-10-19）：**同一份路径在编辑器侧与差异视图侧必须给出同一个
 * language id**。
 *
 * 为什么写成对拍而不是"断言我新写的正则"：差异视图此前自己抄了一份方言尾正则，少一
 * 整个正文扩展名（症状 = 同一份大写正文文件编辑器里是 ERB 高亮、差异视图里是纯文本）。
 * 只断言新代码的用例，回退成旧正则照样过——那种测试不守住任何东西。对拍断言的是
 * "两处不许分叉"这件事本身：把 `languageIdForSide` 换回旧的自写尾正则，`.erm` 那一行
 * 与点文件那一行立刻红。
 */
describe('languageIdForSide ⇄ 编辑器侧 languageFor 对拍（同一份路径只许一个答案）', () => {
  const PLAINTEXT = 'plaintext';
  const cases: [string, string][] = [
    ['C:\\game\\ERB\\口上\\M_KOJO_K11.erb', ERB_LANGUAGE_ID],
    ['C:\\game\\ERB\\口上\\M_KOJO_K11.ERB', ERB_LANGUAGE_ID],
    ['C:\\game\\ERB\\口上\\正文.erm', ERB_LANGUAGE_ID],
    ['C:\\game\\ERB\\口上\\MARKS_OF_SUIKA.ERM', ERB_LANGUAGE_ID],
    ['C:\\game\\ERB\\口上\\变量定义.erh', ERB_LANGUAGE_ID],
    ['D:\\作者工作区\\事件.kojo', KOJO_LANGUAGE_ID],
    ['D:\\x\\说明.txt', PLAINTEXT],
  ];

  it.each(cases)('%s ⇒ 两侧同一个 id（且确为 %s）', (p, expected) => {
    expect(languageFor(p), `编辑器侧 ${p}`).toBe(expected);
    expect(languageIdForSide({ label: p, path: p }), `差异视图·路径侧 ${p}`).toBe(expected);
    expect(languageIdForSide({ label: p }), `差异视图·仅标签侧 ${p}`).toBe(expected);
  });

  it('契约方言清单的每个扩展名两种写法都零漂移（清单日后加一项，本条自动覆盖）', () => {
    for (const ext of ERB_DIALECT_EXTENSIONS) {
      for (const form of [ext, ext.toUpperCase()]) {
        const p = `C:\\game\\ERB\\口上\\文件${form}`;
        expect(languageIdForSide({ label: p, path: p }), `对拍 ${form}`).toBe(languageFor(p));
      }
    }
  });

  it('多点名与点文件两侧一致判否（口径 = extname(basename)，不是整条路径尾巴）', () => {
    for (const p of ['C:\\x\\事件.kojo.bak', 'C:\\x\\.erb', 'C:\\dir.ERB\\说明.txt']) {
      expect(languageIdForSide({ label: p, path: p }), `对拍 ${p}`).toBe(languageFor(p));
    }
    expect(languageFor('C:\\x\\.erb')).toBe(PLAINTEXT);
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

describe('diffEqualityBanner · W17 判等核的两态读数', () => {
  const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('行同字节同 ⇒ 完全一致', () => {
    const eq = diffEqualityOf({ text: 'a\nb', bytes: bytesOf('a\nb') }, { text: 'a\nb', bytes: bytesOf('a\nb') });
    expect(diffEqualityBanner(eq)).toEqual({ noLineDiff: true, message: '两侧内容完全一致（无差异）。' });
  });

  it('负自证：行同字节不同（换行风格/编码）⇒ 不说"完全一致"', () => {
    const eq = diffEqualityOf(
      { text: 'a\r\nb', bytes: bytesOf('a\r\nb') },
      { text: 'a\nb', bytes: bytesOf('a\nb') },
    );
    const banner = diffEqualityBanner(eq);
    expect(banner?.noLineDiff).toBe(true);
    expect(banner?.message).toContain('字节不同');
    expect(banner?.message).not.toContain('完全一致');
  });

  it('负自证：字节同而行不同（缓冲区文本配盘上字节）⇒ 交给行级 diff，不冒充一致', () => {
    const eq = diffEqualityOf(
      { text: '编辑中的另一版', bytes: bytesOf('a\nb') },
      { text: 'a\nb', bytes: bytesOf('a\nb') },
    );
    expect(eq.bytesEqual).toBe(true);
    expect(diffEqualityBanner(eq)).toBeNull();
  });

  it('行不同 ⇒ null（交给 Monaco 行级 diff）', () => {
    const eq = diffEqualityOf({ text: 'a', bytes: bytesOf('a') }, { text: 'b', bytes: bytesOf('b') });
    expect(diffEqualityBanner(eq)).toBeNull();
  });

  it('内联文本没有字节 ⇒ 只说行级一致（不冒充字节相同）', () => {
    const eq = diffEqualityOf({ text: 'a' }, { text: 'a' });
    expect(diffEqualityBanner(eq)).toEqual({ noLineDiff: true, message: '两侧行内容一致（无差异）。' });
  });
});
