import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 教程浮层宿主侧切片 `tutorial-surface.css` 的静态闸（视觉批十一 R4 ·
 * 按 L19 在 dev-note.css 留的 `// ui-kit-candidate` 记号搬成独立切片时立）。
 *
 * 口径照 `tutorial-code-block.test.ts` 先例：纯视觉判据钉在 CSS 源文本上（PITFALLS §127
 * 同款纪律），断言**按声明名取值**、不整段比文本——改注释/调声明顺序不该红，改语义才红。
 *
 * 钉六件事：
 *  ① 接线与位次：`main.tsx` 静态链 import 本表，且排在 `styles.css` 与 `themes/light.css`
 *     之后（与 light 档同特异性的井身反相内衬赢平靠位次；`css-slices-wired` 只查"有没有
 *     人 import"，查不出"import 得早晚"，早晚在这里钉）；
 *  ② 纸条零教程：dev-note.css 里一枚 `.wizard.tutorial` 选择器都不许有（回潮 = 双源漂移）；
 *  ③ 颜色纪律：切片去注释后零 hex、零 rgb()/rgba()、圆角零裸 px（一切取 token / color-mix）；
 *  ④ 代码井：井身凹槽只吃 `--well-edge`；上下"还有内容"四层配方；**不许重新声明
 *     white-space**——软折行是 2026-10-22 用户反馈、由 `tutorial-code-block.test.ts` 钉在
 *     两张表上的修法，本切片不借 override 翻回去；
 *  ⑤ 语法全表的井（真横滚的那口）：四边八层配方，`to right`/`to left` 的"右边还有内容"
 *     必须在位；
 *  ⑥ 目录条目：静息编号与层级线都收起（opacity 0），悬停/聚焦/当前三态才显；当前条目
 *     左条 + 语义色 + 字重、**零 accent 洗色**（全表不许出现 `--accent-dim`）；窄窗撤回。
 *
 * 「正在载入」一行口径与懒装载边由 `ps10-tutorial-lazy.test.ts` 钉死，本路零 JS 改动，
 * 不在这里重复钉。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const sliceSrc = (): string => read('../src/tutorial-surface.css');
const devNote = (): string => read('../src/dev-note.css');
const mainTsx = (): string => read('../src/main.tsx');

/** 去掉注释（颜色/选择器纪律只查活代码，注释里讲历史不许算违规） */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取某选择器的**全部**声明块（同一枚选择器允许在 @media 里再出现一次，按出现序返回） */
function ruleBodies(css: string, marker: string): string[] {
  const src = stripComments(css);
  const out: string[] = [];
  let at = src.indexOf(marker);
  while (at >= 0) {
    const open = src.indexOf('{', at);
    const close = src.indexOf('}', open);
    if (open < 0 || close < 0) throw new Error(`规则块不完整：${marker}`);
    out.push(src.slice(open + 1, close));
    at = src.indexOf(marker, close);
  }
  if (out.length === 0) throw new Error(`样式表里找不到规则起点：${marker}`);
  return out;
}

/** 声明块 → 属性表（同名后到者覆盖，与浏览器一致）；顺序与空白不参与判据 */
function decls(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of body.split(';')) {
    const at = raw.indexOf(':');
    if (at <= 0) continue;
    const prop = raw.slice(0, at).trim().toLowerCase();
    if (prop === '') continue;
    map.set(prop, raw.slice(at + 1).replace(/\s+/g, ' ').trim());
  }
  return map;
}

const first = (css: string, marker: string): Map<string, string> => decls(ruleBodies(css, marker)[0]!);
const last = (css: string, marker: string): Map<string, string> => {
  const all = ruleBodies(css, marker);
  return decls(all[all.length - 1]!);
};

describe('tutorial-surface.css：接线、纪律与三族形态', () => {
  it('① main.tsx 静态链 import 本表，且位次在 styles.css 与 themes/light.css 之后', () => {
    const main = mainTsx();
    expect(main).toMatch(/import\s+'\.[/]tutorial-surface\.css'/);
    const iSlice = main.indexOf("import './tutorial-surface.css'");
    expect(iSlice, 'tutorial-surface.css 必须由 main.tsx 直接 import（不许再借纸条链）').toBeGreaterThanOrEqual(0);
    expect(main.indexOf("import './styles.css'"), '位次必须晚于轻档').toBeLessThan(iSlice);
    expect(main.indexOf("import './themes/light.css'"), '位次必须晚于主题翻色').toBeLessThan(iSlice);
  });

  it('② 纸条（dev-note.css）零教程选择器——搬走了就不许回潮成双源', () => {
    const bare = stripComments(devNote());
    expect(bare).not.toMatch(/\.wizard\.tutorial|tutorial-/);
  });

  it('③ 颜色纪律：切片零 hex、零 rgb()/rgba()、圆角零裸 px（一切取 token / color-mix）', () => {
    const bare = stripComments(sliceSrc());
    expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(bare).not.toMatch(/\brgba?\(/);
    expect(bare).not.toMatch(/border-radius:\s*[^;]*\d+px/);
  });

  it('④ 代码井：凹槽吃 --well-edge、上下四层"还有内容"、不许翻软折行的修法', () => {
    const well = first(sliceSrc(), '.wizard.tutorial .tutorial-code code {');
    expect(well.get('box-shadow')).toBe('var(--well-edge)');
    expect(well.has('white-space'), '切片里重新声明 white-space = 借 override 翻 2026-10-22 的软折行修法').toBe(false);
    expect(well.get('background-attachment')).toBe('local, local, scroll, scroll');
    const layers = (well.get('background-image') ?? '').split('linear-gradient').length - 1;
    expect(layers, '代码身只该有上下四层（cover×2 + hint×2），软折行下没有横向溢出就不给撒谎的左右提示').toBe(4);
    expect(well.get('background-color')).toBe('var(--surface-sunken)');
  });

  it('⑤ 语法全表的井四边提示在位：八层配方，右缘即「右边还有内容」', () => {
    const table = first(sliceSrc(), '.wizard.tutorial .tutorial-table-scroll {');
    const image = table.get('background-image') ?? '';
    expect(image.split('linear-gradient').length - 1, '表井的横滚提示不许只给一半（cover 与 hint 都要成对）').toBe(8);
    expect(image).toMatch(/to right/);
    expect(image).toMatch(/to left/);
    const attach = (table.get('background-attachment') ?? '').split(',').map((s) => s.trim());
    expect(attach).toHaveLength(8);
    expect(attach.slice(0, 4).every((a) => a === 'local'), 'cover 层必须 local（跟内容走，到边自然盖住）').toBe(true);
    expect(attach.slice(4).every((a) => a === 'scroll'), 'hint 层必须 scroll（贴容器边才是"还有内容"）').toBe(true);
  });

  it('⑥ 目录静息只显标题：编号与层级线都是静息 opacity 0，三态才显；防撑破的 min-width 在位', () => {
    const rail = first(sliceSrc(), '.wizard.tutorial .tutorial-toc .tutorial-toc-item::before {');
    expect(rail.get('opacity'), '层级线静息就该收起（静息唯一可见物是标题）').toBe('0');
    expect(rail.get('width')).toBe('1px');
    expect(rail.get('background-color')).toBe('var(--border)');
    const num = first(sliceSrc(), '.wizard.tutorial .tutorial-toc .tutorial-toc-num {');
    expect(num.get('opacity')).toBe('0');
    const bare = stripComments(sliceSrc());
    // 三态显号（编号与层级线成对显出，缺一个态就是"悬停不亮"或"聚焦不亮"）
    expect(bare).toMatch(/\.tutorial-toc-item:hover \.tutorial-toc-num/);
    expect(bare).toMatch(/\.tutorial-toc-item:focus-visible \.tutorial-toc-num/);
    expect(bare).toMatch(/\.tutorial-toc-item\[aria-current='true'\] \.tutorial-toc-num/);
    expect(bare).toMatch(/\.tutorial-toc-item:hover::before/);
    expect(bare).toMatch(/\.tutorial-toc-item:focus-visible::before/);
    expect(bare).toMatch(/\.tutorial-toc-item\[aria-current='true'\]::before/);
    const grid = first(sliceSrc(), '.wizard.tutorial .tutorial-pair > .tutorial-code,');
    expect(grid.get('min-width')).toBe('0');
    expect(grid.get('max-width')).toBe('100%');
  });

  it('⑦ 当前条目：左条 + 语义色 + 字重，全表零 accent 洗色（反白行在 light 档会闪）', () => {
    const current = first(sliceSrc(), ".tutorial-toc-item[aria-current='true']:hover {");
    expect(current.get('background'), '当前条目不许有整行底色').toBe('none');
    expect(current.get('color')).toBe('var(--accent-text)');
    expect(current.get('border-left-color')).toBe('var(--accent)');
    expect(current.get('font-weight')).toBe('600');
    expect(stripComments(sliceSrc())).not.toMatch(/--accent-dim/);
  });

  it('⑧ 窄窗（≤680px）撤回竖线与藏号，别的不碰', () => {
    const rail = last(sliceSrc(), '.wizard.tutorial .tutorial-toc .tutorial-toc-item::before {');
    expect(rail.get('content'), '胶囊带里没地方挂竖线').toBe('none');
    const num = last(sliceSrc(), '.wizard.tutorial .tutorial-toc .tutorial-toc-num {');
    expect(num.get('opacity'), '胶囊里编号要一直显着').toBe('1');
    expect(ruleBodies(sliceSrc(), '.wizard.tutorial .tutorial-toc .tutorial-toc-item::before {')).toHaveLength(2);
  });

  it('⑨ 行内芯片补档在位（标题/导语与 p/td 同一配方，不另起一档）', () => {
    const chip = first(sliceSrc(), '.wizard.tutorial .tutorial-head :is(h3, .tutorial-lead) code,');
    expect(chip.get('background')).toBe('var(--chip-bg, var(--surface-overlay))');
    expect(chip.get('border-radius')).toBe('var(--radius-xs)');
  });
});
