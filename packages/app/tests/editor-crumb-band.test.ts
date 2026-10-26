/**
 * VIS-15（1026 编辑器体感批 E2）：**一条上下文带**的静态守门。
 *
 * 形状照 `editor-widget-css.test.ts`（E1）/ `readonly-pill.test.ts` 先例：EditorPane 挂着
 * Monaco 与整套内核槽位，node 里渲染不出来，而这一批全是**结构约定**（哪个节点还在、
 * 哪一句挪去了哪里、带子多高、切片怎么接线），运行期没有可观测面 ⇒ 只能钉在源码与样式表文本上。
 *
 * 钉六件事：
 *  ① 一条带：`.editor-crumb-band` 在册、`.editor-toolbar` 节点不再渲染、面包屑并进带子左簇；
 *  ② 身份只出现一次：file-label 落进导航簇，而项目相对口径三条（长前缀不上屏 / 目录与文件名
 *     之间那道「/」 / 完整绝对路径恒在 `title={filePath}`）一件不许丢；
 *  ③ 降级提示不在导航带里（两枚徽章整族离开带子）；
 *  ④ 窄屏溢出走**共享** `<ContextMenu>`，断点从"默认就命中的 1280"改成真的窄（1024）；
 *  ⑤ 切片纪律：真被 import、零硬编码色、字号只吃刻度、每条规则都靠特异性而不靠注入顺序、
 *     减弱动效自带豁免；
 *  ⑥ 溢出菜单的内容单源（`editor-pane/band-overflow.ts`）且只在真有次要项时才有那颗按钮。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BAND_MARKS_ID,
  BAND_STATS_ID,
  SUGAR_STATS_DETAIL,
  bandHasSecondary,
  bandOverflowItems,
  type BandSecondaryFacts,
} from '../src/ui/editor-pane/band-overflow';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const pane = readFileSync(path.join(SRC, 'ui/EditorPane.tsx'), 'utf8');
const slicePath = path.join(SRC, 'ui', 'editor-crumb-band.css');
const sliceRaw = readFileSync(slicePath, 'utf8');
/** 判据一律看剥掉注释后的正文（注释里可以提死掉的名字，活代码不许） */
const slice = sliceRaw.replace(/\/\*[\s\S]*?\*\//g, '');
const heavy = readFileSync(path.join(SRC, 'styles-project.css'), 'utf8');
const crumbBar = readFileSync(path.join(SRC, 'ui/breadcrumb-bar.tsx'), 'utf8');

/** 带子的 JSX 区间：从带子根节点到 `.editor-body` 之前（含左簇与右簇） */
const bandRegion = (): string => {
  const start = pane.indexOf('<div className="editor-crumb-band"');
  expect(start, '带子的根节点没渲染').toBeGreaterThan(-1);
  const end = pane.indexOf('<div className="editor-body"', start);
  expect(end, '带子区间找不到结尾锚点（`.editor-body`）').toBeGreaterThan(start);
  return pane.slice(start, end);
};

/**
 * 带子区间里**真正渲染着**的东西（JSX 注释 `{/* … *\/}` 全部剥掉）。
 * 判据要吃活代码：注释里提一句"那两枚徽章搬走了"不算把告警留在了带子里。
 */
const bandRegionCode = (): string => bandRegion().replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/** 取切片里某选择器的规则体（只在本文件射程内找，逐字面匹配） */
function sliceRule(selector: string): string {
  const i = slice.indexOf(`${selector} {`);
  expect(i, `切片里找不到选择器「${selector}」`).toBeGreaterThanOrEqual(0);
  return slice.slice(i, slice.indexOf('}', i));
}

/** 切片里的选择器全表（`@media` / `@keyframes` 的内层段与 at-rule 头按"必须从类或属性起头"筛掉） */
const sliceSelectors = [...slice.matchAll(/([^{}]+)\{/g)]
  .map((m) => m[1]!.trim().replace(/\s+/g, ' '))
  .filter((s) => s.length > 0 && !s.startsWith('@'))
  .flatMap((s) => s.split(',').map((one) => one.trim()))
  .filter((s) => /^[.:]/.test(s));

const FACTS_ON: BandSecondaryFacts = { previewing: true, stats: '已收起 128 行', marks: true };

describe('① 一条带：工具条节点退场，面包屑并进左簇', () => {
  it('带子根节点在册并接管 editor 面；`.editor-toolbar` 不再渲染', () => {
    expect(pane).toContain('<div className="editor-crumb-band" data-context-surface="editor">');
    expect(pane).not.toContain('className="editor-toolbar"');
    expect(pane).not.toContain('className="editor-crumb"'); // 那一行由 CrumbBar 自己渲染，带子不另起
  });

  it('CrumbBar 渲染在带子**内部**的导航簇里（不再是带子之后的第二条）', () => {
    const nav = pane.indexOf('<div className="band-nav">');
    const divider = pane.indexOf('<span className="band-divider"');
    const crumb = pane.indexOf('<CrumbBar');
    expect(nav).toBeGreaterThan(-1);
    expect(crumb).toBeGreaterThan(nav);
    expect(divider).toBeGreaterThan(crumb);
    expect(crumbBar).toContain('className="editor-crumb"');
  });

  it('带子高 28px（改前 34 + 20 = 54，省下的 ≈ 两行代码）', () => {
    expect(sliceRule('.editor-crumb-band')).toMatch(/min-height:\s*28px/);
    expect(sliceRule('.editor-crumb-band')).toMatch(/border-bottom:\s*1px solid var\(--border\)/);
  });

  it('面包屑并入后不再自带面板底与底边轨（两簇各自画一遍底就是"两根灰条"的病根）', () => {
    const body = sliceRule('.editor-crumb-band .editor-crumb');
    expect(body).toMatch(/background:\s*transparent/);
    expect(body).toMatch(/border-bottom:\s*0/);
    expect(body).toMatch(/padding:\s*0/);
  });
});

describe('② 身份只出现一次，且项目相对口径三条都在', () => {
  it('file-label 落在导航簇内、`title={filePath}` 恒在（完整绝对路径永远悬停即得）', () => {
    expect(bandRegion()).toContain('<span className="file-label" title={filePath}>');
  });

  it('绝对长前缀不上屏（切片自带这条，落点从 `.editor-toolbar` 换成带子）', () => {
    expect(sliceRule('.editor-crumb-band .file-label .file-dir')).toMatch(/display:\s*none/);
  });

  it('目录与文件名之间有那道可见「/」', () => {
    expect(sliceRule(".editor-crumb-band .file-label .file-pkg::after")).toMatch(/content:\s*'/);
  });

  it('身份不许被裁：被挤的轮到最深目录那一格自己省略', () => {
    const body = sliceRule('.editor-crumb-band .file-label .file-pkg');
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    expect(slice).not.toMatch(/\.file-base\s*\{[^}]*text-overflow/);
  });
});

describe('③ 降级提示离开导航带', () => {
  it('两枚徽章整族不在带子里（带子里找不到那两句人话，也不引用 `bandNoticeNodes`）', () => {
    const region = bandRegionCode();
    expect(region).not.toContain('bandNoticeNodes');
    expect(region).not.toContain('折叠太多');
    expect(region).not.toContain('文件太大，错误检查已暂停');
    expect(region).not.toContain('erb-mode-notice');
  });

  it('落点是编辑区自身的浮层（`.editor-notice-layer` 在 `.editor-body` 里，单例渲染一次）', () => {
    const start = pane.indexOf('<div className="editor-body"');
    expect(start).toBeGreaterThan(-1);
    const body = pane.slice(start, pane.indexOf('{pendingChoice ?', start));
    expect(body.match(/className="editor-notice-layer"/g)?.length).toBe(1);
    expect(body).toContain('<div className="editor-notice-layer">{bandNoticeNodes}</div>');
    // JSX 仍只有一个真源（带子里不许有第二份文案）
    expect(pane.match(/const bandNoticeNodes = \(/g)?.length).toBe(1);
  });

  it('浮层整层不吃指针、只有徽章自己吃（不许挡住代码上的点击）', () => {
    expect(sliceRule('.editor-notice-layer')).toMatch(/pointer-events:\s*none/);
    expect(sliceRule('.editor-notice-layer .erb-mode-hint')).toMatch(/pointer-events:\s*auto/);
  });
});

describe('④ 窄屏溢出：共享弹出语言 + 真的窄', () => {
  it('断点改到 1024（1280 是默认窗口宽，旧判据在正常态天天命中）', () => {
    expect(pane).toContain("const BAND_NARROW_QUERY = '(max-width: 1024px)';");
    expect(pane).not.toContain("= '(max-width: 1280px)'");
  });

  it('溢出走共享 <ContextMenu>，自造浮层那套 DOM 与监听整族退场', () => {
    expect(pane).toContain("from './context-menu'");
    expect(pane).toContain('items={bandOverflowItems(bandSecondary)}');
    expect(pane).toContain('aria-haspopup="menu"');
    expect(pane).toContain('className="ghost small band-more"');
    expect(pane).not.toContain('toolbar-more');
    expect(pane).not.toContain('toolbar-more-pop');
    // 自造浮层要自己写"外部按下 / Esc 收起"；共享菜单负责退场，本组件不再监听一套
    expect(pane).not.toContain("document.addEventListener('pointerdown'");
  });

  it('主控件一件不藏：预览开关、解锁态、状态位、保存都还在带子里', () => {
    const region = bandRegion();
    for (const needle of [
      'className={`ghost small sugar-toggle',
      'className="erb-mode-hint unlocked"',
      '<span className="editor-status"',
      '<SaveButton',
    ]) {
      expect(region, `带子里少了主控件「${needle}」`).toContain(needle);
    }
  });
});

describe('⑤ 切片纪律', () => {
  it('切片真被 import（只认 import 语句，注释提文件名不算）', () => {
    expect(slice.length).toBeGreaterThan(400);
    expect(pane).toMatch(/import\s*['"]\.\/editor-crumb-band\.css['"]/);
  });

  it('零硬编码色：无十六进制，rgb()/hsl() 只许套 var()', () => {
    const hex = [...slice.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(hex, `写死的色值：${hex.join(' ')}`).toEqual([]);
    const bad = [...slice.matchAll(/\b(?:rgba?|hsla?)\(([^)]*)\)/g)]
      .filter((m) => !m[1]!.includes('var('))
      .map((m) => m[0]);
    expect(bad, `裸分量色函数：${bad.join(' ')}`).toEqual([]);
  });

  it('字号只吃 --fs-* 六档，零裸 px 字号', () => {
    const sizes = [...slice.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(sizes.length, '一处字号都没写：这条判据要的是"写就必须吃 token"').toBeGreaterThan(0);
    for (const v of sizes) expect(v, `font-size: ${v} 不吃 --fs-*`).toMatch(/^var\(--fs-[a-z0-9]+\)$/);
  });

  it('靠特异性取胜，不靠注入顺序：切片里没有一枚"裸单类"选择器与重档同名', () => {
    // 生产构建里组件切片与 styles-project.css 谁先到不确定 ⇒ 同名单类必输于顺序赌局。
    const naked = sliceSelectors.filter((s) => /^\.[a-z][a-z0-9-]*$/.test(s));
    const colliding = naked.filter((s) => new RegExp(`(^|\\n)\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`).test(heavy));
    expect(colliding, `与重档同名的裸单类（谁后注入谁赢）：${colliding.join(' , ')}`).toEqual([]);
    // 其余每条都至少两级（`.editor-crumb-band X` 一类）
    for (const s of sliceSelectors) {
      if (s.startsWith(':root[data-motion')) continue; // 动效豁免那两条按属性命中
      expect(s, `选择器只有一级、压不住重档：${s}`).toMatch(/\S\s+\S|^\.[a-z][a-z0-9-]*$/);
    }
  });

  it('减弱动效自带豁免：两条开关各自把局部节奏压成 0ms 并撤掉入场', () => {
    expect(slice).toMatch(/:root\[data-motion='reduced'\] \.editor-notice-layer\s*\{[^}]*--cb-dur:\s*0ms/);
    expect(slice).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?--cb-dur:\s*0ms/);
    expect(slice).toMatch(/animation:\s*cb-notice-in var\(--cb-dur\)/);
  });

  it('带子上不许挂 transform / filter / contain（共享菜单是 fixed，会被局部坐标系接管）', () => {
    expect(sliceRule('.editor-crumb-band')).not.toMatch(/\b(transform|filter|backdrop-filter|contain)\s*:/);
  });

  it('动作簇自带旧工具条那批度量（残留被删那天不会静默掉档）', () => {
    // 这三件今天同时住在 `styles-project.css` 的 `.editor-toolbar …` 残留里（Lane B 收尾要删），
    // 带子不靠它们：少了任何一件，症状都是"外观悄悄退化而全绿"。
    expect(sliceRule('.editor-crumb-band .band-actions button')).toMatch(/white-space:\s*nowrap/);
    expect(sliceRule('.editor-crumb-band .erb-mode-hint')).toMatch(/flex:\s*0 0 auto/);
    const status = sliceRule('.editor-crumb-band .editor-status');
    expect(status).toMatch(/min-width:\s*16ch/); // 元信息空档留恒定占位 ⇒ 瞬时态不推着开关跳
    expect(status).toMatch(/text-align:\s*right/);
  });

  it('保存键的 .idle 弱化档在带子里重钉一份（P3-4 三段式不许随残留退场）', () => {
    const idle = sliceRule('.editor-crumb-band button.primary.idle');
    expect(idle).toMatch(/background:\s*transparent/);
    expect(idle).toMatch(/border-color:\s*var\(--border\)/);
    expect(idle).toMatch(/color:\s*var\(--fg-dim\)/);
    expect(sliceRule('.editor-crumb-band button.primary.idle:hover:not(:disabled)')).toMatch(
      /border-color:\s*var\(--border-strong\)/,
    );
  });
});

describe('⑥ 溢出菜单内容单源（纯函数，可 node 直测）', () => {
  it('没有次要项 ⇒ 一颗钮都不该出现', () => {
    expect(bandHasSecondary({ previewing: false, stats: '已收起 128 行', marks: true })).toBe(false);
    expect(bandHasSecondary({ previewing: true, stats: null, marks: true })).toBe(false);
    expect(bandOverflowItems({ previewing: false, stats: null, marks: false })).toEqual([]);
  });

  it('读数那一格是**按不动的信息行**，且说清为什么按不动（铁律 4 的菜单侧同款）', () => {
    const items = bandOverflowItems(FACTS_ON);
    const stats = items.find((i) => i.id === BAND_STATS_ID);
    expect(stats?.disabled).toBe(true);
    expect(stats?.disabledReason ?? '').toContain('读数');
    expect(stats?.disabledReason).toContain(SUGAR_STATS_DETAIL); // 与带子里那格的 title 同一句（单源）
  });

  it('「显示语法标记」是**可点**的勾选项，标签恒定（换字会横抖）', () => {
    const items = bandOverflowItems(FACTS_ON);
    const marks = items.find((i) => i.id === BAND_MARKS_ID);
    expect(marks?.disabled).toBeUndefined();
    expect(marks?.checked).toBe(true);
    expect(marks?.label).toBe('显示语法标记');
    expect(bandOverflowItems({ ...FACTS_ON, marks: false })
      .find((i) => i.id === BAND_MARKS_ID)?.checked).toBe(false);
  });

  it('读数过长只截标签，全文永远在悬停里；条目都有中文标签（与全站菜单同一口径）', () => {
    const long = bandOverflowItems({ previewing: true, stats: '一'.repeat(80), marks: true });
    const stats = long.find((i) => i.id === BAND_STATS_ID);
    expect((stats?.label ?? '').length).toBeLessThanOrEqual(41);
    expect(stats?.disabledReason).toContain(SUGAR_STATS_DETAIL);
    for (const item of bandOverflowItems(FACTS_ON)) expect(item.label).toMatch(/[\u4e00-\u9fff]/);
  });
});
