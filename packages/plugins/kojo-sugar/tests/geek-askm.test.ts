/**
 * 2 号批 · `询问` / `确认` = 引擎封装问答函数（eraTW `ASK_M` / `ASK_YN`）。
 *
 * 条目头 = `「标签」 [逐项显示条件]：`——该槽是**逐项显示条件**（引擎逐条第 2 参：0 = 灰显无效 /
 * 负 = 隐藏 / 非 0 = 有效），**不是**选中返回值；槽**可选**，缺省 `1`（语料绝大多数是 `,1)`）。
 * 选中项由 `CASE 0..n-1` 的**书写次序**（0 基）决定，与逐项显示条件无关。
 *
 * 产物形态**逐字照真实语料**（`C:\game\eratw-画蛇添足版eratw4.980\…\011 Marisa [魔理沙]\`
 * 的 `M_KOJO_K11_2_イベント.ERB` / 全目录 50 处 `CALL ASK_M|ASK_YN`）：
 * ```
 * CALL ASK_M("甲",1,"乙",1)   ← 逐项 `标签,条件`（无空格、ASCII 双引号）
 * SELECTCASE RESULT
 *     CASE 0        ← 选中序号 0 基
 *         …
 * ENDSELECT
 * ```
 * 引擎函数名 / 参数 / 读回变量属**游戏知识**（只住 eratw-adapter 的 `KojoFaceTable.ask`），
 * 糖里零硬编码。诊断**复用既有码**（`SugarDiagnosticCode` 是闭集，绝不新增）：
 * `block-empty` / `face-table-missing` / `indent-mismatch`。
 */

import { describe, expect, it } from 'vitest';
import type { KojoFaceTable } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { SUGAR_LEXICON_WORDS } from '../src/keywords';
import { stubDict, stubFaceTable } from './support';

const svc = (faceTable: KojoFaceTable = stubFaceTable()) =>
  createSugarTranspileService({ dictionary: stubDict, faceTable });
const t = (src: string, faceTable?: KojoFaceTable) => svc(faceTable).transpile(src);
const codes = (src: string, faceTable?: KojoFaceTable) => t(src, faceTable).diagnostics.map((d) => d.code);

/** 头部 + 一个时机块 */
const wrap = (body: string) => `角色: 12\n时机 指令 310：\n${body}`;

/**
 * 截取问答产物片段：从含 `marker` 的行起、到该块 `ENDSELECT` 止，去掉一层缩进。
 */
const slice = (src: string, marker: string, faceTable?: KojoFaceTable): string => {
  const lines = t(src, faceTable).erb.split('\n');
  const start = lines.findIndex((l) => l.includes(marker));
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

describe('询问 · 多选（ASK_M）', () => {
  const src = wrap(
    '    询问 "要不要一起修炼？"：\n        "好呀" 1：\n            「嗯！」\n        "下次吧" 0：\n            「…算了。」\n',
  );

  it('产物逐字节（CALL ASK_M + SELECTCASE RESULT + CASE 0..n-1）', () => {
    expect(slice(src, 'CALL ASK_M')).toBe(
      [
        'CALL ASK_M("好呀",1,"下次吧",0)',
        'SELECTCASE RESULT',
        '\tCASE 0',
        '\t\tPRINTFORMW 「嗯！」',
        '\tCASE 1',
        '\t\tPRINTFORMW 「…算了。」',
        'ENDSELECT',
        '',
      ].join('\n'),
    );
  });

  it('逐项显示条件 = 引擎逐项**条件**（标签,条件）；CASE 序号是**位置** 0 基', () => {
    const out = t(src).erb;
    // 值 1 / 0 原样落在第二条参数上（0 = 灰显无效，非「选中值」）
    expect(out).toContain('CALL ASK_M("好呀",1,"下次吧",0)');
    // 第一项（值 1）对应 CASE 0、第二项（值 0）对应 CASE 1 —— 序号按书写顺序
    const c0 = out.indexOf('CASE 0');
    const c1 = out.indexOf('CASE 1');
    expect(c0).toBeGreaterThan(-1);
    expect(c1).toBeGreaterThan(c0);
    expect(out.slice(c0, c1)).toContain('「嗯！」');
    expect(out.slice(c1)).toContain('「…算了。」');
  });

  it('提示文案走文本行管线：旁白 `PRINTFORMDW 要不要一起修炼？` 在调用之前', () => {
    const out = t(src).erb;
    const prompt = out.indexOf('PRINTFORMDW 要不要一起修炼？');
    const call = out.indexOf('CALL ASK_M(');
    expect(prompt).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(prompt);
  });

  it('无诊断；不产按钮/菜单形构件（另一条管线）', () => {
    const r = t(src);
    expect(r.diagnostics).toEqual([]);
    expect(r.erb).not.toContain('PRINTBUTTON');
    expect(r.erb).not.toContain('INPUTS');
    expect(r.erb).not.toContain('INPUT\n');
    expect(r.erb).not.toContain('PRINTL [');
  });
});

describe('询问 · 逐项显示条件', () => {
  it('省略逐项条件 → 用 adapter 模板缺省（eraTW `1`）', () => {
    const src = wrap('    询问：\n        「甲」：\n            「a」\n        「乙」：\n            「b」\n');
    expect(slice(src, 'CALL ASK_M')).toContain('CALL ASK_M("甲",1,"乙",1)');
  });

  it('显式条件可为表达式（走表达式降糖，非仅字面量）：变量族引用原样落产物', () => {
    const src = wrap('    询问：\n        「甲」 CFLAG:TARGET:5：\n            「a」\n        「乙」 1：\n            「b」\n');
    const r = t(src);
    expect(r.diagnostics).toEqual([]);
    expect(r.erb).toContain('CALL ASK_M("甲",CFLAG:TARGET:5,"乙",1)');
  });
});

describe('询问 · 逐项显示条件：可选槽（缺省 1）+ 原样透传', () => {
  it('无显式条件 → 缺省 1；CASE 序号按书写次序 0 基', () => {
    const src = wrap('    询问：\n        「甲」：\n            「a」\n        「乙」：\n            「b」\n');
    expect(slice(src, 'CALL ASK_M')).toBe(
      [
        'CALL ASK_M("甲",1,"乙",1)',
        'SELECTCASE RESULT',
        '\tCASE 0',
        '\t\tPRINTFORMW 「a」',
        '\tCASE 1',
        '\t\tPRINTFORMW 「b」',
        'ENDSELECT',
        '',
      ].join('\n'),
    );
    expect(t(src).diagnostics).toEqual([]);
  });

  it('显式条件表达式原样透传（与缺省混写：一项带条件、一项省略）', () => {
    const src = wrap('    询问：\n        「甲」 CFLAG:TARGET:5：\n            「a」\n        「乙」：\n            「b」\n');
    expect(t(src).erb).toContain('CALL ASK_M("甲",CFLAG:TARGET:5,"乙",1)');
    expect(t(src).diagnostics).toEqual([]);
  });
});

describe('确认 · 二择（ASK_YN）', () => {
  const src = wrap('    确认 "要开启吗？"：\n        「开启」：\n            「好。」\n        「关闭」：\n            「……嗯。」\n');

  it('产物逐字节（CALL ASK_YN 纯标签 + SELECTCASE RESULT）', () => {
    expect(slice(src, 'CALL ASK_YN')).toBe(
      [
        'CALL ASK_YN("开启","关闭")',
        'SELECTCASE RESULT',
        '\tCASE 0',
        '\t\tPRINTFORMW 「好。」',
        '\tCASE 1',
        '\t\tPRINTFORMW 「……嗯。」',
        'ENDSELECT',
        '',
      ].join('\n'),
    );
    expect(t(src).erb).toContain('PRINTFORMDW 要开启吗？');
  });

  it('恰两项：三项 → block-empty（复用既有码）且不产 CALL', () => {
    const bad = wrap(
      '    确认：\n        「甲」：\n            「a」\n        「乙」：\n            「b」\n        「丙」：\n            「c」\n',
    );
    expect(codes(bad)).toContain('block-empty');
    expect(t(bad).erb).not.toContain('CALL ASK_YN');
  });

  it('二择不接受逐项显示条件：写了条件 → block-empty 且不产 CALL', () => {
    const bad = wrap('    确认：\n        「甲」 1：\n            「a」\n        「乙」：\n            「b」\n');
    expect(codes(bad)).toContain('block-empty');
    expect(t(bad).erb).not.toContain('CALL ASK_YN');
  });
});

describe('英文别名（ask / confirm）', () => {
  it('与中文主形等价（同一产物）', () => {
    const zh = wrap('    询问：\n        「甲」 1：\n            「a」\n        「乙」 1：\n            「b」\n');
    const en = wrap('    ask：\n        「甲」 1：\n            「a」\n        「乙」 1：\n            「b」\n');
    expect(slice(en, 'CALL ASK_M')).toBe(slice(zh, 'CALL ASK_M'));
    expect(t(en).diagnostics).toEqual([]);

    const zhYN = wrap('    确认：\n        「甲」：\n            「a」\n        「乙」：\n            「b」\n');
    const enYN = wrap('    confirm：\n        「甲」：\n            「a」\n        「乙」：\n            「b」\n');
    expect(slice(enYN, 'CALL ASK_YN')).toBe(slice(zhYN, 'CALL ASK_YN'));
  });

  it('关键字已登记进词表（中文主形 + 英文小写别名，role=block）', () => {
    for (const w of ['询问', 'ask', '确认', 'confirm']) {
      expect(SUGAR_LEXICON_WORDS.some((x) => x.word === w && x.role === 'block')).toBe(true);
    }
  });
});

describe('边界（复用既有诊断码，不产半成品）', () => {
  it('无条目 → block-empty', () => {
    expect(codes(wrap('    询问：\n'))).toContain('block-empty');
  });

  it('只有一项（< minOptions）→ block-empty 且不产 CALL', () => {
    const src = wrap('    询问：\n        「甲」 1：\n            「a」\n');
    expect(codes(src)).toContain('block-empty');
    expect(t(src).erb).not.toContain('CALL ASK_M');
  });

  it('adapter 未声明问答模板 → face-table-missing 且不产 CALL', () => {
    const noAsk: KojoFaceTable = { faces: { 初见: { template: 'M_KOJO{t}_ENCOUNTER_K{n}' } } };
    const src = `角色: 12\n时机 初见：\n    询问：\n        「甲」 1：\n            「a」\n        「乙」 1：\n            「b」\n`;
    expect(codes(src, noAsk)).toContain('face-table-missing');
    expect(t(src, noAsk).erb).not.toContain('CALL ASK_M');
  });

  it('条目缺冒号 → indent-mismatch', () => {
    const src = wrap('    询问：\n        「甲」 1\n            「a」\n        「乙」 1：\n            「b」\n');
    expect(codes(src)).toContain('indent-mismatch');
  });
});

describe('块体经 emitBody（不静默降级）', () => {
  it('条目体内的 `你：` 自机台词照常上色（SETCOLOR 缺省自机色）', () => {
    const src = wrap('    询问：\n        「甲」 1：\n            你：「好呀」\n        「乙」 1：\n            「b」\n');
    const out = t(src).erb;
    expect(out).toContain('SETCOLOR 0x4682B4');
    expect(out).toContain('PRINTFORMW 「好呀」');
  });

  it('产物能站在「函数 …：」块体内', () => {
    const src =
      '角色: 12\n函数 打个招呼()：\n    询问 "要不要一起修炼？"：\n        「好呀」 1：\n            「嗯！」\n        「下次吧」 0：\n            「…算了。」\n';
    const out = t(src).erb;
    expect(out).toContain('CALL ASK_M("好呀",1,"下次吧",0)');
    expect(out).toContain('SELECTCASE RESULT');
  });
});

describe('回归自证：既有可选块一个字都不动', () => {
  it('`选项：` 仍产 PRINTBUTTON + INPUTS + RESULTS，不含问答形构件', () => {
    const src = wrap('    选项：\n        「A」：\n            「a」\n        「B」：\n            「b」\n');
    const out = t(src).erb;
    expect(out).toContain('PRINTBUTTON "A", "1"');
    expect(out).toContain('SELECTCASE RESULTS');
    expect(out).not.toContain('CALL ASK_M');
    expect(out).not.toContain('CALL ASK_YN');
  });
});
