/**
 * 自动保存偏好单测（A6）。契约照 `font-size-pref.test.ts`：
 * ①默认**关**（游戏目录是部署目标，静默写盘必须显式选择）；②损坏/未在册值回默认，绝不抛；
 * ③set 写穿 localStorage 并广播、取消订阅后不再收；④`decideAutosave` 护栏判定表全覆盖
 *   （needs-choice / 外部改动未决 / 糖视图 / 不可写 / 互斥在途 / 不脏 各归各位）。
 * 单测环境是 `node`（无 window），用假 localStorage 驱动。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MODE_DEFAULT,
  decideAutosave,
  loadAutosavePref,
  parseAutosaveMode,
  setAutosavePref,
  subscribeAutosavePref,
  type AutosaveGateInput,
} from '../src/ui/autosave-pref';

const KEY = 'kojo.ui.autosave.v1';

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

/** 全绿的现场读数（各护栏用例只翻自己那一格） */
const PASS: AutosaveGateInput = {
  mode: 'afterDelay',
  dirty: true,
  saving: false,
  saveWarningPending: false,
  externalChangePending: false,
  sugarView: false,
  writable: true,
};

afterEach(() => vi.unstubAllGlobals());

describe('loadAutosavePref · 缺省与损坏回落', () => {
  it('默认关；闲置窗口 1000ms（口径写死在一处，UI 文案从这里算秒数）', () => {
    expect(AUTOSAVE_MODE_DEFAULT).toBe('off');
    expect(AUTOSAVE_IDLE_MS).toBe(1000);
    stubWindow(undefined);
    expect(loadAutosavePref()).toBe('off');
  });

  it('在册档位照读；未在册 / 损坏一律回默认（坏值不许把默认翻成"开"）', () => {
    stubWindow(fakeStorage({ [KEY]: 'afterDelay' }));
    expect(loadAutosavePref()).toBe('afterDelay');
    for (const junk of ['', 'on', 'onBlur', 'AFTERDELAY', 'NaN']) {
      stubWindow(fakeStorage({ [KEY]: junk }));
      expect(loadAutosavePref(), junk).toBe('off');
    }
    expect(parseAutosaveMode(null)).toBe('off');
    expect(parseAutosaveMode('afterDelay')).toBe('afterDelay');
  });

  it('读抛错 ⇒ 回默认，绝不抛进渲染链', () => {
    const boom = { getItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    stubWindow(boom);
    expect(loadAutosavePref()).toBe('off');
  });
});

describe('setAutosavePref · 写与通知', () => {
  it('写入 localStorage 唯一真源；订阅者逐一收到；取消后不再收', () => {
    const storage = fakeStorage();
    stubWindow(storage);
    const a = vi.fn();
    const unsubA = subscribeAutosavePref(a);
    const b = vi.fn();
    subscribeAutosavePref(b);
    setAutosavePref('afterDelay');
    expect(storage.getItem(KEY)).toBe('afterDelay');
    expect(loadAutosavePref()).toBe('afterDelay');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    setAutosavePref('off');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('写抛错（隐私模式/配额满）也照样广播——本次会话内仍是你的选择', () => {
    const boom = { setItem: () => { throw new Error('quota'); } } as unknown as Storage;
    stubWindow(boom);
    const a = vi.fn();
    subscribeAutosavePref(a);
    setAutosavePref('afterDelay');
    expect(a).toHaveBeenCalledTimes(1);
  });
});

describe('decideAutosave · 护栏判定表（跳过原因如实可辨，不静默）', () => {
  it('全绿现场 ⇒ run', () => {
    expect(decideAutosave(PASS)).toBe('run');
  });

  it('每条护栏各归各位；优先级 = 开关 → 有无内容 → 互斥 → 数据护栏 → 写权限', () => {
    expect(decideAutosave({ ...PASS, mode: 'off' })).toBe('off');
    expect(decideAutosave({ ...PASS, dirty: false })).toBe('clean');
    expect(decideAutosave({ ...PASS, saving: true })).toBe('saving');
    expect(decideAutosave({ ...PASS, saveWarningPending: true })).toBe('needs-choice');
    expect(decideAutosave({ ...PASS, externalChangePending: true })).toBe('external-change');
    expect(decideAutosave({ ...PASS, sugarView: true })).toBe('sugar-view');
    expect(decideAutosave({ ...PASS, writable: false })).toBe('readonly');
  });

  it('护栏叠着时按优先级报第一条（needs-choice 先于糖视图与不可写）', () => {
    expect(
      decideAutosave({ ...PASS, saveWarningPending: true, sugarView: true, writable: false }),
    ).toBe('needs-choice');
    expect(decideAutosave({ ...PASS, dirty: false, saveWarningPending: true })).toBe('clean');
  });
});
