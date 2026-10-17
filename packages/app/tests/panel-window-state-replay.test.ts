/**
 * 状态回放面板 · 谓词列表（PredicateList）的窗口化 DOM 行数上界证据（2026-10-16 窗口批）。
 *
 * 为什么住 app 侧：react-dom（SSR）只有 app 包依赖；断言对象是 ui-state-replay 插件的
 * `PredicateList`（相对导入其 `src/preview`——与 vitest alias 同源）。
 *
 * 口径（照 face-list-render.test.ts）：初开 ≤ PRED_WINDOW_INITIAL / 触底每步 +STEP /
 * 窗口 ≥ total 哨兵消失（旧实现硬截 300 + 「其余 N 条未显示」——那 N 条不可达）。
 * 另钉 G1「跳到命中状态」的既有承诺：位点行在初始窗口之外时，窗口把它撑进屏
 * （旧实现 300 之外本就做不到，窗口化不许弄丢）。
 */

import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PredicateReplay } from '@kojo/plugin-api';
import { PredicateList } from '../../plugins/ui-state-replay/src/preview';
import { PRED_WINDOW_INITIAL, PRED_WINDOW_STEP } from '../../plugins/ui-state-replay/src/panel-logic';

function pred(line: number): PredicateReplay {
  return {
    kind: 'IF',
    text: `TFLAG:${line} == 1`,
    line,
    outcome: { kind: 'true' },
    expr: { kind: 'opaque', text: `TFLAG:${line} == 1` },
  };
}
const preds = (n: number): PredicateReplay[] => Array.from({ length: n }, (_, i) => pred(10 + i));
const count = (markup: string, sub: string): number => (markup.split(sub).length - 1);

function render(list: PredicateReplay[], limit: number | undefined, atLine: number | null = null): string {
  return renderToStaticMarkup(
    h(PredicateList, {
      predicates: list,
      filePath: 'C:/game/kojo/a.erb',
      normalizedName: 'M_TEST',
      assumed: [],
      atLine,
      limit,
      onGrow: () => {},
      emitReveal: () => {},
    }),
  );
}

describe('PredicateList · 谓词窗口的 DOM 行数上界', () => {
  it('10k 条：初开只挂 INITIAL 条 + 一个哨兵（旧实现要挂 300 条且其余不可达）', () => {
    const html = render(preds(10_000), undefined);
    expect(count(html, 'rp-pred-btn')).toBe(PRED_WINDOW_INITIAL);
    expect(count(html, 'rp-more-btn')).toBe(1);
    expect(html).toContain(`显示更多（还剩 ${10_000 - PRED_WINDOW_INITIAL}）`);
  });

  it('窗口按 STEP 生长：每步只多挂 STEP 条；到 total 后哨兵消失', () => {
    const htmlStep = render(preds(10_000), PRED_WINDOW_INITIAL + PRED_WINDOW_STEP);
    expect(count(htmlStep, 'rp-pred-btn')).toBe(PRED_WINDOW_INITIAL + PRED_WINDOW_STEP);
    expect(htmlStep).toContain(`显示更多（还剩 ${10_000 - PRED_WINDOW_INITIAL - PRED_WINDOW_STEP}）`);

    const htmlFull = render(preds(10_000), 10_000);
    expect(count(htmlFull, 'rp-pred-btn')).toBe(10_000);
    expect(count(htmlFull, 'rp-more-btn')).toBe(0);
  });

  it('常见函数（< INITIAL 谓词）：零哨兵、全量在屏（与旧实现的常见路径同构）', () => {
    const html = render(preds(90), undefined);
    expect(count(html, 'rp-pred-btn')).toBe(90);
    expect(count(html, 'rp-more-btn')).toBe(0);
  });

  it('G1 跳转承诺：位点行在初始窗口之外时窗口盖住它（且带 data-locate 高亮）', () => {
    const list = preds(5_000);
    const atLine = list[249]!.line; // 第 250 条，初始窗口（120）之外
    const html = render(list, undefined, atLine);
    expect(count(html, 'rp-pred-btn')).toBe(250);
    expect(count(html, 'data-locate="1"')).toBe(1);
    expect(html).toContain('rp-locate-row');

    // 位点落在窗口内 → 不额外撑大
    const htmlInside = render(list, undefined, list[10]!.line);
    expect(count(htmlInside, 'rp-pred-btn')).toBe(PRED_WINDOW_INITIAL);
  });

  it('行为语义不丢：行带 kind / 结果标记与「文件:行」title', () => {
    const html = render(preds(2), undefined);
    expect(count(html, 'rp-kind')).toBe(2);
    expect(html).toContain('title="C:/game/kojo/a.erb:10"');
    expect(html).toContain('rp-outcome hit');
  });
});
