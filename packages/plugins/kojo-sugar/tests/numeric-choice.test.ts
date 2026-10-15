/**
 * B2 批 · `选项 数字：` 数字输入菜单形（内核 add-on）。
 *
 * 与既有按钮形（`选项：`）**条目结构完全同形**，只换产物：编号打印 + `INPUT` 重试
 * 循环 + `SELECTCASE RESULT`（返回值从 1 起）。产物口径逐字照语料主流写法
 * （`M_KOJO_K16_10_イベント.ERB:121-135`、`M_KOJO_K73_1_イベント.ERB:239-250`）。
 *
 * 关键边界：**不写 `选项 数字：` 时按钮形产物逐字节不变**（回归自证见末组）。
 * 诊断**复用既有码**（`SugarDiagnosticCode` 是闭集，绝不新增）。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { SUGAR_LEXICON_WORDS } from '../src/keywords';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);
const codes = (src: string) => t(src).diagnostics.map((d) => d.code);

/** 位置：头部 + 一个时机块 */
const wrap = (body: string) => `角色: 12\n时机 指令 310：\n${body}`;

/**
 * 截取数字菜单产物片段：从第一个 `PRINTFORML [1]` 起、到该块 `ENDSELECT` 止，
 * 并**去掉一层缩进**（与 golden 摘录同口径）——便于逐字节对照、不受外层信封影响。
 */
const slice = (src: string): string => {
  const lines = t(src).erb.split('\n');
  const start = lines.findIndex((l) => l.includes('PRINTFORML [1]'));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && l.trim() === 'ENDSELECT');
  if (end < 0) return '';
  return (
    lines
      .slice(start, end + 1)
      .map((l) => (l.startsWith('\t') ? l.slice(1) : l))
      .join('\n') + '\n'
  );
};

/* ============================================================================ */

describe('B2 · `选项 数字：` 单条', () => {
  const src = wrap('    选项 数字：\n        「继续」：\n            「好。」\n');

  it('产物逐字节（PRINTFORML [n] / DO / INPUT / CLEARLINE 1 / SIF 范围 / BREAK / LOOP / SELECTCASE RESULT / CASE 1）', () => {
    expect(slice(src)).toBe(
      [
        'PRINTFORML [1] 继续',
        'DO',
        'INPUT',
        'CLEARLINE 1',
        'SIF RESULT >= 1 && RESULT <= 1',
        '\tBREAK',
        'LOOP 1',
        'SELECTCASE RESULT',
        '\tCASE 1',
        '\t\tPRINTFORMW 「好。」',
        'ENDSELECT',
        '',
      ].join('\n'),
    );
  });

  it('无诊断；且不产按钮形指令（INPUTS / RESULTS / PRINTBUTTON）', () => {
    const r = t(src);
    expect(r.diagnostics).toEqual([]);
    expect(r.erb).not.toContain('INPUTS');
    expect(r.erb).not.toContain('RESULTS');
    expect(r.erb).not.toContain('PRINTBUTTON');
    expect(r.erb).toContain('SELECTCASE RESULT');
  });
});

describe('B2 · `选项 数字：` 多条', () => {
  const src = wrap(
    '    选项 数字：\n        「用亲吻代替回答」：\n            「……唔。」\n        「摸摸头」：\n            「……好。」\n        「什么也不做」：\n            「……回去吧。」\n',
  );

  it('编号 1..n、范围上界 = n、CASE 1..n 逐字节', () => {
    expect(slice(src)).toBe(
      [
        'PRINTFORML [1] 用亲吻代替回答',
        'PRINTFORML [2] 摸摸头',
        'PRINTFORML [3] 什么也不做',
        'DO',
        'INPUT',
        'CLEARLINE 1',
        'SIF RESULT >= 1 && RESULT <= 3',
        '\tBREAK',
        'LOOP 1',
        'SELECTCASE RESULT',
        '\tCASE 1',
        '\t\tPRINTFORMW 「……唔。」',
        '\tCASE 2',
        '\t\tPRINTFORMW 「……好。」',
        '\tCASE 3',
        '\t\tPRINTFORMW 「……回去吧。」',
        'ENDSELECT',
        '',
      ].join('\n'),
    );
  });

  it('返回值从 1 起（不含 CASE 0）', () => {
    const out = t(src).erb;
    expect(out).toContain('SIF RESULT >= 1 && RESULT <= 3');
    expect(out).not.toContain('CASE 0');
  });
});

describe('B2 · 英文别名 `choice number：`', () => {
  it('与中文主形等价（同一产物）', () => {
    const zh = wrap('    选项 数字：\n        「继续」：\n            「好。」\n');
    const en = wrap('    choice number：\n        「继续」：\n            「好。」\n');
    expect(slice(en)).toBe(slice(zh));
    expect(t(en).diagnostics).toEqual([]);
  });

  it('`数字` **不进**关键字表（正文里的「数字」二字不被当指令）', () => {
    expect(SUGAR_LEXICON_WORDS.some((w) => w.word === '数字')).toBe(false);
    expect(SUGAR_LEXICON_WORDS.some((w) => w.word === 'number')).toBe(false);
    const out = t(wrap('    「这里的数字是多少。」\n')).erb;
    expect(out).toContain('PRINTFORMW 「这里的数字是多少。」');
  });
});

describe('B2 · 两种形并存与冲突（复用既有码）', () => {
  it('不同时机各一个块（一按钮 + 一数字）→ 无诊断', () => {
    const src =
      '角色: 12\n' +
      '时机 指令 310：\n' +
      '    选项：\n' +
      '        「A」：\n' +
      '            「a」\n' +
      '时机 指令 311：\n' +
      '    选项 数字：\n' +
      '        「B」：\n' +
      '            「b」\n';
    const r = t(src);
    expect(r.diagnostics).toEqual([]);
    expect(r.erb).toContain('PRINTBUTTON "A", "1"');
    expect(r.erb).toContain('PRINTFORML [1] B');
  });

  it('同一时机两个数字块 → choice-multiple', () => {
    const src = wrap(
      '    选项 数字：\n        「A」：\n            「a」\n    选项 数字：\n        「B」：\n            「b」\n',
    );
    expect(codes(src)).toContain('choice-multiple');
  });

  it('同一时机一按钮 + 一数字 → choice-multiple', () => {
    const src = wrap(
      '    选项：\n        「A」：\n            「a」\n    选项 数字：\n        「B」：\n            「b」\n',
    );
    expect(codes(src)).toContain('choice-multiple');
  });

  it('数字块嵌套（在如果体内）→ choice-nested', () => {
    const src = wrap('    如果 她的好感度 超过 0：\n        选项 数字：\n            「A」：\n                「a」\n');
    expect(codes(src)).toContain('choice-nested');
  });

  it('数字块作随机候选 → choice-nested', () => {
    const src = wrap(
      '    随机：\n        「平」\n        选项 数字：\n            「按钮」：\n                「选后」\n',
    );
    expect(codes(src)).toContain('choice-nested');
  });

  it('空数字块 → block-empty', () => {
    expect(codes(wrap('    选项 数字：\n'))).toContain('block-empty');
  });
});

describe('B2 · 回归自证：不写该形 ⇒ 产物逐字节不变', () => {
  it('按钮形仍产 PRINTBUTTON + INPUTS + SELECTCASE RESULTS，且无数字形构件', () => {
    const src = wrap('    选项：\n        「A」：\n            「a」\n        「B」：\n            「b」\n');
    const out = t(src).erb;
    expect(out).toContain('PRINTBUTTON "A", "1"');
    expect(out).toContain('PRINTBUTTON "B", "2"');
    expect(out).toContain('INPUTS');
    expect(out).toContain('SELECTCASE RESULTS');
    expect(out).toContain('\t\tCASE "1"');
    // 数字形构件一个都不出现
    expect(out).not.toContain('PRINTFORML [');
    expect(out).not.toContain('CLEARLINE');
    expect(out).not.toContain('RESULT >= 1');
    expect(out).not.toContain('LOOP 1');
    // 注意 `SELECTCASE RESULTS` 含 `SELECTCASE RESULT` 子串——用行尾锚定区分
    expect(out).not.toMatch(/SELECTCASE RESULT\n/);
  });
});
