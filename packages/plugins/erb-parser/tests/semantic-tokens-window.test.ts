/**
 * ERB 结构化着色 · **行窗口**等价性（R3，2026-10-28）。
 *
 * 这一条是本批唯一的正确性闸，钉的事只有一件：
 *
 * > `erbSemanticTokens(text, index, 任意窗口)` ≡ `erbSemanticTokens(text, index)`
 * > 按行过滤到那个窗口。
 *
 * 为什么必须**穷举全部窗口**而不是抽查几个：窗口化踩坏的两类错都只在一小段行上现形——
 * ① 切片丢掉了前缀里开着的 `[SKIPSTART]`（窗口起点落在块内那一档）；
 * ② 行号平移少算一行（合成标记那一行）。
 * 抽查会正好绕开它们，而"大文件滚动"恰恰每一屏都在换窗口。
 *
 * 三种行尾 / 偏移缺省都各跑一遍：宿主永远给 `fromOffset`，但纯函数调用方（与老的量具）
 * 走的是"自己数换行"那条退路，两条必须逐条相同（A 批 `inlay-hints.test.ts` 同纪律）。
 */

import { describe, expect, it } from 'vitest';
import type { EditorSemanticTokenSpan, ErbFunction, ErbIndex } from '@kojo/plugin-api';
import { erbSemanticTokens } from '../src/semantic-tokens';

function indexWith(names: readonly string[]): ErbIndex {
  const byName = new Map<string, ErbFunction[]>();
  for (const name of names) byName.set(name.toUpperCase(), []);
  return { files: new Map(), byName, fingerprint: null } as unknown as ErbIndex;
}

const INDEX = indexWith(['M_KOJO_A', 'M_KOJO_B', 'M_KOJO_C']);

/**
 * 语料：22 行，每一档都放进去——定义（带形参 / 带缩进）、`#DIM`、注释、空行、
 * 代码前缀行、两段屏蔽区（其中一段里还藏着定义与引用）、`CALL` 与随便提及。
 * 屏蔽区的存在是这一批的关键：它让"窗口起点在块内"成为必然会被遍历到的一档。
 */
const LINES = [
  '@M_KOJO_A(ARGS, ARG:1 = 3)', // 1  定义 + 形参
  '\tCALL M_KOJO_B(1)', // 2  调用（槽位）
  '; M_KOJO_A 只是一行注释，不该有色', // 3  注释
  '', // 4  空行
  '#DIM FLAG_1', // 5  #DIM
  '  @M_KOJO_B', // 6  带缩进的定义
  ';!;CALL M_KOJO_C', // 7  代码前缀（`;!;` 之后是真代码）
  '[SKIPSTART]', // 8  屏蔽区开始
  '@M_KOJO_C(ARG)', // 9  屏蔽区里的定义：一行都不许产
  '\tCALL M_KOJO_A', // 10 屏蔽区里的调用：同样不许产
  '[SKIPEND]', // 11 屏蔽区结束
  '\tPRINTFORMW M_KOJO_A 也只是提及', // 12 提及
  '#DIM FLAG_2', // 13 第二个 #DIM
  '\tCALL M_KOJO_C(1, 2)', // 14 调用
  '', // 15
  '; 注释', // 16
  '@M_KOJO_C', // 17 定义
  '\tCALL M_KOJO_B', // 18
  '  ;#;CALL M_KOJO_A', // 19 另一种代码前缀
  '\tIF TFLAG:0', // 20 普通行（变量族不算引用）
  '\tCALL M_KOJO_A', // 21
  '@M_KOJO_B(ARG:1, ARG:2)', // 22 定义 + 两个形参
];

const EOL_CASES = [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
] as const;

/** 第 `line` 行行首在该份文本里的字符偏移（量具用；与宿主 `getOffsetAt` 同口径） */
function offsetOfLine(text: string, line: number, eol: string): number {
  let at = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf('\n', at);
    if (nl === -1) return text.length;
    at = nl + 1;
  }
  void eol;
  return at;
}

const inWindow = (spans: readonly EditorSemanticTokenSpan[], from: number, to: number) =>
  spans.filter((s) => s.line >= from && s.line <= to);

describe('erbSemanticTokens · 行窗口 ≡ 整篇按行过滤', () => {
  for (const [label, eol] of EOL_CASES) {
    it(`${label}：全部 (from, to) 组合逐条相同（带 fromOffset）`, () => {
      const text = LINES.join(eol);
      const full = erbSemanticTokens(text, INDEX);
      // 两段防线：语料本身要真的产色（否则"全空 ≡ 全空"会让这条用例永远绿）
      expect(full.length).toBeGreaterThan(8);
      expect(full.some((s) => s.line === 9), '屏蔽区里的定义不该有色').toBe(false);

      let windows = 0;
      for (let from = 1; from <= LINES.length + 1; from++) {
        for (let to = from; to <= LINES.length + 1; to++) {
          const windowed = erbSemanticTokens(text, INDEX, {
            from,
            to,
            fromOffset: offsetOfLine(text, from, eol),
          });
          expect(windowed, `${label} 窗口 ${from}..${to}`).toEqual(inWindow(full, from, to));
          windows++;
        }
      }
      // 22 行 ⇒ 253 个窗口；真跑到了才谈"穷举"
      expect(windows).toBeGreaterThan(200);
    });

    it(`${label}：不给 fromOffset 的退路逐条相同（纯函数调用方走这条）`, () => {
      const text = LINES.join(eol);
      const full = erbSemanticTokens(text, INDEX);
      for (let from = 1; from <= LINES.length; from++) {
        const to = Math.min(LINES.length, from + 4);
        const withOffset = erbSemanticTokens(text, INDEX, {
          from,
          to,
          fromOffset: offsetOfLine(text, from, eol),
        });
        const walked = erbSemanticTokens(text, INDEX, { from, to });
        expect(walked, `${label} 窗口 ${from}..${to}`).toEqual(withOffset);
        expect(walked).toEqual(inWindow(full, from, to));
      }
    });
  }

  it('给错的 fromOffset 一律退回走位，结果不变（行内偏移 / 越界 / 非数值）', () => {
    const text = LINES.join('\n');
    const full = erbSemanticTokens(text, INDEX);
    const good = offsetOfLine(text, 6, '\n');
    const bogus = [good + 3, -1, text.length + 100, Number.NaN, 12_345];
    for (const fromOffset of bogus) {
      const spans = erbSemanticTokens(text, INDEX, { from: 6, to: 9, fromOffset });
      expect(spans, `fromOffset=${fromOffset}`).toEqual(inWindow(full, 6, 9));
    }
  });

  it('窗口落在文末之外 / 空区间 / NaN：空数组，不抛', () => {
    const text = LINES.join('\n');
    expect(erbSemanticTokens(text, INDEX, { from: 99, to: 120 })).toEqual([]);
    expect(erbSemanticTokens(text, INDEX, { from: 5, to: 4 })).toEqual([]);
    expect(erbSemanticTokens(text, INDEX, { from: Number.NaN, to: 4 })).toEqual([]);
    expect(erbSemanticTokens(text, INDEX, { from: 1, to: Number.NaN })).toEqual([]);
  });

  it('`to = Infinity` 走到文末为止（与 from..末行 相同）', () => {
    const text = LINES.join('\n');
    const full = erbSemanticTokens(text, INDEX);
    expect(erbSemanticTokens(text, INDEX, { from: 12, to: Number.POSITIVE_INFINITY })).toEqual(
      inWindow(full, 12, LINES.length),
    );
  });

  it('空文本：整篇与窗口都空（不因窗口路径多抛一次）', () => {
    expect(erbSemanticTokens('', INDEX)).toEqual([]);
    expect(erbSemanticTokens('', INDEX, { from: 1, to: 10 })).toEqual([]);
  });

  it('索引缺席：窗口也只交声明那条腿（与整篇同一条降级）', () => {
    const text = LINES.join('\n');
    const full = erbSemanticTokens(text, null);
    const windowed = erbSemanticTokens(text, null, { from: 1, to: 3 });
    expect(windowed).toEqual(inWindow(full, 1, 3));
    // 引用点（`function` 且不带 `declaration`）一条都不许有；形参槽是 `parameter`，不在判据里
    expect(windowed.some((s) => s.tokenType === 'function' && s.modifiers?.includes('declaration') !== true)).toBe(
      false,
    );
    expect(windowed.length).toBeGreaterThan(0);
  });
});
