/**
 * 编辑器显示偏好单测（1020 编辑器体感批）。契约照 `font-size-pref.test.ts` /
 * `layout-pref` 那一份：①缺省 = 今天硬编码的那几个值（没动过设置的作者逐字不变）；
 * ②坏值一律清洗或回落，绝不抛进渲染链；③生效路径唯一（补丁只由本模块算，档位表不读偏好）。
 *
 * 单测环境是 `node`（无 window），用假 localStorage 驱动。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDITOR_DISPLAY_PREF_DEFAULT,
  editorDisplayFontPatch,
  editorDisplayOptionPatch,
  loadEditorDisplayPrefs,
  modifiedEditorDisplayKeys,
  resetEditorDisplayPrefs,
  sanitizeFontFamily,
  sanitizeLineHeight,
  saveEditorDisplayPrefs,
  subscribeEditorDisplayPrefs,
} from '../src/ui/editor-display-prefs';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('缺省 = 今天硬编码的那一份', () => {
  it('无 window / 空表 ⇒ 全缺省（行高 0=自动、空白符 none、缩略图开、行号 on、字体族默认、行内提示开）', () => {
    stubWindow(undefined);
    expect(loadEditorDisplayPrefs()).toEqual(EDITOR_DISPLAY_PREF_DEFAULT);
    stubWindow(fakeStorage());
    expect(loadEditorDisplayPrefs()).toEqual(EDITOR_DISPLAY_PREF_DEFAULT);
  });

  it('缺省补丁不改变今天任何一个 Monaco 读数', () => {
    stubWindow(fakeStorage());
    const p = editorDisplayOptionPatch(100);
    expect(p.lineHeight).toBe(0);
    expect(p.renderWhitespace).toBe('none');
    expect(p.minimap).toEqual({ enabled: true, renderCharacters: false, maxColumn: 72 });
    expect(p.lineNumbers).toBe('on');
    expect(p.inlayHints).toEqual({ enabled: 'on' });
    // 字体族缺省 = 不发送（保留 CODE_FONT_BASELINE 那条栈）
    expect(editorDisplayFontPatch()).toEqual({});
  });

  it('快照引用稳定（useSyncExternalStore 的 getSnapshot 契约：值没变返回同一对象）', () => {
    const s = fakeStorage();
    stubWindow(s);
    const a = loadEditorDisplayPrefs();
    saveEditorDisplayPrefs({ minimap: true }); // 与缺省同值 ⇒ 值没变
    expect(loadEditorDisplayPrefs()).toBe(a);
    saveEditorDisplayPrefs({ minimap: false });
    expect(loadEditorDisplayPrefs()).not.toBe(a);
  });
});

describe('坏值清洗（绝不抛进渲染链）', () => {
  it('行高：0 或 14–96 的整数；负数 / 小数 / NaN / 超大都回合法域', () => {
    expect(sanitizeLineHeight(0)).toBe(0);
    expect(sanitizeLineHeight(22.7)).toBe(22);
    expect(sanitizeLineHeight(-3)).toBe(14);
    expect(sanitizeLineHeight(999)).toBe(96);
    expect(sanitizeLineHeight(Number.NaN)).toBe(0);
    expect(sanitizeLineHeight('18' as unknown as number)).toBe(0);
  });

  it('枚举：只有登记值算数，脏值与大小写变体回落缺省', () => {
    stubWindow(
      fakeStorage({
        'kojo.ui.editor.renderWhitespace.v1': 'ALL',
        'kojo.ui.editor.lineNumbers.v1': 'weird',
      }),
    );
    const p = loadEditorDisplayPrefs();
    expect(p.renderWhitespace).toBe('none');
    expect(p.lineNumbers).toBe('on');
  });

  it('localStorage 抛错 ⇒ 整份回落缺省（隐私模式不该把编辑器带崩）', () => {
    const boom = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    } as unknown as Storage;
    stubWindow(boom);
    expect(loadEditorDisplayPrefs()).toEqual(EDITOR_DISPLAY_PREF_DEFAULT);
  });
});

describe('字体族清洗', () => {
  it('空 / 全空格 / 只有逗号 ⇒ 空串（= 用默认栈）', () => {
    expect(sanitizeFontFamily('')).toBe('');
    expect(sanitizeFontFamily('   ')).toBe('');
    expect(sanitizeFontFamily(', ,')).toBe('');
    expect(sanitizeFontFamily(undefined)).toBe('');
  });

  it('去空成员 + 补 monospace 兜底（isUsableCodeFontStack 的硬要求）', () => {
    expect(sanitizeFontFamily('Consolas')).toBe('Consolas, monospace');
    expect(sanitizeFontFamily("'Cascadia Code', ,  YaHei")).toBe("'Cascadia Code', YaHei, monospace");
    expect(sanitizeFontFamily('Consolas, monospace')).toBe('Consolas, monospace');
  });

  it('清洗后的值才落盘；字体补丁只在非空时发送', () => {
    stubWindow(fakeStorage());
    saveEditorDisplayPrefs({ fontFamily: 'Consolas' });
    expect(loadEditorDisplayPrefs().fontFamily).toBe('Consolas, monospace');
    expect(editorDisplayFontPatch()).toEqual({ fontFamily: 'Consolas, monospace' });
    saveEditorDisplayPrefs({ fontFamily: '' });
    expect(editorDisplayFontPatch()).toEqual({});
  });
});

describe('补丁与体量档的叠加（偏好不许把 huge 档的关值翻回来）', () => {
  it('缩略图：用户开 ⇒ small/large 开、huge 仍关；用户关 ⇒ 三档全关', () => {
    stubWindow(fakeStorage());
    saveEditorDisplayPrefs({ minimap: true });
    expect(editorDisplayOptionPatch(100).minimap?.enabled).toBe(true);
    expect(editorDisplayOptionPatch(6_000).minimap?.enabled).toBe(true);
    expect(editorDisplayOptionPatch(60_000).minimap?.enabled).toBe(false);
    saveEditorDisplayPrefs({ minimap: false });
    for (const n of [100, 6_000, 60_000]) {
      expect(editorDisplayOptionPatch(n).minimap, `${n} 行应当整条关`).toEqual({
        enabled: false,
        renderCharacters: false,
        maxColumn: 72,
      });
    }
  });

  it('行内提示只映射开关，大文件的让路仍归 provider 侧（本模块不越过那条判据）', () => {
    stubWindow(fakeStorage());
    saveEditorDisplayPrefs({ inlayHints: false });
    expect(editorDisplayOptionPatch(100).inlayHints).toEqual({ enabled: 'off' });
    expect(editorDisplayOptionPatch(60_000).inlayHints).toEqual({ enabled: 'off' });
    saveEditorDisplayPrefs({ inlayHints: true });
    expect(editorDisplayOptionPatch(100).inlayHints).toEqual({ enabled: 'on' });
  });

  it('行高 / 空白符 / 行号与体量正交：任何行数都按用户值发', () => {
    stubWindow(fakeStorage());
    saveEditorDisplayPrefs({ lineHeight: 24, renderWhitespace: 'boundary', lineNumbers: 'relative' });
    for (const n of [100, 6_000, 60_000, 990_000]) {
      const p = editorDisplayOptionPatch(n);
      expect(p.lineHeight, `${n}`).toBe(24);
      expect(p.renderWhitespace, `${n}`).toBe('boundary');
      expect(p.lineNumbers, `${n}`).toBe('relative');
    }
  });

  it('补丁永不含 fontSize / zoomLevel（A1 那条不变式不许被新偏好破）', () => {
    stubWindow(fakeStorage());
    saveEditorDisplayPrefs({ lineHeight: 20, fontFamily: 'Consolas' });
    for (const p of [editorDisplayOptionPatch(6_000), editorDisplayFontPatch()]) {
      expect(Object.keys(p)).not.toContain('fontSize');
      expect(Object.keys(p)).not.toContain('zoomLevel');
    }
  });
});

describe('订阅与已修改读数', () => {
  it('写入即广播；退订后不再收到', () => {
    stubWindow(fakeStorage());
    let hits = 0;
    const off = subscribeEditorDisplayPrefs(() => {
      hits++;
    });
    saveEditorDisplayPrefs({ lineNumbers: 'off' });
    expect(hits).toBe(1);
    off();
    saveEditorDisplayPrefs({ lineNumbers: 'on' });
    expect(hits).toBe(1);
  });

  it('modifiedEditorDisplayKeys：只报偏离缺省的键；全缺省 = 空表', () => {
    stubWindow(fakeStorage());
    expect(modifiedEditorDisplayKeys()).toEqual([]);
    saveEditorDisplayPrefs({ minimap: true }); // 与缺省同值 ⇒ 不算已修改
    expect(modifiedEditorDisplayKeys()).toEqual([]);
    saveEditorDisplayPrefs({ lineHeight: 24, renderWhitespace: 'all' });
    expect(modifiedEditorDisplayKeys()).toEqual(['lineHeight', 'renderWhitespace']);
  });

  it('reset 回到全缺省并清掉「已修改」', () => {
    stubWindow(fakeStorage());
    saveEditorDisplayPrefs({ lineHeight: 28, minimap: false, fontFamily: 'Consolas' });
    expect(modifiedEditorDisplayKeys().length).toBe(3);
    resetEditorDisplayPrefs();
    expect(loadEditorDisplayPrefs()).toEqual(EDITOR_DISPLAY_PREF_DEFAULT);
    expect(modifiedEditorDisplayKeys()).toEqual([]);
  });
});
