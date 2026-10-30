/**
 * B3h 折叠区间供方的闸（`src/folding.ts` + `plugin.ts` 接线）。
 *
 * 这一格的形状与其它腿不同：可折区间是**结构 worker**（异步）算的，宿主在打开 / 改动时
 * 预取进缓存，随请求的 `folds` 递过来；供方**同步**作答。所以四组断言钉的是：
 *
 * 1. **语言过滤**：非 kojo2 ⇒ `undefined`（弃权）——宿主这枚 provider 也挂在 ERB / kojo1 上，
 *    混成空结果会把那门语言自己的折叠供方顶掉；
 * 2. **三态**：有快照 ⇒ 区间；快照为空 ⇒ `ranges: []`；**快照缺席**（还没预取到）⇒ 同样
 *    `ranges: []`（作答，不是弃权，也不异步等待）；
 * 3. **最后一道闸**：快照按请求里的 `lineCount` 再裁一遍（越界 / 倒置 / 重复 / 非整数），
 *    判据与宿主建快照时是**同一份实现**（`@kojo/kojo-lang/folding`）；
 * 4. **装配**：`kojo2-foldingRange` 是独立一枚贡献（order 10），不与别的腿合并。
 */
import { describe, expect, it } from 'vitest';
import type { EditorFoldingRange, PluginContext } from '@kojo/plugin-api';
import { createKojoLangPlugin, provideFoldingRanges } from '../src/index';

const PATH = 'D:/proj/口上/1_测试.kojo';

function fold(startLine: number, endLine: number): EditorFoldingRange {
  return { startLine, endLine };
}

function request(over: Record<string, unknown> = {}) {
  return {
    kind: 'foldingRange' as const,
    path: PATH,
    text: '# 幕 神社清晨\n> 晨光。\n',
    lineCount: 20,
    project: null,
    languageId: 'kojo2',
    ...over,
  } as never;
}

describe('折叠供方 · 语言过滤与三态', () => {
  it('非 kojo2 ⇒ undefined（弃权；不顶掉 ERB / kojo1 自己的折叠供方）', () => {
    expect(provideFoldingRanges(request({ languageId: 'kojo-erb', folds: [fold(1, 2)] }))).toBeUndefined();
    // 没有 languageId 时退回扩展名：`.erb` 不是 2.0
    expect(provideFoldingRanges(request({ languageId: undefined, path: 'D:/p/a.ERB' }))).toBeUndefined();
  });

  it('不是 foldingRange 的请求 ⇒ undefined（同一槽的其它判别成员不归这里）', () => {
    expect(provideFoldingRanges(request({ kind: 'documentSymbol' }))).toBeUndefined();
  });

  it('有快照 ⇒ 区间原样交回（顺序与区间逐字不变）', () => {
    expect(provideFoldingRanges(request({ folds: [fold(1, 2), fold(4, 10)] }))).toEqual({
      kind: 'foldingRange',
      ranges: [fold(1, 2), fold(4, 10)],
    });
  });

  it('快照为空 ⇒ ranges: []（作答："这一版确实没有可折块"）', () => {
    expect(provideFoldingRanges(request({ folds: [] }))).toEqual({ kind: 'foldingRange', ranges: [] });
  });

  it('快照缺席（还没预取到）⇒ ranges: []（作答，不是弃权；不异步等待）', () => {
    expect(provideFoldingRanges(request())).toEqual({ kind: 'foldingRange', ranges: [] });
  });

  it('请求没带 lineCount ⇒ 同档空（没有行数事实就判不了越界）', () => {
    expect(provideFoldingRanges(request({ lineCount: undefined, folds: [fold(1, 2)] }))).toEqual({
      kind: 'foldingRange',
      ranges: [],
    });
  });
});

describe('折叠供方 · 最后一道闸（按当下行数再裁一遍）', () => {
  it('越界的快照行丢掉（不夹取：折错行比不折更糟）', () => {
    expect(provideFoldingRanges(request({ lineCount: 10, folds: [fold(1, 2), fold(3, 30)] }))).toEqual({
      kind: 'foldingRange',
      ranges: [fold(1, 2)],
    });
  });

  it('倒置 / 零高 / 重复 / 非整数条目丢掉，合法的照留', () => {
    const bad = [fold(4, 4), fold(6, 3), fold(2, 6), fold(2, 6), { startLine: 1.5, endLine: 3 } as never];
    expect(provideFoldingRanges(request({ folds: [fold(1, 5), ...bad] }))).toEqual({
      kind: 'foldingRange',
      ranges: [fold(1, 5), fold(2, 6)],
    });
  });
});

describe('折叠供方 · 装配', () => {
  it('`kojo2-foldingRange` 是独立一枚贡献（order 10），与其它腿并列注册', () => {
    const registered: { slot: string; item: { id: string; order?: number } }[] = [];
    const ctx = {
      pluginId: 'kojo-lang',
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      slots: {
        register: (slot: string, item: { id: string; order?: number }) => {
          registered.push({ slot, item });
          return () => undefined;
        },
      },
    } as unknown as PluginContext;

    createKojoLangPlugin().activate(ctx);
    const folding = registered.filter((entry) => entry.item.id === 'kojo2-foldingRange');
    expect(folding).toHaveLength(1);
    expect(folding[0]!.slot).toBe('ui.editor.languageService');
    expect(folding[0]!.item.order).toBe(10);
  });
});
