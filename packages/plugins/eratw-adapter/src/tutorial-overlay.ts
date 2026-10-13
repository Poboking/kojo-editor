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
 */

import { createElement as h } from 'react';
import type { Tutorial } from './tutorial-content';

/** overlay 贡献 id（面板按钮发 `ui.overlay.open` 时引用） */
export const SUGAR_TUTORIAL_OVERLAY_ID = 'eratw.tutorialSugar';
export const KOJO_TUTORIAL_OVERLAY_ID = 'eratw.tutorialKojo';

export interface TutorialOverlayDeps {
  tutorial: Tutorial;
  /** 关闭自身（经内核事件，组件不持有宿主引用） */
  close(): void;
}

/** 教程浮层组件（createElement 风格；与既有向导一致，无 JSX） */
export function createTutorialOverlay(deps: TutorialOverlayDeps): () => unknown {
  return function TutorialOverlay(): unknown {
    const { tutorial } = deps;
    return h(
      'div',
      { className: 'wizard tutorial' },
      h('h3', null, tutorial.title),
      h('p', { className: 'dim' }, tutorial.lead),
      h(
        'div',
        { className: 'tutorial-body' },
        ...tutorial.sections.map((s, i) =>
          h(
            'div',
            { key: i, className: 'tutorial-section' },
            h('h4', null, s.heading),
            ...s.paragraphs.map((p, j) => h('p', { key: j }, p)),
            ...(s.samples ?? []).map((sample, j) =>
              h(
                'div',
                { key: j, className: 'tutorial-sample' },
                sample.caption ? h('div', { className: 'tutorial-caption dim' }, sample.caption) : null,
                h('pre', { className: 'tutorial-code' }, h('code', null, sample.kojo)),
                // ERB 对照可选：有才渲染，且固定标「→ 编译为」，读者不用猜哪块是本产物
                sample.erb ? h('div', { className: 'tutorial-caption dim' }, '→ 编译为') : null,
                sample.erb ? h('pre', { className: 'tutorial-code' }, h('code', null, sample.erb)) : null,
              ),
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
