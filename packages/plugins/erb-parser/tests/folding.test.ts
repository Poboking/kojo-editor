/**
 * ERB 折叠区间（D3）单测。
 *
 * 走**真扫描器**（`scanControlFlow` + `parseErbText`）而不是手搓 `ControlFlowStatement`：
 * 折叠的全部价值建立在"区间端点与源行对得上、配对表与骨架/体检同一张"上，手搓语句表
 * 只能证明栈算法自洽。栈算法本体仍单测（喂合成语句表），因为容错分支很难用真文本凑齐。
 *
 * 覆盖：正常配对 / 分支段（CASE、ELSE）/ TRY 系与 CATCH 归属 / PRINTDATA 系；
 * 结构错误文件的边界口径（未闭合不吞全篇、函数边界重置、孤儿闭合无主分支不动栈）；
 * 空文件；超长文件的量级读数（区间数 + 耗时上限，防"provider 里做全文正则二次扫描"回潮）。
 */

import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement } from '@kojo/plugin-api';
import { controlFlowFoldingRanges, erbFoldingRanges, functionFoldingRanges } from '../src/folding';
import { parseErbText, scanControlFlow } from '../src/scanner';

const has = (ranges: readonly { startLine: number; endLine: number }[], start: number, end: number): boolean =>
  ranges.some((r) => r.startLine === start && r.endLine === end);

describe('controlFlowFoldingRanges · 正常配对', () => {
  it('WHILE…WEND（无分支块）：只给整块区间，不给只差闭合行的重复段', () => {
    const text = ['@F', 'WHILE A < 3', 'PRINTL 一', 'WEND', 'RETURN'].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(ranges).toEqual([{ startLine: 2, endLine: 4 }]);
  });

  it('IF…ELSE…ENDIF：整块 + 每个分支段各一枚', () => {
    const text = [
      'IF A == 1', // 1
      'PRINTL 甲', // 2
      'PRINTL 乙', // 3
      'ELSE', // 4
      'PRINTL 丙', // 5
      'ENDIF', // 6
    ].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(has(ranges, 1, 6)).toBe(true); // 整块
    expect(has(ranges, 1, 3)).toBe(true); // IF 段
    expect(has(ranges, 4, 5)).toBe(true); // ELSE 段
  });

  it('SELECTCASE 多分支：每段折到下一分支前一行，段体单行不出段（无可隐藏行）', () => {
    const text = [
      'SELECTCASE RAND:2', // 1
      'CASE 1', // 2
      'PRINTL 一', // 3
      'CASE 2', // 4
      'PRINTL 二', // 5
      'ENDSELECT', // 6
    ].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(has(ranges, 1, 6)).toBe(true);
    expect(has(ranges, 2, 3)).toBe(true);
    expect(has(ranges, 4, 5)).toBe(true);
    expect(ranges.some((r) => r.startLine === 1 && r.endLine === 1)).toBe(false);
  });

  it('嵌套块各自成区间（深度由配对表重建，不靠缩进）', () => {
    const text = ['IF A', 'IF B', 'PRINTL 深', 'ENDIF', 'ENDIF'].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(has(ranges, 1, 5)).toBe(true);
    expect(has(ranges, 2, 4)).toBe(true);
  });

  it('PRINTDATA…ENDDATA 与 DATALIST…ENDLIST 正常闭合', () => {
    const text = ['PRINTDATA', 'PRINTL 甲', 'ENDDATA', 'DATALIST', 'ITEM 1 2', 'ENDLIST'].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(has(ranges, 1, 3)).toBe(true);
    expect(has(ranges, 4, 6)).toBe(true);
  });

  it('TRYCALLLIST…CATCH…ENDFUNC：CATCH 归 funclist 层（同体检判据），整块与 CATCH 段都给', () => {
    const text = ['TRYCALLLIST', 'CALL A', 'CALL B', 'CATCH', 'CALL C', 'ENDFUNC'].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(has(ranges, 1, 6)).toBe(true);
    expect(has(ranges, 4, 5)).toBe(true);
  });

  it('TRYCGOTO…CATCH…ENDCATCH：try 层的 CATCH 走正常配对', () => {
    const text = ['TRYCGOTO *先, LABEL:目标', 'CATCH', 'PRINTL 失败', 'ENDCATCH'].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(has(ranges, 1, 4)).toBe(true);
    expect(has(ranges, 2, 3)).toBe(true);
  });
});

describe('controlFlowFoldingRanges · 结构错误边界', () => {
  const st = (kind: string, line: number): ControlFlowStatement => ({ kind, expression: '', depth: 0, line });

  it('未闭合的开块不产出区间，且**不吞**别的正常块（文件尾 / 中段都算）', () => {
    const ranges = controlFlowFoldingRanges([st('IF', 1), st('PRINTDATA', 2), st('ENDDATA', 3)]);
    expect(ranges).toEqual([{ startLine: 2, endLine: 3 }]); // 欠 ENDIF 的 IF 不发 [1..?]
  });

  it('孤儿闭合不关别人的门（裸 ENDSELECT 不许把 IF 提前收尾）', () => {
    const orphan = controlFlowFoldingRanges([st('IF', 1), st('ENDSELECT', 2), st('ENDIF', 3)]);
    expect(orphan).toEqual([{ startLine: 1, endLine: 3 }]); // ENDSELECT 不动栈，ENDIF 照常关 IF
  });

  it('错配嵌套（IF→REPEAT→ENDIF）：REPEAT 残缺不发区间，IF 照常整块', () => {
    const ranges = controlFlowFoldingRanges([st('IF', 1), st('REPEAT', 2), st('ENDIF', 3)]);
    expect(ranges).toEqual([{ startLine: 1, endLine: 3 }]);
  });

  it('函数边界清空栈：上一函数欠的 ENDIF 不许把下一函数整段折走', () => {
    const text = ['@F1', 'IF A', '@F2', 'PRINTL 乙', 'ENDIF'].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text), [1, 3]);
    expect(ranges).toEqual([]); // IF 未闭合于 F1：不产出；F2 的 ENDIF 成了孤儿也不产出
  });

  it('分支无主（裸 ELSE）不动栈', () => {
    const ranges = controlFlowFoldingRanges([st('ELSE', 1), st('IF', 2), st('ENDIF', 3)]);
    expect(ranges).toEqual([{ startLine: 2, endLine: 3 }]);
  });

  it('SIF 单行语句不开块', () => {
    const ranges = controlFlowFoldingRanges([st('SIF', 1), st('IF', 2), st('ENDIF', 3)]);
    expect(ranges).toEqual([{ startLine: 2, endLine: 3 }]);
  });
});

describe('erbFoldingRanges · 文本级', () => {
  it('函数区间逐 `@` 块给出（与大纲同源的边界）', () => {
    const text = ['@F1', 'PRINTL 一', '@F2', 'PRINTL 二'].join('\n');
    const file = parseErbText(text);
    expect(functionFoldingRanges(file)).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 3, endLine: 4 },
    ]);
    const ranges = erbFoldingRanges(text);
    expect(has(ranges, 1, 2)).toBe(true);
    expect(has(ranges, 3, 4)).toBe(true);
  });

  it('空文件 → 空区间（认这个文件但无可折块）', () => {
    expect(erbFoldingRanges('')).toEqual([]);
  });

  it('正常小样本：函数块 + 内部控制流同时在场、行号各就各位', () => {
    const text = [
      '@M_KOJO_TEST', // 1
      'SELECTCASE RAND:2', // 2
      'CASE 1', // 3
      'PRINTL 甲', // 4
      'CASE 2', // 5
      'PRINTL 乙', // 6
      'ENDSELECT', // 7
      'RETURN', // 8
    ].join('\n');
    const ranges = erbFoldingRanges(text);
    expect(has(ranges, 1, 8)).toBe(true);
    expect(has(ranges, 2, 7)).toBe(true);
    expect(has(ranges, 3, 4)).toBe(true);
    expect(has(ranges, 5, 6)).toBe(true);
    for (const r of ranges) expect(r.endLine).toBeGreaterThan(r.startLine);
  });

  it('超长文件（52,601 行语料同量级合成）：区间数与耗时有上限读数，provider 不许退化成全文正则再扫', () => {
    const unit = ['@F_K0', 'IF A == 1', 'ELSEIF A == 2', 'ELSE', 'PRINTL 甲', 'ENDIF', 'RETURN'];
    const parts: string[] = [];
    const perFunction = unit.length; // 7 行/函数
    const count = Math.ceil((52_601 - 1) / perFunction);
    for (let i = 0; i < count; i++) parts.push(unit.map((line) => (line === '@F_K0' ? `@F_${i}` : line)).join('\n'));
    const text = parts.join('\n');
    expect(text.split('\n').length).toBeGreaterThan(50_000);
    const t0 = performance.now();
    const ranges = erbFoldingRanges(text);
    const elapsed = performance.now() - t0;
    // 每函数至少 2 枚区间（函数块 + IF 整块），再加两条 ELSEIF/ELSE 段
    expect(ranges.length).toBeGreaterThanOrEqual(count * 2);
    // 读数上限放得极宽（防数量级回归用，不是微基准）：CI 抖动不至于踩到
    expect(elapsed).toBeLessThan(4_000);
  });
});
