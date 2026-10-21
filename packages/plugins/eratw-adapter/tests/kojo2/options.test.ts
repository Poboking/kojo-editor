/**
 * eraTW `选项` 落点测试（E4.3 / K2-OPTIONS）。
 *
 * 纯函数口径：core 的 ETB 计划（真实 parser 产出）→ `emitOptions` → 产物行 / `EmitFailure`。
 * 覆盖：按钮顺序与数量、`INPUTS` + `SELECTCASE RESULTS` 骨架、每档正文不丢（正文由 core
 * 2.0 叙事 lower + eraTW text 发射器真实降糖）、标签字面量转义、未声明/数据不一致 fail-closed。
 *
 * 数据派生：按钮/输入指令断言直接对 `ERATW_PRESENTATION.options` 读数，不在测试里抄第二份。
 */
import { describe, expect, it } from 'vitest';
import type { EmitFailure, EmitResult, GameAdapter, KojoOptionItem, KojoOptionsBlock, KojoSpan } from '@kojo/kojo-core';
import { compileKojoSource, isEmitFailure, lowerNarrative, parseSource, planOptionsBlock } from '@kojo/kojo-core';

import { createEratwEmitBackend } from '../../src/kojo2/backend.js';
import { ERATW_GAME_ADAPTER, emitOptions, type OptionsPlanFact } from '../../src/kojo2/index.js';
import { ERATW_PRESENTATION } from '../../src/kojo2/presentation.js';

/* ============================== 夹具 ============================== */

const MACHINE = '# 机 开场\n';

/** 只做原样透传的表达式端口（本测试的正文只用纯文本，不依赖表达式编译） */
const BACKEND = createEratwEmitBackend({ compileExpression: (expr) => expr.text });

/** 产物数据（非空断言只在测试夹具里用；adapter 模块装载保证 eraTW 四项全声明） */
const OPTIONS = ERATW_PRESENTATION.options;
if (OPTIONS === null) throw new Error('eraTW presentation 必须声明选项 UI');

function optionsNode(source: string): KojoOptionsBlock {
  const file = parseSource(source);
  for (const scene of file.scenes) {
    for (const node of scene.items) {
      if (node.kind === 'optionsBlock') return node;
    }
  }
  throw new Error('fixture 里没有 `选项` 块');
}

/** 真实 2.0 叙事 lower（eraTW text 发射器）→ 每档正文行 */
function lowerItemBody(item: KojoOptionItem): readonly string[] {
  return lowerNarrative(item.body, { backend: BACKEND }).lines;
}

function linesOf(result: EmitResult): readonly string[] {
  if (isEmitFailure(result)) throw new Error(`expected lines, got failure: ${failureOf(result).diagnostics[0]?.message ?? ''}`);
  if (typeof result === 'string') return [result];
  if (result === null) throw new Error('expected lines, got null');
  return result;
}

function failureOf(result: EmitResult): EmitFailure {
  if (!isEmitFailure(result)) throw new Error(`expected EmitFailure, got ${JSON.stringify(result)}`);
  return result;
}

const TWO_BUTTONS = [
  MACHINE,
  '选项：',
  '    「用亲吻代替回答」：',
  '        灵梦：「……唔。」',
  '    「摸摸头」：',
  '        灵梦：「……好。」',
  '',
].join('\n');

const THREE_BUTTONS = [
  MACHINE,
  '选项：',
  '    「一」：',
  '        > 一。',
  '    「二」：',
  '        > 二。',
  '    「三」：',
  '        > 三。',
  '',
].join('\n');

/* ============================== 1. golden ============================== */

describe('eraTW 选项落点：按钮 + INPUTS + SELECTCASE 骨架', () => {
  it('两个按钮逐字节 golden（正文由 2.0 叙事 lower 真实降糖，不丢块体）', () => {
    const plan = planOptionsBlock(optionsNode(TWO_BUTTONS));
    const lines = linesOf(emitOptions({ plan, lowerItem: (item) => lowerItemBody(item) }));

    expect(lines).toEqual([
      `${OPTIONS.button} "用亲吻代替回答", "1"`,
      `${OPTIONS.button} "摸摸头", "2"`,
      OPTIONS.input,
      'SELECTCASE RESULTS',
      '    CASE "1"',
      '        PRINTFORMW ……唔。',
      '    CASE "2"',
      '        PRINTFORMW ……好。',
      'ENDSELECT',
    ]);
  });

  it('按钮数 = 书写条目数；编号与 CASE 档位一一对应', () => {
    const plan = planOptionsBlock(optionsNode(THREE_BUTTONS));
    const lines = linesOf(emitOptions({ plan, lowerItem: (item) => [`BODY ${item.label}`] }));

    expect(lines.filter((line) => line.startsWith(`${OPTIONS.button} `))).toHaveLength(3);
    expect(lines.filter((line) => line.trimStart().startsWith('CASE '))).toHaveLength(3);
    expect(lines.slice(0, 3)).toEqual([
      `${OPTIONS.button} "一", "1"`,
      `${OPTIONS.button} "二", "2"`,
      `${OPTIONS.button} "三", "3"`,
    ]);
    expect(lines.slice(3, 6)).toEqual([OPTIONS.input, 'SELECTCASE RESULTS', '    CASE "1"']);
    expect(lines.slice(-1)).toEqual(['ENDSELECT']);
  });

  it('每档正文落进自己的 CASE（顺序与按钮一致，一行不丢）', () => {
    const plan = planOptionsBlock(optionsNode(TWO_BUTTONS));
    const lines = linesOf(emitOptions({ plan, lowerItem: (item) => lowerItemBody(item) }));

    const case1 = lines.indexOf('    CASE "1"');
    const case2 = lines.indexOf('    CASE "2"');
    const body1 = lines.indexOf('        PRINTFORMW ……唔。');
    const body2 = lines.indexOf('        PRINTFORMW ……好。');
    expect(case1).toBeGreaterThanOrEqual(0);
    expect(body1).toBeGreaterThan(case1);
    expect(body1).toBeLessThan(case2);
    expect(body2).toBeGreaterThan(case2);
    expect(body2).toBeLessThan(lines.indexOf('ENDSELECT'));
  });

  it('落点数据来自 presentation：按钮/输入指令跟着数据走（不手抄第二份）', () => {
    const plan = planOptionsBlock(optionsNode(TWO_BUTTONS));
    const overridden = { ...OPTIONS, button: 'BTN', input: 'INPUTS' };
    const lines = linesOf(emitOptions({ plan, lowerItem: () => [], presentation: overridden }));
    expect(lines[0]).toBe('BTN "用亲吻代替回答", "1"');
    expect(lines[2]).toBe('INPUTS');
    // 分派键也读数据（不改 emitter 里的字面量）
    expect(lines[3]).toBe(`SELECTCASE ${overridden.result}`);
  });
});

/* ============================== 2. 字面量 ============================== */

describe('eraTW 选项落点：按钮标签走唯一字面量编码器', () => {
  it('标签里的引号被编码成引擎可读字面量（不破行）', () => {
    const plan = planOptionsBlock(optionsNode([MACHINE, '选项：', '    「他说"好"」：', '        > 行。', ''].join('\n')));
    const lines = linesOf(emitOptions({ plan, lowerItem: () => [] }));
    expect(lines[0]).toBe(`${OPTIONS.button} "他说\\"好\\"", "1"`);
  });

  it('标签含 NUL：fail-closed（core/expr/bad-literal），不产半成品', () => {
    const plan = planOptionsBlock(optionsNode(TWO_BUTTONS));
    const broken: OptionsPlanFact = {
      ...plan,
      buttons: [{ ...plan.buttons[0]!, label: '坏\u0000字' }, plan.buttons[1]!],
    };
    const failure = failureOf(emitOptions({ plan: broken, lowerItem: () => [] }));
    expect(failure.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['core/expr/bad-literal']);
  });
});

/* ============================== 3. fail-closed ============================== */

describe('eraTW 选项落点：数据/计划不自洽一律 fail-closed', () => {
  it('adapter 未声明 presentation.options：unit/backend-incomplete，零行', () => {
    const plan = planOptionsBlock(optionsNode(TWO_BUTTONS));
    const failure = failureOf(emitOptions({ plan, lowerItem: () => [], presentation: null }));
    expect(failure.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.message).toContain('presentation.options');
  });

  it('presentation.options.input 不是已知输入指令：不猜回传槽', () => {
    const plan = planOptionsBlock(optionsNode(TWO_BUTTONS));
    const failure = failureOf(
      emitOptions({ plan, lowerItem: () => [], presentation: { ...OPTIONS, input: 'BUTTONS' } }),
    );
    expect(failure.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.message).toContain('BUTTONS');
  });

  it('空计划（没有按钮）→ fail-closed，不生成空的 INPUTS/SELECTCASE', () => {
    const plan = planOptionsBlock(optionsNode(`${MACHINE}选项：\n`));
    const failure = failureOf(emitOptions({ plan, lowerItem: () => [] }));
    expect(failure.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['unit/backend-incomplete']);
  });

  it('按钮数与分支数不一致 → fail-closed', () => {
    const plan = planOptionsBlock(optionsNode(TWO_BUTTONS));
    const mismatched: OptionsPlanFact = { ...plan, branches: [plan.branches[0]!] };
    const failure = failureOf(emitOptions({ plan: mismatched, lowerItem: () => [] }));
    expect(failure.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['unit/backend-incomplete']);
  });

  it('按钮与分支的回传值不对应 → fail-closed（不把正文挂错档）', () => {
    const plan = planOptionsBlock(optionsNode(TWO_BUTTONS));
    const mismatched: OptionsPlanFact = {
      ...plan,
      branches: [{ ...plan.branches[0]!, value: '2' }, plan.branches[1]!],
    };
    const failure = failureOf(emitOptions({ plan: mismatched, lowerItem: () => [] }));
    expect(failure.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['unit/backend-incomplete']);
  });
});

/* ============================== 4. 契约边界 ============================== */

describe('eraTW 选项落点：结构与 span', () => {
  it('失败诊断带计划块头 span（可点回源行）', () => {
    const node = optionsNode(TWO_BUTTONS);
    const plan = planOptionsBlock(node);
    const failure = failureOf(emitOptions({ plan, lowerItem: () => [], presentation: null }));
    const span: KojoSpan | null = failure.diagnostics[0]?.span ?? null;
    expect(span).not.toBeNull();
    expect(span?.start.line).toBe(node.span.start.line);
  });
});

/* ============================== 5. 数据自洽（result additive） ============================== */

describe('eraTW 选项落点：读回槽数据自洽', () => {
  it('result 与输入指令的引擎约定不符 → fail-closed（不写错分派变量）', () => {
    const plan = planOptionsBlock(optionsNode(TWO_BUTTONS));
    const failure = failureOf(
      emitOptions({ plan, lowerItem: () => [], presentation: { ...OPTIONS, result: 'RESULT' } }),
    );
    expect(failure.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['unit/backend-incomplete']);
  });
});

/* ============================== 6. 全链 golden（compileKojoSource） ============================== */

describe('eraTW 选项：`# 机` + 选项块全链 golden', () => {
  const FULL_CHAIN = [
    '# 机 初见',
    '选项：',
    '    「用亲吻代替回答」：',
    '        灵梦：「……唔。」',
    '    「摸摸头」：',
    '        灵梦：「……好。」',
    '',
  ].join('\n');

  function fullChainBackend() {
    return createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo: '12' });
  }

  it('事件头组装 + 按钮/输入/分派骨架 + 正文逐字节（core 主链 → adapter 落点）', () => {
    const result = compileKojoSource({
      source: FULL_CHAIN,
      adapter: ERATW_GAME_ADAPTER,
      backend: fullChainBackend(),
    });

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    // 待定 warning 只一条（parser 报过，lowering 不重复）
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === 'core/options/pending')).toHaveLength(1);

    expect(result.erb).toBe(
      [
        ';kojo2: # 机 初见',
        '@M_KOJO_ENCOUNTER_K12',
        'CALL M_KOJO_ENCOUNTER_K12_1',
        'RETURN RESULT',
        '',
        '@M_KOJO_ENCOUNTER_K12_1',
        ';-------------------------------------------------',
        ';記入チェック（=0, 非表示、1, 表示）',
        'LOCAL = 1',
        ';-------------------------------------------------',
        'IF LOCAL',
        '    PRINTBUTTON "用亲吻代替回答", "1"',
        '    PRINTBUTTON "摸摸头", "2"',
        '    INPUTS',
        '    SELECTCASE RESULTS',
        '        CASE "1"',
        '            PRINTFORMW ……唔。',
        '        CASE "2"',
        '            PRINTFORMW ……好。',
        '    ENDSELECT',
        'ENDIF',
        'RETURN 1',
      ].join('\n') + '\n',
    );
    expect(result.sourceMap.lineCount).toBe(result.erb.slice(0, -1).split('\n').length);
  });

  it('adapter 未声明 options：全链 fail-closed（零字节、零 source map）', () => {
    const bare: GameAdapter = {
      ...ERATW_GAME_ADAPTER,
      presentation: { ...ERATW_GAME_ADAPTER.presentation, options: null },
    };
    const result = compileKojoSource({ source: FULL_CHAIN, adapter: bare, backend: fullChainBackend() });

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.sourceMap.lineCount).toBe(0);
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'core/feature/unsupported' && diagnostic.severity === 'error',
      ),
    ).toBe(true);
  });
});
