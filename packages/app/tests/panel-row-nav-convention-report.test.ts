// @vitest-environment happy-dom
/**
 * 约定校验面板的行键盘（kw8a 1102 行键盘批 · 第二步之一）。
 *
 * 判据是**行为级**（真挂载、真派发 KeyboardEvent、看焦点落在哪一行）：
 * - ↑↓ 只在可见行之间移焦点、不打开任何东西（组头也在名单：组默认全收起时键盘仍走得到）；
 * - F4/F8 移过去并**当场敲那一枚按钮**——跳转仍只走行的既有 `onClick`
 *   （`editor.revealLocation` 每按一次只发一条）；Shift 反向；
 * - 没画出来的行不参与名单：窗口外的条目（ISSUE_WINDOW 80）与收起组里的条目都不在；
 * - 输入法合成期一律放行（不吞键、不动焦点）；
 * - roving tabindex：整段名单只留一枚 0（照 `FileTree.tsx` 先例）。
 *
 * 真源判据在契约层（`plugin-api/tests/panel-row-nav.test.ts` 钉键位语义），
 * 本文件钉的是**面板接线**：行标记、容器键盘腿、漫游位对齐。
 * 为什么住 app 侧：react-dom 与 happy-dom 只有 app 包依赖（同 `panel-window-convention-report.test.ts`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ConventionIssue,
  ConventionReport,
  Plugin,
  PluginContext,
  UIPanelProps,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createUiConventionReportPlugin } from '../../plugins/ui-convention-report/src/index';
import { ISSUE_WINDOW_INITIAL } from '../../plugins/ui-convention-report/src/panel-logic';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const issues = (ruleId: string, n: number, lineBase: number): ConventionIssue[] =>
  Array.from({ length: n }, (_, i) => ({
    ruleId,
    severity: 'warning' as const,
    message: `问题 ${lineBase + i}`,
    filePath: `work/${ruleId}.src`,
    line: lineBase + i,
  }));

function makeReport(big = 100, small = 3): ConventionReport {
  return {
    adapterId: 'demo',
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    issues: [...issues('rule-big', big, 1), ...issues('rule-small', small, 1000)],
    counts: { error: 0, warning: big + small, info: 0 },
    ruleCount: 2,
    failedRules: [],
  };
}

let container: HTMLDivElement;
let root: Root;
let emitSpy: ReturnType<typeof vi.fn>;
let Panel: ((props: UIPanelProps) => unknown) | null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  emitSpy = vi.fn();
  Panel = null;

  const report = makeReport();
  const linter = {
    run: async () => report,
    report: () => report,
    subscribe: () => () => undefined,
    rules: () => [],
  };
  const parser = { currentIndex: () => ({ files: new Map() }) };
  const project = { current: () => null };
  const slots = {
    register: (kind: string, def: { id: string; component?: (props: UIPanelProps) => unknown }) => {
      if (kind === 'ui.panel' && def.id === 'convention-report') Panel = def.component ?? null;
    },
    query: () => [],
  };
  const fakes: Record<string, unknown> = {
    [WellKnownServices.ConventionLinter]: linter,
    [WellKnownServices.ErbParser]: parser,
    [KernelServices.Project]: project,
    [KernelServices.Slots]: slots,
  };
  const ctx = {
    inject: (key: string) => fakes[key],
    slots,
    bus: { emit: emitSpy, on: () => () => undefined },
    log: { warn: () => undefined, info: () => undefined, error: () => undefined },
    onDispose: () => undefined,
  };
  (createUiConventionReportPlugin() as Plugin).activate(ctx as unknown as PluginContext);
  expect(Panel, 'ui.panel 槽必须注册出面板组件').toBeTruthy();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

async function mount(): Promise<void> {
  const Comp = Panel as unknown as (props: UIPanelProps) => ReactElement;
  await act(async () => {
    root.render(h(Comp, {}));
  });
}

/** 名单（契约层行标记）按 DOM 序 */
function rows(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-panel-row]'));
}

async function press(
  key: string,
  init: KeyboardEventInit = {},
): Promise<KeyboardEvent> {
  const target = (document.activeElement as HTMLElement | null) ?? container;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

async function focusOn(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.focus();
  });
}

describe('约定校验面板 · 行键盘', () => {
  it('组默认全收起：↑↓ 在组头之间走（边界回绕），什么都不打开', async () => {
    await mount();
    const list = rows();
    expect(list).toHaveLength(2); // 两条规则 = 两个组头；条目行没画出来 ⇒ 不在名单
    expect(list[0]!.textContent).toContain('rule-big'); // 按条数降序，大组在前

    const panel = container.querySelector<HTMLElement>('.panel-convention-report')!;
    await focusOn(panel);
    let e = await press('ArrowDown');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(list[0]);
    e = await press('ArrowDown');
    expect(document.activeElement).toBe(list[1]);
    e = await press('ArrowDown'); // 末行再往下 = 回绕到第一行
    expect(document.activeElement).toBe(list[0]);
    expect(emitSpy).not.toHaveBeenCalled(); // ↑↓ 不打开任何东西
  });

  it('敲开组头（行自己的 onClick）后条目行进名单；窗口外的第 81 条不参与', async () => {
    await mount();
    const groupBtn = rows()[0]!;
    await act(async () => {
      groupBtn.click();
    });
    const list = rows();
    // 组头1 + 80 条目 + 组头2（第二组仍收起，它的 3 条不在名单上）
    expect(list).toHaveLength(1 + ISSUE_WINDOW_INITIAL + 1);
    expect(list[1]!.className).toContain('conv-issue-btn');

    await focusOn(list[0]!);
    await press('ArrowDown');
    expect(document.activeElement).toBe(list[1]); // ↓ 只移焦点
    expect(emitSpy).not.toHaveBeenCalled();

    await focusOn(list[ISSUE_WINDOW_INITIAL]!); // 第 80 条（窗口末行）
    await press('ArrowDown');
    expect(document.activeElement).toBe(list[ISSUE_WINDOW_INITIAL + 1]); // 下一行是收起组的组头
  });

  it('F8 移过去并当场打开：跳转只走行的既有 onClick（revealLocation 一条不落第二通道）', async () => {
    await mount();
    const groupBtn = rows()[0]!;
    await act(async () => {
      groupBtn.click();
    });
    const list = rows();
    await focusOn(list[0]!); // 焦点在组头
    const e = await press('F8');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(list[1]);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('editor.revealLocation', {
      filePath: 'work/rule-big.src',
      line: 1,
      source: 'rule-big',
    });
  });

  it('Shift+F8 反向；合成期（isComposing / keyCode 229）一律放行', async () => {
    await mount();
    const groupBtn = rows()[0]!;
    await act(async () => {
      groupBtn.click();
    });
    const list = rows();
    await focusOn(list[2]!);
    await press('F8', { shiftKey: true });
    expect(document.activeElement).toBe(list[1]);
    expect(emitSpy).toHaveBeenCalledTimes(1); // 反向挪一格 + 当场敲那一枚（只此一条通道）

    emitSpy.mockClear();
    const before = document.activeElement;
    const e1 = await press('ArrowDown', { isComposing: true });
    expect(e1.defaultPrevented).toBe(false);
    const e2 = await press('ArrowDown', { keyCode: 229 });
    expect(e2.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(before); // 合成中的键归输入法
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('非导航键（Enter/Tab/Escape）与空白处都不被行导航吞掉', async () => {
    await mount();
    const list = rows();
    await focusOn(list[0]!);
    for (const key of ['Enter', 'Tab', 'Escape', 'ArrowLeft']) {
      const e = await press(key);
      expect(e.defaultPrevented, key).toBe(false);
    }
  });

  it('roving tabindex：整段名单只留一枚 0，鼠标点行也对齐（焦点可见走全局 --focus-ring，零新色）', async () => {
    await mount();
    const tabbable = () => rows().filter((r) => r.tabIndex === 0);
    expect(tabbable()).toHaveLength(1); // 挂载后兜底第一行

    await act(async () => {
      rows()[0]!.click(); // 展开首组：名单从 2 行长到 82 行，effect 重对齐
    });
    const list = rows();
    expect(list.length).toBeGreaterThan(2);
    await focusOn(list[2]!); // 鼠标/编程式聚焦 ⇒ 容器 focus 腿对齐
    expect(tabbable()).toEqual([list[2]]);

    await press('ArrowDown'); // 键盘移动焦点 ⇒ 判据层就地办结
    expect(tabbable()).toEqual([rows()[3]]);
    expect(list[0]!.tabIndex).toBe(-1);
    expect(list[2]!.tabIndex).toBe(-1);
  });
});
