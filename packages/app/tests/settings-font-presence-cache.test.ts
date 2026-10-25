// @vitest-environment happy-dom
/**
 * 字体可用性判定的缓存钉子（2026-10-25 设置页性能批）。
 *
 * 背景：`FontPresetControl` 原先在**渲染期**对每个档位栈跑 `checkFontStackPresence`
 * （每枚家族三把泛尺 × `canvas.measureText`）。profile 实测 selfTime 329.8ms / 进节长任务
 * 168ms，且每次进节重头量一遍。
 *
 * 本批把它改成「渲染期只读缓存 + 面板打开后 8ms 一片的预热」，判据函数一个字未改。
 * 这条用例钉的就是那个前提：**同一批次家族只量为一次**，第二次挂载面板不再碰 canvas。
 *
 * 判据用 `CanvasRenderingContext2D#measureText` 的调用计数（不是计时，免得机器忙就假红）。
 */
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SettingsPanel, type SettingsPanelProps } from '../src/ui/SettingsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 量宽调用计数（唯一判据：单调递增说明缓存没命中） */
let measureCalls = 0;
const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  // 假 2D 上下文：只需要 `font` 可写 + `measureText` 返回宽度。
  // 宽度取"字号与家族名都算进去"的长短差异，让判定核读到"装着的"（本用例不关心真假，只数次数）。
  HTMLCanvasElement.prototype.getContext = function getContext(): unknown {
    const ctx = {
      font: '16px sans-serif',
      measureText(text: string) {
        measureCalls += 1;
        return { width: text.length * 7 + 1 };
      },
    };
    return ctx;
  } as typeof HTMLCanvasElement.prototype.getContext;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

const noop = (): void => {};
const asyncNoop = async (): Promise<void> => {};

function panelProps(over: Partial<SettingsPanelProps> = {}): SettingsPanelProps {
  return {
    onClose: noop,
    initialSection: 'general',
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
    ...over,
  };
}

/** 预热是 setTimeout 链 ⇒ 等到计数不再变化（连续一轮无新增）为止 */
async function settle(): Promise<void> {
  let previous = -1;
  for (let round = 0; round < 80 && previous !== measureCalls; round += 1) {
    previous = measureCalls;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

/** 挂载一次面板并等预热跑完，返回这次挂载期间的量宽调用数 */
async function mountOnce(): Promise<number> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const before = measureCalls;
  await act(async () => {
    root.render(h(SettingsPanel, panelProps()));
  });
  await settle();
  const used = measureCalls - before;
  await act(async () => root.unmount());
  container.remove();
  return used;
}

describe('字体可用性判定：缓存后不再量第二次', () => {
  it('第一次挂载会量（预热真的跑了），第二次挂载一枚 measureText 都不再调', async () => {
    const first = await mountOnce();
    expect(first).toBeGreaterThan(0); // 自证：假 canvas 确实被走通了，否则下面的 0 是空匹配

    const second = await mountOnce();
    console.log(`[font-presence] 首次挂载 measureText ${first} 次；二次挂载 ${second} 次（缓存命中应为 0）`);
    expect(second).toBe(0);
  });
});
