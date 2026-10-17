/**
 * FaceList（函数树 · 面函数列表的窗口化渲染）DOM 行数上界证据（2026-10-16 UX 感知批）。
 *
 * 为什么住 app 侧：react-dom（SSR）只有 app 包依赖它；断言对象是 navigator 插件的
 * `FaceList`（相对导入其 src——与 vitest alias 同源）。
 *
 * 口径：`renderToStaticMarkup` 数**真实产出的行节点数**——
 * - 初开 ≤ FACE_WINDOW_INITIAL 行（旧实现是硬截 300，且首帧就要挂最多 300 行）；
 * - 触底每步 +FACE_WINDOW_STEP（增量挂载，不存在"一次挂一整面"）；
 * - 窗口 ≥ total 时哨兵（「显示更多」）消失——与旧「300 上限」的语义差异是**全量可达**
 *   （滚动即自然加载），这正是任务允许的"窗口版的自然结果"。
 */

import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FamilyMatch } from '@kojo/plugin-api';
import { FaceList } from '../../plugins/ui-kojo-navigator/src/face-list';
import {
  FACE_WINDOW_INITIAL,
  FACE_WINDOW_STEP,
  type FunctionNode,
} from '../../plugins/ui-kojo-navigator/src/tree';

function node(i: number): FunctionNode {
  const match: FamilyMatch = {
    kind: 'ok',
    prefix: 'M_KOJO',
    family: '',
    characterNo: 1,
    selector: 0,
    face: 'MESSAGE_COM',
    sub: '',
    isMessageCheck: false,
    slot: String(i),
    isPlaceholder: false,
  };
  return {
    name: `M_KOJO_MESSAGE_COM_K1_${i}`,
    normalizedName: `M_KOJO_MESSAGE_COM_K1_${i}`,
    filePath: '/p/koa/001/A.ERB',
    startLine: i * 10 + 2,
    endLine: i * 10 + 9,
    match,
  };
}

const rows = (n: number): FunctionNode[] => Array.from({ length: n }, (_, i) => node(i + 1));
const count = (markup: string, cls: string): number => (markup.match(new RegExp(cls, 'g')) ?? []).length;

function render(functions: FunctionNode[], limit: number | undefined): string {
  return renderToStaticMarkup(
    h(FaceList, {
      faceKey: 'k1|f|MESSAGE_COM',
      functions,
      limit,
      onGrow: () => {},
      badges: () => [],
      onOpen: () => {},
      tooltip: (fn) => `tip:${fn.name}`,
    }),
  );
}

describe('FaceList · 面窗口的 DOM 行数上界', () => {
  it('10k 行面：初开只挂 INITIAL 行 + 一个哨兵（旧实现要挂 300 行）', () => {
    const html = render(rows(10_000), undefined);
    expect(count(html, 'nav-func-btn')).toBe(FACE_WINDOW_INITIAL);
    expect(count(html, 'nav-more-btn')).toBe(1);
    expect(html).toContain(`显示更多（其余 ${10_000 - FACE_WINDOW_INITIAL} 个）`);
  });

  it('窗口按 STEP 生长：每步只多挂 STEP 行；到 total 后哨兵消失', () => {
    const html240 = render(rows(10_000), FACE_WINDOW_INITIAL + FACE_WINDOW_STEP);
    expect(count(html240, 'nav-func-btn')).toBe(240);
    expect(html240).toContain(`显示更多（其余 ${10_000 - 240} 个）`);

    const htmlFull = render(rows(10_000), 10_000);
    expect(count(htmlFull, 'nav-func-btn')).toBe(10_000);
    expect(count(htmlFull, 'nav-more-btn')).toBe(0);
  });

  it('小面（≤ INITIAL）：无哨兵、行数 = total（与旧实现的常见路径同构）', () => {
    const html = render(rows(50), undefined);
    expect(count(html, 'nav-func-btn')).toBe(50);
    expect(count(html, 'nav-more-btn')).toBe(0);
    expect(html).toContain('M_KOJO_MESSAGE_COM_K1_1');
  });

  it('行为语义不丢：tooltip（含注释）与行按钮都在（点击跳函数通道由 onClick 保持）', () => {
    const html = render(rows(3), undefined);
    expect(html).toContain('title="tip:M_KOJO_MESSAGE_COM_K1_2"');
    expect(count(html, 'nav-func-name')).toBe(3);
  });
});
