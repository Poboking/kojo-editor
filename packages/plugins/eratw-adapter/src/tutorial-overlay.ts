/**
 * 内置教程浮层（2026-10-13 教程批 E6；`ui.overlay` 贡献，三个实例：语法糖 / 口上 / 语法全表附录）。
 *
 * 链路：面板底部教程按钮 → 内核事件 `ui.overlay.open` → 宿主打开本 overlay
 * → 正文读 `tutorial-content.ts` / `tutorial-reference.ts` 的纯数据 → 「关闭」按钮发 `ui.overlay.close`。
 * Esc / 遮罩关闭由宿主负责，组件不自己处理（与既有向导同一契约）。
 *
 * 长文滚动策略：标题与脚部固定，只有 `.tutorial-body` 滚（样式见 styles.css
 * 的 `.wizard.tutorial`）——教程是"读"的界面，读到一半把「关闭」和标题卷出
 * 视野之外是最典型的浮层失败。
 *
 * 版面（E9 宽版文档式；TUT-1 行内标记与对照样例；TUT-2 目录跳转与对照表）：
 * - 正文列 `.tutorial-doc` 限宽 ≈680px（宽版宿主 920px 里保持可读行长）；
 * - 行内标记（`**粗体**` / 反引号代码）经 `tutorial-inline.ts` 解析后渲染成
 *   <strong> / <code>——此前标记原样上屏，导语承诺的"右边是它编译出来的"对不上字面；
 * - 对照样例左右并排（`.tutorial-pair`：左 kojo / 中「编译为」/ 右产物），窄窗由容器
 *   查询回落上下堆叠；样例与表都比散文吃宽度，经容器查询单位突破正文列；
 * - 目录 `.tutorial-toc` 贴在滚动区顶部：点一条把滚动区滚到那一节、焦点交给该节
 *   （键盘与读屏跟着走），减弱动效下不做平滑滚动（`<html data-motion='reduced'>`）。
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
 * 目录跳转靠它找节，测试也可以按它数节。
 */
const sectionAnchorId = (tutorialId: string, index: number): string => `tu-${tutorialId}-s${index}`;

/**
 * 目录跳转要用的那几个 DOM 成员。本包 tsconfig 不带 DOM lib（DOM 归宿主），
 * 所以按既有面板的写法只声明用到的成员。
 */
type DomBox = {
  getBoundingClientRect(): { top: number };
  scrollTop: number;
  scrollTo(init: { top: number }): void;
  focus(options?: { preventScroll?: boolean }): void;
  querySelector(selector: string): DomBox | null;
  closest(selector: string): DomBox | null;
  offsetHeight: number;
};

/**
 * 从被点的目录条目跳到第 i 节：滚的是 `.tutorial-body` 这一块（不是窗口），
 * 焦点交给该节，键盘与读屏跟着走。留出的顶距 = 一点呼吸 + **贴顶目录自己的高度**，
 * 否则节标题正好被目录条盖住（跳了等于没跳）。
 *
 * 走事件而不走 ref：本组件是「纯函数产元素树」（测试直接调用它拿树），挂不得 hook。
 * 平滑滚动也不在这里——它在样式里（`.tutorial-body { scroll-behavior }`，
 * 减弱动效下压成瞬移），插件不读用户偏好。
 */
function jumpToSection(tutorialId: string, index: number, from: unknown): void {
  const body = (from as DomBox | null)?.closest?.('.tutorial-body') ?? null;
  const section = body?.querySelector(`#${sectionAnchorId(tutorialId, index)}`) ?? null;
  if (!body || !section) return;
  const pad = 12 + (body.querySelector('.tutorial-toc')?.offsetHeight ?? 0);
  const delta = section.getBoundingClientRect().top - body.getBoundingClientRect().top;
  body.scrollTo({ top: Math.max(0, body.scrollTop + delta - pad) });
  section.focus({ preventScroll: true });
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

/** 教程浮层组件（createElement 风格；与既有向导一致，无 JSX） */
export function createTutorialOverlay(deps: TutorialOverlayDeps): () => unknown {
  return function TutorialOverlay(): unknown {
    const { tutorial } = deps;

    return h(
      'div',
      { className: 'wizard tutorial' },
      h('h3', null, ...inlineText(tutorial.title, 'title')),
      h('p', { className: 'tutorial-lead' }, ...inlineText(tutorial.lead, 'lead')),
      h(
        'div',
        { className: 'tutorial-body' },
        tutorial.sections.length > 1
          ? h(
              'nav',
              { className: 'tutorial-toc', 'aria-label': '教程目录' },
              ...tutorial.sections.map((s, i) =>
                h(
                  'button',
                  {
                    key: i,
                    type: 'button',
                    className: 'tutorial-toc-item',
                    title: tutorialInlinePlain(s.heading),
                    onClick: (e: { currentTarget: unknown }) => jumpToSection(tutorial.id, i, e.currentTarget),
                  },
                  tutorialInlinePlain(s.heading),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'tutorial-doc' },
          ...tutorial.sections.map((s, i) =>
            h(
              'div',
              {
                key: i,
                id: sectionAnchorId(tutorial.id, i),
                className: 'tutorial-section',
                // 目录跳转后焦点落这里：键盘与读屏跟着跳，不停在原位
                tabIndex: -1,
              },
              h('h4', null, ...inlineText(s.heading, `h${i}`)),
              ...s.paragraphs.map((p, j) => h('p', { key: j }, ...inlineText(p, `p${i}-${j}`))),
              ...(s.samples ?? []).map((sample, j) => sampleNode(sample, `sample${i}-${j}`)),
              ...(s.tables ?? []).map((table, j) => tableNode(table, `table${i}-${j}`)),
            ),
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
