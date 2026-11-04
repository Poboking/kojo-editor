// @vitest-environment happy-dom
/**
 * 设置页更新区三件强化（UPD-D）的渲染判据。
 *
 * UpdateSection 不单独导出，判据走它唯一的真实落点——`SettingsPanel` 的 about 节
 * （照 `settings-workspace-default.test.ts` 的挂载先例：createRoot + act，吃得到
 * useSyncExternalStore / useEffect 的 client 行为；`renderToString` 会走 server
 * 快照，那两条会话级读数一律是 null，测不了）。钉的是"作者在页面上看得到什么"：
 *
 * 1. **done 态真出口**：宿主传了 `onRestart`（= `appRelaunch`）才有「立即重启」，
 *    且点了真调它；同时那句「重启应用后生效」换成「更新已就位」语义——
 *    **没传就不画按钮、不改口**（与 UpdateDialog 同纪律：按钮必须真能重启，不许演）；
 * 2. **上次检查 hint**：会话内查过才画（三档粒度文案的细节归 `update-last-check.test.ts`，
 *    这里钉"有没有、随记录变"）；本文件首条先断"无记录不画"，后面的用例才 record；
 * 3. **免打扰恢复行**：确有**有效**免打扰记录（同版本 + 判龄未过）才出现，文案带
 *    版本号与 `UPDATE_NOTICE_QUIET_DAYS` 插值；点「恢复提醒」行即消失、记录真清空；
 *    过期记录不配占一行。
 */
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsPanel, type SettingsPanelProps } from '../src/ui/SettingsPanel';
import { updateStatus, type UpdatePhase } from '../src/ui/update-check';
import {
  clearUpdateDismissal,
  UPDATE_DISMISS_KEY,
  UPDATE_NOTICE_QUIET_DAYS,
} from '../src/ui/update-dismiss-pref';
import { recordUpdateCheck } from '../src/ui/update-last-check';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = (): void => {};
const asyncNoop = async (): Promise<void> => {};

/** 壳层传进来的那一整套（缺省态照 lazy-sections / workspace-default 两份先例，更新带由 over 覆写） */
function panelProps(over: Partial<SettingsPanelProps> = {}): SettingsPanelProps {
  return {
    onClose: noop,
    initialSection: 'about',
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

/** 挂 about 节（UpdateSection 的唯一真实落点），返回容器与卸载句柄 */
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

const buttonByText = (root: ParentNode, text: string): HTMLButtonElement | null =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text) ?? null;

/** 免打扰记录的写入口（update-dismiss-pref 的落盘形态原样：JSON { version, dismissedAt }） */
function seedDismissal(version: string, dismissedAt: number): void {
  window.localStorage.setItem(UPDATE_DISMISS_KEY, JSON.stringify({ version, dismissedAt }));
}

/** done / found 共用的发布信息（字段名照 UpdateRelease） */
const release: UpdatePhase = { kind: 'found', version: '9.9.9' };
const donePhase: UpdatePhase = { ...release, kind: 'done' };

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('done 态：重启出口只随真通道出现', () => {
  it('传了 onRestart：有「立即重启」（primary small），点击真调它；话术换「更新已就位」', async () => {
    const onRestart = vi.fn();
    const { container, unmount } = await mount({
      updatePhase: donePhase,
      updateStatusLine: updateStatus(donePhase),
      onRestart,
    });
    try {
      const restart = buttonByText(container, '立即重启');
      expect(restart).not.toBeNull();
      expect(restart!.className).toContain('primary');
      expect(restart!.className).toContain('small');
      await act(async () => {
        restart!.click();
      });
      expect(onRestart).toHaveBeenCalledTimes(1);
      const text = container.textContent ?? '';
      expect(text).toContain('更新已就位');
      expect(text).not.toContain('重启应用后生效');
    } finally {
      await unmount();
    }
  });

  it('没传 onRestart：不画按钮，状态行维持状态机原句（手动重启话术）', async () => {
    const { container, unmount } = await mount({
      updatePhase: donePhase,
      updateStatusLine: updateStatus(donePhase),
    });
    try {
      expect(buttonByText(container, '立即重启')).toBeNull();
      const text = container.textContent ?? '';
      expect(text).toContain('重启应用后生效');
      expect(text).not.toContain('更新已就位');
    } finally {
      await unmount();
    }
  });
});

describe('上次检查 hint：会话内查过才画', () => {
  it('本会话没查过：一条「上次检查」都不画（文件内先于一切 record）', async () => {
    const { container, unmount } = await mount({});
    try {
      expect(container.textContent ?? '').not.toContain('上次检查');
    } finally {
      await unmount();
    }
  });

  it('今天查过：hint 报「上次检查 HH:mm」——记录一落，设置页就看得见', async () => {
    const now = new Date();
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()).getTime();
    recordUpdateCheck('latest', at);
    const { container, unmount } = await mount({});
    try {
      expect(container.textContent ?? '').toMatch(/上次检查 \d{2}:\d{2}/);
    } finally {
      await unmount();
    }
  });

  it('记录换更早的：文案跟着换档（这里钉"随记录变"，粒度细节归模块单测）', async () => {
    recordUpdateCheck('failed', new Date(2024, 11, 1, 22, 58).getTime());
    const { container, unmount } = await mount({});
    try {
      expect(container.textContent ?? '').toContain('上次检查 2024年12月1日');
    } finally {
      await unmount();
    }
  });
});

describe('免打扰恢复行：有有效记录才在，点了真清', () => {
  it('无记录：整行不存在（不占地方）', async () => {
    const { container, unmount } = await mount({});
    try {
      const text = container.textContent ?? '';
      expect(text).not.toContain('开启免打扰');
      expect(buttonByText(container, '恢复提醒')).toBeNull();
    } finally {
      await unmount();
    }
  });

  it('有效记录（同版本、判龄未过）：行出现，文案带版本号与天数插值', async () => {
    seedDismissal('0.0.0-test', Date.now() - 24 * 60 * 60 * 1000); // 一天前点的「稍后」
    const { container, unmount } = await mount({});
    try {
      const text = container.textContent ?? '';
      expect(text).toContain('已对 v0.0.0-test 开启免打扰');
      expect(text).toContain(`${UPDATE_NOTICE_QUIET_DAYS} 天内不再自动提醒`);
      expect(buttonByText(container, '恢复提醒')).not.toBeNull();
    } finally {
      await unmount();
    }
  });

  it('过期记录：不画——免打扰是礼遇，过期就自己退场，不需要一条"已过期"占位', async () => {
    seedDismissal(
      '0.0.0-test',
      Date.now() - (UPDATE_NOTICE_QUIET_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    const { container, unmount } = await mount({});
    try {
      const text = container.textContent ?? '';
      expect(text).not.toContain('开启免打扰');
      expect(buttonByText(container, '恢复提醒')).toBeNull();
    } finally {
      await unmount();
    }
  });

  it('别的版本的记录：对当前版不算数，同样不画（免打扰只对同版本生效）', async () => {
    seedDismissal('8.8.8', Date.now() - 60 * 1000); // 刚点的「稍后」，但点在别的版本上
    const { container, unmount } = await mount({});
    try {
      expect(container.textContent ?? '').not.toContain('开启免打扰');
    } finally {
      await unmount();
    }
  });

  it('点「恢复提醒」：行消失、落盘记录真被清掉（下次自动提醒恢复）', async () => {
    seedDismissal('0.0.0-test', Date.now() - 24 * 60 * 60 * 1000);
    const { container, unmount } = await mount({});
    try {
      const restore = buttonByText(container, '恢复提醒');
      expect(restore).not.toBeNull();
      await act(async () => {
        restore!.click();
      });
      expect(buttonByText(container, '恢复提醒')).toBeNull();
      expect(container.textContent ?? '').not.toContain('开启免打扰');
      expect(window.localStorage.getItem(UPDATE_DISMISS_KEY)).toBeNull();
    } finally {
      await unmount();
      clearUpdateDismissal(); // 模块真源已清，这里只兜住万一（记录本就来自本用例）
    }
  });
});

describe('found 态不回归：两按钮行照旧（UPD-D 只加不改）', () => {
  it('「下载并安装」与「看更新内容」仍在同一行', async () => {
    const { container, unmount } = await mount({
      updatePhase: release,
      updateStatusLine: updateStatus(release),
    });
    try {
      expect(buttonByText(container, '下载并安装')).not.toBeNull();
      expect(buttonByText(container, '看更新内容')).not.toBeNull();
      expect(buttonByText(container, '立即重启')).toBeNull(); // found 不是 done，别越位
    } finally {
      await unmount();
    }
  });
});
