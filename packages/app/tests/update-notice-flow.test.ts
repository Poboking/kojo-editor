// @vitest-environment happy-dom
/**
 * 更新提醒的**会话编排**（`useUpdateNotice`）在真 React 生命周期里的行为（2026-11-02 UI 打磨批）。
 *
 * 为什么单开这一份：`update-notice-card.test.ts` 钉的是纯判据与静态渲染面，它明确不跑 effect；
 * 而本批的三个卖点全都在 effect 里——
 * ① 破坏性更新「打开即模态」现在**吃跨会话免打扰**（改前每一轮启动都硬开一次模态）；
 * ② 点「后台下载」收起模态后，右下卡要接住进度（否则屏上零反馈）；
 * ③ 下载中按 X 只是收起这张格，**不许**写成免打扰（那不是拒绝更新）。
 * 这三条不挂进真 hook 就只是文件头上的愿望，所以这里用 `createRoot + act` 跑起来。
 *
 * 环境口径照 `settings-panel-lazy-sections.test.ts`：happy-dom 的 localStorage 是真实现，
 * 每个用例前清一次；`<button>` 用 textContent 找，不依赖 class 顺序。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useUpdateNotice, type UseUpdateNoticeResult } from '../src/ui/UpdateNoticeCard';
import { UPDATE_DISMISS_KEY } from '../src/ui/update-dismiss-pref';
import type { UpdatePhase } from '../src/ui/update-check';

const noop = (): void => {};

// createRoot + act 的前提（缺这枚旗 React 每次 act 都抱怨一声；同 settings-panel-lazy-sections）
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FOUND_VERSION = '0.9.0';

const found = (notes: string): UpdatePhase => ({
  kind: 'found',
  version: FOUND_VERSION,
  currentVersion: '0.8.0',
  notes,
});

const DOWNLOADING: UpdatePhase = { kind: 'downloading', version: FOUND_VERSION, received: 10, total: 20 };
const DONE: UpdatePhase = { kind: 'done', version: FOUND_VERSION };

/** 把 hook 的读数原样交给探针，测试从探针取（不在模块外造第二份状态） */
function Probe({ phase, sink }: { phase: UpdatePhase; sink: (r: UseUpdateNoticeResult) => void }): null {
  sink(useUpdateNotice(phase));
  return null;
}

let container: HTMLDivElement;
let root: Root;
let latest: UseUpdateNoticeResult;

function mount(phase: UpdatePhase): void {
  latest = emptyResult();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(Probe, { phase, sink: (r) => { latest = r; } }));
  });
}

function emptyResult(): UseUpdateNoticeResult {
  return {
    notice: null,
    forced: false,
    dialog: null,
    openDialog: noop,
    dismissNotice: noop,
    closeDialog: noop,
  };
}

/** 换 phase 重渲（同一棵树，模拟状态机往前走一步） */
function rerender(phase: UpdatePhase): void {
  act(() => {
    root.render(createElement(Probe, { phase, sink: (r) => { latest = r; } }));
  });
}

function storedDismissal(): { version: string; dismissedAt: number } | null {
  const raw = window.localStorage.getItem(UPDATE_DISMISS_KEY);
  return raw === null ? null : (JSON.parse(raw) as { version: string; dismissedAt: number });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('useUpdateNotice · 打扰分层', () => {
  it('普通 found：只举卡，绝不自开模态（作者没点头前不许全屏挡路）', () => {
    mount(found('- 新增：一张卡'));
    expect(latest.notice?.kind).toBe('found');
    expect(latest.forced).toBe(false);
    expect(latest.dialog).toBeNull();
  });

  it('破坏性 found：自动开模态；作者推辞过（免打扰落盘）后同一版不再纠缠', () => {
    mount(found('- 破坏性：换存储格式'));
    expect(latest.forced).toBe(true);
    expect(latest.notice).toBeNull(); // 卡让位给模态，同一版不双提醒
    expect(latest.dialog?.kind).toBe('found');

    act(() => {
      latest.closeDialog();
    });
    expect(latest.dialog).toBeNull();
    expect(storedDismissal()?.version).toBe(FOUND_VERSION);

    // 重开（= 下一次进应用，状态机重新举 found）：免打扰期内连模态都不该自动开
    mount(found('- 破坏性：换存储格式'));
    expect(latest.forced).toBe(false);
    expect(latest.dialog).toBeNull();
    expect(latest.notice).toBeNull();
  });

  it('「后台下载」关模态 ⇒ 卡接住进度；这一态不写免打扰（更新在路上 ≠ 拒绝更新）', () => {
    mount(found('- 新增：一张卡'));
    act(() => {
      latest.openDialog();
    });
    expect(latest.dialog?.kind).toBe('found');
    rerender(DOWNLOADING);
    expect(latest.dialog?.kind).toBe('downloading');

    act(() => {
      latest.closeDialog();
    });
    expect(latest.dialog).toBeNull();
    expect(latest.notice?.kind).toBe('downloading'); // 屏上唯一还在报进度的落点
    expect(window.localStorage.getItem(UPDATE_DISMISS_KEY)).toBeNull();
  });

  it('下载中按 X：本会话收起这一格，但换到「已就位」要重新举卡', () => {
    mount(DOWNLOADING);
    expect(latest.notice?.kind).toBe('downloading');
    act(() => {
      latest.dismissNotice();
    });
    expect(latest.notice).toBeNull();
    expect(window.localStorage.getItem(UPDATE_DISMISS_KEY)).toBeNull();

    rerender(DONE);
    expect(latest.notice?.kind).toBe('done');
  });

  it('found 的 X = 推辞：落跨会话免打扰，同版本不再举卡', () => {
    mount(found('- 新增：一张卡'));
    act(() => {
      latest.dismissNotice();
    });
    expect(latest.notice).toBeNull();
    expect(storedDismissal()?.version).toBe(FOUND_VERSION);
  });
});
