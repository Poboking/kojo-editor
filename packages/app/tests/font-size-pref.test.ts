/**
 * 字号/缩放偏好单测（A1）。契约照 `semantic-color-pref.test.ts`：
 * ①默认 = 原硬编码 14px / 缩放 0 档；②损坏值与抛错一律回默认/钳制，绝不抛到渲染链；
 * ③生效路径唯一（字号 → `updateOptions({fontSize})`；缩放 → 注入的 EditorZoom 假对象）。
 * 单测环境是 `node`（无 window），用假 localStorage 驱动。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_ZOOM_DEFAULT,
  FONT_ZOOM_MAX,
  FONT_ZOOM_MIN,
  applyFontSizePref,
  applyFontZoomPref,
  clampFontZoom,
  clampFontSize,
  loadFontSizePref,
  loadFontZoomPref,
  resetFontZoomPref,
  setFontSizePref,
  setFontZoomPref,
  stepFontSizePref,
  stepFontZoomPref,
  subscribeFontSizePref,
  type FontSizeTarget,
  type FontZoomTarget,
} from '../src/ui/font-size-pref';

const SIZE_KEY = 'kojo.ui.fontSize.v1';
const ZOOM_KEY = 'kojo.ui.fontZoom.v1';

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

/** 假编辑器：只记 updateOptions 收到过什么 */
function stubEditor(): FontSizeTarget & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return { calls, updateOptions: (options) => void calls.push(options) };
}

/** 假 EditorZoom：记 setZoomLevel（真单例自带 -5..20 闸，这里不模拟——钳制归模块管） */
function stubZoom(): FontZoomTarget & { levels: number[] } {
  const levels: number[] = [];
  return { levels, getZoomLevel: () => levels.at(-1) ?? 0, setZoomLevel: (level) => void levels.push(level) };
}

afterEach(() => vi.unstubAllGlobals());

describe('loadFontSizePref · 缺省、钳制与损坏回落', () => {
  it('默认就是原硬编码 14', () => {
    expect(FONT_SIZE_DEFAULT).toBe(14);
  });

  it('没 window / 没 localStorage / 键不存在 ⇒ 都是默认（不抛）', () => {
    stubWindow(undefined);
    expect(loadFontSizePref()).toBe(FONT_SIZE_DEFAULT);
    stubWindow(fakeStorage());
    expect(loadFontSizePref()).toBe(FONT_SIZE_DEFAULT);
  });

  it('合法值照读；越界钳到量程两端；损坏值（空串/文字/NaN）回默认', () => {
    stubWindow(fakeStorage({ [SIZE_KEY]: '18' }));
    expect(loadFontSizePref()).toBe(18);
    stubWindow(fakeStorage({ [SIZE_KEY]: String(FONT_SIZE_MIN - 2) }));
    expect(loadFontSizePref()).toBe(FONT_SIZE_MIN);
    stubWindow(fakeStorage({ [SIZE_KEY]: String(FONT_SIZE_MAX + 99) }));
    expect(loadFontSizePref()).toBe(FONT_SIZE_MAX);
    for (const junk of ['', 'abc', 'NaN', 'Infinity', '  ', '12px']) {
      stubWindow(fakeStorage({ [SIZE_KEY]: junk }));
      expect(loadFontSizePref(), junk).toBe(FONT_SIZE_DEFAULT);
    }
  });

  it('读抛错 ⇒ 回默认，绝不抛到编辑器链路', () => {
    const boom = { getItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    stubWindow(boom);
    expect(loadFontSizePref()).toBe(FONT_SIZE_DEFAULT);
    expect(loadFontZoomPref()).toBe(FONT_ZOOM_DEFAULT);
  });
});

describe('loadFontZoomPref · 档位轴', () => {
  it('默认 0 档；钳制区间与 Monaco EditorZoom 内部闸一致', () => {
    expect(FONT_ZOOM_DEFAULT).toBe(0);
    expect([FONT_ZOOM_MIN, FONT_ZOOM_MAX]).toEqual([-5, 20]);
    stubWindow(fakeStorage({ [ZOOM_KEY]: '999' }));
    expect(loadFontZoomPref()).toBe(FONT_ZOOM_MAX);
    stubWindow(fakeStorage({ [ZOOM_KEY]: '-999' }));
    expect(loadFontZoomPref()).toBe(FONT_ZOOM_MIN);
  });

  it('档位是整数：小数四舍五入；损坏值回默认', () => {
    stubWindow(fakeStorage({ [ZOOM_KEY]: '2.6' }));
    expect(loadFontZoomPref()).toBe(3);
    for (const junk of ['', 'x', 'NaN']) {
      stubWindow(fakeStorage({ [ZOOM_KEY]: junk }));
      expect(loadFontZoomPref(), junk).toBe(FONT_ZOOM_DEFAULT);
    }
  });
});

describe('set / step · 写与通知', () => {
  it('写入前钳制：30px 存成上限、-9 档存成下限', () => {
    const storage = fakeStorage();
    stubWindow(storage);
    setFontSizePref(FONT_SIZE_MAX + 6);
    expect(storage.getItem(SIZE_KEY)).toBe(String(FONT_SIZE_MAX));
    setFontZoomPref(FONT_ZOOM_MIN - 4);
    expect(storage.getItem(ZOOM_KEY)).toBe(String(FONT_ZOOM_MIN));
  });

  it('步进以持久化为基准，两端停下不再越界', () => {
    stubWindow(fakeStorage());
    setFontSizePref(FONT_SIZE_MAX);
    stepFontSizePref(1);
    expect(loadFontSizePref()).toBe(FONT_SIZE_MAX);
    stepFontSizePref(-1);
    expect(loadFontSizePref()).toBe(FONT_SIZE_MAX - 1);
    setFontZoomPref(FONT_ZOOM_MIN);
    stepFontZoomPref(-1);
    expect(loadFontZoomPref()).toBe(FONT_ZOOM_MIN);
    resetFontZoomPref();
    expect(loadFontZoomPref()).toBe(FONT_ZOOM_DEFAULT);
  });

  it('订阅者逐一收到通知；取消后不再收到；写抛错也照样通知', () => {
    const boom = { setItem: () => { throw new Error('quota'); } } as unknown as Storage;
    stubWindow(boom);
    const a = vi.fn();
    const unsubA = subscribeFontSizePref(a);
    const b = vi.fn();
    subscribeFontSizePref(b);
    stepFontSizePref(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    setFontZoomPref(2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});

describe('纯钳制函数（NaN 不进渲染链）', () => {
  it('非有限数回默认（损坏口径），其余夹到区间', () => {
    expect(clampFontSize(Number.NaN)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(-Infinity)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(999)).toBe(FONT_SIZE_MAX);
    expect(clampFontZoom(Number.POSITIVE_INFINITY)).toBe(FONT_ZOOM_DEFAULT);
    expect(clampFontZoom(7.4)).toBe(7);
  });
});

describe('apply · 唯一生效路径', () => {
  it('字号 → updateOptions({fontSize})，缺省读当前偏好，写入前再钳一次', () => {
    stubWindow(fakeStorage({ [SIZE_KEY]: '40' }));
    const editor = stubEditor();
    applyFontSizePref(editor);
    applyFontSizePref(editor, 3);
    expect(editor.calls).toEqual([{ fontSize: FONT_SIZE_MAX }, { fontSize: FONT_SIZE_MIN }]);
  });

  it('缩放 → 注入对象的 setZoomLevel（钳后档位），缺省读当前偏好', () => {
    stubWindow(fakeStorage({ [ZOOM_KEY]: '999' }));
    const zoom = stubZoom();
    applyFontZoomPref(zoom);
    applyFontZoomPref(zoom, -2);
    expect(zoom.levels).toEqual([FONT_ZOOM_MAX, -2]);
  });

  it('没有目标 / 没有 window 都静默跳过（不抛）', () => {
    stubWindow(undefined);
    expect(() => applyFontSizePref(null)).not.toThrow();
    expect(() => applyFontSizePref(undefined)).not.toThrow();
    expect(() => applyFontZoomPref(undefined)).not.toThrow();
    expect(() => applyFontSizePref(stubEditor())).not.toThrow();
    expect(() => applyFontZoomPref(stubZoom())).not.toThrow();
  });
});
