/**
 * B2 批（前向修正）· `菜单：` 数字输入菜单块。
 *
 * 产物 = 逐条 `PRINTL [n] 标签` + `$INPUT_LOOP` 回跳落点 + `INPUT` + `SELECTCASE RESULT`
 * 的 `CASE n` … `CASEELSE → GOTO INPUT_LOOP`（无效输入回菜单、正常分支透出退出）。
 * 形态**逐字照语料主流写法**（全 ERB 1,770 处裸 `INPUT`：标签回跳环 ~590 处 vs
 * `DO`/`LOOP` 环 ~105 处；标签 `INPUT_LOOP` 居首 43 处；菜单项 `PRINTL` 居首 1,186 行）。
 *
 * 关键边界：既有按钮形 `选项：` 产物**逐字节不变**（见末组回归自证）。
 * 诊断**复用既有码**（`SugarDiagnosticCode` 是闭集，绝不新增）：
 * `choice-multiple` / `choice-nested` / `block-empty`。
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
 * 截取菜单产物片段：从第一个 `PRINTL [1]` 起、到该块 `ENDSELECT` 止，
 * 并**去掉一层缩进**（与 golden 摘录同口径）——便于逐字节对照、不受外层信封影响。
 */
const slice = (src: string): string => {
  const lines = t(src).erb.split('\n');
  const start = lines.findIndex((l) => l.includes('PRINTL [1]'));
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

describe('B2 · `菜单：` 单条', () => {
  const src = wrap('    菜单：\n        「继续」：\n            「好。」\n');

  it('产物逐字节（PRINTL [n] / $INPUT_LOOP / INPUT / SELECTCASE RESULT / CASE 1 / CASEELSE 回跳）', () => {
    expect(slice(src)).toBe(
      [
        'PRINTL [1] 继续',
        '$INPUT_LOOP',
        'INPUT',
        'SELECTCASE RESULT',
        '\tCASE 1',
        '\t\tPRINTFORMW 「好。」',
        '\tCASEELSE',
        '\t\tGOTO INPUT_LOOP',
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

describe('B2 · `菜单：` 多条', () => {
  const src = wrap(
    '    菜单：\n        「用亲吻代替回答」：\n            「……唔。」\n        「摸摸头」：\n            「……好。」\n        「什么也不做」：\n            「……回去吧。」\n',
  );

  it('编号 1..n、PRINTL 逐条、CASE 1..n 逐字节', () => {
    expect(slice(src)).toBe(
      [
        'PRINTL [1] 用亲吻代替回答',
        'PRINTL [2] 摸摸头',
        'PRINTL [3] 什么也不做',
        '$INPUT_LOOP',
        'INPUT',
        'SELECTCASE RESULT',
        '\tCASE 1',
        '\t\tPRINTFORMW 「……唔。」',
        '\tCASE 2',
        '\t\tPRINTFORMW 「……好。」',
        '\tCASE 3',
        '\t\tPRINTFORMW 「……回去吧。」',
        '\tCASEELSE',
        '\t\tGOTO INPUT_LOOP',
        'ENDSELECT',
        '',
      ].join('\n'),
    );
  });
});

describe('B2 · 回跳环（无效/默认分支回菜单、正常分支退出）', () => {
  const src = wrap(
    '    菜单：\n        「继续」：\n            「好。」\n        「不弄了」：\n            「……嗯。」\n',
  );

  it('无效/默认分支（CASEELSE）回菜单：$INPUT_LOOP 落点 + GOTO 回跳', () => {
    const out = t(src).erb;
    expect(out).toContain('$INPUT_LOOP');
    expect(out).toContain('\tCASEELSE');
    expect(out).toContain('GOTO INPUT_LOOP');
  });

  it('正常分支退出：CASE 体内无 BREAK / GOTO 回跳（透出 ENDSELECT 即退出）', () => {
    expect(slice(src)).toBe(
      [
        'PRINTL [1] 继续',
        'PRINTL [2] 不弄了',
        '$INPUT_LOOP',
        'INPUT',
        'SELECTCASE RESULT',
        '\tCASE 1',
        '\t\tPRINTFORMW 「好。」',
        '\tCASE 2',
        '\t\tPRINTFORMW 「……嗯。」',
        '\tCASEELSE',
        '\t\tGOTO INPUT_LOOP',
        'ENDSELECT',
        '',
      ].join('\n'),
    );
    const out = t(src).erb;
    expect(out).not.toContain('BREAK');
    expect(out).not.toContain('DO');
    expect(out).not.toContain('LOOP 1');
  });
});

describe('B2 · 英文别名 `menu：`', () => {
  it('与中文主形等价（同一产物）', () => {
    const zh = wrap('    菜单：\n        「继续」：\n            「好。」\n');
    const en = wrap('    menu：\n        「继续」：\n            「好。」\n');
    expect(slice(en)).toBe(slice(zh));
    expect(t(en).diagnostics).toEqual([]);
  });

  it('`菜单` 已登记进关键字表（中文主形 + 英文小写别名）', () => {
    expect(SUGAR_LEXICON_WORDS.some((w) => w.word === '菜单' && w.role === 'block')).toBe(true);
    expect(SUGAR_LEXICON_WORDS.some((w) => w.word === 'menu' && w.role === 'block')).toBe(true);
  });
});

describe('B2 · 冲突与嵌套（复用既有码）', () => {
  it('同一时机两个菜单块 → choice-multiple', () => {
    const src = wrap('    菜单：\n        「A」：\n            「a」\n    菜单：\n        「B」：\n            「b」\n');
    expect(codes(src)).toContain('choice-multiple');
  });

  it('菜单块嵌套（在如果体内）→ choice-nested', () => {
    const src = wrap('    如果 她的好感度 超过 0：\n        菜单：\n            「A」：\n                「a」\n');
    expect(codes(src)).toContain('choice-nested');
  });

  it('菜单块作随机候选 → choice-nested', () => {
    const src = wrap('    随机：\n        「平」\n        菜单：\n            「按钮」：\n                「选后」\n');
    expect(codes(src)).toContain('choice-nested');
  });

  it('空菜单块 → block-empty', () => {
    expect(codes(wrap('    菜单：\n'))).toContain('block-empty');
  });
});

describe('B2 · 回归自证：既有 `选项：`（按钮形）一个字都不动', () => {
  it('按钮形仍产 PRINTBUTTON + INPUTS + SELECTCASE RESULTS，且无菜单形构件', () => {
    const src = wrap('    选项：\n        「A」：\n            「a」\n        「B」：\n            「b」\n');
    const out = t(src).erb;
    expect(out).toContain('PRINTBUTTON "A", "1"');
    expect(out).toContain('PRINTBUTTON "B", "2"');
    expect(out).toContain('INPUTS');
    expect(out).toContain('SELECTCASE RESULTS');
    expect(out).toContain('\t\tCASE "1"');
    // 菜单形构件一个都不出现
    expect(out).not.toContain('PRINTL [');
    expect(out).not.toContain('$INPUT_LOOP');
    expect(out).not.toContain('SELECTCASE RESULT\n');
  });

  it('同一时机的 `选项：` 与 `菜单：` 各自成块（读回变量不同：RESULTS vs RESULT）→ 无诊断', () => {
    const src = wrap('    选项：\n        「A」：\n            「a」\n    菜单：\n        「B」：\n            「b」\n');
    const r = t(src);
    expect(r.diagnostics).toEqual([]);
    expect(r.erb).toContain('PRINTBUTTON "A", "1"');
    expect(r.erb).toContain('PRINTL [1] B');
    expect(r.erb).toContain('SELECTCASE RESULTS');
    expect(r.erb).toContain('SELECTCASE RESULT\n');
  });
});
