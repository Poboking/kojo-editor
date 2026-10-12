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

  it('表外变体 / FORM 行内条件 → 原样保留（不静默）', () => {
    // 批 F 后 `PRINTL` 已有显示口径（见「输出家族全覆盖」组），表外的按钮类仍原样
    const r = project(
      ['PRINTL 非 FORM 系', 'PRINTBUTTON "x", 1', 'PRINTFORML \\@ X ? A # B \\@'].join('\n'),
    );
    expect(r.segments).toHaveLength(1);
    expect(segLines(r.segments[0]!)).toEqual(['非 FORM 系 续']);
    expect(r.stats.nativeLines).toBe(2);
    const reasons = Object.fromEntries(r.stats.nativeByReason.map((x) => [x.reason, x.count]));
    expect(reasons['unsupported-print-variant']).toBe(1);
    expect(reasons['inline-condition']).toBe(1);
  });
});

/* ==================== 批 F：PRINT 输出家族全覆盖 ==================== */

describe('糖投影 · 输出家族全覆盖（批 F）', () => {
  /** 桩字典：CFLAG 1088=好感度；用于证明"非 FORM 行不走属性反糖" */
  const dict = {
    resolveFamily: () => undefined,
    resolve: () => undefined,
    nameAt: (family: string, index: string): string | undefined =>
      family === 'CFLAG' && index === '1088' ? '好感度' : undefined,
  };
  const withDict = (source: string) =>
    liftProject(
      { transpile: () => { throw new Error('x'); }, scanControlFlow, dictionary: () => dict },
      { source },
    );
  const reasonsOf = (r: { stats: { nativeByReason: { reason: string; count: number }[] } }) =>
    Object.fromEntries(r.stats.nativeByReason.map((x) => [x.reason, x.count]));

  it('非 FORM 文本行**逐字符原样**（代词 / `{…}` 一律不反糖）', () => {
    // 引擎语义：只有 PRINTFORM* 展开 FORM 记号；非 FORM 行里的 `%…%` `{…}` 是被打印的字面字符。
    // 真实语料实证：非 FORM 行含 `%…%` 仅 5/62,651 行；`PRINTDL` 含 `\@` 的 518 行全是 ASCII 图形文字。
    const r = project(
      ['PRINTDL %CALLNAME:TARGET%', 'PRINTW 耐久度 {PAGECOUNT}', 'PRINTL {你}不是反糖'].join('\n'),
    );
    expect(segLines(r.segments[0]!)).toEqual([
      '%CALLNAME:TARGET% 续',
      '耐久度 {PAGECOUNT}',
      '{你}不是反糖 续',
    ]);
    // 同一支记号在 FORM 行里照旧反糖（对照，钉死"只对 FORM 做"不是全局关掉）
    const f = project(['PRINTFORMDL %CALLNAME:TARGET%', 'PRINTFORMW {你}'].join('\n'));
    expect(segLines(f.segments[0]!)).toEqual(['{她} 续', '{你}']);
  });

  it('非 FORM 行不走属性反糖（即使字典查得到）', () => {
    const plain = withDict('PRINTL {CFLAG:TARGET:1088}');
    expect(segLines(plain.segments[0]!)).toEqual(['{CFLAG:TARGET:1088} 续']);
    const form = withDict('PRINTFORMW {CFLAG:TARGET:1088}');
    expect(segLines(form.segments[0]!)).toEqual(['{她的好感度}']);
  });

  it('L/W 变体的空体 → 一行空行，且不再切断糖段', () => {
    const r = project(['PRINTFORMW 甲', 'PRINTL', 'PRINTW', 'PRINTDW ', 'PRINTDL\t', 'PRINTFORML 乙'].join('\n'));
    expect(r.segments).toHaveLength(1);
    expect(segLines(r.segments[0]!)).toEqual(['甲', '', '', '', '', '乙 续']);
    expect(r.stats.nativeLines).toBe(0);
    expect(r.stats.projectedLines).toBe(6);
  });

  it('无换行变体的空体 → 原样保留（既不输出也不换行，没有可显示的东西）', () => {
    const r = project(['PRINT', 'PRINTD', 'PRINTFORM', 'PRINTFORMD '].join('\n'));
    expect(r.segments).toHaveLength(0);
    expect(reasonsOf(r)['unsupported-print-variant']).toBe(4);
  });

  it('裸 FORM 片段（PRINTFORM / PRINTFORMD）→ 文本行 + 可读化，但**不加**「续」', () => {
    // `续` 在糖里 = `L`（换行不等待）；无后缀是"不换行"，糖没有等价标记（规范 §3.3 能力边界），
    // 故投影成独立文本行、不谎称续行。
    const r = project(['PRINTFORM %CALLNAME:MASTER%', 'PRINTFORMD 带着温柔的笑容'].join('\n'));
    expect(segLines(r.segments[0]!)).toEqual(['{你}', '带着温柔的笑容']);
  });

  it('指令后紧跟 `;` → 原样保留（那是注释，不是要打印的字）', () => {
    const r = project('PRINTFORMW ;这是注释');
    expect(r.segments).toHaveLength(0);
    expect(reasonsOf(r)['unsupported-print-variant']).toBe(1);
  });

  it('表外变体（按钮 / 排版 / 罕见）不投影 —— 宁缺勿误导', () => {
    const r = project(
      ['PRINTBUTTON "[回去]", "0"', 'PRINTLC 甲', 'PRINTS @"%a%"', 'PRINTPLAIN 乙', 'PRINTV X', 'PRINTFORMKW 丙'].join(
        '\n',
      ),
    );
    expect(r.segments).toHaveLength(0);
    expect(reasonsOf(r)['unsupported-print-variant']).toBe(6);
  });

  it('非 FORM 行里的 `\\@` 不触发 inline-condition（ASCII 图形文字样本）', () => {
    // 语料原型（K 系作者画的字符画）：`\@` 在这里只是画面的一部分，不是行内条件。
    const body = '"@@O` [O\\.  =@@@`,\\^ \\@O]  ./@O@@@OO@@/ \\@ .[[[.."';
    const r = project(`PRINTDL ${body}`);
    expect(segLines(r.segments[0]!)).toEqual([`${body} 续`]);
    expect(r.stats.nativeLines).toBe(0);
  });

  it('结构判据仍优先：PRINTDATA 数据表体内的 `PRINTL` 不投影', () => {
    const r = project(['PRINTDATAL', 'PRINTL 这是数据不是显示语句', 'ENDDATA'].join('\n'));
    expect(r.segments).toHaveLength(0);
    expect(reasonsOf(r)['data-or-skip']).toBe(1);
    expect(reasonsOf(r)['unsupported-control-flow']).toBe(2);
  });

  it('不变量：三类计数之和恒等于总行数（批 F 新行也入账）', () => {
    const src = [
      'PRINTL 甲',
      'PRINTW',
      'PRINTFORM 乙',
      'PRINTBUTTON "x", 1',
      '',
      '; 注释',
      '@FUNC',
    ].join('\n');
    const { stats } = project(src);
    expect(stats.projectedLines + stats.passthroughLines + stats.nativeLines).toBe(stats.totalLines);
    expect(stats.totalLines).toBe(7);
    expect(stats.projectedLines).toBe(3);
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
/* ==================== 属性反糖（用户第 7 条） ==================== */

describe('糖投影 · 属性反糖（需变量字典的反向查询）', () => {
  /** 桩字典：只有 CFLAG 1088=好感度、TALENT 3=恋慕；其余查不到（模拟名称表未收录） */
  const dict = {
    resolveFamily: () => undefined,
    resolve: () => undefined,
    nameAt: (family: string, index: string): string | undefined => {
      if (family === 'CFLAG' && index === '1088') return '好感度';
      if (family === 'TALENT' && (index === '3' || index === '恋慕')) return '恋慕';
      return undefined;
    },
  };
  const withDict = (source: string) =>
    liftProject(
      { transpile: () => { throw new Error('x'); }, scanControlFlow, dictionary: () => dict },
      { source },
    );

  it('三段式（FAMILY:TARGET:编号）→ 她的 + 名称', () => {
    const r = withDict('PRINTFORMW 「好感度是{CFLAG:TARGET:1088}。」');
    expect(segLines(r.segments[0]!)).toEqual(['「好感度是{她的好感度}。」']);
  });

  it('两段式（FAMILY:编号，角色省略 = TARGET）→ 同样反糖', () => {
    const r = withDict('PRINTFORMW 「{CFLAG:1088}」');
    expect(segLines(r.segments[0]!)).toEqual(['「{她的好感度}」']);
  });

  it('玩家作用域 → 你的；具名索引 → 原名照用', () => {
    const r = withDict(['PRINTFORMW 「{TALENT:TARGET:恋慕}」', 'PRINTFORMDW {TALENT:MASTER:3}'].join('\n'));
    expect(segLines(r.segments[0]!)).toEqual(['「{她的恋慕}」', '{你的恋慕}']);
  });

  it('控制流表达式也反糖（条件里的数字同样是"读不懂"的来源）', () => {
    const r = withDict('IF CFLAG:TARGET:1088 >= 500\nPRINTFORMDW 甲\nENDIF');
    expect(segLines(r.segments[0]!)[0]).toBe('如果 她的好感度 >= 500：');
  });

  it('**全局族不反糖**（`FLAG:70` 不是"她的"，写错比不写更糟）', () => {
    const r = withDict('IF FLAG:70 && TFLAG:192\nPRINTFORMDW 甲\nENDIF');
    expect(segLines(r.segments[0]!)[0]).toBe('如果 FLAG:70 && TFLAG:192：');
  });

  it('名称查不到 / 非目标与玩家角色 / 表达式混写 → **一律不动**（绝不猜）', () => {
    const r = withDict(
      [
        'PRINTFORMW 「{CFLAG:TARGET:9999}」',
        'PRINTFORMDW 「{CFLAG:12:1088}」',
        'PRINTFORMDW 「{CFLAG:TARGET:1088 + 1}」',
      ].join('\n'),
    );
    expect(segLines(r.segments[0]!)).toEqual([
      '「{CFLAG:TARGET:9999}」',
      '「{CFLAG:12:1088}」',
      '「{CFLAG:TARGET:1088 + 1}」',
    ]);
  });

  it('无字典（adapter 未激活）→ 退化为不做属性反糖，其余照常', () => {
    const r = project('PRINTFORMW 「{CFLAG:TARGET:1088}」');
    expect(segLines(r.segments[0]!)).toEqual(['「{CFLAG:TARGET:1088}」']);
  });
});

/* ==================== 着色块（用户第 8 条） ==================== */

describe('糖投影 · `SETCOLOR`/`RESETCOLOR` → 「着色 …：」块', () => {
  it('配对成功 → 块头 + 体内缩进 +1 + `RESETCOLOR` 被吸收（不显示）', () => {
    const src = [
      'SETCOLOR 0xFF8080',
      'IF A',
      '\tPRINTFORMDW 甲。',
      'ENDIF',
      'RESETCOLOR',
      'PRINTFORMDW 乙。',
    ].join('\n');
    const r = project(src);
    expect(r.segments).toHaveLength(1);
    expect(segLines(r.segments[0]!)).toEqual([
      '着色 0xFF8080：',
      '\t如果 A：',
      '\t\t甲。',
      '乙。',
    ]);
  });

  it('**配不上就不发糖**（真实语料 SETCOLOR 远多于 RESETCOLOR——猜边界会把代码藏起来）', () => {
    const r = project('SETCOLOR 0xFF8080\nPRINTFORMDW 甲。');
    expect(r.segments).toHaveLength(1); // 只有台词行成段
    expect(segLines(r.segments[0]!)).toEqual(['甲。']);
    const reasons = Object.fromEntries(r.stats.nativeByReason.map((x) => [x.reason, x.count]));
    expect(reasons['other']).toBe(1); // SETCOLOR 原样保留
  });

  it('跨深度不配对（另一层作者的收尾不该画进本块）', () => {
    const src = [
      'SETCOLOR 0xFF8080',
      'IF A',
      '\tPRINTFORMDW 甲。',
      '\tRESETCOLOR',
      'ENDIF',
    ].join('\n');
    const r = project(src);
    // SETCOLOR 在深度 0、RESETCOLOR 在深度 1 → 不配对 → SETCOLOR 原样保留
    const reasons = Object.fromEntries(r.stats.nativeByReason.map((x) => [x.reason, x.count]));
    expect(reasons['other']).toBe(2); // SETCOLOR + RESETCOLOR 都原样
    expect(segLines(r.segments[0]!)).toEqual(['如果 A：', '\t甲。']);
  });

  it('嵌套着色：体内 +1 层逐级叠加', () => {
    const src = [
      'SETCOLOR 0x111111',
      'SETCOLOR 0x222222',
      'PRINTFORMDW 甲。',
      'RESETCOLOR',
      'RESETCOLOR',
    ].join('\n');
    const r = project(src);
    expect(segLines(r.segments[0]!)).toEqual([
      '着色 0x111111：',
      '\t着色 0x222222：',
      '\t\t甲。',
    ]);
  });
});

describe('糖投影 · 着色块不跨函数边界 / 不跨停用区', () => {
  it('**不跨函数**：上一函数未收尾的 SETCOLOR 不与下一函数的 RESETCOLOR 配对', () => {
    const src = [
      '@FUNC_A',
      'SETCOLOR 0xFF8080',
      'PRINTFORMDW 甲。',
      '@FUNC_B',
      'RESETCOLOR',
      'PRINTFORMDW 乙。',
    ].join('\n');
    const r = project(src);
    // SETCOLOR / RESETCOLOR 都原样保留（不配对），两句台词各自成段
    const reasons = Object.fromEntries(r.stats.nativeByReason.map((x) => [x.reason, x.count]));
    expect(reasons['other']).toBe(4); // @FUNC_A / SETCOLOR / @FUNC_B / RESETCOLOR
    expect(r.segments.map((s) => s.fromLine)).toEqual([3, 6]);
    // 关键：没有出现「着色 …：」块头
    for (const s of r.segments) expect(s.sugarText).not.toContain('着色');
  });

  it('**不跨停用区**：`[SKIPSTART]` 打断配对推断', () => {
    const src = [
      'SETCOLOR 0xFF8080',
      '[SKIPSTART]',
      'PRINTFORMDW 停用',
      '[SKIPEND]',
      'RESETCOLOR',
    ].join('\n');
    const r = project(src);
    for (const s of r.segments) expect(s.sugarText).not.toContain('着色');
  });
});

/* ==================== 函数骨架合并（用户第 2 条） ==================== */

describe('糖投影 · 函数骨架合并（包装三联 + 記入チェック信封）', () => {
  /** 真实 K49 形态的骨架（与语料实测一致） */
  const SKELETON = [
    '@M_KOJO_MESSAGE_COM_K1_310',
    'CALL M_KOJO_MESSAGE_COM_K1_310_1',
    'RETURN 1',
    '@M_KOJO_MESSAGE_COM_K1_310_1',
    ';-------------------------------------------------',
    ';記入チェック（=0, 非表示、1, 表示）',
    'LOCAL = 1',
    ';-------------------------------------------------',
    'IF LOCAL',
    '\tPRINTFORMW 「呀……！」',
    '\tPRINTFORMDW 她别开了脸。',
    'ENDIF',
    'RETURN 1',
  ].join('\n');

  it('包装三联吸收、`@A` 保留；信封拆掉后正文**减一层缩进**', () => {
    const r = project(SKELETON);
    // 段从第 2 行起（第 1 行 @A 是原生行，切断段），一直消化到第 13 行
    expect(r.segments).toHaveLength(1);
    expect(`${r.segments[0]!.fromLine}-${r.segments[0]!.toLine}`).toBe('2-13');
    expect(segLines(r.segments[0]!)).toEqual([
      ';-------------------------------------------------',
      ';記入チェック（=0, 非表示、1, 表示）',
      ';-------------------------------------------------',
      '「呀……！」',
      '她别开了脸。',
    ]);
  });

  it('骨架被吸收的行计入 `projectedLines`（不静默：读者看不到，但账要平）', () => {
    const { stats } = project(SKELETON);
    expect(stats.projectedLines + stats.passthroughLines + stats.nativeLines).toBe(stats.totalLines);
    expect(stats.totalLines).toBe(13);
    // 只有 `@A` 一行是「保留原生」
    expect(stats.nativeLines).toBe(1);
  });

  it('嵌套块在信封内 → 也整体减一层（相对缩进保持）', () => {
    const src = [
      '@F_1',
      'LOCAL = 1',
      'IF LOCAL',
      '\tIF FLAG:1',
      '\t\tPRINTFORMDW 甲。',
      '\tENDIF',
      'ENDIF',
      'RETURN 1',
    ].join('\n');
    const r = project(src);
    expect(segLines(r.segments[0]!)).toEqual(['如果 FLAG:1：', '\t甲。']);
  });

  it('**配不上就不动**：`LOCAL = 1` 之后不是 `IF LOCAL`', () => {
    const src = ['@F_1', 'LOCAL = 1', 'LOCAL:1 = 1', 'IF LOCAL', 'PRINTFORMDW 甲。', 'ENDIF'].join('\n');
    const r = project(src);
    // LOCAL = 1 与 LOCAL:1 = 1 原样保留（后者挡住"紧邻"判据）
    expect(segLines(r.segments[0]!)).toEqual(['如果 LOCAL：', '\t甲。']);
    const reasons = Object.fromEntries(r.stats.nativeByReason.map((x) => [x.reason, x.count]));
    // 三行原生：`@F_1` / `LOCAL = 1` / `LOCAL:1 = 1`（后者挡住"紧邻"判据）
    expect(reasons['other']).toBe(3);
  });

  it('**无函数头就不合并**（正文里的同名守卫不该被当信封拆掉）', () => {
    const src = ['PRINTFORMDW 前面', 'LOCAL = 1', 'IF LOCAL', 'PRINTFORMDW 甲。', 'ENDIF'].join('\n');
    const r = project(src);
    // 信封未被识别 → `IF LOCAL` 照常投影、正文保持一层缩进（`LOCAL = 1` 仍是原生行，把段切开）
    expect(r.segments).toHaveLength(2);
    expect(segLines(r.segments[0]!)).toEqual(['前面']);
    expect(segLines(r.segments[1]!)).toEqual(['如果 LOCAL：', '\t甲。']);
  });

  it('`IF LOCAL` 带缩进（不在函数体最外层）→ 不合并', () => {
    const src = ['@F_1', 'LOCAL = 1', '    IF LOCAL', 'PRINTFORMDW 甲。', '    ENDIF'].join('\n');
    const r = project(src);
    const all = r.segments.map((s) => s.sugarText).join('\n');
    // 不合并的证据：`如果 LOCAL：` 仍在，且正文仍缩一层（合并了的话这两行都会消失）
    expect(all).toBe('如果 LOCAL：\n\t甲。');
  });

  it('包装三联**四行必须连续**：中间插一行就不合并', () => {
    const src = ['@A', 'CALL A_1', ';注释打断', 'RETURN 1', '@A_1', 'PRINTFORMDW 甲。'].join('\n');
    const r = project(src);
    const reasons = Object.fromEntries(r.stats.nativeByReason.map((x) => [x.reason, x.count]));
    expect(reasons['other']).toBe(4); // @A / CALL / @A_1 / ... 都原样
  });
});

describe('糖投影 · 只藏不显的段（契约：`lineCount === 0` 时宿主不插空 ViewZone）', () => {
  it('纯骨架吸收段：`sugarText` 为空、`lineCount` 为 0，但区间仍被覆盖（骨架该藏起来）', () => {
    // 只有包装三联、没有任何正文 → 该段没有可显示的糖，只承担"把骨架收起来"
    const src = ['@A', 'CALL A_1', 'RETURN 1', '@A_1', '@B'].join('\n');
    const r = project(src);
    const empty = r.segments.filter((s) => s.lineCount === 0);
    expect(empty).toHaveLength(1);
    expect(empty[0]!.sugarText).toBe('');
    // 区间覆盖被吸收的三行
    expect(`${empty[0]!.fromLine}-${empty[0]!.toLine}`).toBe('2-4');
  });
});
