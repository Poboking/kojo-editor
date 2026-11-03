// @vitest-environment happy-dom
/**
 * 设置页「工作区 → 作品位置」的默认落点选择器（2026-11-03 默认工作区批）。
 *
 * 这一节回答两件事：**新建的作品默认落在哪**，以及**每条位置是什么状态**。
 * 判据全部按"作者在页面上看得到什么 / 点下去发生什么"写，不碰实现细节：
 *
 * 1. checked 的单选点**恰有一枚**，且它正是壳层给的那条生效默认落点（`isDefault`）；
 * 2. 内置那条带「内置」徽标、**没有**撤销钮（内核也会拒，但入口不该先给出一个注定失败的按钮）；
 * 3. 自选那条带撤销，且点了先进两步确认（不可逆动作不设一键）；
 * 4. 失效（设定过但现在读不到）那条**照列**：徽标「当前不可用」、单选点禁用、
 *    不 checked——失效不静默（铁律 4），但绝不假装它还是默认；
 * 5. 点另一条 = 调 `onSetWorkspaceDefaultRoot` 并给出那条路径；失败原因**原样**上屏（`role=alert`）；
 * 6. 「选择其他文件夹…」：对话框选定（回调回路径）⇒ 紧接着把它设成默认；
 *    取消（回 null）⇒ 一个设定都不发；平台抛错 ⇒ 原因上屏，不发设定。
 * 7. 组首那句限定（"自选的文件夹只是落点"）经 `aria-describedby` 挂在单选组上；
 *    自选行的说明按"此刻是不是生效落点"分两种读法——撤掉当前默认后作品去哪儿，
 *    只有那一条该念出来。
 */
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsPanel, type SettingsPanelProps } from '../src/ui/SettingsPanel';
import type { WorkspaceLocationRow } from '../src/ui/workspace-roots';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = (): void => {};
const asyncNoop = async (): Promise<void> => {};

const BUILTIN = 'C:/appdata/workspaces';
const EXTRA = 'D:/我的作品库';

function row(
  path: string,
  over: Partial<Omit<WorkspaceLocationRow, 'path'>> = {},
): WorkspaceLocationRow {
  return { path, isBuiltin: false, isDefault: false, available: true, ...over };
}

/** 壳层传进来的那一整套（值取"什么都没改过"的缺省态，工作区带由 `over` 覆写） */
function panelProps(over: Partial<SettingsPanelProps> = {}): SettingsPanelProps {
  return {
    onClose: noop,
    initialSection: 'workspace',
    commands: [],
    zen: false,
    zenLimitWidth: false,
    dispatch: noop,
    onResetLayout: noop,
    themePref: 'dark',
    motionPref: 'full',
    commitMotionPref: noop,
    panelVirtualize: true,
    glassTransparency: 15,
    sealed: true,
    nameColorOn: false,
    fontSize: 16,
    fontZoom: 0,
    quickSuggestionsOn: true,
    commitQuickSuggestions: noop,
    wordSuggestionsOn: true,
    commitWordSuggestions: noop,
    suggestDelay: 0,
    commitSuggestDelay: noop,
    inlineCompletionOn: true,
    commitInlineCompletion: noop,
    inlineMinShowDelay: 0,
    commitInlineMinShowDelay: noop,
    inlineMaxCandidates: 5,
    commitInlineMaxCandidates: noop,
    sugarViewOn: false,
    applySugarViewPref: noop,
    formatOnSave: false,
    commitFormatOnSave: noop,
    codeLensOn: false,
    commitCodeLens: noop,
    autosaveMode: 'off',
    directMode: false,
    marketSource: null,
    marketEndpointDraft: '',
    setMarketEndpointDraft: noop,
    saveMarketEndpoint: asyncNoop,
    resetMarketEndpoint: asyncNoop,
    appVersion: '0.0.0-test',
    updatePhase: { kind: 'idle' },
    updateStatusLine: null,
    runUpdateCheck: asyncNoop,
    installUpdate: asyncNoop,
    openUpdateDialog: noop,
    ...over,
  };
}

/** 挂载工作区节，返回容器与卸载句柄 */
async function mount(
  props: Partial<SettingsPanelProps>,
): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(h(SettingsPanel, panelProps(props)));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const rowsOf = (root: ParentNode): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('.settings-ws-root'),
];
const radioOf = (row: Element): HTMLInputElement =>
  row.querySelector<HTMLInputElement>('.kit-radio-input')!;
const textOf = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ');

describe('设置页「作品位置」：默认落点单选组', () => {
  it('内置 + 自选两条：恰有一枚 checked，就是壳层标了 isDefault 的那条', async () => {
    const { container, unmount } = await mount({
      workspaceRoots: [
        row(BUILTIN, { isBuiltin: true }),
        row(EXTRA, { isDefault: true }),
      ],
    });
    try {
      const rows = rowsOf(container);
      expect(rows.map((r) => r.getAttribute('data-workspace-root'))).toEqual([BUILTIN, EXTRA]);
      const checked = rows.filter((r) => radioOf(r).checked);
      expect(checked).toHaveLength(1);
      expect(checked[0]!.getAttribute('data-ws-default')).toBe('1');
      expect(checked[0]!.getAttribute('data-workspace-root')).toBe(EXTRA);
      // 徽标：自选那条挂「默认」，内置那条挂「内置」
      expect(textOf(rows[0]!.querySelector('.settings-ws-badge'))).toBe('内置');
      expect(textOf(rows[1]!.querySelector('.settings-ws-badge'))).toBe('默认');
      // 无障碍：radiogroup 有名字，作者用读屏也听得懂这一组在选什么
      const group = container.querySelector('[role="radiogroup"]');
      expect(group?.getAttribute('aria-label')).toBe('默认作品位置');
      // 名字之外还要带上组首那句限定（"自选的文件夹只是落点，可写的是里面的作品目录"）：
      // 读屏逐行念单选点时，这一句决定作者会不会以为选了文件夹就等于能往里写
      const describedBy = group?.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(textOf(container.querySelector(`#${describedBy}`))).toContain('只是落点');
    } finally {
      await unmount();
    }
  });

  it('自选行的说明分两种读法：此刻是落点的那条要说清"撤掉后新建的作品去哪儿"', async () => {
    const { container, unmount } = await mount({
      workspaceRoots: [row(BUILTIN, { isBuiltin: true }), row(EXTRA, { isDefault: true }), row('F:/另一个作品库')],
    });
    try {
      const [, defaultRow, plainRow] = rowsOf(container);
      const defaultHint = textOf(defaultRow!.querySelector('.settings-hint'));
      expect(defaultHint).toContain('现在新建作品的落点');
      // 撤掉当前默认落点 ≠ 设定消失（内核口径：设定保留，重新授权同一个文件夹自动沿用）
      expect(defaultHint).toContain('回到软件自带的位置');
      expect(defaultHint).toContain('沿用回来');
      // 没在生效的那条只说"选它会怎样"，不许带"回到内置"这类与它无关的后果
      const plainHint = textOf(plainRow!.querySelector('.settings-hint'));
      expect(plainHint).toContain('以后新建的作品都放这儿');
      expect(plainHint).not.toContain('回到软件自带的位置');
    } finally {
      await unmount();
    }
  });

  it('内置那条不给撤销钮，自选那条给——而且点了先变成两步确认', async () => {
    const setDefault = vi.fn(async (): Promise<void> => {});
    const { container, unmount } = await mount({
      workspaceRoots: [row(BUILTIN, { isBuiltin: true, isDefault: true }), row(EXTRA)],
      onRevokeWorkspaceRoot: vi.fn(async () => {}),
      onSetWorkspaceDefaultRoot: setDefault,
    });
    try {
      const [builtinRow, extraRow] = rowsOf(container);
      expect(builtinRow!.querySelector('.settings-ws-ops')).toBeNull();
      const revoke = extraRow!.querySelector<HTMLButtonElement>('.settings-ws-ops button');
      expect(revoke).not.toBeNull();
      expect(textOf(revoke)).toBe('撤销');
      await act(async () => {
        revoke!.click();
      });
      // 就地换成「确认撤销 / 取消」，不设一键不可逆
      const labels = [
        ...extraRow!.querySelectorAll<HTMLButtonElement>('.settings-ws-ops button'),
      ].map((b) => textOf(b));
      expect(labels).toEqual(['确认撤销', '取消']);
      // 二次确认这一步不该顺手改动默认落点
      expect(setDefault).not.toHaveBeenCalled();
      expect(radioOf(extraRow!).checked).toBe(false);
    } finally {
      await unmount();
    }
  });

  it('设定过但现在读不到的那条照列：徽标「当前不可用」、单选点禁用、不 checked', async () => {
    const gone = 'E:/移动硬盘的作品库';
    const { container, unmount } = await mount({
      // 内核语义：`defaultRoot()` 已落回内置根，`customDefaultRoot()` 仍留着 E: 那条
      // ⇒ `workspaceLocationRows` 把 E: 作为 `available:false` 的行追加在末尾
      workspaceRoots: [row(BUILTIN, { isBuiltin: true, isDefault: true }), row(gone, { available: false })],
    });
    try {
      const rows = rowsOf(container);
      const dead = rows[1]!;
      expect(dead.getAttribute('data-workspace-root')).toBe(gone);
      expect(dead.getAttribute('data-ws-available')).toBe('0');
      expect(dead.getAttribute('data-ws-default')).toBe('0');
      expect(radioOf(dead).disabled).toBe(true);
      expect(radioOf(dead).checked).toBe(false);
      expect(dead.querySelector('.settings-ws-ops')).toBeNull(); // 撤不了的行不给撤的入口
      const badges = [...dead.querySelectorAll('.settings-ws-badge')].map((b) => textOf(b));
      expect(badges).toContain('当前不可用');
      // 失效说明要说清"此刻落在哪"与"重新授权会自动沿用回来"
      expect(textOf(dead.querySelector('.settings-hint'))).toContain('默认');
      // 生效默认仍只有内置那一枚
      expect(rows.filter((r) => radioOf(r).checked)).toHaveLength(1);
    } finally {
      await unmount();
    }
  });

  it('点另一条 = 把那条路径交给 onSetWorkspaceDefaultRoot；失败原因原样上屏', async () => {
    const setDefault = vi.fn(async (): Promise<void> => {});
    const { container, unmount } = await mount({
      workspaceRoots: [row(BUILTIN, { isBuiltin: true, isDefault: true }), row(EXTRA)],
      onSetWorkspaceDefaultRoot: setDefault,
    });
    try {
      const [builtinRow, extraRow] = rowsOf(container);
      await act(async () => {
        radioOf(extraRow!).click();
      });
      expect(setDefault).toHaveBeenCalledTimes(1);
      expect(setDefault).toHaveBeenCalledWith(EXTRA);
      // 点已选中的那条不该重复写盘
      await act(async () => {
        radioOf(builtinRow!).click();
      });
      expect(setDefault).toHaveBeenCalledTimes(1);
    } finally {
      await unmount();
    }
  });

  it('设默认被内核拒（名单外的路径）⇒ 内核那句中文原文挂在行下，不弹窗不静默', async () => {
    const { container, unmount } = await mount({
      workspaceRoots: [row(BUILTIN, { isBuiltin: true, isDefault: true }), row(EXTRA)],
      onSetWorkspaceDefaultRoot: async () => {
        throw new Error('这个位置不在已授权的作品位置清单里：D:/我的作品库');
      },
    });
    try {
      const extraRow = rowsOf(container)[1]!;
      await act(async () => {
        radioOf(extraRow).click();
      });
      const alert = extraRow.querySelector('[role="alert"]');
      expect(textOf(alert)).toBe('这个位置不在已授权的作品位置清单里：D:/我的作品库');
    } finally {
      await unmount();
    }
  });

  it('「选择其他文件夹…」：选定即授权并设为默认；取消不发设定；平台抛错则原因上屏', async () => {
    const pickedRow = row('F:/新授权的作品库');
    const setDefault = vi.fn(async (): Promise<void> => {});
    const choose = vi.fn(async (): Promise<string | null> => 'F:/新授权的作品库');
    const { container, unmount } = await mount({
      workspaceRoots: [row(BUILTIN, { isBuiltin: true, isDefault: true })],
      onSetWorkspaceDefaultRoot: setDefault,
      onChooseWorkspaceLocation: choose,
    });
    try {
      const button = [
        ...container.querySelectorAll<HTMLButtonElement>('button'),
      ].find((b) => textOf(b) === '选择其他文件夹作为作品位置…');
      expect(button, '页面上没有那颗按钮').not.toBeUndefined();
      await act(async () => {
        button!.click();
      });
      expect(choose).toHaveBeenCalledTimes(1);
      expect(setDefault).toHaveBeenCalledWith('F:/新授权的作品库');
      expect(rowsOf(container).some((r) => r.getAttribute('data-workspace-root') === pickedRow.path)).toBe(
        false, // 清单由壳层重取，本组件不自己伪造新行
      );
    } finally {
      await unmount();
    }

    // 取消对话框（回 null）⇒ 一个设定都不发
    const setDefault2 = vi.fn(async (): Promise<void> => {});
    const m2 = await mount({
      workspaceRoots: [row(BUILTIN, { isBuiltin: true, isDefault: true })],
      onSetWorkspaceDefaultRoot: setDefault2,
      onChooseWorkspaceLocation: async () => null,
    });
    try {
      const button = [
        ...m2.container.querySelectorAll<HTMLButtonElement>('button'),
      ].find((b) => textOf(b) === '选择其他文件夹作为作品位置…')!;
      await act(async () => {
        button.click();
      });
      expect(setDefault2).not.toHaveBeenCalled();
    } finally {
      await m2.unmount();
    }

    // 平台不支持 / 被禁选根挡下 ⇒ 原文上屏，且不发设定
    const setDefault3 = vi.fn(async (): Promise<void> => {});
    const m3 = await mount({
      workspaceRoots: [row(BUILTIN, { isBuiltin: true, isDefault: true })],
      onSetWorkspaceDefaultRoot: setDefault3,
      onChooseWorkspaceLocation: async () => {
        throw new Error('这个文件夹不能当作品位置：它与当前游戏的目录重叠（D:/DSH/erato）。');
      },
    });
    try {
      const button = [
        ...m3.container.querySelectorAll<HTMLButtonElement>('button'),
      ].find((b) => textOf(b) === '选择其他文件夹作为作品位置…')!;
      await act(async () => {
        button.click();
      });
      expect(setDefault3).not.toHaveBeenCalled();
      expect(textOf(m3.container.querySelector('[role="alert"]'))).toContain(
        '它与当前游戏的目录重叠',
      );
    } finally {
      await m3.unmount();
    }
  });

  it('没有回调（浏览器调试壳 / 服务不可用）⇒ 单选点全禁用，但页面不塌、也不伪造位置', async () => {
    const html = renderToString(
      h(SettingsPanel, panelProps({ workspaceRoots: [] })),
    );
    expect(html).toContain('暂时读不到工作区位置');
    expect(html).not.toContain(BUILTIN);
    expect(html).not.toContain('settings-ws-root');
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});
