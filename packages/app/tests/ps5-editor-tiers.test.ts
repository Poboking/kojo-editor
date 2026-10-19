/**
 * PS-5 · 体量档位在"全文级开销"这条轴上的补齐（editor-options.ts）。
 *
 * 钉四件事：
 *  ① 体量轴上的每一条键**每一档都写值**——`updateOptions` 只覆写发过去的键，小档漏写就是从
 *     大文件切回来卡在大档的关值（档位漂移，与既有 `minimap` / `stickyScroll` 同一条纪律）。
 *     这一族键**从表里枚举**（`sizeTierKeys` / `sizeTierKeysMissingFromSmall`），不是手抄清单：
 *     PS-5 交付说的「小档必须显式写回，否则档位漂移」当时只做到 6 条里的 5 条，
 *     而它自己的测试把清单抄成五条 ⇒ 漏掉的那条（`formatOnType`）带着 bug 一路全绿（1020 止血批）。
 *  ② 大档真的关掉了那三条全文级扫描，huge 再关折行与折叠；
 *  ③ 三条既有不变式不受影响（CJK 基线逐档同在 / 降级集永不含 fontSize·zoomLevel /
 *     find 逐档同值）；
 *  ④ 论据不靠记忆：vendor 侧的取证（find 的 19,999 上限、diff 的 5,000ms·50MB 缺省、
 *     `largeFileOptimizations` 这个总开关**不在** monaco-editor 里、折叠的
 *     `foldingMaximumRegions` 缺省与"有供给器就不退回缩进折叠"）逐条读源码钉住。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// —— P2-16 追加用例的依赖（一律新行；上面的既有 import 一行未动）——
import { afterEach, vi } from 'vitest';
import {
  HUGE_FILE_LINES,
  LARGE_FILE_LINES,
  CJK_TYPING_BASELINE,
  FIND_BASELINE,
  applySizeTier,
  editorOptionsForLineCount,
  foldingEnabledForLineCount,
  formatOnTypeForDocument,
  sizeTierKeys,
  sizeTierKeysMissingFromSmall,
} from '../src/ui/editor-options';

const vendor = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../node_modules/monaco-editor/esm/vs/${rel}`, import.meta.url)), 'utf8');

const paneSource = () =>
  readFileSync(fileURLToPath(new URL('../src/ui/EditorPane.tsx', import.meta.url)), 'utf8');

const tierSamples = [1, 4_999, LARGE_FILE_LINES, HUGE_FILE_LINES, 990_000];

describe('PS-5 档位补齐：每条体量轴的键都必须逐档有值（**清单从表里取**）', () => {
  const KEYS = sizeTierKeys();

  it('枚举出来的这条轴非空、且含那五条已知键 + formatOnType（清单漂了本条先响）', () => {
    expect(KEYS.length).toBeGreaterThanOrEqual(6);
    for (const k of ['wordWrap', 'selectionHighlight', 'links', 'colorDecorators', 'folding', 'formatOnType']) {
      expect(KEYS, `体量轴上应当认得 ${k}`).toContain(k);
    }
  });

  it('五档样本都带齐这一族键（小档不写 = 从大文件切回来卡在关值）', () => {
    for (const n of tierSamples) {
      const o = editorOptionsForLineCount(n);
      for (const k of KEYS) expect(o, `${n} 缺 ${k}`).toHaveProperty(k);
    }
  });

  it('判据本体：任一档关掉而 small 档没写回的键 = **空表**（非空就是漂移，键名直接报出来）', () => {
    expect(sizeTierKeysMissingFromSmall()).toEqual([]);
  });

  it('small 档：五条全开 + 打字规范化开（便利特性不因"补齐"而被默认值带走）', () => {
    const o = editorOptionsForLineCount(500);
    expect(o.wordWrap).toBe('on');
    expect(o.selectionHighlight).toBe(true);
    expect(o.links).toBe(true);
    expect(o.colorDecorators).toBe(true);
    expect(o.folding).toBe(true);
    expect(o.formatOnType).toBe(true);
  });

  it('large 档：关三条全文级扫描 + 关打字规范化，折行与折叠照留（读台词要靠它们）', () => {
    const o = editorOptionsForLineCount(LARGE_FILE_LINES);
    expect(o.selectionHighlight).toBe(false);
    expect(o.links).toBe(false);
    expect(o.colorDecorators).toBe(false);
    expect(o.formatOnType).toBe(false);
    expect(o.wordWrap).toBe('on');
    expect(o.folding).toBe(true);
    // 折叠这一档"选项开 + 供给器也让路"那一对矛盾不许回来：两边的判据同源
    expect(foldingEnabledForLineCount(LARGE_FILE_LINES)).toBe(true);
  });

  it('huge 档：折行关 + 折叠关，并继承 large 的三条关值', () => {
    const o = editorOptionsForLineCount(HUGE_FILE_LINES);
    expect(o.wordWrap).toBe('off');
    expect(o.folding).toBe(false);
    expect(o.selectionHighlight).toBe(false);
    expect(o.links).toBe(false);
    expect(o.colorDecorators).toBe(false);
    expect(foldingEnabledForLineCount(HUGE_FILE_LINES)).toBe(false);
    // 99 万行级盘同样走这一档（阈值判据不许在超大读数上漂档）
    expect(editorOptionsForLineCount(990_000).wordWrap).toBe('off');
  });

  it('往返：huge → small，这一族键**每条都有值**（切标签不"半套恢复"）', () => {
    editorOptionsForLineCount(HUGE_FILE_LINES);
    const back = editorOptionsForLineCount(100);
    // 判据是"小档写过这个键"，不是"值恒为真"：`renderLineHighlightOnlyWhenFocus` 这类
    // 小档本来就该是 false 的键，真值断言会把它误判成漏写；漏写的真值是 undefined。
    for (const k of KEYS) expect(back, `${k} 在小档没被写回`).toHaveProperty(k);
  });

  /**
   * `applySizeTier` 是档位写入的**唯一出口**，所以这里拿一枚假编辑器把 Monaco 那一句
   * "updateOptions 只覆写发过去的键"演出来：先把 huge 档发上去，再把小档发上去，
   * **叠出来的当前选项**必须逐键等于小档全量——漏写回任何一条，这一条就红在这一键上。
   */
  it('叠出来的选项：huge → 挂上一份更大的投影 → 回到小文件，每一步都按"此刻屏幕上那份"落档', () => {
    const current: Record<string, unknown> = {};
    const ed = { updateOptions: (o: Record<string, unknown>) => Object.assign(current, o) };
    applySizeTier(ed, 60_000); // 打开一份 huge 原文
    expect(current.formatOnType).toBe(false);
    expect(current.folding).toBe(false);
    applySizeTier(ed, 120_000, { readOnly: true }); // 挂上 .kojo 投影（比原文更长）
    expect(current.readOnly).toBe(true);
    applySizeTier(ed, 800); // 撤下投影、按回到屏幕上的那份原文落档
    const small = editorOptionsForLineCount(800) as Record<string, unknown>;
    for (const k of KEYS) expect(current[k], `切回 800 行后 ${k} 还留在上一档`).toEqual(small[k]);
    expect(current.formatOnType).toBe(true);
    expect(current.folding).toBe(true);
    expect(current.wordWrap).toBe('on');
  });

  it('不变式不被动：find 与 CJK 基线逐档同值，降级集永不含字号/缩放', () => {
    for (const n of tierSamples) {
      const o = editorOptionsForLineCount(n);
      expect(o.find, String(n)).toEqual(FIND_BASELINE.find);
      expect(o.unicodeHighlight, String(n)).toEqual(CJK_TYPING_BASELINE.unicodeHighlight);
      expect(Object.keys(o)).not.toContain('fontSize');
      expect(Object.keys(o)).not.toContain('zoomLevel');
    }
  });
});

/**
 * 档位写入点的形状守卫（1020 止血批）。
 *
 * 为什么又读一次源码：这三处都活在 2,000 行组件的闭包里（同 `ps5-editor-pane-wiring.test.ts`
 * 的既定口径——行为面交给纯函数单测，形状面钉"接线在不在"）。上一批的**第二个**漂移就漂在
 * "写档位的点有三个、还原只做在一处"：挂投影时按投影行数落过档，撤投影却只回可写态，
 * 于是 huge 投影的折行 / 折叠 / 找同词一路骑到下一份小文件上。
 */
describe('档位写入口只有 applySizeTier 一个（EditorPane.tsx 静态取证）', () => {
  it('三个写入点都走 applySizeTier：切标签 / 挂投影 / 撤投影', () => {
    const src = paneSource();
    expect(src).toContain('applySizeTier(ed, restoreLines, tierOverrides(restoreLines,'); // 撤下投影 ⇒ 按原文行数重落
    expect(src).toContain('applySizeTier(ed, sugarTierLines, tierOverrides(sugarTierLines,'); // 挂上投影 ⇒ 按投影行数
    expect(src).toContain('applySizeTier(ed, tierLines, tierOverrides(tierLines,'); // 切标签 ⇒ 按原文行数
    // 三个点都是**三参**调用：档位表之外的那一层（语言感知 formatOnType + 显示偏好）只许住在 tierOverrides 里
    expect((src.match(/applySizeTier\(ed, /g) ?? []).length).toBe(3);
    expect(src).not.toMatch(/applySizeTier\(ed, [^,)]+\)/);
  });

  it('没有任何一处再自己 spread 档位表（判据只许有一份，两处抄表必漂）', () => {
    expect(paneSource()).not.toContain('editorOptionsForLineCount(');
  });

  it('创建时那一格 formatOnType 仍然开着（ZH-D4 回车缩进的兜底腿靠 on-type provider 派发）', () => {
    expect(paneSource()).toContain('formatOnType: true,');
  });

  /**
   * 打字规范化这一位**按方言分**（1020 编辑器体感批）。
   *
   * 档位表里 large/huge 写 `false` 的依据早已过期：ERB 的 on-type 腿在 PS-4 就改成只取
   * 触发行窗口（`editor-global-providers.ts` 的 `formatRequestWindowFor`），而 `.kojo` 的
   * 缩进单位与 `@` 块状态是文档级判据、窗口视角会数错。所以判据只有
   * {@link formatOnTypeForDocument} 这一份，接线层问它，档位表解释它。
   */
  it('formatOnType：ERB 大文件重新开、.kojo 大文件继续关、小文件两者都开', () => {
    for (const n of [1, LARGE_FILE_LINES - 1]) {
      expect(formatOnTypeForDocument(n, true), String(n)).toBe(true);
      expect(formatOnTypeForDocument(n, false), String(n)).toBe(true);
    }
    for (const n of [LARGE_FILE_LINES, HUGE_FILE_LINES, 990_000]) {
      expect(formatOnTypeForDocument(n, true), String(n)).toBe(true);
      expect(formatOnTypeForDocument(n, false), String(n)).toBe(false);
    }
    // 非法行数 ⇒ 不是 small（NaN 不进小档的"恒开"），也别把它当小档哄骗过去
    expect(formatOnTypeForDocument(Number.NaN, true)).toBe(false);
  });

  it('接线层确实按屏幕上那份文档问它：切标签/撤投影给 isErbLike，挂投影恒 false', () => {
    const src = paneSource();
    expect(src).toContain('tierOverrides(restoreLines, isErbLike(filePathRef.current))');
    expect(src).toContain('tierOverrides(tierLines, isErbLike(filePath)');
    expect(src).toContain('tierOverrides(sugarTierLines, false');
  });

  it('折叠超额那句人话真在渲染里，且不含内部术语（铁律 4：少给了必须说）', () => {
    const src = paneSource();
    const i0 = src.indexOf('{foldingCap[filePath] ? (');
    expect(i0, '工具条上没有折叠超额那一格').toBeGreaterThan(0);
    const block = src.slice(i0, src.indexOf('</span>', i0));
    const literals = (block.match(/'([^']*)'/g) ?? []).map((s) => s.slice(1, -1)).join('');
    const visible = literals + block.slice(block.lastIndexOf('/>') + 2);
    for (const w of [
      'marker', 'Marker', '装饰', '阈值', '码元', 'byte', '字节', 'validation',
      '缓存', '索引', 'worker', 'Worker', 'model', 'Model', 'Monaco', 'monaco', '语法糖', 'provider',
    ]) {
      expect(visible, `禁词「${w}」出现在作者可见文案里`).not.toContain(w);
    }
    expect(visible).toContain('折叠太多');
  });
});

describe('PS-5 论据取证（读 vendor 源码，不读记忆）', () => {
  it('find 的命中计数自带 19,999 上限 ⇒ 这一项没有档位旋钮可拧，也不必拧', () => {
    const src = vendor('editor/contrib/find/browser/findModel.js');
    expect(src).toContain('const MATCHES_LIMIT = 19999;');
    // 越界即"数到顶就停 + 显示 20000+"，全文级代价已被 vendor 自己封顶（不做第二层闸）
    expect(vendor('editor/contrib/find/browser/findWidget.js')).toContain('MATCHES_LIMIT');
  });

  it('monaco-editor 不导出 VS Code 那个 largeFileOptimizations 总开关 ⇒ 只能自己按档列', () => {
    expect(vendor('editor/common/config/editorOptions.js')).not.toContain('largeFileOptimizations');
  });

  it('本轮新用的五条键都在 0.57 的类型面上在册（写错键名 = 静默无效）', () => {
    const dts = readFileSync(fileURLToPath(new URL('../node_modules/monaco-editor/monaco.d.ts', import.meta.url)), 'utf8');
    for (const k of ['selectionHighlight?:', 'links?:', 'colorDecorators?:', 'folding?:', 'wordWrap?:']) {
      expect(dts, k).toContain(k);
    }
  });

  it('diff 的两道 vendor 刹车缺省确实太晚（5,000ms / 50MB）——PS-5 的收紧有据', () => {
    const src = vendor('editor/common/config/diffEditor.js');
    expect(src).toContain('maxComputationTime: 5000');
    expect(src).toContain('maxFileSize: 50');
  });
});

/**
 * P2-16 排版偏好：create 路径与三个写入点同源（源码形状 + 假编辑器行为）。
 *
 * 钉四件事：① EditorPane 的 create options spread 同一份偏好补丁、create 那格不再另写
 * wordWrap（不许一条路径读偏好、另一条读硬编码）；② 订阅那条腿接在创建 effect 上
 * （设置页一翻即时生效，不用重开文件）；③ 档位表不变式保持——偏好是**叠层**不是新
 * 档位键（`sizeTierKeys` 枚举口径不变，`sizeTierKeysMissingFromSmall` 照旧恒空）；
 * ④ 撤下预览回到小文件，wordWrap 不卡 huge 档的关值（含偏好叠层与两个新键）。
 */
describe('P2-16 排版偏好：create 路径与三个写入点同源', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('EditorPane create options spread 同一份偏好补丁；create 那格不再另写 wordWrap', () => {
    const src = paneSource();
    expect(src).toContain('...layoutPrefPatch(),');
    // 读了偏好就不能再留一条硬编码路径（create 时按 small 档取值由补丁给）
    expect(src).not.toContain("wordWrap: 'on',");
  });

  it('偏好订阅接在创建 effect 上：设置页一翻，编辑器即时重发这三个键', () => {
    const src = paneSource();
    expect(src).toContain('subscribeLayoutPref(');
    expect(src).toContain('ed.updateOptions(layoutPrefPatch(model ? model.getLineCount() : 0));');
  });

  it('档位表不变式保持：偏好是叠层，不是新档位键（sizeTierKeys 枚举口径不变）', () => {
    expect(sizeTierKeysMissingFromSmall()).toEqual([]);
    expect(sizeTierKeys()).toContain('wordWrap'); // wordWrap 照旧住在档位表里
    expect(sizeTierKeys()).not.toContain('multiCursorModifier');
    expect(sizeTierKeys()).not.toContain('columnSelection');
  });

  it('叠出来的选项带偏好：huge → 挂更大投影 → 撤下回到小文件，wordWrap 不卡关值', () => {
    const current: Record<string, unknown> = {};
    const ed = { updateOptions: (o: Record<string, unknown>) => Object.assign(current, o) };
    applySizeTier(ed, 60_000); // 打开一份 huge 原文：档位表关折行
    expect(current.wordWrap).toBe('off');
    applySizeTier(ed, 120_000, { readOnly: true }); // 挂上 .kojo 投影（比原文更长）
    applySizeTier(ed, 800); // 撤下投影、按回到屏幕上的那份原文落档
    // 缺省偏好 = 跟随档 ⇒ 补丁给档位表自己的值，不卡 huge 的关值
    expect(current.wordWrap).toBe('on');
    expect(current.multiCursorModifier).toBe('ctrlCmd');
    expect(current.columnSelection).toBe(false);
    expect(current.readOnly).toBe(true); // 偏好补丁不碰可写态（三个写入点的 overrides 照旧）
  });

  it('存过「强制关」：三个写入点读的是同一份偏好——撤投影回小文件也 off', () => {
    const map = new Map([['kojo.ui.layout.wordWrap.v1', 'off']]);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
    });
    const current: Record<string, unknown> = {};
    const ed = { updateOptions: (o: Record<string, unknown>) => Object.assign(current, o) };
    applySizeTier(ed, 60_000); // huge：档位本就 off
    expect(current.wordWrap).toBe('off');
    applySizeTier(ed, 800); // 回到小文件：跟随档本该 on，强制关盖在档位表之后
    expect(current.wordWrap).toBe('off');
  });
});
