/**
 * 字体档位表单测（视觉批十二 L20）。钉四类事：
 * ①**形状**：每条代码栈过 `isUsableCodeFontStack`；每条栈里第一个 CJK 成员必须晚于
 *   **全部**拉丁成员（反了中文面自带的半比例拉丁会接管前段，整套等宽就废——理由见
 *   `code-font.ts` 头注，这里按名单逐档核对，名单即口径）；UI 栈末位泛型正确。
 * ②**兼容红线**：老用户存过非空 `fontFamily` ⇒ 它赢；档位 id 不认识 ⇒ 回落缺省档且
 *   `fellBack` 这个事实读得出（不许静默换栈）。
 * ③**生效链同串**：Monaco 补丁的 `fontFamily` 与写进根元素内联的 `--font-code` 逐字相等
 *   （一条断言读两个出口，防再次分叉）；默认档两位都**不写**（零视觉漂移）。
 * ④**逐字闸**：`UI_FONT_CSS_LINE` 在 tokens.css 原样在册、基础 `:root` 的 `font-family`
 *   走 `var(--font-ui)`、默认值与 L20 之前逐字相等。
 *
 * 环境是 node（无 window/document）：localStorage 用假表、字体可用性判定用注入替身——
 * `document.fonts.check` 的真实可用性归组长真壳复验，不在本池自证。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODE_FONT_STACK, CODE_FONT_CSS_TOKEN, isUsableCodeFontStack } from '../src/ui/code-font';
import {
  CODE_FONT_PRESETS,
  CUSTOM_CODE_FONT_PRESET_ID,
  CUSTOM_UI_FONT_PRESET_ID,
  FONT_PREVIEW_SAMPLE,
  UI_FONT_CSS_LINE,
  UI_FONT_CSS_TOKEN,
  UI_FONT_PRESETS,
  UI_FONT_SYSTEM_STACK,
  checkFontStackPresence,
  fontStackConcreteMembers,
  fontStackMembers,
  isUsableUiFontStack,
  resolveCodeFontStack,
  resolveUiFontStack,
  sanitizeUiFontFamily,
} from '../src/ui/font-presets';
import {
  EDITOR_DISPLAY_PREF_DEFAULT,
  applyFontStackCssPrefs,
  editorDisplayFontPatch,
  loadEditorDisplayPrefs,
  saveEditorDisplayPrefs,
  type EditorDisplayPrefs,
  type UiFontScaleRoot,
} from '../src/ui/editor-display-prefs';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const tokens = () => read('../src/tokens.css');

/**
 * CJK 面名单（口径注释）：这些家族**含汉字字形**，出现在栈头就会用自带半比例拉丁接管前段。
 * 判定只看"是不是中文面"，不看拉丁名拼写——`Sarasa` / `LXGW` / `Noto … CJK` / `YaHei` /
 * `SimHei` / `黑体` / `MS Gothic` / `PingFang` / `Source Han` 全在列。
 */
const CJK_FAMILIES = new Set([
  'Era Mono SC',
  'Sarasa Term SC',
  'Noto Sans Mono CJK SC',
  'Noto Sans CJK SC',
  'Noto Sans SC',
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'LXGW Console Mono',
  'LXGW WenKai Mono',
  'SimHei',
  '黑体',
  'MS Gothic',
  'PingFang SC',
  'Source Han Sans SC',
]);
const GENERIC_FAMILIES = new Set(['monospace', 'sans-serif', 'serif']);

// 原始成员（**保留引号**——引号语法闸要看的就是原样；名字比对处自行去引号）
const CODE_MEMBERS = new Map(
  CODE_FONT_PRESETS.filter((p) => p.stack !== '').map((p) => [p.id, p.stack.split(',').map((m) => m.trim())]),
);

function prefs(over: Partial<EditorDisplayPrefs>): EditorDisplayPrefs {
  return { ...EDITOR_DISPLAY_PREF_DEFAULT, ...over };
}

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

/** 假根元素：只记写了什么、摘了什么（与 editor-display-prefs.test 的同款最小面） */
function fakeRoot(): { root: UiFontScaleRoot; written: Map<string, string>; removed: string[] } {
  const written = new Map<string, string>();
  const removed: string[] = [];
  const root: UiFontScaleRoot = {
    style: {
      removeProperty: (name) => {
        removed.push(name);
        written.delete(name);
      },
      setProperty: (name, value) => void written.set(name, value),
    },
  };
  return { root, written, removed };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('档位表形状（每张栈都必须自己站得住）', () => {
  it('代码档：id 不重复；非自定义栈全过 isUsableCodeFontStack；custom 档栈恒为空串', () => {
    const ids = CODE_FONT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const custom = CODE_FONT_PRESETS.find((p) => p.id === CUSTOM_CODE_FONT_PRESET_ID);
    expect(custom?.stack).toBe('');
    for (const p of CODE_FONT_PRESETS) {
      if (p.stack === '') continue;
      expect(isUsableCodeFontStack(p.stack), `${p.id} 栈不可用：${p.stack}`).toBe(true);
    }
  });

  it('代码档：default 档逐字 = CODE_FONT_STACK（缺省零漂移）', () => {
    expect(CODE_FONT_PRESETS.find((p) => p.id === 'default')?.stack).toBe(CODE_FONT_STACK);
  });

  it('代码档：第一个 CJK 成员晚于全部拉丁成员（位置反了等宽就废）', () => {
    for (const [id, members] of CODE_MEMBERS) {
      const cjkIdx = members.findIndex((m) => CJK_FAMILIES.has(m.replace(/^'|'$/g, '')));
      expect(cjkIdx, `${id} 档没有中文收尾，拉丁面缺汉字时整条落平台默认`).toBeGreaterThan(-1);
      for (let i = 0; i < members.length; i++) {
        const name = members[i]!.replace(/^'|'$/g, '');
        if (CJK_FAMILIES.has(name) || GENERIC_FAMILIES.has(name.toLowerCase())) continue;
        expect(i, `${id} 档拉丁成员 ${name} 排在中文面之后`).toBeLessThan(cjkIdx);
      }
    }
  });

  it('代码档：含空格 / 非 ASCII 的家族名一律带引号（CSS 语法）', () => {
    for (const [id, members] of CODE_MEMBERS) {
      for (const m of members) {
        if (/ /.test(m) || !/^[\x00-\x7f]*$/.test(m)) expect(m, `${id} 档 ${m}`).toMatch(/^'.*'$/);
      }
    }
  });

  it('界面档：id 不重复；非空栈全过 isUsableUiFontStack；末位泛型正确（mono 档 = monospace）', () => {
    const ids = UI_FONT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(UI_FONT_PRESETS.find((p) => p.id === CUSTOM_UI_FONT_PRESET_ID)?.stack).toBe('');
    for (const p of UI_FONT_PRESETS) {
      if (p.stack === '') continue;
      expect(isUsableUiFontStack(p.stack), `${p.id} 栈不可用：${p.stack}`).toBe(true);
      const last = fontStackMembers(p.stack).at(-1)!.toLowerCase();
      expect(last, `${p.id} 末位泛型`).toBe(p.id === 'mono' ? 'monospace' : 'sans-serif');
    }
  });

  it('界面 system 档逐字 = UI_FONT_SYSTEM_STACK（现状那串，默认零视觉变化）', () => {
    expect(UI_FONT_PRESETS.find((p) => p.id === 'system')?.stack).toBe(
      "'Segoe UI', 'Microsoft YaHei UI', 'Noto Sans CJK SC', sans-serif",
    );
  });

  it('预览样例含全角、中日汉字与易连字符号（所见即所得必须看得见这三类）', () => {
    expect(FONT_PREVIEW_SAMPLE).toContain('100％');
    expect(FONT_PREVIEW_SAMPLE).toContain('　'); // 全角空格
    expect(FONT_PREVIEW_SAMPLE).toMatch(/[一-鿿]/);
    for (const sym of ['!=', '->', '::']) expect(FONT_PREVIEW_SAMPLE, sym).toContain(sym);
  });
});

describe('tokens.css 逐字闸（界面字体转正，默认值不许漂）', () => {
  it('UI_FONT_CSS_LINE 原样在册；:root 的 font-family 走 var(--font-ui)，字面量行不再存在', () => {
    expect(tokens()).toContain(UI_FONT_CSS_LINE);
    expect(tokens()).toContain('font-family: var(--font-ui);');
    expect(tokens(), '字面量必须只活在 --font-ui token 里').not.toContain(
      "font-family: 'Segoe UI'",
    );
  });

  it('--font-ui 是新增 token，不撞已有名；--font-meta/--font-console/--font-mono 面值不动', () => {
    expect(tokens()).toContain('--font-ui:');
    expect(tokens()).toContain(
      "--font-mono: Consolas, 'Cascadia Mono', 'JetBrains Mono', monospace;",
    );
    expect(tokens()).toContain("--font-console: Consolas, 'Cascadia Mono', 'JetBrains Mono', 'Noto Sans Mono CJK SC', 'MS Gothic', monospace;");
  });
});

describe('解析与兼容红线（生效链的唯一入口）', () => {
  it('老用户存过非空 fontFamily ⇒ 它赢，即便档位选了别的（不许把自定义吃掉）', () => {
    const r = resolveCodeFontStack(prefs({ fontFamily: 'Consolas, monospace', codeFontPreset: 'sarasa' }));
    expect(r.stack).toBe('Consolas, monospace');
    expect(r.presetId).toBe('custom');
  });

  it('档位 id 不认识 ⇒ 回落 default 栈，且「回落了」这个事实读得出', () => {
    const r = resolveCodeFontStack(prefs({ codeFontPreset: 'bogus' }));
    expect(r.stack).toBe(CODE_FONT_STACK);
    expect(r.presetId).toBe('default');
    expect(r.fellBack).toBe(true);
    expect(r.requestedPresetId).toBe('bogus');
  });

  it('选 custom 但文本为空 ⇒ 回落 default 并可见（不猜、不静默）', () => {
    const r = resolveCodeFontStack(prefs({ codeFontPreset: CUSTOM_CODE_FONT_PRESET_ID, fontFamily: '' }));
    expect(r.stack).toBe(CODE_FONT_STACK);
    expect(r.fellBack).toBe(true);
  });

  it('在册档位取各自的栈、不回落；每条解析出的栈都过护栏', () => {
    for (const p of CODE_FONT_PRESETS) {
      if (p.id === CUSTOM_CODE_FONT_PRESET_ID) continue;
      const r = resolveCodeFontStack(prefs({ codeFontPreset: p.id }));
      expect(r.presetId).toBe(p.id);
      expect(r.fellBack).toBe(false);
      expect(isUsableCodeFontStack(r.stack), p.id).toBe(true);
    }
  });

  it('界面档：未知 id 回落 system 且 fellBack；custom 吃 uiFontFamily；空文本回落 system', () => {
    const bad = resolveUiFontStack(prefs({ uiFontPreset: 'nope' }));
    expect(bad.stack).toBe(UI_FONT_SYSTEM_STACK);
    expect(bad.fellBack).toBe(true);
    const custom = resolveUiFontStack(prefs({ uiFontPreset: 'custom', uiFontFamily: 'Arial, sans-serif' }));
    expect(custom.stack).toBe('Arial, sans-serif');
    const empty = resolveUiFontStack(prefs({ uiFontPreset: 'custom', uiFontFamily: '' }));
    expect(empty.presetId).toBe('system');
    expect(empty.fellBack).toBe(true);
  });

  it('界面 mono 档跟随所选代码栈（代码选了 sarasa ⇒ 界面也是 sarasa 那条）', () => {
    const sarasa = CODE_FONT_PRESETS.find((p) => p.id === 'sarasa')!.stack;
    const r = resolveUiFontStack(prefs({ uiFontPreset: 'mono', codeFontPreset: 'sarasa' }));
    expect(r.stack).toBe(sarasa);
    // 老自由文本同样被跟随（跟随的是**生效**代码栈，不是档位）
    const withOld = resolveUiFontStack(
      prefs({ uiFontPreset: 'mono', codeFontPreset: 'sarasa', fontFamily: 'Consolas, monospace' }),
    );
    expect(withOld.stack).toBe('Consolas, monospace');
  });
});

describe('UI 自定义栈清洗', () => {
  it('空 / 全逗号 ⇒ 空串；缺泛型补 sans-serif；半坏栈回落空串', () => {
    expect(sanitizeUiFontFamily('')).toBe('');
    expect(sanitizeUiFontFamily(', ,')).toBe('');
    expect(sanitizeUiFontFamily('Arial')).toBe('Arial, sans-serif');
    expect(sanitizeUiFontFamily("'PingFang SC', , YaHei")).toBe("'PingFang SC', YaHei, sans-serif");
    expect(sanitizeUiFontFamily('Arial, monospace')).toBe('Arial, monospace');
    expect(sanitizeUiFontFamily(42)).toBe('');
  });
});

describe('生效链：Monaco 补丁与内联 CSS 同串（一条断言读两个出口）', () => {
  it('非默认代码档：patch.fontFamily === 内联 --font-code === 档位栈', () => {
    const p = prefs({ codeFontPreset: 'sarasa' });
    const patch = editorDisplayFontPatch(p);
    const { root, written, removed } = fakeRoot();
    applyFontStackCssPrefs(p, root);
    const sarasa = CODE_FONT_PRESETS.find((x) => x.id === 'sarasa')!.stack;
    expect(patch.fontFamily).toBe(sarasa);
    expect(written.get(CODE_FONT_CSS_TOKEN)).toBe(patch.fontFamily);
    // 界面仍是 system ⇒ --font-ui 不写（只摘），两token 互不牵连
    expect(written.get(UI_FONT_CSS_TOKEN)).toBeUndefined();
    expect(removed).toContain(UI_FONT_CSS_TOKEN);
  });

  it('界面非默认档：内联 --font-ui === resolveUiFontStack 的栈；代码 token 同步在册', () => {
    const p = prefs({ uiFontPreset: 'source-han' });
    const { root, written } = fakeRoot();
    applyFontStackCssPrefs(p, root);
    expect(written.get(UI_FONT_CSS_TOKEN)).toBe(resolveUiFontStack(p).stack);
  });

  it('全默认（default + system + 空文本）⇒ 两位内联都不写，只摘自己的 ⇒ 界面与编辑器逐字不变', () => {
    const { root, written, removed } = fakeRoot();
    applyFontStackCssPrefs(prefs({}), root);
    expect(written.size).toBe(0);
    expect(removed).toContain(CODE_FONT_CSS_TOKEN);
    expect(removed).toContain(UI_FONT_CSS_TOKEN);
  });

  it('老自定义文本同时喂两个出口：Monaco 与 --font-code 拿到的就是那串（兼容链不是平行链）', () => {
    const p = prefs({ fontFamily: 'Consolas, monospace' });
    const patch = editorDisplayFontPatch(p);
    const { root, written } = fakeRoot();
    applyFontStackCssPrefs(p, root);
    expect(patch.fontFamily).toBe('Consolas, monospace');
    expect(written.get(CODE_FONT_CSS_TOKEN)).toBe('Consolas, monospace');
  });

  it('无 document / 无根元素时安全空转（node 判定链不许把崩抛进渲染）', () => {
    expect(() => applyFontStackCssPrefs(prefs({ codeFontPreset: 'sarasa' }), null)).not.toThrow();
    // editorDisplayFontPatch 内嵌的播种在无 DOM 环境同样空转
    expect(editorDisplayFontPatch(prefs({ codeFontPreset: 'lxgw' })).fontFamily).toBe(
      CODE_FONT_PRESETS.find((p) => p.id === 'lxgw')!.stack,
    );
  });
});

describe('可用性判定（注入替身，不靠真壳）', () => {
  it('checker 逐成员给存在性：缺装的家族被点名，泛型不参与', () => {
    const checker = (spec: string) => !spec.includes('JetBrains');
    const rows = checkFontStackPresence(
      CODE_FONT_PRESETS.find((p) => p.id === 'jbmono-noto')!.stack,
      checker,
    );
    expect(rows).not.toBeNull();
    const missing = rows!.filter((r) => !r.present).map((r) => r.family);
    expect(missing).toEqual(['JetBrains Mono']);
    for (const r of rows!) expect(GENERIC_FAMILIES.has(r.family.toLowerCase())).toBe(false);
  });

  it('判定源拿不到 ⇒ 返回 null（= 判定不了，UI 必须明说，不许假装都装了）', () => {
    expect(checkFontStackPresence(CODE_FONT_STACK, null)).toBeNull();
  });

  it('判定本身抛错 ⇒ 该成员不误报缺失（选择照常生效，标注只是提示）', () => {
    const boom: Record<string, boolean> = {};
    const rows = checkFontStackPresence("'Cascadia Code', Consolas, monospace", (spec) => {
      if (spec.includes('Cascadia')) throw new Error('boom');
      boom[spec] = true;
      return true;
    });
    expect(rows).toEqual([
      { family: 'Cascadia Code', present: true },
      { family: 'Consolas', present: true },
    ]);
  });

  it('fontStackConcreteMembers：去引号、去泛型、留顺序', () => {
    expect(fontStackConcreteMembers("'Segoe UI', SimHei, sans-serif")).toEqual(['Segoe UI', 'SimHei']);
  });
});

describe('偏好落盘（新三位键与读盘回落）', () => {
  it('档位存取往返；脏 id 读盘即回落缺省档（可见的回落，不是静默）', () => {
    const s = fakeStorage();
    vi.stubGlobal('window', { localStorage: s });
    saveEditorDisplayPrefs({ codeFontPreset: 'lxgw' });
    expect(s.getItem('kojo.ui.editor.codeFontPreset.v1')).toBe('lxgw');
    expect(loadEditorDisplayPrefs().codeFontPreset).toBe('lxgw');
    saveEditorDisplayPrefs({ uiFontPreset: 'mono', uiFontFamily: 'Arial, sans-serif' });
    expect(s.getItem('kojo.ui.editor.uiFontPreset.v1')).toBe('mono');
    expect(s.getItem('kojo.ui.editor.uiFontFamily.v1')).toBe('Arial, sans-serif');
    // 脏档位 id 直接落进盘里（模拟旧版本/手改）⇒ 读盘层清洗回缺省档
    s.setItem('kojo.ui.editor.codeFontPreset.v1', 'bogus');
    s.setItem('kojo.ui.editor.uiFontPreset.v1', 'bogus');
    const loaded = loadEditorDisplayPrefs();
    expect(loaded.codeFontPreset).toBe('default');
    expect(loaded.uiFontPreset).toBe('system');
  });

  it('自定义文本仍是 fontFamily 那条路（语义零改动）；选档位时文本原样留着由 resolve 定输赢', () => {
    const s = fakeStorage({ 'kojo.ui.editor.fontFamily.v1': 'Consolas, monospace' });
    vi.stubGlobal('window', { localStorage: s });
    expect(loadEditorDisplayPrefs().fontFamily).toBe('Consolas, monospace');
    const r = resolveCodeFontStack(loadEditorDisplayPrefs());
    expect(r.presetId).toBe('custom');
  });
});
