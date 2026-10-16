/**
 * 内置教程浮层（2026-10-13 教程批 E6；`ui.overlay` 贡献，两个实例）。
 *
 * 链路：面板底部教程按钮 → 内核事件 `ui.overlay.open` → 宿主打开本 overlay
 * → 正文读 `tutorial-content.ts` 的纯数据 → 「关闭」按钮发 `ui.overlay.close`。
 * Esc / 遮罩关闭由宿主负责，组件不自己处理（与既有向导同一契约）。
 *
 * 长文滚动策略：标题与脚部固定，只有 `.tutorial-body` 滚（样式见 styles.css
 * 的 `.wizard.tutorial`）——教程是"读"的界面，读到一半把「关闭」和标题卷出
 * 视野之外是最典型的浮层失败。
 *
 * 版面（E9 宽版文档式；TUT-1 2026-10-16 修复 + 打磨）：
 * - 正文列 `.tutorial-doc` 限宽 ≈680px（宽版宿主 920px 里保持可读行长）；
 * - 行内标记（`**粗体**` / 反引号代码）经 `tutorial-inline.ts` 解析后渲染成
 *   <strong> / <code>——此前标记原样上屏，导语承诺的"右边是它编译出来的"对不上字面；
 * - 对照样例左右并排（`.tutorial-pair`：左 kojo / 中「编译为」/ 右产物），
 *   窄窗由容器查询回落上下堆叠——导语里"左边是你写的，右边是它编译出来的"
 *   是版面承诺，不是比喻；样例区比散文需要更多宽度，经容器查询单位突破正文列。
 */

import { createElement as h, type ReactNode } from 'react';
import { parseTutorialInline, type TutorialInlineNode } from './tutorial-inline';
import type { Tutorial, TutorialSample } from './tutorial-content';

/** overlay 贡献 id（面板按钮发 `ui.overlay.open` 时引用） */
export const SUGAR_TUTORIAL_OVERLAY_ID = 'eratw.tutorialSugar';
export const KOJO_TUTORIAL_OVERLAY_ID = 'eratw.tutorialKojo';

export interface TutorialOverlayDeps {
  tutorial: Tutorial;
  /** 关闭自身（经内核事件，组件不持有宿主引用） */
  close(): void;
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
        h(
          'div',
          { className: 'tutorial-doc' },
          ...tutorial.sections.map((s, i) =>
            h(
              'div',
              { key: i, className: 'tutorial-section' },
              h('h4', null, ...inlineText(s.heading, `h${i}`)),
              ...s.paragraphs.map((p, j) => h('p', { key: j }, ...inlineText(p, `p${i}-${j}`))),
              ...(s.samples ?? []).map((sample, j) => sampleNode(sample, `sample${i}-${j}`)),
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: deps.close }, '关闭'),
      ),
    );
  };
}
