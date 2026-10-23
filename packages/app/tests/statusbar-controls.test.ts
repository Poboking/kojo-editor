/**
 * 批次十 S1 · 状态栏控制面（语言模式 / 缩进 / 编码三格）。
 *
 * 本文件**不引真 Monaco、也不渲染 DOM**——三格的纯逻辑（持久化 / 缺省 / 循环 / 脏分支）
 * 是重开恢复与编码动作确认的唯一真源，直接对各自模块取证：
 * - `language-mode-pref.ts`：按路径存"语言 id"，`languageOverrideFor(path)` 重开恢复；
 * - `indentation-pref.ts`：按路径存 Tab / 2 / 4 / 8，点击循环与 `updateOptions` 映射；
 * - `ShellLayout.tsx` 的 `encodingConfirmMessage`：脏文档先确认的唯一判据。
 *
 * 挂在 `node` 环境（仓库 app 池的默认环境）：偏好模块只在**调用时**摸 `window.localStorage`，
 * 所以给一份最小存储垫片即可跑纯逻辑，不需要 DOM 环境。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodingConfirmMessage } from '../src/ui/ShellLayout';
import {
  LANGUAGE_MODE_BASE_CHOICES,
  languageModeChoices,
  languageOverrideFor,
  resolveModelLanguage,
  setLanguageOverride,
  clearLanguageOverride,
  subscribeLanguageOverride,
} from '../src/ui/language-mode-pref';
import {
  INDENT_DEFAULT,
  applyIndentPref,
  indentChoiceFromOptions,
  indentLabel,
  indentLabelFromOptions,
  indentOptions,
  indentPrefFor,
  nextIndentChoice,
  setIndentPref,
  storedIndentChoiceFor,
} from '../src/ui/indentation-pref';

const WIN_PATH = 'C:\\kojo\\project\\口上\\角色.erb';

/** 最小 localStorage 垫片（node 池没有 window；偏好模块的读取面就是这几条） */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  } as Storage;
}

beforeAll(() => {
  (globalThis as { window?: { localStorage: Storage } }).window = { localStorage: memoryStorage() };
});

describe('编码动作的脏分支（encodingConfirmMessage）', () => {
  it('干净文档 ⇒ 不确认；脏文档按动作类型给出中文说明', () => {
    expect(encodingConfirmMessage('reopen', 'gbk', false)).toBeNull();
    expect(encodingConfirmMessage('save', 'gbk', false)).toBeNull();
    expect(encodingConfirmMessage('reopen', 'gbk', true)).toContain('未保存修改');
    expect(encodingConfirmMessage('save', 'gbk', true)).toContain('丢字');
  });
});

describe('语言模式偏好（language-mode-pref）', () => {
  beforeEach(() => window.localStorage.clear());

  it('没存过 ⇒ null（调用方回落到扩展名判据）；空路径也不落键', () => {
    expect(languageOverrideFor(WIN_PATH)).toBeNull();
    setLanguageOverride('', 'json');
    expect(window.localStorage.getItem('kojo.languageMode.v1')).toBeNull();
  });

  it('按路径持久化，重读得到原值；路径归一（大小写 / 分隔符）指向同一条', () => {
    setLanguageOverride(WIN_PATH, 'json');
    expect(languageOverrideFor(WIN_PATH)).toBe('json');
    expect(languageOverrideFor('c:/kojo/project/口上/角色.erb')).toBe('json');
    // 另一份文件互不影响
    expect(languageOverrideFor('C:\\kojo\\project\\口上\\其他.erb')).toBeNull();
  });

  it('撤销选择 ⇒ 清该条；清完空表连键一起移除', () => {
    setLanguageOverride(WIN_PATH, 'kojo2');
    clearLanguageOverride(WIN_PATH);
    expect(languageOverrideFor(WIN_PATH)).toBeNull();
    expect(window.localStorage.getItem('kojo.languageMode.v1')).toBeNull();
  });

  it('脏存储（非 JSON / 数组 / 空串值）一律当"没存过"，绝不抛', () => {
    window.localStorage.setItem('kojo.languageMode.v1', 'not-json');
    expect(languageOverrideFor(WIN_PATH)).toBeNull();
    window.localStorage.setItem('kojo.languageMode.v1', '[]');
    expect(languageOverrideFor(WIN_PATH)).toBeNull();
    window.localStorage.setItem(
      'kojo.languageMode.v1',
      JSON.stringify({ 'c:\\kojo\\project\\口上\\角色.erb': '' }),
    );
    expect(languageOverrideFor(WIN_PATH)).toBeNull();
  });

  it('菜单项 = 四档固定项 ∪ 注册面 id（去重、追加在后）', () => {
    expect(languageModeChoices([])).toEqual([...LANGUAGE_MODE_BASE_CHOICES]);
    expect(languageModeChoices(['kojo-sugar', 'json', ''])).toEqual([
      ...LANGUAGE_MODE_BASE_CHOICES,
      'kojo-sugar',
    ]);
  });

  it('单一判据 resolveModelLanguage：覆盖 > descriptor，无覆盖原样交回', () => {
    expect(resolveModelLanguage(WIN_PATH, 'kojo-erb')).toBe('kojo-erb');
    setLanguageOverride(WIN_PATH, 'json');
    expect(resolveModelLanguage(WIN_PATH, 'kojo-erb')).toBe('json');
    clearLanguageOverride(WIN_PATH);
    expect(resolveModelLanguage(WIN_PATH, 'kojo-erb')).toBe('kojo-erb');
  });

  it('覆盖变更广播给订阅者（设置值 / 撤销 null 两个方向）；退订后不再收到', () => {
    const seen: Array<[string, string | null]> = [];
    const unsubscribe = subscribeLanguageOverride((filePath, languageId) => {
      seen.push([filePath, languageId]);
    });
    setLanguageOverride(WIN_PATH, 'json');
    clearLanguageOverride(WIN_PATH);
    unsubscribe();
    setLanguageOverride(WIN_PATH, 'kojo2');
    expect(seen).toEqual([
      [WIN_PATH, 'json'],
      [WIN_PATH, null],
    ]);
  });
});

describe('缩进偏好（indentation-pref）', () => {
  beforeEach(() => window.localStorage.clear());

  it('缺省 Tab；没存过时 stored… 为 null（重开恢复不去覆盖 model 缺省）', () => {
    expect(INDENT_DEFAULT).toBe('tab');
    expect(indentPrefFor(WIN_PATH)).toBe('tab');
    expect(storedIndentChoiceFor(WIN_PATH)).toBeNull();
  });

  it('按路径持久化；Tab → 2 → 4 → 8 → Tab 循环', () => {
    setIndentPref(WIN_PATH, 4);
    expect(indentPrefFor(WIN_PATH)).toBe(4);
    expect(indentPrefFor('C:\\kojo\\project\\口上\\另一份.erb')).toBe('tab');
    expect(nextIndentChoice('tab')).toBe(2);
    expect(nextIndentChoice(2)).toBe(4);
    expect(nextIndentChoice(4)).toBe(8);
    expect(nextIndentChoice(8)).toBe('tab');
  });

  it('档位 → Monaco 选项；读数文案 Tab / Spaces:N；认不出的档位如实显示', () => {
    expect(indentOptions('tab')).toEqual({ insertSpaces: false, tabSize: 4 });
    expect(indentOptions(2)).toEqual({ insertSpaces: true, tabSize: 2 });
    expect(indentLabel('tab')).toBe('Tab');
    expect(indentLabel(8)).toBe('Spaces:8');
    expect(indentChoiceFromOptions({ insertSpaces: false, tabSize: 7 })).toBe('tab');
    expect(indentChoiceFromOptions({ insertSpaces: true, tabSize: 2 })).toBe(2);
    expect(indentChoiceFromOptions({ insertSpaces: true, tabSize: 3 })).toBeNull();
    expect(indentLabelFromOptions({ insertSpaces: true, tabSize: 3 })).toBe('Spaces:3');
  });

  it('applyIndentPref 命中 model.updateOptions；model 缺席时静默早退', () => {
    const model = { getOptions: () => ({ insertSpaces: false, tabSize: 4 }), updateOptions: vi.fn() };
    applyIndentPref(model, 8);
    expect(model.updateOptions).toHaveBeenCalledWith({ insertSpaces: true, tabSize: 8 });
    expect(() => applyIndentPref(null, 2)).not.toThrow();
  });

  it('脏存储（非 JSON / 非法档位）回默认，不抛', () => {
    window.localStorage.setItem('kojo.indentation.v1', '{oops');
    expect(indentPrefFor(WIN_PATH)).toBe('tab');
    window.localStorage.setItem(
      'kojo.indentation.v1',
      JSON.stringify({ 'c:\\kojo\\project\\口上\\角色.erb': 3 }),
    );
    expect(indentPrefFor(WIN_PATH)).toBe('tab');
  });
});
