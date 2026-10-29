/**
 * eraTW `# 对照表` 等值分派落点测试（K2-TABLE-SELECTCASE / §6.3 / §16.2 C2.5）。
 *
 * 纯函数口径：core 的结构计划（含真实 `validateTable` + `planTableDispatch` 产出）→
 * `emitTableDispatch` → 产物行 / `EmitFailure`。
 *
 * 覆盖：逐字节 golden（`CASE ELSE` / 档内缩进 / 空 `否` / 无 `否`）、档位顺序与多行正文、
 * 关键字数据派生（不在 emitter 里写死）、计划不自洽一律 fail-closed（零字节），
 * 以及"core 主链 + 本落点"的全链 golden（证明两半的契约真的对得上）。
 */
import { describe, expect, it } from 'vitest';
import type { EmitFailure, EmitResult, KojoSpan } from '@kojo/kojo-core';
import { compileKojoSource, isEmitFailure } from '@kojo/kojo-core';

import { createEratwEmitBackend } from '../../src/kojo2/backend.js';
import {
  ERATW_GAME_ADAPTER,
  ERATW_TABLE_DISPATCH,
  emitTableDispatch,
} from '../../src/kojo2/index.js';
import type {
  EratwTableEmitInput,
  TableDispatchCaseFact,
  TableDispatchPlanFact,
} from '../../src/kojo2/index.js';

/* ============================== 夹具 ============================== */

const spanAt = (line: number): KojoSpan => ({
  start: { line, column: 1 },
  end: { line, column: 8 },
});

const SPAN = spanAt(1);

const casesOf = (...values: readonly number[]): TableDispatchCaseFact[] =>
  values.map((value, index) => ({ value, span: spanAt(index + 3) }));

function selectcasePlan(values: readonly number[], hasDefault = true): TableDispatchPlanFact {
  return { style: 'selectcase', cases: casesOf(...values), hasDefault, span: SPAN };
}

const SUBJECT = '__kojo_table_心情';
const VALUE = '__kojo_table_心情__value';

/** core 交来的已降糖臂行（eraTW backend 的 assign 形状） */
const ASSIGN = (value: string): readonly string[] => [`${VALUE} = ${value}`];

const THREE_ARMS = {
  armLines: [ASSIGN('"疏远"'), ASSIGN('"平常"'), ASSIGN('"亲近"')],
  elseLines: ASSIGN('"未知"'),
};

function input(overrides: Partial<EratwTableEmitInput> = {}): EratwTableEmitInput {
  return {
    plan: selectcasePlan([0, 5, 10]),
    subjectSlot: SUBJECT,
    valueSlot: VALUE,
    armLines: THREE_ARMS.armLines,
    elseLines: THREE_ARMS.elseLines,
    ...overrides,
  };
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

const codesOf = (failure: EmitFailure): readonly string[] =>
  failure.diagnostics.map((diagnostic) => diagnostic.code);

/* ============================== 1. 逐字节 golden ============================== */

describe('eraTW 表等值分派：逐字节 golden', () => {
  it('3 档 + CASE ELSE：块头 / 档头 / 档内缩进 / 块尾逐字节', () => {
    expect(linesOf(emitTableDispatch(input()))).toEqual([
      'SELECTCASE __kojo_table_心情',
      '    CASE 0',
      '        __kojo_table_心情__value = "疏远"',
      '    CASE 5',
      '        __kojo_table_心情__value = "平常"',
      '    CASE 10',
      '        __kojo_table_心情__value = "亲近"',
      '    CASE ELSE',
      '        __kojo_table_心情__value = "未知"',
      'ENDSELECT',
    ]);
  });

  it('空 `否`（有兜底臂但没有正文）：CASE ELSE 留档、不产多余行', () => {
    expect(linesOf(emitTableDispatch(input({ elseLines: [] })))).toEqual([
      'SELECTCASE __kojo_table_心情',
      '    CASE 0',
      '        __kojo_table_心情__value = "疏远"',
      '    CASE 5',
      '        __kojo_table_心情__value = "平常"',
      '    CASE 10',
      '        __kojo_table_心情__value = "亲近"',
      '    CASE ELSE',
      'ENDSELECT',
    ]);
  });

  it('没有 `否`：eraTW 数据 missingDefault=omit → 不写 CASE ELSE', () => {
    expect(ERATW_TABLE_DISPATCH.missingDefault).toBe('omit');
    const lines = linesOf(emitTableDispatch(input({ plan: selectcasePlan([0, 5, 10], false), elseLines: [] })));
    expect(lines.some((line) => line.trim() === 'CASE ELSE')).toBe(false);
    expect(lines[lines.length - 1]).toBe('ENDSELECT');
    expect(lines).toHaveLength(1 + 3 * 2 + 1);
  });

  it('数据 missingDefault=empty → 没有 `否` 也留一个空兜底档（按数据能力定）', () => {
    const lines = linesOf(
      emitTableDispatch(
        input({
          plan: selectcasePlan([0, 5, 10], false),
          elseLines: [],
          presentation: { ...ERATW_TABLE_DISPATCH, missingDefault: 'empty' },
        }),
      ),
    );
    expect(lines[lines.length - 2]).toBe('    CASE ELSE');
    expect(lines[lines.length - 1]).toBe('ENDSELECT');
    expect(lines.filter((line) => line.trim() === 'CASE ELSE')).toHaveLength(1);
  });

  it('档位顺序 = 计划顺序（3 / 1 / 2 不排序）', () => {
    const lines = linesOf(
      emitTableDispatch(
        input({
          plan: selectcasePlan([3, 1, 2]),
          armLines: [ASSIGN('"三"'), ASSIGN('"一"'), ASSIGN('"二"')],
          elseLines: ASSIGN('"否"'),
        }),
      ),
    );
    expect(lines.filter((line) => line.trimStart().startsWith('CASE '))).toEqual([
      '    CASE 3',
      '    CASE 1',
      '    CASE 2',
      '    CASE ELSE',
    ]);
  });

  it('多行档内正文逐行缩进；空行保持空行（不加尾随空白）', () => {
    const lines = linesOf(
      emitTableDispatch(
        input({
          armLines: [[`${VALUE} = "甲"`, '', 'SECOND']],
          plan: selectcasePlan([0]),
          elseLines: [],
        }),
      ),
    );
    expect(lines).toEqual([
      'SELECTCASE __kojo_table_心情',
      '    CASE 0',
      '        __kojo_table_心情__value = "甲"',
      '',
      '        SECOND',
      '    CASE ELSE',
      'ENDSELECT',
    ]);
  });
});

/* ============================== 2. 数据派生 ============================== */

describe('eraTW 表等值分派：关键字跟着数据走', () => {
  it('覆盖 presentation → 块头/档头/兜底/块尾/缩进全部改数据', () => {
    const lines = linesOf(
      emitTableDispatch(
        input({
          presentation: {
            selectCase: 'SEL',
            case: 'WHEN',
            caseElse: 'OTHER',
            endSelect: 'FIN',
            indent: '\t',
            missingDefault: 'omit',
          },
        }),
      ),
    );
    expect(lines).toEqual([
      'SEL __kojo_table_心情',
      '\tWHEN 0',
      '\t\t__kojo_table_心情__value = "疏远"',
      '\tWHEN 5',
      '\t\t__kojo_table_心情__value = "平常"',
      '\tWHEN 10',
      '\t\t__kojo_table_心情__value = "亲近"',
      '\tOTHER',
      '\t\t__kojo_table_心情__value = "未知"',
      'FIN',
    ]);
  });

  it('eraTW 数据本体：关键字逐字（唯一一份，换引擎只改数据文件）', () => {
    expect(ERATW_TABLE_DISPATCH).toEqual({
      selectCase: 'SELECTCASE',
      case: 'CASE',
      caseElse: 'CASE ELSE',
      endSelect: 'ENDSELECT',
      indent: '    ',
      missingDefault: 'omit',
    });
    expect(Object.isFrozen(ERATW_TABLE_DISPATCH)).toBe(true);
  });
});

/* ============================== 3. fail-closed（零字节） ============================== */

describe('eraTW 表等值分派：计划不自洽一律 fail-closed', () => {
  it('未声明落点数据（presentation=null）→ unit/backend-incomplete，零行', () => {
    const failure = failureOf(emitTableDispatch(input({ presentation: null })));
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.message).toContain('等值分派落点');
    expect(failure.diagnostics[0]?.severity).toBe('error');
  });

  it('计划 style=if-chain（core 说不可证）→ fail-closed，不硬转', () => {
    const failure = failureOf(
      emitTableDispatch(input({ plan: { ...selectcasePlan([0, 5, 10]), style: 'if-chain' } })),
    );
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.message).toContain('selectcase');
  });

  it('等值臂与正文组数错位 → fail-closed', () => {
    const failure = failureOf(emitTableDispatch(input({ armLines: [ASSIGN('"疏远"')] })));
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.message).toContain('一一对应');
  });

  it('等值键重复 → fail-closed，诊断指向后一档', () => {
    const failure = failureOf(
      emitTableDispatch(input({ plan: selectcasePlan([0, 5, 5]), armLines: [ASSIGN('"甲"'), ASSIGN('"乙"'), ASSIGN('"丙"')] })),
    );
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.span?.start.line).toBe(5);
    expect(failure.diagnostics[0]?.message).toContain('重复');
  });

  it('等值键不是安全整数 → fail-closed', () => {
    const huge = Number.MAX_SAFE_INTEGER + 2;
    const failure = failureOf(
      emitTableDispatch(
        input({
          plan: selectcasePlan([0, huge, 7]),
          armLines: [ASSIGN('"甲"'), ASSIGN('"乙"'), ASSIGN('"丙"')],
        }),
      ),
    );
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.message).toContain('安全整数');
  });

  it('缺判别槽 / 缺值槽 / 空臂 → fail-closed（不生成无主分派）', () => {
    expect(codesOf(failureOf(emitTableDispatch(input({ subjectSlot: '  ' }))))).toEqual(['unit/backend-incomplete']);
    expect(codesOf(failureOf(emitTableDispatch(input({ valueSlot: '' }))))).toEqual(['unit/backend-incomplete']);
    expect(
      codesOf(
        failureOf(
          emitTableDispatch(input({ plan: selectcasePlan([]), armLines: [], elseLines: [] })),
        ),
      ),
    ).toEqual(['unit/backend-incomplete']);
  });

  it('计划说没有 `否`，却给了兜底正文 → fail-closed（不生成来源不明的兜底档）', () => {
    const failure = failureOf(
      emitTableDispatch(input({ plan: selectcasePlan([0, 5, 10], false), elseLines: ASSIGN('"未知"') })),
    );
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.message).toContain('兜底');
  });
});

/* ============================== 4. 全链：core 主链 + 本落点 ============================== */

describe('eraTW 表等值分派：core 主链 → adapter 落点（全链 golden）', () => {
  const SOURCE = [
    '# 机 初见',
    '# 对照表 心情 依据 恋慕',
    '    0 -> 疏远',
    '    5 -> 平常',
    '    10 -> 亲近',
    '    否 -> 未知',
    '> 她今天看起来{心情}。',
    '',
  ].join('\n');

  /** 正式接线后的真 backend（`kojo2/backend.ts` 已把 `program.tableDispatch` 转到本落点） */
  const wiredBackend = () =>
    createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo: '12' });

  /** 摘掉能力的夹层（= 老 adapter；用于钉"没有能力时产物逐字节不变"） */
  function withoutTableDispatch() {
    const base = wiredBackend();
    return { ...base, program: { ...base.program, tableDispatch: undefined } };
  }

  it('可证等值 + 能力接上 → 产物只有分派块（不再有等值 IF/ELSEIF 链）', () => {
    const result = compileKojoSource({ source: SOURCE, adapter: ERATW_GAME_ADAPTER, backend: wiredBackend() });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);

    const lines = result.erb.slice(0, -1).split('\n');
    const start = lines.findIndex((line) => line.includes('SELECTCASE'));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(lines.slice(start, start + 10)).toEqual([
      '    SELECTCASE __kojo_table_心情',
      '        CASE 0',
      '            __kojo_table_心情__value = "疏远"',
      '        CASE 5',
      '            __kojo_table_心情__value = "平常"',
      '        CASE 10',
      '            __kojo_table_心情__value = "亲近"',
      '        CASE ELSE',
      '            __kojo_table_心情__value = "未知"',
      '    ENDSELECT',
    ]);
    // 判别式仍只求值一次，且在任何分派之前
    const subjectAt = lines.findIndex((line) => line.trim() === '__kojo_table_心情 = 恋慕');
    expect(subjectAt).toBeGreaterThanOrEqual(0);
    expect(subjectAt).toBeLessThan(start);
    expect(lines.some((line) => line.includes('IF __kojo_table_心情'))).toBe(false);
    expect(lines.some((line) => line.includes('ELSEIF'))).toBe(false);
  });

  it('没有接能力 → 既有等值 IF 链逐字节（golden 零变化）', () => {
    const backend = withoutTableDispatch();
    const result = compileKojoSource({ source: SOURCE, adapter: ERATW_GAME_ADAPTER, backend });
    expect(result.ok).toBe(true);
    const lines = result.erb.slice(0, -1).split('\n');
    expect(lines).toContain('    IF __kojo_table_心情 == 0');
    expect(lines).toContain('    ELSEIF __kojo_table_心情 == 5');
    expect(lines).toContain('    ELSEIF __kojo_table_心情 == 10');
    expect(lines).toContain('    ENDIF');
    expect(lines.some((line) => line.includes('SELECTCASE'))).toBe(false);
  });
});
