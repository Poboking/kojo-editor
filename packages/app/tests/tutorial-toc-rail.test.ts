import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUGAR_TUTORIAL, TUTORIALS } from '../../plugins/eratw-adapter/src/tutorial-content';
import { createTutorialOverlay } from '../../plugins/eratw-adapter/src/tutorial-overlay';

/**
 * 教程目录「层级线」的落点闸（L19-B 收口审计，2026-10-24）。
 *
 * 缺陷形态（审计查实，改前）：`.tutorial-toc-item::before` 那条 1px 层级线的 x 坐标是
 * `calc(var(--space-2) + var(--fs-0) * 0.6)` = 8 + 11 × 0.6 = **14.6px**，它假定每条目录
 * 都有「编号格」（`.tutorial-toc-num`，`min-width: 1.2em` + `gap`）。而渲染器只在标题
 * 起首有圈码时才产那个 span（`tutorial-overlay.ts` 的 `marker ? h('span', …) : null`）：
 * 语法全表 13 节、语法糖第 1 节「先说清…」都没有圈码 ⇒ 条目的标题文本直接从 8px 起排，
 * 层级线落在 14.6px —— **1px 竖线从标题首字中间穿过**（12px 汉字首字横向约 4.6–16.6px）。
 *
 * 修法：没有编号格的条目静息不画层级线（`:not(:has(.tutorial-toc-num))`）。层级线的语义
 * 是「编号那一格的占位」，没有编号格就没有可落的位；有编号的条目一字未动（静息只显标题
 * 的口径不翻）。窄窗（≤680px）本来就把层级线整体撤回，不参与本闸。
 *
 * 断言按**声明名取值**（与 `tutorial-code-block.test.ts` 同写法），改排版 / 调声明顺序不该红。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
// 教程面的皮住在 `tutorial-surface.css`（视觉批十一 R4 从 dev-note.css 搬出，纸条与教程分离）
const NOTE = (): string => read('../src/tutorial-surface.css');

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

/** 声明块 → 属性表（同名后到者覆盖；空白与声明顺序都不参与判据） */
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

const BASE = '.wizard.tutorial .tutorial-toc .tutorial-toc-item::before {';
const GUARD =
  '.wizard.tutorial .tutorial-toc .tutorial-toc-item:not(:has(.tutorial-toc-num))::before {';

/* ---------------------------- 目录条目产物的形状 ---------------------------- */

type Elt = { props?: Record<string, unknown> };

/** 极简元素树遍历（createElement 产物，不是 DOM；与 `tutorial.test.ts` 同款） */
function collectNodes(node: unknown, className: string, out: Elt[] = []): Elt[] {
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, className, out);
    return out;
  }
  if (node !== null && typeof node === 'object') {
    const el = node as Elt;
    if (el.props?.className === className) out.push(el);
    const children = el.props?.children;
    if (children !== undefined) collectNodes(children, className, out);
  }
  return out;
}

const renderOverlay = (t: typeof SUGAR_TUTORIAL): Elt =>
  (createTutorialOverlay({ tutorial: t, close: () => {} }) as () => Elt)();

/** 一条目录项的直接孩子里有没有编号格（span.tutorial-toc-num） */
function hasNumCell(item: Elt): boolean {
  const children = item.props?.children;
  const flat = Array.isArray(children) ? children : [children];
  return flat.some((child) => (child as Elt | null)?.props?.className === 'tutorial-toc-num');
}

describe('教程目录：层级线只画在有编号格的条目上（L19-B 审计缺口）', () => {
  it('没有圈码的节不产编号格，有圈码的节才产（层级线的落点前提）', () => {
    const reference = collectNodes(renderOverlay(TUTORIALS.reference), 'tutorial-toc-item');
    expect(reference.length).toBe(TUTORIALS.reference.sections.length);
    // 语法全表各节标题一律「…」起首，没有圈码 ⇒ 整本目录没有编号格
    for (const item of reference) expect(hasNumCell(item), '语法全表的目录项不该有编号格').toBe(false);

    const sugar = collectNodes(renderOverlay(SUGAR_TUTORIAL), 'tutorial-toc-item');
    // 语法糖第 1 节「先说清：这份教程教的是 v1 写法」没有圈码，其后 ①–⑳ 都有
    expect(hasNumCell(sugar[0] as Elt), '导言节不该有编号格').toBe(false);
    for (const item of sugar.slice(1)) expect(hasNumCell(item), '带圈码的节该有编号格').toBe(true);

    const kojo2 = collectNodes(renderOverlay(TUTORIALS.kojo2), 'tutorial-toc-item');
    for (const item of kojo2) expect(hasNumCell(item), '2.0 那本各节一律带圈码').toBe(true);
  });

  it('没有编号格的条目静息不画层级线（线的 x 是编号格中心，否则穿过标题首字）', () => {
    const css = NOTE();
    // 有编号格：层级线的配方一字不动（静息只显标题的口径不翻）
    const base = decls(css, BASE);
    expect(base.get('width'), '教程层级线宽度没吃 --rail-w').toBe('var(--rail-w)');
    // 色用长声明 `background-color`（::before 只需要颜色，简写会顺手清掉别的背景层）
    expect(base.get('background-color'), '教程层级线静息色没吃 --rail-color').toBe('var(--rail-color)');
    // 没有编号格：同一条线必须撤掉，否则 1px 竖线落在标题首字上
    expect(decls(css, GUARD).get('content'), '无编号格的目录项仍在画层级线（穿过标题首字）').toBe('none');
  });
});
