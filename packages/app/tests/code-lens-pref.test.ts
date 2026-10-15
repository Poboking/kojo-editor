/**
 * 「标注函数被谁调用」偏好单测（B8）。存法与契约照 `format-pref.test.ts`：
 * ①默认**关**（往正文里插行的能力必须作者主动来要）；②读不到 / 抛错一律回默认，
 * 绝不把编辑器的呈现链卡死；③只有明确存过 `on` 才算开（别的取值都是关）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODE_LENS_DEFAULT, loadCodeLensPref, saveCodeLensPref } from '../src/ui/code-lens-pref';

const KEY = 'kojo.ui.codeLens.v1';

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

describe('loadCodeLensPref · 缺省与回落', () => {
  it('默认是关', () => {
    expect(CODE_LENS_DEFAULT).toBe(false);
  });

  it('没 window / 没 localStorage / 键不存在 / 取值不是 on ⇒ 都是关（不抛）', () => {
    stubWindow(undefined);
    expect(loadCodeLensPref()).toBe(false);
    stubWindow(fakeStorage());
    expect(loadCodeLensPref()).toBe(false);
    stubWindow(fakeStorage({ [KEY]: 'true' }));
    expect(loadCodeLensPref()).toBe(false);
    stubWindow(fakeStorage({ [KEY]: 'off' }));
    expect(loadCodeLensPref()).toBe(false);
  });

  it('存过 on 才算开', () => {
    stubWindow(fakeStorage({ [KEY]: 'on' }));
    expect(loadCodeLensPref()).toBe(true);
  });

  it('getItem 抛错（隐私模式）⇒ 回默认，不影响编辑器', () => {
    const s = fakeStorage();
    s.getItem = () => {
      throw new Error('SecurityError');
    };
    stubWindow(s);
    expect(loadCodeLensPref()).toBe(false);
  });
});

describe('saveCodeLensPref · 写入与降级', () => {
  it('开 = 写 on；关 = 删键（不留第三种取值）', () => {
    const s = fakeStorage();
    stubWindow(s);
    saveCodeLensPref(true);
    expect(s.getItem(KEY)).toBe('on');
    saveCodeLensPref(false);
    expect(s.getItem(KEY)).toBeNull();
  });

  it('setItem 抛错 ⇒ 静默（最多下次开会回到默认），不冒到设置页的 onChange', () => {
    const s = fakeStorage();
    s.setItem = () => {
      throw new Error('QuotaExceeded');
    };
    stubWindow(s);
    expect(() => saveCodeLensPref(true)).not.toThrow();
  });

  it('没有 window（node 侧调用）⇒ 不抛，读回默认', () => {
    stubWindow(undefined);
    expect(() => saveCodeLensPref(true)).not.toThrow();
    expect(loadCodeLensPref()).toBe(false);
  });
});
