// @vitest-environment happy-dom
/**
 * 「上次检查更新」会话读数的单测（UPD-D）。
 *
 * 三块判据：
 * 1. **真源语义**：启动即 null；`recordUpdateCheck` 后读数齐全（`at` 可注入）；后记的覆盖先记的；
 * 2. **React 快照身份**：`useSyncExternalStore` 每轮渲染 `Object.is` 比较快照——真源引用
 *    只在 record 时换新、其余时刻恒同，才能不坠无限重渲（这是 `update-dismiss-pref`
 *    「原始串快照」同目的的另一种解法，此处真源本身就是不可变对象）；
 * 3. **三档时间粒度**：今天 / 今年内 / 更早的文案各归各档；脏值（非有限数）退 null 不画。
 *
 * 时间断言全用 `new Date(y, m, d, h, min)` 本地构造：与 `formatUpdateLastCheck` 的本地
 * 分档（getFullYear / getMonth / getDate）同钟，不依赖跑测机器的时区。
 */
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatUpdateLastCheck,
  getLastUpdateCheck,
  recordUpdateCheck,
  subscribeUpdateLastCheck,
  useLastUpdateCheck,
  type UpdateLastCheck,
} from '../src/ui/update-last-check';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 渲染期把 `useLastUpdateCheck()` 的快照交给回调（hook 返回什么，测试就读什么） */
let probeValue: UpdateLastCheck | null = null;
function Probe(): null {
  probeValue = useLastUpdateCheck();
  return null;
}

async function renderProbe(): Promise<() => Promise<void>> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(h(Probe));
  });
  return async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

/** 同一测试文件共享一份模块真源；用例间互不假设进入态——每条先 record 已知值再断言 */
afterEach(() => {
  document.body.innerHTML = '';
});

describe('会话真源（不落盘）', () => {
  it('本会话没查过时读数是 null（文件内首条：真源此刻必然未被动过）', () => {
    expect(getLastUpdateCheck()).toBeNull();
  });

  it('record 后读数齐全；再记一次后记的赢（同一会话只留最近一次）', () => {
    recordUpdateCheck('found', 1000);
    expect(getLastUpdateCheck()).toEqual({ at: 1000, outcome: 'found' });
    recordUpdateCheck('latest', 2000);
    expect(getLastUpdateCheck()).toEqual({ at: 2000, outcome: 'latest' });
  });

  it('快照身份稳定：不 record 时同引用（Object.is 恒真），record 才换新对象', () => {
    recordUpdateCheck('failed', 3000);
    const first = getLastUpdateCheck();
    const second = getLastUpdateCheck();
    expect(second).toBe(first); // 两次读是同一枚引用——useSyncExternalStore 不会因此重渲
    recordUpdateCheck('latest', 4000);
    expect(getLastUpdateCheck()).not.toBe(first);
    expect(getLastUpdateCheck()).toEqual({ at: 4000, outcome: 'latest' });
  });

  it('订阅：record 通知在册订阅者；退订后不再通知', () => {
    let hits = 0;
    const unsubscribe = subscribeUpdateLastCheck(() => {
      hits += 1;
    });
    recordUpdateCheck('found', 5000);
    expect(hits).toBe(1);
    unsubscribe();
    recordUpdateCheck('found', 6000);
    expect(hits).toBe(1); // 退订后这一次不再送达
    expect(getLastUpdateCheck()).toEqual({ at: 6000, outcome: 'found' });
  });
});

describe('useLastUpdateCheck（React 读数）', () => {
  it('渲染期捕获当前真源；act 里 record 后快照跟着换新（组件跟着真源走）', async () => {
    recordUpdateCheck('failed', 6000); // 先落一个已知值：渲染期 probeValue 捕获的就是它
    const unmount = await renderProbe();
    try {
      expect(probeValue).toEqual({ at: 6000, outcome: 'failed' });
      await act(async () => {
        recordUpdateCheck('latest', 7000);
      });
      expect(probeValue).toEqual({ at: 7000, outcome: 'latest' });
    } finally {
      await unmount();
    }
  });
});

describe('formatUpdateLastCheck（三档粒度，纯函数）', () => {
  const now = new Date(2026, 10, 5, 14, 32).getTime(); // 2026-11-05 14:32（本地）

  it('今天：只报时分', () => {
    const at = new Date(2026, 10, 5, 9, 5).getTime();
    expect(formatUpdateLastCheck(at, now)).toBe('上次检查 09:05');
  });

  it('今年内：月日 + 时分', () => {
    const at = new Date(2026, 2, 1, 8, 7).getTime(); // 2026-03-01
    expect(formatUpdateLastCheck(at, now)).toBe('上次检查 3月1日 08:07');
  });

  it('更早：年月日，不再带时分（人只对"刚才"有分钟级记忆）', () => {
    const at = new Date(2024, 11, 1, 22, 58).getTime(); // 2024-12-01
    expect(formatUpdateLastCheck(at, now)).toBe('上次检查 2024年12月1日');
  });

  it('跨年边界：昨天是去年 ⇒ 落「今年内」档不成立，报整年月日', () => {
    const at = new Date(2025, 11, 31, 23, 59).getTime(); // 2025-12-31
    expect(formatUpdateLastCheck(at, now)).toBe('上次检查 2025年12月31日');
  });

  it('脏值（非有限数）退 null：时间读数是礼遇，绝不把设置页卡出错误框', () => {
    expect(formatUpdateLastCheck(Number.NaN, now)).toBeNull();
    expect(formatUpdateLastCheck(now, Number.NaN)).toBeNull();
  });
});
