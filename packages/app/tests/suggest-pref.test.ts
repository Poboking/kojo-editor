/**
 * 「补全弹出延迟」偏好单测（SUGGEST-2B）。契约照 `font-size-pref.test.ts` / `semantic-color-pref.test.ts`：
 * ①默认 0ms（保持"打字即弹"的旧体感）；②损坏值 / 越界 / 读抛错一律回默认或夹到区间，绝不抛进渲染链；
 * ③持久化走 localStorage 单一真源；④订阅表在每次 save 后逐一通知（写失败也通知）。
 * 单测环境是 `node`（无 window），用假 localStorage 驱动。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SUGGEST_DELAY_DEFAULT,
  SUGGEST_DELAY_MAX,
  SUGGEST_DELAY_MIN,
  SUGGEST_DELAY_STEP,
  clampSuggestDelay,
  loadSuggestDelayPref,
  saveSuggestDelayPref,
  subscribeSuggestDelayPref,
} from '../src/ui/suggest-pref';

const KEY = 'kojo.ui.suggestDelay.v1';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

function stubWindow(storage: Storage | undefined): void {
  vi.stubGlobal('window', storage === undefined ? {} : { localStorage: storage });
}

afterEach(() => vi.unstubAllGlobals());

describe('suggest-pref · 常量与缺省', () => {
  it('默认 0ms（立即）；可调 0–1000ms、每档 100ms', () => {
    expect(SUGGEST_DELAY_DEFAULT).toBe(0);
    expect([SUGGEST_DELAY_MIN, SUGGEST_DELAY_MAX, SUGGEST_DELAY_STEP]).toEqual([0, 1000, 100]);
  });

  it('没 window / 没 localStorage / 键不存在 ⇒ 都是默认 0（不抛）', () => {
    stubWindow(undefined);
    expect(loadSuggestDelayPref()).toBe(SUGGEST_DELAY_DEFAULT);
    stubWindow(fakeStorage());
    expect(loadSuggestDelayPref()).toBe(SUGGEST_DELAY_DEFAULT);
  });
});

describe('suggest-pref · 读：合法值、夹取与损坏回落', () => {
  it('合法值照读（含步进档位）', () => {
    for (const ms of [0, 100, 300, 1000]) {
      stubWindow(fakeStorage({ [KEY]: String(ms) }));
      expect(loadSuggestDelayPref(), String(ms)).toBe(ms);
    }
  });

  it('越界钳到区间两端（手改 localStorage 不造出负担不起的定时器）', () => {
    stubWindow(fakeStorage({ [KEY]: '-500' }));
    expect(loadSuggestDelayPref()).toBe(SUGGEST_DELAY_MIN);
    stubWindow(fakeStorage({ [KEY]: String(SUGGEST_DELAY_MAX + 9000) }));
    expect(loadSuggestDelayPref()).toBe(SUGGEST_DELAY_MAX);
  });

  it('损坏值（空串 / 文字 / NaN / 带单位）⇒ 回默认 0', () => {
    for (const junk of ['', ' ', 'abc', 'NaN', 'Infinity', '300ms', '1e']) {
      stubWindow(fakeStorage({ [KEY]: junk }));
      expect(loadSuggestDelayPref(), junk).toBe(SUGGEST_DELAY_DEFAULT);
    }
  });

  it('小数四舍五入（读数永远是整数毫秒）', () => {
    stubWindow(fakeStorage({ [KEY]: '237.6' }));
    expect(loadSuggestDelayPref()).toBe(238);
  });

  it('getItem 抛错 ⇒ 回默认，绝不抛到编辑器链路', () => {
    const boom = {
      getItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    stubWindow(boom);
    expect(loadSuggestDelayPref()).toBe(SUGGEST_DELAY_DEFAULT);
  });
});

describe('suggest-pref · 写与持久化', () => {
  it('写入前钳制：负数存 0、超大存上限、小数存整数', () => {
    const storage = fakeStorage();
    stubWindow(storage);
    saveSuggestDelayPref(-20);
    expect(storage.getItem(KEY)).toBe('0');
    saveSuggestDelayPref(SUGGEST_DELAY_MAX + 1);
    expect(storage.getItem(KEY)).toBe(String(SUGGEST_DELAY_MAX));
    saveSuggestDelayPref(137.6);
    expect(storage.getItem(KEY)).toBe('138');
  });

  it('存过再读拿到同一值（真源只有 localStorage 一份）', () => {
    const storage = fakeStorage();
    stubWindow(storage);
    saveSuggestDelayPref(400);
    expect(loadSuggestDelayPref()).toBe(400);
    saveSuggestDelayPref(0);
    expect(storage.getItem(KEY)).toBe('0');
    expect(loadSuggestDelayPref()).toBe(0);
  });

  it('没有 window 也照样通知（不抛）', () => {
    stubWindow(undefined);
    const listener = vi.fn();
    subscribeSuggestDelayPref(listener);
    expect(() => saveSuggestDelayPref(300)).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('suggest-pref · 订阅', () => {
  it('订阅者逐一收到通知；取消后不再收到', () => {
    stubWindow(fakeStorage());
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeSuggestDelayPref(a);
    subscribeSuggestDelayPref(b);
    saveSuggestDelayPref(100);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    saveSuggestDelayPref(200);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('setItem 抛错也照样通知（本次选择不落盘，但订阅方仍收到一次通知）', () => {
    const boom = {
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage;
    stubWindow(boom);
    const listener = vi.fn();
    subscribeSuggestDelayPref(listener);
    expect(() => saveSuggestDelayPref(500)).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('suggest-pref · 纯钳制函数（NaN 不进 setTimeout）', () => {
  it('非有限数回默认；其余夹到区间并取整', () => {
    expect(clampSuggestDelay(Number.NaN)).toBe(SUGGEST_DELAY_DEFAULT);
    expect(clampSuggestDelay(Number.POSITIVE_INFINITY)).toBe(SUGGEST_DELAY_DEFAULT);
    expect(clampSuggestDelay(Number.NEGATIVE_INFINITY)).toBe(SUGGEST_DELAY_DEFAULT);
    expect(clampSuggestDelay(-1)).toBe(SUGGEST_DELAY_MIN);
    expect(clampSuggestDelay(99999)).toBe(SUGGEST_DELAY_MAX);
    expect(clampSuggestDelay(99.4)).toBe(99);
    expect(clampSuggestDelay(99.5)).toBe(100);
  });
});
