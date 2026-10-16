/**
 * 毛玻璃透明度偏好单测（2026-10-17 教程打磨批）。契约照 `font-size-pref.test.ts` /
 * `motion-pref.test.ts`：①默认 = 15%（克制通透）；②损坏值与抛错一律回默认/钳制，绝不抛到
 * 渲染链；③生效路径唯一（写根元素的 `--glass-alpha` + `data-glass`，无根元素时安全跳过）。
 * 单测环境是 `node`（无 window / document），用假 localStorage 与假根元素驱动。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GLASS_TRANSPARENCY_DEFAULT,
  GLASS_TRANSPARENCY_MAX,
  GLASS_TRANSPARENCY_MIN,
  GLASS_TRANSPARENCY_STEP,
  applyGlassPref,
  clampGlassTransparency,
  glassAlphaFromTransparency,
  loadGlassTransparencyPref,
  resetGlassTransparencyPref,
  setGlassTransparencyPref,
  stepGlassTransparencyPref,
  subscribeGlassPref,
  type GlassRoot,
} from '../src/ui/glass-pref';

const GLASS_KEY = 'kojo.ui.glassTransparency.v1';

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

/** 假根元素：记下 setAttribute 与 style.setProperty 收到过什么 */
function stubRoot(): GlassRoot & { attrs: Record<string, string>; props: Record<string, string> } {
  const attrs: Record<string, string> = {};
  const props: Record<string, string> = {};
  return {
    attrs,
    props,
    setAttribute: (n, v) => void (attrs[n] = v),
    style: { setProperty: (n, v) => void (props[n] = v) },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('loadGlassTransparencyPref · 缺省、钳制与损坏回落', () => {
  it('默认是克制的 15%', () => {
    expect(GLASS_TRANSPARENCY_DEFAULT).toBe(15);
    expect([GLASS_TRANSPARENCY_MIN, GLASS_TRANSPARENCY_MAX, GLASS_TRANSPARENCY_STEP]).toEqual([0, 60, 5]);
  });

  it('没 window / 没 localStorage / 键不存在 ⇒ 都是默认（不抛）', () => {
    stubWindow(undefined);
    expect(loadGlassTransparencyPref()).toBe(GLASS_TRANSPARENCY_DEFAULT);
    stubWindow(fakeStorage());
    expect(loadGlassTransparencyPref()).toBe(GLASS_TRANSPARENCY_DEFAULT);
  });

  it('合法值照读；越界钳到量程两端；损坏值（空串/文字/NaN/带单位）回默认', () => {
    stubWindow(fakeStorage({ [GLASS_KEY]: '30' }));
    expect(loadGlassTransparencyPref()).toBe(30);
    stubWindow(fakeStorage({ [GLASS_KEY]: String(GLASS_TRANSPARENCY_MIN - 5) }));
    expect(loadGlassTransparencyPref()).toBe(GLASS_TRANSPARENCY_MIN);
    stubWindow(fakeStorage({ [GLASS_KEY]: String(GLASS_TRANSPARENCY_MAX + 99) }));
    expect(loadGlassTransparencyPref()).toBe(GLASS_TRANSPARENCY_MAX);
    for (const junk of ['', 'abc', 'NaN', 'Infinity', '  ', '12%']) {
      stubWindow(fakeStorage({ [GLASS_KEY]: junk }));
      expect(loadGlassTransparencyPref(), junk).toBe(GLASS_TRANSPARENCY_DEFAULT);
    }
  });

  it('小数四舍五入到整数档', () => {
    stubWindow(fakeStorage({ [GLASS_KEY]: '22.6' }));
    expect(loadGlassTransparencyPref()).toBe(23);
  });

  it('读抛错 ⇒ 回默认，绝不抛到渲染链', () => {
    const boom = {
      getItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    stubWindow(boom);
    expect(loadGlassTransparencyPref()).toBe(GLASS_TRANSPARENCY_DEFAULT);
  });
});

describe('clampGlassTransparency / glassAlphaFromTransparency · 纯换算', () => {
  it('非有限数回默认，其余夹到区间', () => {
    expect(clampGlassTransparency(Number.NaN)).toBe(GLASS_TRANSPARENCY_DEFAULT);
    expect(clampGlassTransparency(-Infinity)).toBe(GLASS_TRANSPARENCY_DEFAULT);
    expect(clampGlassTransparency(999)).toBe(GLASS_TRANSPARENCY_MAX);
    expect(clampGlassTransparency(-3)).toBe(GLASS_TRANSPARENCY_MIN);
    expect(clampGlassTransparency(7.4)).toBe(7);
  });

  it('透明度 → 填充不透明度：0%→1、15%→0.85、60%→0.4', () => {
    expect(glassAlphaFromTransparency(0)).toBe(1);
    expect(glassAlphaFromTransparency(15)).toBe(0.85);
    expect(glassAlphaFromTransparency(60)).toBe(0.4);
    // 越界/损坏也走钳制，绝不产出越界的 alpha
    expect(glassAlphaFromTransparency(999)).toBe(0.4);
    expect(glassAlphaFromTransparency(Number.NaN)).toBe(0.85);
  });
});

describe('set / step · 写与通知', () => {
  it('写入前钳制：99 存成上限、-9 存成下限', () => {
    const storage = fakeStorage();
    stubWindow(storage);
    setGlassTransparencyPref(GLASS_TRANSPARENCY_MAX + 6);
    expect(storage.getItem(GLASS_KEY)).toBe(String(GLASS_TRANSPARENCY_MAX));
    setGlassTransparencyPref(GLASS_TRANSPARENCY_MIN - 9);
    expect(storage.getItem(GLASS_KEY)).toBe(String(GLASS_TRANSPARENCY_MIN));
  });

  it('步进以持久化为基准、一档 5%，两端停下不再越界', () => {
    stubWindow(fakeStorage());
    setGlassTransparencyPref(GLASS_TRANSPARENCY_MAX);
    stepGlassTransparencyPref(1);
    expect(loadGlassTransparencyPref()).toBe(GLASS_TRANSPARENCY_MAX);
    stepGlassTransparencyPref(-1);
    expect(loadGlassTransparencyPref()).toBe(GLASS_TRANSPARENCY_MAX - GLASS_TRANSPARENCY_STEP);
    setGlassTransparencyPref(GLASS_TRANSPARENCY_MIN);
    stepGlassTransparencyPref(-1);
    expect(loadGlassTransparencyPref()).toBe(GLASS_TRANSPARENCY_MIN);
    resetGlassTransparencyPref();
    expect(loadGlassTransparencyPref()).toBe(GLASS_TRANSPARENCY_DEFAULT);
  });

  it('订阅者逐一收到通知；取消后不再收到；写抛错也照样通知', () => {
    const boom = {
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage;
    stubWindow(boom);
    const a = vi.fn();
    const unsubA = subscribeGlassPref(a);
    const b = vi.fn();
    subscribeGlassPref(b);
    stepGlassTransparencyPref(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    setGlassTransparencyPref(20);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});

describe('applyGlassPref · 唯一生效路径', () => {
  it('写根元素的 --glass-alpha（换算后）与 data-glass；非 0% 是 on', () => {
    stubWindow(fakeStorage({ [GLASS_KEY]: '15' }));
    const root = stubRoot();
    applyGlassPref(15, root);
    expect(root.props['--glass-alpha']).toBe('0.85');
    expect(root.attrs['data-glass']).toBe('on');
  });

  it('0% ⇒ data-glass=solid、--glass-alpha=1（样式据此撤掉磨砂）', () => {
    const root = stubRoot();
    applyGlassPref(0, root);
    expect(root.props['--glass-alpha']).toBe('1');
    expect(root.attrs['data-glass']).toBe('solid');
  });

  it('缺省读当前偏好；写入前再钳一次', () => {
    stubWindow(fakeStorage({ [GLASS_KEY]: '999' }));
    const root = stubRoot();
    applyGlassPref(undefined, root); // 缺省参 ⇒ 现读持久化值（已钳到 60）
    expect(root.props['--glass-alpha']).toBe('0.4'); // 钳到 60% 后换算
    applyGlassPref(-50, root);
    expect(root.props['--glass-alpha']).toBe('1');
    expect(root.attrs['data-glass']).toBe('solid');
  });

  it('根元素为 null 时安全跳过；缺省 root 在 node（无 document）下 no-op，不抛', () => {
    expect(() => applyGlassPref(15, null)).not.toThrow();
    expect(typeof document).toBe('undefined');
    expect(() => applyGlassPref(15)).not.toThrow();
  });
});
