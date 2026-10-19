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
  UI_FONT_SCALE_TOKENS,
  applyUiFontScalePref,
  editorDisplayFontPatch,
  editorDisplayOptionPatch,
  loadEditorDisplayPrefs,
  minimapEnabledFor,
  modifiedEditorDisplayKeys,
  normalizeMinimapPref,
  resetEditorDisplayPrefs,
  sanitizeFontFamily,
  sanitizeLineHeight,
  sanitizeUiFontScale,
  saveEditorDisplayPrefs,
  scaleFontToken,
  subscribeEditorDisplayPrefs,
  type UiFontScalePref,
  type UiFontScaleRoot,
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

/** 假根元素：只记 `--fs-*` 那几位写了什么、摘了什么（生效路径的唯一可测面） */
function fakeRoot(): {
  root: UiFontScaleRoot;
  written: Map<string, string>;
  removed: string[];
} {
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

/** 样式表基线（与 `styles.css` 的 `:root` 同值；测试里就是一张表，不参与计算） */
const BASELINE_TOKENS: Record<string, string> = {
  '--fs-0': '11px',
  '--fs-1': '12px',
  '--fs-2': '13px',
  '--fs-3': '14px',
  '--fs-4': '16px',
  '--fs-5': '18px',
  '--fs-display': '26px',
};

describe('缺省 = 今天硬编码的那一份', () => {
  it('无 window / 空表 ⇒ 全缺省（行高 0=自动、空白符 none、缩略图跟随、行号 on、字体族默认、行内提示开、界面字号 100%）', () => {
    stubWindow(undefined);
    expect(loadEditorDisplayPrefs()).toEqual(EDITOR_DISPLAY_PREF_DEFAULT);
    stubWindow(fakeStorage());
    expect(loadEditorDisplayPrefs()).toEqual(EDITOR_DISPLAY_PREF_DEFAULT);
    expect(EDITOR_DISPLAY_PREF_DEFAULT.minimap).toBe('follow');
    expect(EDITOR_DISPLAY_PREF_DEFAULT.uiFontScale).toBe(100);
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

  it('界面字号缩放**不进** Monaco 补丁（它走 CSS 变量，与编辑器字号两条轴）', () => {
    stubWindow(fakeStorage({ 'kojo.ui.editor.uiFontScale.v1': '125' }));
    for (const p of [editorDisplayOptionPatch(100), editorDisplayFontPatch()]) {
      expect(Object.keys(p)).not.toContain('uiFontScale');
      expect(Object.keys(p)).not.toContain('fontSize');
    }
  });

  it('快照引用稳定（useSyncExternalStore 的 getSnapshot 契约：值没变返回同一对象）', () => {
    const s = fakeStorage();
    stubWindow(s);
    const a = loadEditorDisplayPrefs();
    saveEditorDisplayPrefs({ minimap: 'follow' }); // 与缺省同值 ⇒ 值没变
    expect(loadEditorDisplayPrefs()).toBe(a);
    saveEditorDisplayPrefs({ minimap: 'off' });
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
  it('常开档：small/large 开、huge 仍关；关闭档：三档全关', () => {
    stubWindow(fakeStorage());
    saveEditorDisplayPrefs({ minimap: 'on' });
    expect(editorDisplayOptionPatch(100).minimap?.enabled).toBe(true);
    expect(editorDisplayOptionPatch(6_000).minimap?.enabled).toBe(true);
    expect(editorDisplayOptionPatch(60_000).minimap?.enabled).toBe(false);
    // 「常开」时预览与 .kojo 正文也照画——跟随档那两条内容判据只在 follow 上说话
    expect(editorDisplayOptionPatch(100, undefined, { preview: true }).minimap?.enabled).toBe(true);
    expect(editorDisplayOptionPatch(100, undefined, { kojoText: true }).minimap?.enabled).toBe(true);
    saveEditorDisplayPrefs({ minimap: 'off' });
    for (const n of [100, 6_000, 60_000]) {
      expect(editorDisplayOptionPatch(n).minimap, `${n} 行应当整条关`).toEqual({
        enabled: false,
        renderCharacters: false,
        maxColumn: 72,
      });
    }
  });

  it('跟随档（新缺省）：只有"小体量 + 非 .kojo 正文 + 非预览"才画', () => {
    stubWindow(fakeStorage());
    expect(loadEditorDisplayPrefs().minimap).toBe('follow');
    // 普通代码文件：小体量画、长文不画（≥5,000 行的口上长文靠大纲与「转到行」导航）
    expect(editorDisplayOptionPatch(100).minimap?.enabled).toBe(true);
    expect(editorDisplayOptionPatch(6_000).minimap?.enabled).toBe(false);
    expect(editorDisplayOptionPatch(60_000).minimap?.enabled).toBe(false);
    // `.kojo` 正文与 `.kojo` 预览投影：无论多少行都不画（中日文正文在那条上只是彩色噪点）
    expect(editorDisplayOptionPatch(100, undefined, { kojoText: true }).minimap?.enabled).toBe(false);
    expect(editorDisplayOptionPatch(100, undefined, { preview: true }).minimap?.enabled).toBe(false);
    // create 路径（屏幕上还没有文档 ⇒ 空上下文）与旧行为一致：先画，第一个文件落档时再按真实判据覆写
    expect(editorDisplayOptionPatch(0).minimap?.enabled).toBe(true);
  });

  it('minimapEnabledFor 是判据的唯一出口（补丁与设置页读的是同一条尺子）', () => {
    expect(minimapEnabledFor(100, 'off')).toBe(false);
    expect(minimapEnabledFor(60_000, 'on')).toBe(false);
    expect(minimapEnabledFor(6_000, 'on')).toBe(true);
    expect(minimapEnabledFor(6_000, 'follow')).toBe(false);
    expect(minimapEnabledFor(500, 'follow', { preview: true })).toBe(false);
    expect(minimapEnabledFor(500, 'follow', { kojoText: true })).toBe(false);
    expect(minimapEnabledFor(500, 'follow', {})).toBe(true);
    // 脏值不猜：按缺省（跟随）走
    expect(minimapEnabledFor(500, 'weird' as unknown as 'on')).toBe(true);
    expect(minimapEnabledFor(6_000, 'weird' as unknown as 'on')).toBe(false);
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
    saveEditorDisplayPrefs({ minimap: 'follow' }); // 与缺省同值 ⇒ 不算已修改
    expect(modifiedEditorDisplayKeys()).toEqual([]);
    saveEditorDisplayPrefs({ lineHeight: 24, renderWhitespace: 'all' });
    expect(modifiedEditorDisplayKeys()).toEqual(['lineHeight', 'renderWhitespace']);
  });

  it('reset 回到全缺省并清掉「已修改」', () => {
    stubWindow(fakeStorage());
    saveEditorDisplayPrefs({ lineHeight: 28, minimap: false, fontFamily: 'Consolas', uiFontScale: 125 });
    expect(modifiedEditorDisplayKeys()).toEqual(['lineHeight', 'minimap', 'fontFamily', 'uiFontScale']);
    resetEditorDisplayPrefs();
    expect(loadEditorDisplayPrefs()).toEqual(EDITOR_DISPLAY_PREF_DEFAULT);
    expect(modifiedEditorDisplayKeys()).toEqual([]);
    // 复位后旧布尔键也被镜像成新键的等价读数（旧版本回滚读它仍然是"开"）
    expect(loadEditorDisplayPrefs().minimap).toBe('follow');
  });
});

/* ==========================================================================================
 * C-1b · 缩略图三态的读盘口径（向后兼容是这一批的红线）
 *
 * 三态键 `kojo.ui.editor.minimapMode.v1` 是新真源；旧布尔键 `kojo.ui.editor.minimap.v1`
 * （'1'/'0'）仍要认——否则"当年亲手关掉缩略图"的作者，升级当天会发现它又回来了。
 * ========================================================================================== */
describe('缩略图读盘向后兼容（老用户的选择不许被新缺省覆盖）', () => {
  it('只有旧布尔键：\'1\' ⇒ 常开、\'0\' ⇒ 关闭（等价于升级前的行为）', () => {
    stubWindow(fakeStorage({ 'kojo.ui.editor.minimap.v1': '1' }));
    expect(loadEditorDisplayPrefs().minimap).toBe('on');
    expect(editorDisplayOptionPatch(6_000).minimap?.enabled).toBe(true); // 老用户的大文件仍然画
    stubWindow(fakeStorage({ 'kojo.ui.editor.minimap.v1': '0' }));
    expect(loadEditorDisplayPrefs().minimap).toBe('off');
    expect(editorDisplayOptionPatch(100).minimap?.enabled).toBe(false);
  });

  it('两把尺子都没存过 ⇒ 跟随（新缺省策略；这只影响从没动过这一项的作者）', () => {
    stubWindow(fakeStorage());
    expect(loadEditorDisplayPrefs().minimap).toBe('follow');
  });

  it('三态键优先于旧键；三态键是脏值时回落到旧键，绝不静默变成新缺省', () => {
    stubWindow(
      fakeStorage({
        'kojo.ui.editor.minimapMode.v1': 'off',
        'kojo.ui.editor.minimap.v1': '1',
      }),
    );
    expect(loadEditorDisplayPrefs().minimap).toBe('off');
    stubWindow(
      fakeStorage({
        'kojo.ui.editor.minimapMode.v1': 'nonsense',
        'kojo.ui.editor.minimap.v1': '0',
      }),
    );
    expect(loadEditorDisplayPrefs().minimap).toBe('off');
  });

  it('normalizeMinimapPref：布尔与三态都收，脏值返回 null 交给调用方回落', () => {
    expect(normalizeMinimapPref(true)).toBe('on');
    expect(normalizeMinimapPref(false)).toBe('off');
    expect(normalizeMinimapPref('follow')).toBe('follow');
    expect(normalizeMinimapPref('on')).toBe('on');
    expect(normalizeMinimapPref('off')).toBe('off');
    for (const bad of [undefined, null, '', 'ON', 'yes', 1, {}]) {
      expect(normalizeMinimapPref(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('写入同时镜像旧键（回滚到旧版本也不至于"缩略图 settings 全丢"）', () => {
    const s = fakeStorage();
    stubWindow(s);
    saveEditorDisplayPrefs({ minimap: 'off' });
    expect(s.getItem('kojo.ui.editor.minimapMode.v1')).toBe('off');
    expect(s.getItem('kojo.ui.editor.minimap.v1')).toBe('0');
    saveEditorDisplayPrefs({ minimap: 'follow' });
    expect(s.getItem('kojo.ui.editor.minimapMode.v1')).toBe('follow');
    expect(s.getItem('kojo.ui.editor.minimap.v1')).toBe('1'); // 旧版本读 '1' = 画，与跟随档的小文件一致
  });
});

/* ==========================================================================================
 * C-1b · 界面字号缩放（外壳 CSS 变量，与编辑器字号两条轴）
 *
 * 三条口径：① 100% 一位都不写 ⇒ 没动过这一项的作者界面逐字不变；② 倍率以**样式表基线**为尺
 * （写之前先摘掉自己那几位），连点两次不许把字号滚成 1.1×1.1；③ 读不懂的值不覆写（返回 null），
 * 宁可那一格保持基线，也不喂一个算错进界面。
 * ========================================================================================== */
describe('界面字号缩放', () => {
  it('只认登记档位（数字与数字串都收）；脏值 = 100% = 不覆写', () => {
    expect(sanitizeUiFontScale(110)).toBe(110);
    expect(sanitizeUiFontScale('125')).toBe(125);
    expect(sanitizeUiFontScale(100)).toBe(100);
    for (const bad of [0, 1, 105, 200, -110, 'weird', '', undefined, null, Number.NaN, {}]) {
      expect(sanitizeUiFontScale(bad), String(bad)).toBe(100);
    }
  });

  it('scaleFontToken：纯 px 才乘，取整避免出现 13.75px；非 px / 坏值返回 null（= 这一格不覆写）', () => {
    expect(scaleFontToken('11px', 1.25)).toBe('14px');
    expect(scaleFontToken(' 12px ', 1.1)).toBe('13px');
    expect(scaleFontToken('26px', 1.1)).toBe('29px');
    expect(scaleFontToken('1px', 0.5)).toBe('1px'); // 取整后不足 1px 的一律不写（界面不许出现 0px 文字）
    for (const bad of ['', 'bold', '1.5em', 'calc(11px * 2)', 'var(--fs-0)', '11', '-2px']) {
      expect(scaleFontToken(bad, 1.25), bad).toBeNull();
    }
  });

  it('100% ⇒ 只摘不写（默认档下计算值就是样式表那一份）', () => {
    const { root, written, removed } = fakeRoot();
    applyUiFontScalePref(100, root, (name) => BASELINE_TOKENS[name] ?? '');
    expect(written.size).toBe(0);
    expect(removed).toEqual([...UI_FONT_SCALE_TOKENS]);
  });

  it('110% / 125% ⇒ 每位 token 按基线取整落进行内声明', () => {
    stubWindow(fakeStorage());
    const a = fakeRoot();
    applyUiFontScalePref(110, a.root, (name) => BASELINE_TOKENS[name] ?? '');
    expect([...a.written.entries()]).toEqual([
      ['--fs-0', '12px'],
      ['--fs-1', '13px'],
      ['--fs-2', '14px'],
      ['--fs-3', '15px'],
      ['--fs-4', '18px'],
      ['--fs-5', '20px'],
      ['--fs-display', '29px'],
    ]);
    const b = fakeRoot();
    applyUiFontScalePref(125, b.root, (name) => BASELINE_TOKENS[name] ?? '');
    expect(b.written.get('--fs-0')).toBe('14px');
    expect(b.written.get('--fs-display')).toBe('33px');
  });

  it('连点两次不叠加：每次都先摘掉自己写的再读基线（1.1×1.1 那种一路涨到糊的 bug 不许有）', () => {
    // 假"计算样式"就是根元素当前的行内值——正是叠 bug 会长出来的那张表
    const { root, written } = fakeRoot();
    const read = (name: string): string => written.get(name) ?? BASELINE_TOKENS[name] ?? '';
    applyUiFontScalePref(110, root, read);
    applyUiFontScalePref(110, root, read);
    expect(written.get('--fs-0')).toBe('12px'); // 若基数取了自己写的 12px，这里会变成 13px
    applyUiFontScalePref(125, root, read);
    expect(written.get('--fs-0')).toBe('14px'); // 换档同样从基线重算，不是在 12px 上再乘
  });

  it('读不懂的档位整格跳过；无根元素时安全空转（node / 非浏览器壳）', () => {
    const { root, written } = fakeRoot();
    applyUiFontScalePref(125, root, () => '');
    expect(written.size).toBe(0);
    expect(() => applyUiFontScalePref(110, null, () => '11px')).not.toThrow();
  });

  it('写入即落盘并当场应用（设置页那一改不用等编辑器重挂）', () => {
    const s = fakeStorage();
    stubWindow(s);
    const scale = saveEditorDisplayPrefs({ uiFontScale: 110 as UiFontScalePref }).uiFontScale;
    expect(scale).toBe(110);
    expect(s.getItem('kojo.ui.editor.uiFontScale.v1')).toBe('110');
    expect(modifiedEditorDisplayKeys()).toEqual(['uiFontScale']);
  });
});
