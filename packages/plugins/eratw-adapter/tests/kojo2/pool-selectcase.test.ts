/**
 * eraTW `# 池` 等值分派落点测试（K2-POOL-SELECTCASE / §7.1 / §16.2 C2.6）。
 *
 * 纯函数口径：core 的 `planPoolDispatch`（真实 parser 产出）→ `emitPoolDispatch` →
 * 产物行 / `EmitFailure`。
 *
 * 覆盖：逐字节 golden（`CASE` / `CASE ELSE` / 档内缩进 / 空行）、档位顺序、正文不丢、
 * 关键字数据派生（不在 emitter 里写死）、计划不自洽一律 fail-closed（零字节），
 * 以及"core 主链 + 本落点"的全链 golden（证明两半的契约真的对得上）。
 *
 * 数据派生：块关键字直接对 `ERATW_POOL_DISPATCH` 读数，不在测试里抄第二份。
 */
import { describe, expect, it } from 'vitest';
import type { EmitFailure, EmitResult, KojoEmitBackend } from '@kojo/kojo-core';
import { compileKojoSource, isEmitFailure, parseSource } from '@kojo/kojo-core';

import type { KojoPoolDecl } from '../../../../kojo-core/src/ast.js';
import { planPoolDispatch } from '../../../../kojo-core/src/lower/expand/pool-plan.js';
import type { PoolDispatchPlan } from '../../../../kojo-core/src/lower/expand/pool-plan.js';

import { createEratwEmitBackend } from '../../src/kojo2/backend.js';
import {
  ERATW_GAME_ADAPTER,
  ERATW_POOL_DISPATCH,
  emitPoolDispatch,
} from '../../src/kojo2/index.js';
import type {
  EratwPoolDispatchEmitInput,
  PoolDispatchPlanFact,
} from '../../src/kojo2/index.js';

/* ============================== 夹具 ============================== */

const spanAt = (line: number) => ({
  start: { line, column: 1 },
  end: { line, column: 9 },
});

const SPAN = spanAt(1);
const SUBJECT_SLOT = '__kojo_pool_等级问候';

const SOURCE = [
  '# 机 初见',
  '# 视角 灵梦',
  '# 池 等级问候',
  '    ? 好感 == 0',
  '        > 嗯。',
  '    ? 好感 == 1',
  '        > 早上好。',
  '    ? 好感 == 2',
  '        > 亲爱的，早安。',
  '    ? 否',
  '        > ……？',
  '',
].join('\n');

function poolOf(source: string): KojoPoolDecl {
  const file = parseSource(source);
  for (const decl of file.decls) if (decl.kind === 'pool') return decl;
  throw new Error('fixture 里没有 `# 池` 声明');
}

const REAL_PLAN: PoolDispatchPlan = planPoolDispatch(poolOf(SOURCE));

/** core 交来的已降糖分支行（eraTW backend 的真实产物形状） */
const CASE_LINES = [['PRINTFORMW 嗯。'], ['PRINTFORMW 早上好。'], ['PRINTFORMW 亲爱的，早安。']];
const ELSE_LINES = ['PRINTFORMW ……？'];

/** 手工构造的结构事实（反例/不自洽计划用：绕过 core 的 fail-closed 闸） */
function fact(overrides: Partial<PoolDispatchPlanFact> = {}): PoolDispatchPlanFact {
  return {
    style: 'selectcase',
    cases: [
      { value: 0, branchIndex: 0, span: spanAt(4) },
      { value: 1, branchIndex: 1, span: spanAt(6) },
    ],
    hasDefault: true,
    subject: { text: '好感', span: spanAt(1) },
    reason: 'fixture',
    span: SPAN,
    ...overrides,
  };
}

function input(overrides: Partial<EratwPoolDispatchEmitInput> = {}): EratwPoolDispatchEmitInput {
  return {
    plan: REAL_PLAN,
    subjectSlot: SUBJECT_SLOT,
    caseLines: CASE_LINES,
    elseLines: ELSE_LINES,
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

const codesOf = (failure: EmitFailure): readonly string[] => failure.diagnostics.map((diagnostic) => diagnostic.code);

/* ============================== 1. 逐字节 golden ============================== */

describe('eraTW 池等值分派：逐字节 golden', () => {
  it('3 档 + CASE ELSE：块头 / 档头 / 档内缩进 / 块尾逐字节', () => {
    expect(linesOf(emitPoolDispatch(input()))).toEqual([
      'SELECTCASE __kojo_pool_等级问候',
      '    CASE 0',
      '        PRINTFORMW 嗯。',
      '    CASE 1',
      '        PRINTFORMW 早上好。',
      '    CASE 2',
      '        PRINTFORMW 亲爱的，早安。',
      '    CASE ELSE',
      '        PRINTFORMW ……？',
      'ENDSELECT',
    ]);
  });

  it('档位顺序 = 计划顺序（10 / 0 / 5 不排序）', () => {
    const lines = linesOf(
      emitPoolDispatch(
        input({
          plan: fact({
            cases: [
              { value: 10, branchIndex: 0, span: spanAt(4) },
              { value: 0, branchIndex: 1, span: spanAt(6) },
              { value: 5, branchIndex: 2, span: spanAt(8) },
            ],
          }),
          caseLines: [['PRINTFORMW 十'], ['PRINTFORMW 零'], ['PRINTFORMW 五']],
        }),
      ),
    );
    expect(lines.filter((line) => line.startsWith('    CASE ') || line.startsWith('    CASE ELSE'))).toEqual([
      '    CASE 10',
      '    CASE 0',
      '    CASE 5',
      '    CASE ELSE',
    ]);
  });

  it('多行档内正文逐行缩进；空行保持空行（不加尾随空白）', () => {
    const lines = linesOf(
      emitPoolDispatch(
        input({
          plan: fact({
            cases: [
              { value: 0, branchIndex: 0, span: spanAt(4) },
              { value: 1, branchIndex: 1, span: spanAt(6) },
            ],
          }),
          caseLines: [
            ['PRINTFORMW 甲', '', 'PRINTFORMW 乙'],
            ['PRINTFORMW 丙'],
          ],
          elseLines: ['PRINTFORMW 兜底'],
        }),
      ),
    );
    expect(lines).toEqual([
      'SELECTCASE __kojo_pool_等级问候',
      '    CASE 0',
      '        PRINTFORMW 甲',
      '',
      '        PRINTFORMW 乙',
      '    CASE 1',
      '        PRINTFORMW 丙',
      '    CASE ELSE',
      '        PRINTFORMW 兜底',
      'ENDSELECT',
    ]);
  });
});

/* ============================== 2. 真实计划（core 判定 → 本落点） ============================== */

describe('eraTW 池等值分派：core 真实计划', () => {
  it('core `planPoolDispatch` 的正例计划可直接落块（结构兼容）', () => {
    expect(REAL_PLAN.style).toBe('selectcase');
    const lines = linesOf(emitPoolDispatch(input()));
    expect(lines[0]).toBe(`SELECTCASE ${SUBJECT_SLOT}`);
    expect(lines).toHaveLength(1 + REAL_PLAN.cases.length * 2 + 3);
  });

  it('不可证（区间比较）的真实计划：style=if-chain → fail-closed，不硬转', () => {
    const plan = planPoolDispatch(
      parserPool([...SOURCE.split('\n').slice(0, 2), '# 池 等级问候', '    ? 好感 < 0', '        > 甲', '    ? 好感 < 1', '        > 乙', '    ? 否', '        > 丙', '']),
    );
    expect(plan.style).toBe('if-chain');
    const failure = failureOf(emitPoolDispatch(input({ plan })));
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.message).toContain('selectcase');
    expect(failure.diagnostics[0]?.message).toContain('IF');
  });
});

/** 从行数组解析池（避免在测试里重复拼 `\n`） */
function parserPool(lines: readonly string[]): KojoPoolDecl {
  return poolOf(lines.join('\n'));
}

/* ============================== 3. 数据派生 ============================== */

describe('eraTW 池等值分派：关键字跟着数据走', () => {
  it('覆盖 presentation → 块头/档头/兜底/块尾/缩进全部改数据', () => {
    const lines = linesOf(
      emitPoolDispatch(
        input({
          plan: fact(),
          caseLines: [['BODY 0'], ['BODY 1']],
          elseLines: ['BODY ELSE'],
          presentation: {
            ...ERATW_POOL_DISPATCH,
            selectCase: 'SEL',
            case: 'WHEN',
            caseElse: 'OTHER',
            endSelect: 'FIN',
            indent: '\t',
          },
        }),
      ),
    );
    expect(lines).toEqual([
      'SEL __kojo_pool_等级问候',
      '\tWHEN 0',
      '\t\tBODY 0',
      '\tWHEN 1',
      '\t\tBODY 1',
      '\tOTHER',
      '\t\tBODY ELSE',
      'FIN',
    ]);
  });

  it('eraTW 数据本体：关键字逐字、缺省落点 if、冻结（唯一一份，换引擎只改数据）', () => {
    expect(ERATW_POOL_DISPATCH).toEqual({
      style: 'if',
      selectCase: 'SELECTCASE',
      case: 'CASE',
      caseElse: 'CASE ELSE',
      endSelect: 'ENDSELECT',
      indent: '    ',
    });
    expect(Object.isFrozen(ERATW_POOL_DISPATCH)).toBe(true);
  });

  it('未声明落点数据（presentation=null）/ 关键字为空 → fail-closed', () => {
    expect(codesOf(failureOf(emitPoolDispatch(input({ presentation: null }))))).toEqual(['unit/backend-incomplete']);
    expect(
      codesOf(
        failureOf(
          emitPoolDispatch(input({ presentation: { ...ERATW_POOL_DISPATCH, endSelect: '' } })),
        ),
      ),
    ).toEqual(['unit/backend-incomplete']);
  });
});

/* ============================== 4. fail-closed（零字节） ============================== */

describe('eraTW 池等值分派：计划不自洽一律 fail-closed', () => {
  it('计划 style=if-chain / error → fail-closed，不硬转', () => {
    for (const style of ['if-chain', 'error'] as const) {
      const failure = failureOf(emitPoolDispatch(input({ plan: fact({ style }) })));
      expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
      expect(failure.diagnostics[0]?.message).toContain('selectcase');
    }
  });

  it('缺主语 / 主语为空 → fail-closed（不生成无主分派）', () => {
    expect(codesOf(failureOf(emitPoolDispatch(input({ plan: fact({ subject: null }) }))))).toEqual([
      'unit/backend-incomplete',
    ]);
    expect(
      codesOf(failureOf(emitPoolDispatch(input({ plan: fact({ subject: { text: '  ', span: SPAN } }) })))),
    ).toEqual(['unit/backend-incomplete']);
  });

  it('主语槽为空 / 含空白 → fail-closed', () => {
    expect(codesOf(failureOf(emitPoolDispatch(input({ subjectSlot: '   ' }))))).toEqual(['unit/backend-incomplete']);
    expect(codesOf(failureOf(emitPoolDispatch(input({ subjectSlot: '__kojo pool' }))))).toEqual([
      'unit/backend-incomplete',
    ]);
  });

  it('没有 `? 否`（hasDefault=false）→ fail-closed（池兜底必填）', () => {
    const failure = failureOf(emitPoolDispatch(input({ plan: fact({ hasDefault: false }) })));
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.message).toContain('? 否');
  });

  it('`? 否` 正文为空 → fail-closed（不生成空兜底档）', () => {
    const failure = failureOf(emitPoolDispatch(input({ elseLines: [] })));
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.message).toContain('? 否');
  });

  it('档数与正文组数错位 → fail-closed', () => {
    const failure = failureOf(emitPoolDispatch(input({ caseLines: [['PRINTFORMW 只有一组']] })));
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.message).toContain('一一对应');
  });

  it('某档正文为空 → fail-closed（不生成空档）', () => {
    const failure = failureOf(
      emitPoolDispatch(
        input({
          plan: fact({
            cases: [
              { value: 0, branchIndex: 0, span: spanAt(4) },
              { value: 1, branchIndex: 1, span: spanAt(6) },
            ],
          }),
          caseLines: [['PRINTFORMW 甲'], []],
        }),
      ),
    );
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.message).toContain('正文为空');
  });

  it('等值键重复 → fail-closed，诊断指向后一档', () => {
    const failure = failureOf(
      emitPoolDispatch(
        input({
          plan: fact({
            cases: [
              { value: 0, branchIndex: 0, span: spanAt(4) },
              { value: 0, branchIndex: 1, span: spanAt(6) },
            ],
          }),
          caseLines: [['PRINTFORMW 甲'], ['PRINTFORMW 乙']],
        }),
      ),
    );
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.span?.start.line).toBe(6);
    expect(failure.diagnostics[0]?.message).toContain('重复');
  });

  it('等值键不是安全整数 → fail-closed', () => {
    const huge = Number.MAX_SAFE_INTEGER + 2;
    const failure = failureOf(
      emitPoolDispatch(
        input({
          plan: fact({
            cases: [
              { value: 0, branchIndex: 0, span: spanAt(4) },
              { value: huge, branchIndex: 1, span: spanAt(6) },
            ],
          }),
          caseLines: [['PRINTFORMW 甲'], ['PRINTFORMW 乙']],
        }),
      ),
    );
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
    expect(failure.diagnostics[0]?.message).toContain('安全整数');
  });

  it('档数 < 2 → fail-closed（不生成单档分派）', () => {
    const failure = failureOf(
      emitPoolDispatch(
        input({ plan: fact({ cases: [{ value: 0, branchIndex: 0, span: spanAt(4) }] }), caseLines: [['PRINTFORMW 甲']] }),
      ),
    );
    expect(codesOf(failure)).toEqual(['unit/backend-incomplete']);
  });

  it('失败诊断带计划块头 span（可点回源行）', () => {
    const failure = failureOf(emitPoolDispatch(input({ presentation: null })));
    expect(failure.diagnostics[0]?.span?.start.line).toBe(REAL_PLAN.span.start.line);
    expect(failure.diagnostics[0]?.severity).toBe('error');
  });
});

/* ============================== 5. 全链（core 主链 + 本落点） ============================== */

describe('eraTW 池等值分派：core 主链 → adapter 落点（全链 golden）', () => {
  const CALL_SOURCE = `${SOURCE}! 等级问候\n`;

  /** 正式接线后的真 backend（`kojo2/backend.ts` 已把 `presentation.poolDispatch` 转到本落点） */
  const wiredBackend = (): KojoEmitBackend =>
    createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo: '12' });

  /** 摘掉能力的夹层（= 老 adapter；用于钉"没有能力时产物逐字节不变"） */
  function withoutPoolDispatch(): KojoEmitBackend {
    const base = wiredBackend();
    return { ...base, presentation: { ...base.presentation, poolDispatch: undefined } };
  }

  it('可证等值 + 能力接上 → 主语求值一次 + 分派块（不再有 IF/ELSEIF 链）', () => {
    const result = compileKojoSource({ source: CALL_SOURCE, adapter: ERATW_GAME_ADAPTER, backend: wiredBackend() });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);

    const lines = result.erb.slice(0, -1).split('\n');
    expect(lines.slice(0, 6)).toEqual([
      ';kojo2: # 机 初见',
      '@M_KOJO_ENCOUNTER_K12',
      'CALL M_KOJO_ENCOUNTER_K12_1',
      'RETURN RESULT',
      '',
      '@M_KOJO_ENCOUNTER_K12_1',
    ]);
    expect(lines).toContain('#DIM __kojo_pool_等级问候');
    expect(lines).toContain('    __kojo_pool_等级问候 = 好感');
    expect(lines).toContain('    SELECTCASE __kojo_pool_等级问候');
    expect(lines).toContain('        CASE 0');
    expect(lines).toContain('            PRINTFORMW 嗯。');
    expect(lines).toContain('        CASE ELSE');
    expect(lines).toContain('            PRINTFORMW ……？');
    expect(lines).toContain('    ENDSELECT');
    expect(lines.some((line) => line.includes('IF 好感'))).toBe(false);
    expect(lines.some((line) => line.includes('ELSEIF'))).toBe(false);
  });

  it('没有接能力 → 既有等值 IF 链逐字节（golden 零变化）', () => {
    const backend = withoutPoolDispatch();
    const result = compileKojoSource({ source: CALL_SOURCE, adapter: ERATW_GAME_ADAPTER, backend });
    expect(result.ok).toBe(true);
    const lines = result.erb.slice(0, -1).split('\n');
    expect(lines).toContain('    IF 好感 == 0');
    expect(lines).toContain('    ELSEIF 好感 == 1');
    expect(lines).toContain('    ELSEIF 好感 == 2');
    expect(lines).toContain('    ELSE');
    expect(lines).toContain('    ENDIF');
    expect(lines.some((line) => line.includes('SELECTCASE'))).toBe(false);
    expect(lines.some((line) => line.includes('__kojo_pool_'))).toBe(false);
  });
});
