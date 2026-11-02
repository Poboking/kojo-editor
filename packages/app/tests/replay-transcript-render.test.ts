/**
 * 台词推演区的渲染钉（v0.3 口上调试统一批；静态串，默认 node 环境）。
 *
 * 引擎半边的判据在 `state-replay/tests/transcript.test.ts`（可见性 / 求值 / 占位），
 * 这里只钉**呈现**这一层：三档徽章措辞、不显示行保留原文、判不出计数、
 * 边界声明必须出现在脸上（"CALL 出去的段 / PRINTDATA / 循环不推演"），
 * 以及**缺省降级**——旧引擎不给 `transcript` 时整个区不渲染。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { FunctionReplay, TranscriptLine } from '@kojo/plugin-api';
import { TranscriptList, renderReplayPreview } from '../../plugins/ui-state-replay/src/preview';

function tl(
  line: number,
  visibility: TranscriptLine['visibility'],
  parts: { text?: string; payload?: string; unresolved?: number; reason?: string } = {},
): TranscriptLine {
  return {
    line,
    verb: 'PRINTFORML',
    visibility,
    payload: parts.payload ?? `原文${line}`,
    text: visibility === 'hidden' ? '' : (parts.text ?? `文本${line}`),
    unresolved: parts.unresolved ?? 0,
    ...(parts.reason ? { reason: { code: 'opaque', message: parts.reason } } : {}),
    ...(visibility !== 'shown' ? { guardLine: 2 } : {}),
  };
}

function replay(transcript?: TranscriptLine[]): FunctionReplay {
  return {
    normalizedName: 'TEST',
    filePath: 'x.ERB',
    startLine: 1,
    predicates: [],
    branches: [],
    stats: { total: 0, hit: 0, miss: 0, unknown: 0 },
    confidence: 'exact',
    ...(transcript ? { transcript } : {}),
  };
}

function render(result: FunctionReplay): string {
  return renderToStaticMarkup(
    renderReplayPreview({
      result,
      assumedSlots: [],
      emitReveal: () => undefined,
      predLimit: undefined,
      onGrowPreds: () => undefined,
    }) as never,
  );
}

describe('台词推演区呈现', () => {
  it('三档徽章白话：会显示 / 不显示 / 可能', () => {
    const html = render(replay([tl(3, 'shown'), tl(4, 'hidden'), tl(5, 'maybe')]));
    expect(html).toContain('会显示');
    expect(html).toContain('不显示');
    expect(html).toContain('可能');
  });

  it('会显示的行给求值后文本；不显示的行划线保留原文（作者要知道这里本来有句话）', () => {
    const html = render(
      replay([
        tl(3, 'shown', { text: '好感=500' }),
        tl(4, 'hidden', { payload: 'PRINTFORML 不会出现的这句' }),
      ]),
    );
    expect(html).toContain('好感=500');
    expect(html).toContain('rp-tr-hidden');
    expect(html).toContain('不会出现的这句');
  });

  it('判不出的插值在文本里是 `%?%`，并挂处数提示', () => {
    const html = render(replay([tl(3, 'shown', { text: '好感=%?%', unresolved: 1 })]));
    expect(html).toContain('%?%');
    expect(html).toContain('1 处判不出');
  });

  it('被挡的行说清"被谁挡了"（reason 上屏 + title 全文）', () => {
    const html = render(replay([tl(3, 'hidden', { reason: '第 2 行的分支走了别处' })]));
    expect(html).toContain('第 2 行的分支走了别处');
  });

  it('边界声明在脸上：CALL 出去的段 / PRINTDATA / 循环不推演', () => {
    const html = render(replay([tl(3, 'shown')]));
    expect(html).toContain('CALL 出去的段');
    expect(html).toContain('PRINTDATA');
    expect(html).toContain('循环体');
  });

  it('统计头给出"几句会显示 / 共几行"', () => {
    const html = render(replay([tl(3, 'shown'), tl(4, 'hidden'), tl(5, 'shown')]));
    expect(html).toContain('2/3 行会显示');
  });

  it('空载荷（裸 PRINTL）给一枚灰注脚，不让行只剩徽章', () => {
    const html = render(replay([tl(7, 'hidden', { payload: '' })]));
    expect(html).toContain('（空行）');
    expect(html).toContain('rp-tr-blank');
  });

  it('「就是这一行」的位点用 data-locate 标出来（与谓词列表同口径）', () => {
    const html = renderToStaticMarkup(
      createElement(TranscriptList, {
        lines: [tl(3, 'shown'), tl(9, 'shown')],
        filePath: 'x.ERB',
        emitReveal: () => undefined,
        atLine: 9,
      }) as never,
    );
    // 只有命中的那一行带标记，另一行不带（不许整列表一起高亮）
    expect((html.match(/data-locate="1"/g) ?? []).length).toBe(1);
  });
});

describe('缺省降级', () => {
  it('旧引擎不给 transcript ⇒ 整个台词推演区不渲染', () => {
    const html = render(replay());
    expect(html).not.toContain('rp-transcript');
    expect(html).not.toContain('这段会说的话');
  });

  it('空数组同样不渲染（引擎给了个空壳也不画空盒子）', () => {
    expect(render(replay([]))).not.toContain('rp-transcript');
  });
});
