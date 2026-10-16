/**
 * 「定义与调用的名字分色」偏好单测（B6）。存法与契约照 `format-pref.ts`：
 * ①默认**关**（改视觉面的新功能）；②读不到 / 抛错一律回默认，绝不把编辑器链路卡死；
 * ③开关只经 Monaco 那一条生效路径（关着 ⇒ provider 一次都不被问）。
 * 单测环境是 `node`（无 window），故用假 localStorage 驱动。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NAME_COLOR_DEFAULT,
  applyNameColorPref,
  loadNameColorPref,
  setNameColorPref,
  subscribeNameColorPref,
  type NameColorTarget,
} from '../src/ui/semantic-color-pref';

const KEY = 'kojo.ui.nameColor.v1';

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

/** 假编辑器：只记 `updateOptions` 收到过什么 */
function stubEditor(): NameColorTarget & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return { calls, updateOptions: (options) => void calls.push(options) };
}

afterEach(() => vi.unstubAllGlobals());

describe('loadNameColorPref · 缺省与回落', () => {
  it('默认是关', () => {
    expect(NAME_COLOR_DEFAULT).toBe(false);
  });

  it('没 window / 没 localStorage / 键不存在 ⇒ 都是关（不抛）', () => {
    stubWindow(undefined);
    expect(loadNameColorPref()).toBe(false);
    stubWindow(fakeStorage());
    expect(loadNameColorPref()).toBe(false);
  });

  it('存过 `on` 才算开；其它值（含 `1` / `true` / 空串）都算关', () => {
    stubWindow(fakeStorage({ [KEY]: 'on' }));
    expect(loadNameColorPref()).toBe(true);
    for (const value of ['1', 'true', '', 'off', 'ON']) {
      stubWindow(fakeStorage({ [KEY]: value }));
      expect(loadNameColorPref(), value).toBe(false);
    }
  });

  it('localStorage 读抛错 ⇒ 回默认关，绝不抛到编辑器链路', () => {
    const boom = { getItem: () => { throw new Error('quota'); } } as unknown as Storage;
    stubWindow(boom);
    expect(loadNameColorPref()).toBe(false);
  });
});

describe('setNameColorPref · 写与通知', () => {
  it('开写 `on`、关删键（不留 "off" 这种第二形态）', () => {
    const storage = fakeStorage();
    stubWindow(storage);
    setNameColorPref(true);
    expect(storage.getItem(KEY)).toBe('on');
    setNameColorPref(false);
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('订阅者逐一收到通知；取消订阅后不再收到', () => {
    stubWindow(fakeStorage());
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeNameColorPref(a);
    subscribeNameColorPref(b);
    setNameColorPref(true);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    setNameColorPref(false);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('写抛错也照样通知（本次会话立即生效是作者要的行为）', () => {
    const boom = { setItem: () => { throw new Error('quota'); }, removeItem: () => undefined } as unknown as Storage;
    stubWindow(boom);
    const listener = vi.fn();
    subscribeNameColorPref(listener);
    setNameColorPref(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('applyNameColorPref · 唯一生效路径', () => {
  it('开 → `semanticHighlighting.enabled = true`；关 → false（Monaco 自己负责挂卸着色器）', () => {
    const editor = stubEditor();
    applyNameColorPref(editor, true);
    applyNameColorPref(editor, false);
    expect(editor.calls).toEqual([
      { 'semanticHighlighting.enabled': true },
      { 'semanticHighlighting.enabled': false },
    ]);
  });

  it('缺省读当前偏好；没有编辑器 / 没有 window 都静默跳过（不抛）', () => {
    stubWindow(fakeStorage({ [KEY]: 'on' }));
    const editor = stubEditor();
    applyNameColorPref(editor);
    expect(editor.calls).toEqual([{ 'semanticHighlighting.enabled': true }]);
    expect(() => applyNameColorPref(null)).not.toThrow();
    expect(() => applyNameColorPref(undefined)).not.toThrow();
    stubWindow(undefined);
    expect(() => applyNameColorPref(stubEditor())).not.toThrow();
  });
});
