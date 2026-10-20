/**
 * 定位落点的行列 / 列区间夹取（R1 列接线批 2026-10-15 + W9 落点 span 批 2026-10-17）单测。
 *
 * 钉的是"区间一路带到编辑器"这条链上**唯一会算错的地方**：
 * - 越界列夹到该行真实存在的最后一列，缺列 / 坏列（NaN、Infinity）一律当"没给"落行首，
 *   而不是夹到某端假装作者要那儿（本仓"不猜"口径）；
 * - **列口径不在此二次实现**：行长只问注入的 `maxColumn`，且必须用**已夹取过的行号**去问
 *   （行越界时那一行的长度根本不存在）——所以这里的桩几何只记"被问了哪一行"，
 *   不给它任何可以自己数字符的机会。
 *
 * W9 追加钉两件：
 * - **退化唯一**（判据②）：没有 `span` 就退化成零宽（起点 = `column`，再没有就 1），
 *   既不铺到行尾、也不"顺手选一个词"；坏 `span`（端点缺失 / 反向 / NaN）整个丢掉退回同一档；
 * - **发起方共用一个载荷出口**：`revealLocationOf` 在场时 `column` 与 `span` 必然同源
 *   （读旧口径的宿主与读新区间的编辑器落到同一个位置）。
 *
 * 代理对补批（2026-10-20）再钉一条：列口径仍是 UTF-16 码元（**不改成码点**），但注入行文本后
 * 起点 / 终点**不得落在代理对中间**——起点向对边界内收、终点向对边界外扩，零宽落点落在边界上；
 * 全角（BMP）字符与孤立代理是**对照**：它们不是"对中间"，一个码元都不许挪。
 */

import { describe, expect, it } from 'vitest';
import {
  clampRevealPosition,
  revealLocationOf,
  revealSpanOf,
  revealTargetOf,
} from '../src/monaco/reveal-position';

/** 桩几何：行长由外部给（真实调用方传 Monaco 的 `getLineMaxColumn`），这里只记问了哪些行 */
function geometry(lineCount: number, maxColumn: number, asked: number[] = []) {
  return {
    lineCount,
    maxColumn: (lineNumber: number) => {
      asked.push(lineNumber);
      return maxColumn;
    },
  };
}

/** 带行文本的桩几何：`lineText` 与 Monaco `getLineContent` 同口径（行尾不含换行） */
function textGeometry(lines: readonly string[]) {
  return {
    lineCount: lines.length,
    maxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? '').length + 1,
    lineText: (lineNumber: number) => lines[lineNumber - 1] ?? '',
  };
}

describe('clampRevealPosition · 列夹取', () => {
  it('行内列原样落地（不位移、不"顺手"选择整词）', () => {
    expect(clampRevealPosition({ line: 3, column: 12 }, geometry(10, 40))).toEqual({
      lineNumber: 3,
      column: 12,
      columnEnd: 12,
    });
  });

  it('列越过行尾 → 夹到该行最大合法列（Monaco 的 行长度 + 1）', () => {
    expect(clampRevealPosition({ line: 1, column: 999 }, geometry(1, 8))).toEqual({
      lineNumber: 1,
      column: 8,
      columnEnd: 8,
    });
  });

  it('缺列 = 落行首（列 1，零宽），与列接线前的行为逐字一致', () => {
    expect(clampRevealPosition({ line: 2 }, geometry(10, 40))).toEqual({
      lineNumber: 2,
      column: 1,
      columnEnd: 1,
    });
  });

  it('坏列（0 / 负数 / NaN / Infinity）不许冒充位置：0 与负数夹回 1，NaN / Infinity 当没给', () => {
    const g = geometry(5, 20);
    expect(clampRevealPosition({ line: 1, column: 0 }, g)).toEqual({ lineNumber: 1, column: 1, columnEnd: 1 });
    expect(clampRevealPosition({ line: 1, column: -7 }, g)).toEqual({ lineNumber: 1, column: 1, columnEnd: 1 });
    expect(clampRevealPosition({ line: 1, column: Number.NaN }, g)).toEqual({
      lineNumber: 1,
      column: 1,
      columnEnd: 1,
    });
    expect(clampRevealPosition({ line: 1, column: Number.POSITIVE_INFINITY }, g)).toEqual({
      lineNumber: 1,
      column: 1,
      columnEnd: 1,
    });
  });

  it('小数列向下取整（模型列是整数；不四舍五入到不存在的位置）', () => {
    expect(clampRevealPosition({ line: 1, column: 4.8 }, geometry(1, 40))).toEqual({
      lineNumber: 1,
      column: 4,
      columnEnd: 4,
    });
  });

  it('行越界时先夹行、再按**夹后的行**问行长（越界行没有长度可问）', () => {
    const asked: number[] = [];
    const position = clampRevealPosition({ line: 99, column: 30 }, geometry(4, 7, asked));
    expect(position).toEqual({ lineNumber: 4, column: 7, columnEnd: 7 });
    expect(asked).toEqual([4]);
  });

  it('行下越界夹到第 1 行，列上限同样取自第 1 行', () => {
    const asked: number[] = [];
    expect(clampRevealPosition({ line: 0, column: 50 }, geometry(4, 6, asked))).toEqual({
      lineNumber: 1,
      column: 6,
      columnEnd: 6,
    });
    expect(asked).toEqual([1]);
  });
});

describe('clampRevealPosition · 列区间（W9）', () => {
  it('真实区间原样落地（选中的就是发起方指的那一段）', () => {
    expect(clampRevealPosition({ line: 2, span: { columnStart: 6, columnEnd: 13 } }, geometry(10, 40))).toEqual({
      lineNumber: 2,
      column: 6,
      columnEnd: 13,
    });
  });

  it('区间越过行尾 → 两端都夹进行内（终点绝不落在不存在的列上）', () => {
    expect(clampRevealPosition({ line: 1, span: { columnStart: 5, columnEnd: 999 } }, geometry(2, 20))).toEqual({
      lineNumber: 1,
      column: 5,
      columnEnd: 20,
    });
  });

  it('区间起点越界到行尾之后 → 两端一起夹到最后一列（不退化成行首）', () => {
    expect(clampRevealPosition({ line: 1, span: { columnStart: 50, columnEnd: 60 } }, geometry(1, 8))).toEqual({
      lineNumber: 1,
      column: 8,
      columnEnd: 8,
    });
  });

  it('终点早于起点 = 坏区间：整个丢掉，退化成 `column` 那一档（不"顺手"交换两端假装知道方向）', () => {
    expect(
      clampRevealPosition({ line: 1, column: 4, span: { columnStart: 9, columnEnd: 3 } }, geometry(5, 40)),
    ).toEqual({ lineNumber: 1, column: 4, columnEnd: 4 });
  });

  it('坏端点（NaN / Infinity / 缺一个）同样整个丢掉：半个区间不当区间用', () => {
    const g = geometry(5, 40);
    expect(clampRevealPosition({ line: 1, column: 4, span: { columnStart: Number.NaN, columnEnd: 9 } }, g)).toEqual({
      lineNumber: 1,
      column: 4,
      columnEnd: 4,
    });
    expect(
      clampRevealPosition({ line: 1, column: 4, span: { columnStart: 4, columnEnd: Number.POSITIVE_INFINITY } }, g),
    ).toEqual({ lineNumber: 1, column: 4, columnEnd: 4 });
  });

  it('给了 `column` 又给了同源的 `span` ⇒ 以区间为准（两条读法必须同一个落点）', () => {
    const landed = clampRevealPosition({ line: 1, column: 6, span: { columnStart: 6, columnEnd: 11 } }, geometry(3, 30));
    expect(landed).toEqual({ lineNumber: 1, column: 6, columnEnd: 11 });
  });
});

describe('revealSpanOf · 退化只有一条（判据②）', () => {
  it('有区间用区间（小数端点截断到整数码元）', () => {
    expect(revealSpanOf({ span: { columnStart: 4.9, columnEnd: 8.2 } })).toEqual({ columnStart: 4, columnEnd: 8 });
  });

  it('只有列 ⇒ 零宽区间（**唯一的退化形态**：既不铺行尾，也不猜词宽）', () => {
    expect(revealSpanOf({ column: 7 })).toEqual({ columnStart: 7, columnEnd: 7 });
  });

  it('列与区间都没有 ⇒ undefined（连起点都不知道，交给落点侧按行首处理）', () => {
    expect(revealSpanOf({})).toBeUndefined();
    expect(revealSpanOf({ column: Number.NaN })).toBeUndefined();
  });

  it('坏区间退回列那一档（不返回半个区间）', () => {
    expect(revealSpanOf({ column: 5, span: { columnStart: 9, columnEnd: 2 } })).toEqual({
      columnStart: 5,
      columnEnd: 5,
    });
  });
});

describe('revealTargetOf · 事件载荷 → 定位目标', () => {
  it('列给得出就带着（跨文件那条腿靠它才不丢列）；区间同源时一并带上', () => {
    expect(revealTargetOf({ line: 5, column: 13 }, 111)).toEqual({
      line: 5,
      column: 13,
      span: { columnStart: 13, columnEnd: 13 },
      nonce: 111,
    });
  });

  it('区间给得出就带区间（这是权威；`column` 补成同一个起点，老消费方零改动）', () => {
    expect(revealTargetOf({ line: 5, column: 13, span: { columnStart: 13, columnEnd: 20 } }, 111)).toEqual({
      line: 5,
      column: 13,
      span: { columnStart: 13, columnEnd: 20 },
      nonce: 111,
    });
  });

  it('`line` 缺省按第 1 行（接线前逐字一致）', () => {
    expect(revealTargetOf({}, 222)).toEqual({ line: 1, nonce: 222 });
  });

  it('坏列整个省略键（不是给 `column: undefined` 让下游误判"有列但未知"）', () => {
    const target = revealTargetOf({ line: 2, column: Number.NaN }, 333);
    expect('column' in target).toBe(false);
    expect('span' in target).toBe(false);
    expect(target.line).toBe(2);
  });

  it('坏行（NaN）当第 1 行，不让 NaN 漏进夹取', () => {
    expect(revealTargetOf({ line: Number.NaN }, 444).line).toBe(1);
  });
});

describe('revealLocationOf · 发起方的唯一载荷出口', () => {
  it('位置事实 → 载荷：区间与列同源两个键都给（新旧消费方读哪条都落同一个位置）', () => {
    expect(revealLocationOf({ path: 'C:/p/a.ERB', line: 8, span: { columnStart: 3, columnEnd: 9 } }, '问题')).toEqual({
      filePath: 'C:/p/a.ERB',
      line: 8,
      column: 3,
      span: { columnStart: 3, columnEnd: 9 },
      source: '问题',
    });
  });

  it('给不出区间 ⇒ 两个键都不出现（缺省即退化，不由发起方猜）', () => {
    const payload = revealLocationOf({ path: 'C:/p/a.ERB', line: 8 });
    expect(payload).toEqual({ filePath: 'C:/p/a.ERB', line: 8 });
    expect('column' in payload).toBe(false);
    expect('span' in payload).toBe(false);
  });

  it('`source` 不给就不带这个键（总线载荷里不留 `source: undefined`）', () => {
    expect('source' in revealLocationOf({ path: 'C:/p/a.ERB', line: 1 })).toBe(false);
  });
});

describe('clampRevealPosition · 代理对不劈开（UTF-16 码元边界修正）', () => {
  // 1 基列 c 是**插入点**：c 落在代理对的 high / low 两个码元之间时，选区会把一个字符劈成两半。
  // 判据：起点向对边界内收（c+1，丢掉半截字符），终点向对边界外扩（c+1，把整个字符收进来）；
  // 零宽落点随起点，落在对之后的合法边界。列口径仍是 UTF-16 码元，这里**不数码点**。

  it('行尾 astral：columnEnd 恰落在低代理 ⇒ 外扩到对之后（整个字进选区）', () => {
    // 'ab𝄞' = a(0) b(1) high(2) low(3) ⇒ 列 4 在代理对中间、列 5 = 行尾
    expect(clampRevealPosition({ line: 1, span: { columnStart: 1, columnEnd: 4 } }, textGeometry(['ab𝄞']))).toEqual({
      lineNumber: 1,
      column: 1,
      columnEnd: 5,
    });
  });

  it('行尾 astral：终点先夹到 maxColumn（对之后），边界修正不越界', () => {
    expect(
      clampRevealPosition({ line: 1, span: { columnStart: 2, columnEnd: 999 } }, textGeometry(['ab𝄞'])),
    ).toEqual({ lineNumber: 1, column: 2, columnEnd: 5 });
  });

  it('起点落在低代理 ⇒ 向对边界内收（`column` 与零宽 span 同规则）', () => {
    // 'a𝄞b' = a(0) high(1) low(2) b(3) ⇒ 列 3 在代理对中间、列 4 = 对之后
    const g = textGeometry(['a𝄞b']);
    expect(clampRevealPosition({ line: 1, column: 3 }, g)).toEqual({ lineNumber: 1, column: 4, columnEnd: 4 });
    expect(clampRevealPosition({ line: 1, span: { columnStart: 3, columnEnd: 5 } }, g)).toEqual({
      lineNumber: 1,
      column: 4,
      columnEnd: 5,
    });
  });

  it('行首 astral：列 2 在代理对中间 → 列 3；列 1 / 3 本就是边界，零修正', () => {
    // '𝄞ab' = high(0) low(1) a(2) b(3) ⇒ 列 1 在空前、列 2 在中间、列 3 在对之后
    const g = textGeometry(['𝄞ab']);
    expect(clampRevealPosition({ line: 1, column: 2 }, g)).toEqual({ lineNumber: 1, column: 3, columnEnd: 3 });
    expect(clampRevealPosition({ line: 1, column: 1 }, g)).toEqual({ lineNumber: 1, column: 1, columnEnd: 1 });
    expect(clampRevealPosition({ line: 1, column: 3 }, g)).toEqual({ lineNumber: 1, column: 3, columnEnd: 3 });
  });

  it('全角字符（BMP、单码元）作对照：列 2 是真正的字符边界，零修正', () => {
    // 'ＡＢ' 各占一个码元（U+FF21 / U+FF22）——把"宽字符"误判成代理对就会在这里红
    expect(
      clampRevealPosition({ line: 1, span: { columnStart: 2, columnEnd: 3 } }, textGeometry(['ＡＢ'])),
    ).toEqual({ lineNumber: 1, column: 2, columnEnd: 3 });
  });

  it('孤立代理（不成对）不是"对中间"：位置本就是码元边界，不动', () => {
    // 单个高代理后接 x；x 后接单个低代理——都不是合法字符，但也没有"对"可收
    expect(clampRevealPosition({ line: 1, column: 2 }, textGeometry(['\uD834x']))).toEqual({
      lineNumber: 1,
      column: 2,
      columnEnd: 2,
    });
    expect(clampRevealPosition({ line: 1, column: 2 }, textGeometry(['x\uDD1E']))).toEqual({
      lineNumber: 1,
      column: 2,
      columnEnd: 2,
    });
  });

  it('没有 lineText 的几何（改动前的调用方）⇒ 逐字保留旧夹取，不擅自脑补', () => {
    expect(clampRevealPosition({ line: 1, span: { columnStart: 1, columnEnd: 4 } }, geometry(1, 5))).toEqual({
      lineNumber: 1,
      column: 1,
      columnEnd: 4,
    });
  });

  it('lineText 按**已夹取的行号**取（行越界时不问模型里不存在的行）', () => {
    // '𝄞x' = high(0) low(1) x(2)：列 2 在代理对中间
    const asked: number[] = [];
    const g = {
      lineCount: 2,
      maxColumn: () => 4,
      lineText: (lineNumber: number) => {
        asked.push(lineNumber);
        return '𝄞x';
      },
    };
    expect(clampRevealPosition({ line: 99, column: 2 }, g)).toEqual({ lineNumber: 2, column: 3, columnEnd: 3 });
    expect(asked).toEqual([2]);
  });
});
