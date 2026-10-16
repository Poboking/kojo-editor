/**
 * 内置教程浮层（2026-10-13 教程批 E6；`ui.overlay` 贡献，三个实例：语法糖 / 口上 / 语法全表附录）。
 *
 * 链路：面板底部教程按钮 → 内核事件 `ui.overlay.open` → 宿主打开本 overlay
 * → 正文读 `tutorial-content.ts` / `tutorial-reference.ts` 的纯数据 → 「关闭」按钮发 `ui.overlay.close`。
 * Esc / 遮罩关闭由宿主负责，组件不自己处理（与既有向导同一契约）。
 *
 * 长文滚动策略：抬头（标题 + 导语）与脚部固定，只有正文列 `.tutorial-body` 滚（样式见
 * styles.css 的 `.wizard.tutorial`）——教程是"读"的界面，读到一半把「关闭」和标题卷出
 * 视野之外是最典型的浮层失败。
 *
 * 版面（2026-10-17 文档式重排；沿用 E9 宽版 / TUT-1 行内标记与对照样例 / TUT-2 对照表）：
 * - **现代目录栏**：`.tutorial-main` 是「左目录 + 右正文」两列（文档站的读法）。左栏
 *   `.tutorial-toc` 是竖排目录，独立滚动、不随正文滚走；点一条把正文滚到那节、焦点交给该节
 *   （键盘与读屏跟着走）。滚动正文时由 `spyActiveSection` 反查当前节、把 `aria-current`
 *   移到对应条目（scroll-spy），并把该条目滚进目录栏视野——长目录也 always 知道"读到哪了"。
 * - 节标题里的圈码（①②③…）经 `splitHeadingMarker` 拆成独立记号 `.tutorial-num`：目录与
 *   正文共用，编号成列、标题对齐，读起来像一本书的章节而不是散在句首的符号。
 * - 正文列 `.tutorial-doc` 限宽 ≈680px 保持可读行长；样例与表比散文吃宽度，经容器查询单位
 *   （`.tutorial-body` 是 inline-size 容器）突破正文列，窄窗由容器查询回落上下堆叠。
 * - 行内标记（`**粗体**` / 反引号代码）经 `tutorial-inline.ts` 解析后渲染成 <strong> / <code>。
 *
 * 本组件是「纯函数产元素树」（测试直接调用它拿树），**挂不得 hook**：目录跳转与 scroll-spy
 * 都走事件 + DOM 查询（`DomBox` 只声明用到的成员，因为本包 tsconfig 不带 DOM lib），
 * 平滑滚动交给样式（`.tutorial-body` / `.tutorial-toc` 的 `scroll-behavior`，减弱动效下压成瞬移），
 * 插件不读用户偏好。
 */

import { createElement as h, type ReactNode } from 'react';
import { parseTutorialInline, tutorialInlinePlain, type TutorialInlineNode } from './tutorial-inline';
import type { Tutorial, TutorialSample, TutorialTable } from './tutorial-content';

/** overlay 贡献 id（面板按钮发 `ui.overlay.open` 时引用） */
export const SUGAR_TUTORIAL_OVERLAY_ID = 'eratw.tutorialSugar';
export const KOJO_TUTORIAL_OVERLAY_ID = 'eratw.tutorialKojo';
export const REFERENCE_TUTORIAL_OVERLAY_ID = 'eratw.tutorialReference';

export interface TutorialOverlayDeps {
  tutorial: Tutorial;
  /** 关闭自身（经内核事件，组件不持有宿主引用） */
  close(): void;
  /** 可选：把读者送去语法全表（两份教程的脚部各一枚；缺省不渲染按钮） */
  openReference?(): void;
}

/**
 * 一节的锚点 id（`tutorial.id` 只有 ASCII 小写字母与数字，可直接进选择器）。
 * 目录跳转与 scroll-spy 都靠它找节，测试也可以按它数节。
 */
const sectionAnchorId = (tutorialId: string, index: number): string => `tu-${tutorialId}-s${index}`;

/**
 * 节标题起首的圈码记号（①-⑳ = U+2460–2473，㉑-㉟ = U+3251–325F，㊱-㊿ = U+32B1–32BF）。
 * 拆出来单独成一个 `.tutorial-num` 记号：编号在目录里成列、在正文里对齐，比让它黏在句首更像书。
 * 没有圈码的标题（如语法全表附录各节）原样返回 `marker: null`。
 */
const HEADING_MARKER = /^([\u2460-\u2473\u3251-\u325f\u32b1-\u32bf])\s*/u;

export function splitHeadingMarker(heading: string): { marker: string | null; text: string } {
  const m = HEADING_MARKER.exec(heading);
  const whole = m?.[0];
  const marker = m?.[1];
  if (whole === undefined || marker === undefined) return { marker: null, text: heading };
  return { marker, text: heading.slice(whole.length) };
}

/**
 * 目录跳转 / scroll-spy 要用的那几个 DOM 成员。本包 tsconfig 不带 DOM lib（DOM 归宿主），
 * 所以按既有面板的写法只声明用到的成员。
 */
type DomBox = {
  getBoundingClientRect(): { top: number };
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTo(init: { top: number }): void;
  scrollIntoView(init?: { block?: string }): void;
  focus(options?: { preventScroll?: boolean }): void;
  querySelector(selector: string): DomBox | null;
  querySelectorAll(selector: string): ArrayLike<DomBox>;
  closest(selector: string): DomBox | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

/**
 * 从被点的目录条目跳到第 i 节：滚的是正文列 `.tutorial-body`（不是窗口），焦点交给该节，
 * 键盘与读屏跟着走。目录栏现在是正文的**兄弟列**（不再贴在正文顶上），所以只需留一点呼吸顶距，
 * 不必再扣目录条高度。当前节的高亮交给随后的 scroll 事件（`spyActiveSection`）落定。
 */
function jumpToSection(tutorialId: string, index: number, from: unknown): void {
  const body = (from as DomBox | null)?.closest?.('.tutorial-body') ?? null;
  const section = body?.querySelector(`#${sectionAnchorId(tutorialId, index)}`) ?? null;
  if (!body || !section) return;
  const delta = section.getBoundingClientRect().top - body.getBoundingClientRect().top;
  body.scrollTo({ top: Math.max(0, body.scrollTop + delta - 10) });
  section.focus({ preventScroll: true });
}

/** 节顶越过正文列顶 + 这个像素数，就算"读到这一节了"（留一点抬头呼吸，别一到顶就翻篇） */
const SPY_TOP_OFFSET = 28;

/**
 * scroll-spy：正文滚动时反查当前节，把 `aria-current` 移到对应目录条目，并让该条目在目录栏里露出来。
 *
 * 纯 DOM、无 hook（与 `jumpToSection` 同款约束）：从滚动事件的目标（正文列）拿到兄弟目录栏，
 * 逐节比"节顶相对正文列顶"的位移，取最后一个已越过阈值的那节为当前。滚到底时强制点亮末节
 * （否则最后几节因为正文再也滚不动、永远够不到阈值）。当前节没变就早退，不写 DOM——滚动事件很密。
 */
function spyActiveSection(tutorialId: string, count: number, from: unknown): void {
  const body = from as DomBox | null;
  if (!body || count < 2) return;
  const toc = body.closest('.tutorial-main')?.querySelector('.tutorial-toc') ?? null;
  const items = toc?.querySelectorAll('.tutorial-toc-item') ?? null;
  if (!toc || !items || items.length === 0) return;

  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
  const bodyTop = body.getBoundingClientRect().top;
  let active = 0;
  for (let i = 0; i < count; i++) {
    const sec = body.querySelector(`#${sectionAnchorId(tutorialId, i)}`);
    if (sec && sec.getBoundingClientRect().top - bodyTop <= SPY_TOP_OFFSET) active = i;
  }
  if (atBottom) active = count - 1;

  if (toc.getAttribute('data-active') === String(active)) return;
  toc.setAttribute('data-active', String(active));
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    if (i === active) it.setAttribute('aria-current', 'true');
    else it.removeAttribute('aria-current');
  }
  // block:'nearest' 只在条目被目录栏裁掉时才滚，且只滚目录栏（它不是正文的祖先，不会顶动正文）
  items[active]?.scrollIntoView({ block: 'nearest' });
}

/** 行内节点 → React 子树（元素带 key；纯文本直接作为字符串孩子） */
function inlineNodes(nodes: TutorialInlineNode[], keyPrefix: string): ReactNode[] {
  return nodes.flatMap((node, i): ReactNode[] => {
    if (node.kind === 'text') return [node.text];
    if (node.kind === 'code') return [h('code', { key: `${keyPrefix}-${i}` }, node.text)];
    return [
      h('strong', { key: `${keyPrefix}-${i}` }, ...inlineNodes(node.children, `${keyPrefix}-${i}`)),
    ];
  });
}

const inlineText = (text: string, keyPrefix: string): ReactNode[] =>
  inlineNodes(parseTutorialInline(text), keyPrefix);

/** 一个样例：有产物则左右对照（.tutorial-pair 由样式排成三列），没有就单块 */
function sampleNode(sample: TutorialSample, key: string): ReactNode {
  const kojoCode = h('pre', { className: 'tutorial-code' }, h('code', null, sample.kojo));
  return h(
    'div',
    { key, className: 'tutorial-sample' },
    sample.caption
      ? h('div', { className: 'tutorial-caption dim' }, ...inlineText(sample.caption, `${key}-caption`))
      : null,
    sample.erb
      ? h(
          'div',
          { className: 'tutorial-pair' },
          kojoCode,
          // 中间标「编译为」：读者不用猜哪块是产物（箭头字形由样式按横/竖给，见 .tutorial-arrow）
          h('div', { className: 'tutorial-arrow' }, '编译为'),
          h('pre', { className: 'tutorial-code' }, h('code', null, sample.erb)),
        )
      : kojoCode,
  );
}

/** 一张对照表（附录用）：列名 + 等长行；单元文本与段落同一套行内标记 */
function tableNode(table: TutorialTable, key: string): ReactNode {
  return h(
    'div',
    { key, className: 'tutorial-table-block' },
    table.note
      ? h('div', { className: 'tutorial-caption dim' }, ...inlineText(table.note, `${key}-note`))
      : null,
    h(
      'div',
      { className: 'tutorial-table-scroll' },
      h(
        'table',
        { className: 'tutorial-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ...table.columns.map((c, i) =>
              h('th', { key: i, scope: 'col' }, ...inlineText(c, `${key}-h${i}`)),
            ),
          ),
        ),
        h(
          'tbody',
          null,
          ...table.rows.map((row, ri) =>
            h(
              'tr',
              { key: ri },
              ...row.map((cell, ci) => h('td', { key: ci }, ...inlineText(cell, `${key}-r${ri}c${ci}`))),
            ),
          ),
        ),
      ),
    ),
  );
}

/** 一条目录项：圈码记号（若有）单列 + 标题纯文本；当前项由 scroll-spy 挂 `aria-current` */
function tocItemNode(tutorialId: string, heading: string, index: number): ReactNode {
  const { marker, text } = splitHeadingMarker(heading);
  const plain = tutorialInlinePlain(text);
  return h(
    'button',
    {
      key: index,
      type: 'button',
      className: 'tutorial-toc-item',
      title: tutorialInlinePlain(heading),
      // 首项默认点亮（未滚动前"读到哪了"= 开头）；其余交给 spyActiveSection
      'aria-current': index === 0 ? 'true' : undefined,
      onClick: (e: { currentTarget: unknown }) => jumpToSection(tutorialId, index, e.currentTarget),
    },
    marker ? h('span', { className: 'tutorial-toc-num' }, marker) : null,
    h('span', { className: 'tutorial-toc-text' }, plain),
  );
}

/** 教程浮层组件（createElement 风格；与既有向导一致，无 JSX） */
export function createTutorialOverlay(deps: TutorialOverlayDeps): () => unknown {
  return function TutorialOverlay(): unknown {
    const { tutorial } = deps;
    const hasToc = tutorial.sections.length > 1;

    return h(
      'div',
      { className: 'wizard tutorial' },
      h(
        'div',
        { className: 'tutorial-head' },
        h('h3', null, ...inlineText(tutorial.title, 'title')),
        h('p', { className: 'tutorial-lead' }, ...inlineText(tutorial.lead, 'lead')),
      ),
      h(
        'div',
        { className: 'tutorial-main' },
        hasToc
          ? h(
              'nav',
              { className: 'tutorial-toc', 'aria-label': '教程目录', 'data-active': '0' },
              h('div', { className: 'tutorial-toc-label', 'aria-hidden': 'true' }, '目录'),
              ...tutorial.sections.map((s, i) => tocItemNode(tutorial.id, s.heading, i)),
            )
          : null,
        h(
          'div',
          {
            className: 'tutorial-body',
            onScroll: (e: { currentTarget: unknown }) =>
              spyActiveSection(tutorial.id, tutorial.sections.length, e.currentTarget),
          },
          h(
            'div',
            { className: 'tutorial-doc' },
            ...tutorial.sections.map((s, i) => {
              const { marker, text } = splitHeadingMarker(s.heading);
              return h(
                'div',
                {
                  key: i,
                  id: sectionAnchorId(tutorial.id, i),
                  className: 'tutorial-section',
                  // 目录跳转后焦点落这里：键盘与读屏跟着跳，不停在原位
                  tabIndex: -1,
                },
                h(
                  'h4',
                  null,
                  marker ? h('span', { className: 'tutorial-num' }, marker) : null,
                  ...inlineText(text, `h${i}`),
                ),
                ...s.paragraphs.map((p, j) => h('p', { key: j }, ...inlineText(p, `p${i}-${j}`))),
                ...(s.samples ?? []).map((sample, j) => sampleNode(sample, `sample${i}-${j}`)),
                ...(s.tables ?? []).map((table, j) => tableNode(table, `table${i}-${j}`)),
              );
            }),
          ),
        ),
      ),
      h(
        'div',
        { className: 'wizard-actions' },
        deps.openReference && tutorial.id !== 'reference'
          ? h('button', { className: 'ghost small', onClick: deps.openReference }, '查语法全表')
          : null,
        h('button', { className: 'ghost small', onClick: deps.close }, '关闭'),
      ),
    );
  };
}
