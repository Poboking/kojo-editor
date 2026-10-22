import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 教程代码块的「表头不吃正文」闸（2026-10-22 用户反馈回归，PITFALLS §127 同款纪律：
 * 纯视觉口径必须钉在 CSS 源上，否则下一次跨批次合并可能把整块视觉静默覆盖回旧版）。
 *
 * 缺陷形态（改前）：`.tutorial-code::before` 是 `position: sticky` 的吸顶标签行——代码块
 * 内部一滚，标签就把正在读的代码行盖在下面（用户原话：「上面的边框会挡住实际代码内容」）。
 * 修法：井容器改纵向 flex，表头是**不进滚动区**的第一行，滚动下移到 `code`（井身）——
 * 表头与代码身各占各的行，任何滚动位置都不重叠。
 *
 * 本闸钉四件事（两张样式表逐条同口径，轻档/重档任一侧被改回去都红）：
 *  ① 表头不再吸顶、不再用负 margin 逃出井容器（回到遮罩形态就红）；
 *  ② 井容器自己不滚（overflow: hidden），代码身才是唯一滚动层（overflow: auto）；
 *  ③ 表头/代码身的内衬各管各的（井容器 --well-pad-* 归零，表头贴井顶）；
 *  ④ 两侧文案（'kojo 口上' / '编译产物'）还在，且轻档与重档逐条相同。
 *
 * 断言按**声明名取值**而不是整段文本，改排版/调声明顺序不该红；改语义才红。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const LIGHT = (): string => read('../src/styles.css');
const HEAVY = (): string => read('../src/styles-project.css');

/** 去掉注释（本文件只做规则文本断言，注释里的旧文案不该影响判据） */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取某条规则的声明块：从 marker 起找到第一对花括号。这几条规则体内没有嵌套块，够用。 */
function ruleBody(css: string, marker: string): string {
  const src = stripComments(css);
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`样式表里找不到规则起点：${marker}`);
  const open = src.indexOf('{', at);
  const close = src.indexOf('}', open);
  if (open < 0 || close < 0) throw new Error(`规则块不完整：${marker}`);
  return src.slice(open + 1, close);
}

/** 声明块 → 属性表（同名后到者覆盖，与浏览器一致）；空白与声明顺序都不参与判据 */
function decls(css: string, marker: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of ruleBody(css, marker).split(';')) {
    const at = raw.indexOf(':');
    if (at <= 0) continue;
    const prop = raw.slice(0, at).trim().toLowerCase();
    if (prop === '') continue;
    map.set(prop, raw.slice(at + 1).replace(/\s+/g, ' ').trim());
  }
  return map;
}

const SHEETS: Array<[string, () => string]> = [
  ['styles.css（轻档）', LIGHT],
  ['styles-project.css（重档）', HEAVY],
];

/** 表头规则的选择器起点（`.u-well-head::before` 与 `.tutorial-code::before` 是同一条库规则） */
const HEAD_MARKER = '.u-well-head::before,';
const WELL_MARKER = '.tutorial-code {';
const CODE_MARKER = '.tutorial-code code {';
const KOJO_LABEL = '.tutorial-code::before {';
const ERB_LABEL = '.tutorial-pair > .tutorial-code:last-child::before {';

describe('教程代码块：表头不进滚动区（用户反馈 2026-10-22）', () => {
  it('① 表头不再吸顶：无 position / top / z-index / margin，是 flex 列里的固定一行', () => {
    for (const [label, src] of SHEETS) {
      const head = decls(src(), HEAD_MARKER);
      expect(head.has('position'), `${label} 的表头还在定位（吸顶遮罩又回来了？）`).toBe(false);
      expect(head.has('top'), `${label} 的表头还带 top 偏移`).toBe(false);
      expect(head.has('z-index'), `${label} 的表头还压在正文上方`).toBe(false);
      expect(head.has('margin'), `${label} 的表头还在用负 margin 逃出井容器`).toBe(false);
      expect(head.has('margin-top'), `${label} 的表头还带负 margin-top`).toBe(false);
      // 它是 flex 列里的固定一行（不会被压缩、也不参与滚动）
      expect(head.get('flex'), `${label} 的表头缺 flex: none（可能被 flex 压缩）`).toBe('none');
      // 表头与代码身之间用弱化的分隔线，而不是旧的 --border 实线
      expect(head.get('border-bottom'), `${label} 的表头分隔线口径漂了`).toBe(
        '1px solid var(--head-border, var(--border-subtle))',
      );
    }
  });

  it('② 滚动只在代码身：井容器 overflow: hidden，code 是唯一 overflow: auto', () => {
    for (const [label, src] of SHEETS) {
      const well = decls(src(), WELL_MARKER);
      const code = decls(src(), CODE_MARKER);
      expect(well.get('display'), `${label} 的井容器不再纵向分两行`).toBe('flex');
      expect(well.get('flex-direction'), `${label} 的井容器不是纵向 flex 列`).toBe('column');
      expect(well.get('overflow'), `${label} 的井容器自己又成了滚动容器`).toBe('hidden');
      expect(well.get('max-height'), `${label} 的井容器封顶高度丢了`).toBe('320px');
      expect(code.get('overflow'), `${label} 的代码身不再是滚动层`).toBe('auto');
      expect(code.get('display'), `${label} 的代码身不是块级（滚动会失效）`).toBe('block');
      expect(code.get('flex'), `${label} 的代码身不能吃掉剩余高度（长块会溢出井）`).toBe('1 1 auto');
      expect(code.get('min-height'), `${label} 的代码身缺 min-height: 0（flex 子项压不下去）`).toBe('0');
    }
  });

  it('③ 内衬与全局 code 规则归属：井容器零内衬（表头贴井顶），代码身自带内衬/沉一档底/无圆角', () => {
    for (const [label, src] of SHEETS) {
      const well = decls(src(), WELL_MARKER);
      const code = decls(src(), CODE_MARKER);
      for (const token of ['--well-pad-t', '--well-pad-i', '--well-pad-b'] as const) {
        expect(well.get(token), `${label} 的井容器还留着内衬 ${token}（表头会被顶离井沿）`).toBe('0');
      }
      expect(code.get('padding'), `${label} 的代码身没有自己的内衬`).toBe(
        'var(--space-2) var(--space-3) var(--space-3)',
      );
      expect(code.get('background'), `${label} 的代码面颜色口径漂了`).toBe('var(--surface-sunken)');
      expect(code.get('white-space'), `${label} 的代码身长行不再软折行`).toBe('pre-wrap');
      expect(code.get('overflow-wrap'), `${label} 的代码身丢掉整词兜底折断`).toBe('break-word');
      // 全局 `code` 的 4px 圆角/--font-mono 不许漏进块级代码身（圆角在井顶角露底色）
      expect(code.get('border-radius'), `${label} 的代码身还带着全局 code 的圆角`).toBe('0');
      expect(code.get('font-family'), `${label} 的代码身没跟 pre 的编辑器字栈`).toBe('inherit');
      expect(well.get('font-family'), `${label} 的井容器不再提供编辑器字栈`).toBe('var(--font-code)');
    }
  });

  it('④ 两侧文案还在，且轻档与重档的这五条规则逐字相同（PS-18 等价性前提）', () => {
    const labels: Array<[string, string, string]> = [
      ['kojo 口上', KOJO_LABEL, 'kojo 口上'],
      ['编译产物', ERB_LABEL, '编译产物'],
    ];
    for (const [sheet, src] of SHEETS) {
      for (const [text, marker, expected] of labels) {
        expect(decls(src(), marker).get('content'), `${sheet} 缺表头文案「${text}」`).toBe(`'${expected}'`);
      }
    }
    // 轻档只许从重档拷行：这五条视觉规则必须逐字一致（声明顺序不参与判据）
    const sorted = (m: Map<string, string>): Array<[string, string]> =>
      [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const marker of [HEAD_MARKER, WELL_MARKER, CODE_MARKER, KOJO_LABEL, ERB_LABEL]) {
      expect(sorted(decls(LIGHT(), marker)), `轻档与重档的规则不一致：${marker}`).toEqual(
        sorted(decls(HEAVY(), marker)),
      );
    }
  });
});
