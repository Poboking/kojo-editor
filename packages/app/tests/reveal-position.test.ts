/**
 * 定位落点的行列夹取（R1 列接线批）单测。
 *
 * 钉的是"列一路带到编辑器"这条链上**唯一会算错的地方**：
 * - 越界列夹到该行真实存在的最后一列，缺列 / 坏列（NaN、Infinity）一律当"没给"落行首，
 *   而不是夹到某端假装作者要那儿（本仓"不猜"口径）；
 * - **列口径不在此二次实现**：行长只问注入的 `maxColumn`，且必须用**已夹取过的行号**去问
 *   （行越界时那一行的长度根本不存在）——所以这里的桩几何只记"被问了哪一行"，
 *   不给它任何可以自己数字符的机会。
 */

import { describe, expect, it } from 'vitest';
import { clampRevealPosition, revealTargetOf } from '../src/monaco/reveal-position';

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

describe('clampRevealPosition · 列夹取', () => {
  it('行内列原样落地（不位移、不"顺手"选择整词）', () => {
    expect(clampRevealPosition({ line: 3, column: 12 }, geometry(10, 40))).toEqual({ lineNumber: 3, column: 12 });
  });

  it('列越过行尾 → 夹到该行最大合法列（Monaco 的 行长度 + 1）', () => {
    expect(clampRevealPosition({ line: 1, column: 999 }, geometry(1, 8))).toEqual({ lineNumber: 1, column: 8 });
  });

  it('缺列 = 落行首（列 1），与列接线前的行为逐字一致', () => {
    expect(clampRevealPosition({ line: 2 }, geometry(10, 40))).toEqual({ lineNumber: 2, column: 1 });
  });

  it('坏列（0 / 负数 / NaN / Infinity）不许冒充位置：0 与负数夹回 1，NaN / Infinity 当没给', () => {
    const g = geometry(5, 20);
    expect(clampRevealPosition({ line: 1, column: 0 }, g)).toEqual({ lineNumber: 1, column: 1 });
    expect(clampRevealPosition({ line: 1, column: -7 }, g)).toEqual({ lineNumber: 1, column: 1 });
    expect(clampRevealPosition({ line: 1, column: Number.NaN }, g)).toEqual({ lineNumber: 1, column: 1 });
    expect(clampRevealPosition({ line: 1, column: Number.POSITIVE_INFINITY }, g)).toEqual({ lineNumber: 1, column: 1 });
  });

  it('小数列向下取整（模型列是整数；不四舍五入到不存在的位置）', () => {
    expect(clampRevealPosition({ line: 1, column: 4.8 }, geometry(1, 40))).toEqual({ lineNumber: 1, column: 4 });
  });

  it('行越界时先夹行、再按**夹后的行**问行长（越界行没有长度可问）', () => {
    const asked: number[] = [];
    const position = clampRevealPosition({ line: 99, column: 30 }, geometry(4, 7, asked));
    expect(position).toEqual({ lineNumber: 4, column: 7 });
    expect(asked).toEqual([4]);
  });

  it('行下越界夹到第 1 行，列上限同样取自第 1 行', () => {
    const asked: number[] = [];
    expect(clampRevealPosition({ line: 0, column: 50 }, geometry(4, 6, asked))).toEqual({ lineNumber: 1, column: 6 });
    expect(asked).toEqual([1]);
  });
});

describe('revealTargetOf · 事件载荷 → 定位目标', () => {
  it('列给得出就带着（跨文件那条腿靠它才不丢列）', () => {
    expect(revealTargetOf({ line: 5, column: 13 }, 111)).toEqual({ line: 5, column: 13, nonce: 111 });
  });

  it('`line` 缺省按第 1 行（接线前逐字一致）', () => {
    expect(revealTargetOf({}, 222)).toEqual({ line: 1, nonce: 222 });
  });

  it('坏列整个省略键（不是给 `column: undefined` 让下游误判"有列但未知"）', () => {
    const target = revealTargetOf({ line: 2, column: Number.NaN }, 333);
    expect('column' in target).toBe(false);
    expect(target.line).toBe(2);
  });
});
