/**
 * B 层验收：糖**投影**（原生 ERB → 糖显示）。
 *
 * 硬性覆盖（用户验收项「至少体感上能看到绝大部分 erb 文件能被升糖显示」）：
 * 1. **规则表逐条**——台词行 / 控制流行 / 注释空行 / 原生直通四类各自的落点；
 * 2. **单行降级**——一行失败只影响那一行（不向上传播），其余行照常投影；
 * 3. **误映射风险**——`PRINTDATA` 数据表体 / `[SKIPSTART]` 区内的 `PRINTFORM*`
 *    即使形如台词也**不映射**（判据来自结构，不只是行首正则）；
 * 4. **不静默**——保留原生的行按成因计数（`stats.nativeByReason`）。
 *
 * 与 `lift.test.ts`（写盘口径的强自证）刻意分开：本文件是**显示口径**，不承诺
 * round-trip，只承诺"规则表封闭 + 逐行降级 + 不静默"。
 */

import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement, SugarProjectSegment } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { liftProject } from '../src/project';
import type { LiftDeps } from '../src/lift';

/** 投影只依赖结构扫描；`transpile` 不参与（用抛错替身证明"确实没被调用"） */
const deps = (): LiftDeps => ({
  transpile: () => {
    throw new Error('投影不应调用 transpile');
  },
  scanControlFlow: (text: string): ControlFlowStatement[] => scanControlFlow(text),
});

const project = (source: string) => liftProject(deps(), { source });

/** 便捷：段文本按行展开（去空尾） */
const segLines = (s: SugarProjectSegment): string[] => s.sugarText.split('\n');

describe('糖投影 · 台词行', () => {
  it('四个有糖形态变体 → 糖文本行（L 后缀补「续」）', () => {
    const r = project(
      ['PRINTFORMW 「今天也来训练了？」', 'PRINTFORML 「……」', 'PRINTFORMDW 她点了点头。', 'PRINTFORMDL 她叹了口气。'].join(
        '\n',
      ),
    );
    expect(r.segments).toHaveLength(1);
    expect(segLines(r.segments[0]!)).toEqual([
      '「今天也来训练了？」',
      '「……」 续',
      '她点了点头。',
      '她叹了口气。 续',
    ]);
    expect(r.stats.projectedLines).toBe(4);
  });

  it('其余原生记号原样透传（`{…}` / `%…%` 中的非代词）', () => {
    const r = project('PRINTFORMW 「%CALLNAME:12%，{CFLAG:2}」');
    expect(segLines(r.segments[0]!)).toEqual(['「%CALLNAME:12%，{CFLAG:2}」']);
  });

  it('可读化：原生代词记号反糖为糖主形（`%CALLNAME:TARGET%` → `{她}`）', () => {
    const r = project(
      [
        'PRINTFORMW 「%CALLNAME:MASTER%，今天也来训练了？」',
        'PRINTFORMDL %CALLNAME:TARGET%点了点头。',
      ].join('\n'),
    );
    expect(segLines(r.segments[0]!)).toEqual([
      '「{你}，今天也来训练了？」',
      '{她}点了点头。 续',
    ]);
  });

  it('可读化只作用于文本体，控制流表达式原样（不改坏条件）', () => {
    const r = project('IF %CALLNAME:MASTER% == "灵梦"\nPRINTFORMW 甲\nENDIF');
    expect(segLines(r.segments[0]!)[0]).toBe('如果 %CALLNAME:MASTER% == "灵梦"：');
  });

  it('空文本体 → 「输出一行空行」（显示口径：读者看到的是剧本节奏，不是裸指令）', () => {
    // 真实语料里 400 个口上文件有 35,425 行是这个形态（作者用裸指令打空行），
    // 且它是"糖段被切碎"的头号原因——故投影为一行空行、并**不再切断段**。
    const r = project(['PRINTFORMW 甲', 'PRINTFORMDL ', 'PRINTFORML', 'PRINTFORMW 乙'].join('\n'));
    expect(r.segments).toHaveLength(1);
    expect(segLines(r.segments[0]!)).toEqual(['甲', '', '', '乙']);
    expect(r.stats.projectedLines).toBe(4);
    expect(r.stats.nativeLines).toBe(0);
  });

  it('非 FORM 变体 / 行内条件 → 原样保留（不静默）', () => {
    const r = project(
      ['PRINTL 非 FORM 系', 'PRINTBUTTON "x", 1', 'PRINTFORML \\@ X ? A # B \\@'].join('\n'),
    );
    expect(r.segments).toHaveLength(0);
    expect(r.stats.nativeLines).toBe(3);
    const reasons = Object.fromEntries(r.stats.nativeByReason.map((x) => [x.reason, x.count]));
    expect(reasons['unsupported-print-variant']).toBe(2);
    expect(reasons['inline-condition']).toBe(1);
  });
});

describe('糖投影 · 控制流', () => {
  it('IF / ELSEIF / ELSE / ENDIF 与缩进', () => {
    const src = ['IF A', 'PRINTFORMW 甲', 'ELSEIF B', 'PRINTFORMW 乙', 'ELSE', 'PRINTFORMW 丙', 'ENDIF'].join('\n');
    const r = project(src);
    expect(r.segments).toHaveLength(1);
    const seg = r.segments[0]!;
    expect(seg.fromLine).toBe(1);
    expect(seg.toLine).toBe(7); // 段含收束行（ENDIF 不显示但占区间）
    expect(segLines(seg)).toEqual(['如果 A：', '\t甲', '否则如果 B：', '\t乙', '否则：', '\t丙']);
    // 口径：`ENDIF` 虽不产出可见行，但被缩进语义吸收 → 计入 projectedLines
    expect(r.stats.projectedLines).toBe(7);
  });

  it('统计口径完整：三类计数之和**恒等于**总行数（没有行凭空消失）', () => {
    const src = [
      '; 注释',
      'IF A',
      '\tPRINTFORMW 甲',
      'ENDIF',
      '',
      '@FUNC',
      '#DIM X',
    ].join('\n');
    const { stats } = project(src);
    expect(stats.totalLines).toBe(7);
    expect(stats.projectedLines + stats.passthroughLines + stats.nativeLines).toBe(7);
    expect(stats.projectedLines).toBe(3); // IF + 台词 + ENDIF
    expect(stats.passthroughLines).toBe(2); // 注释 + 空行
    expect(stats.nativeLines).toBe(2); // @FUNC + #DIM
  });

  it('SELECTCASE / CASE / CASEELSE / ENDSELECT', () => {
    const src = ['SELECTCASE TFLAG:193', 'CASE 1', 'PRINTFORMW 甲', 'CASEELSE', 'PRINTFORMW 乙', 'ENDSELECT'].join('\n');
    const seg = project(src).segments[0]!;
    expect(segLines(seg)).toEqual(['当 TFLAG:193：', '是 1：', '\t甲', '否则：', '\t乙']);
  });

  it('嵌套缩进按 scanControlFlow 的 depth', () => {
    const src = ['IF A', 'IF B', 'PRINTFORMW 深', 'ENDIF', 'ENDIF'].join('\n');
    const seg = project(src).segments[0]!;
    expect(segLines(seg)).toEqual(['如果 A：', '\t如果 B：', '\t\t深']);
  });
});

describe('糖投影 · 注释与分段', () => {
  it('注释/空行透传并被吸收进段', () => {
    const src = ['PRINTFORMW 甲', ';------', '', 'PRINTFORMW 乙'].join('\n');
    const r = project(src);
    expect(r.segments).toHaveLength(1);
    expect(segLines(r.segments[0]!)).toEqual(['甲', ';------', '', '乙']);
    expect(r.stats.passthroughLines).toBe(2);
  });

  it('原生行切断段；纯注释段不成段', () => {
    const src = ['PRINTFORMW 甲', 'SETCOLOR 0', ';仅注释', 'PRINTFORMW 乙'].join('\n');
    const r = project(src);
    expect(r.segments).toHaveLength(2);
    expect(r.segments.map((s) => [s.fromLine, s.toLine])).toEqual([
      [1, 1],
      [3, 4], // 句首注释被吸收进后一段
    ]);
  });
});

describe('糖投影 · 原生直通（fail-visible）', () => {
  it('SIF / 循环 / TRY / PRINTDATA 等控制流原样保留', () => {
    const src = ['SIF A', 'FOR LOCAL, 1, 3', 'PRINTFORMW 循环内', 'NEXT', 'PRINTDATAL', 'ENDDATA'].join('\n');
    const r = project(src);
    const reasons = Object.fromEntries(r.stats.nativeByReason.map((x) => [x.reason, x.count]));
    expect(reasons['unsupported-control-flow']).toBe(5);
    // 循环体内的台词行仍能单独投影
    expect(r.segments.map((s) => s.fromLine)).toEqual([3]);
  });

  it('PRINTDATA 数据表体内的 PRINTFORM* 不映射（判据来自结构）', () => {
    const src = ['PRINTDATAL', 'PRINTFORML 这是数据不是显示语句', 'ENDDATA'].join('\n');
    const r = project(src);
    expect(r.segments).toHaveLength(0);
    const reasons = Object.fromEntries(r.stats.nativeByReason.map((x) => [x.reason, x.count]));
    expect(reasons['data-or-skip']).toBe(1);
  });

  it('[SKIPSTART] 区内的 PRINTFORM* 不映射', () => {
    const src = ['[SKIPSTART]', 'PRINTFORML 停用代码', '[SKIPEND]', 'PRINTFORML 正常'].join('\n');
    const r = project(src);
    expect(r.segments.map((s) => [s.fromLine, s.toLine])).toEqual([[4, 4]]);
    const reasons = Object.fromEntries(r.stats.nativeByReason.map((x) => [x.reason, x.count]));
    expect(reasons['data-or-skip']).toBe(3);
  });

  it('赋值 / @ / # / $ 行原样保留', () => {
    const src = ['@FUNC', '#DIM X', '$LABEL', 'X = 1', 'PRINTFORML 甲'].join('\n');
    const r = project(src);
    expect(r.segments.map((s) => s.fromLine)).toEqual([5]);
    const reasons = Object.fromEntries(r.stats.nativeByReason.map((x) => [x.reason, x.count]));
    expect(reasons['other']).toBe(4);
  });
});

describe('糖投影 · 降级与边界', () => {
  it('无 scanControlFlow 时：只按行首映射台词，控制流原样保留', () => {
    const r = liftProject({ transpile: () => { throw new Error('x'); } }, {
      source: ['IF A', 'PRINTFORML 甲', 'ENDIF'].join('\n'),
    });
    // 无结构信息 → 控制流行不在糖覆盖判定内，原样保留；台词行仍投影
    expect(r.segments.map((s) => [s.fromLine, s.toLine])).toEqual([[2, 2]]);
    expect(segLines(r.segments[0]!)).toEqual(['甲 续']);
  });

  it('IF 表达式缺失 → 该行原样保留，其余行不受影响', () => {
    const src = ['IF', 'PRINTFORML 甲', 'ENDIF'].join('\n');
    const r = project(src);
    // IF 无表达式 → 不猜；体内台词行照常投影（段延伸到收束行 ENDIF）
    expect(r.segments.map((s) => [s.fromLine, s.toLine])).toEqual([[2, 3]]);
  });

  it('输入非字符串 → 抛错', () => {
    expect(() => liftProject(deps(), { source: 42 as unknown as string })).toThrow(TypeError);
  });

  it('空文件 → 零段零行', () => {
    const r = project('');
    expect(r.segments).toHaveLength(0);
    expect(r.stats.totalLines).toBe(0);
  });
});