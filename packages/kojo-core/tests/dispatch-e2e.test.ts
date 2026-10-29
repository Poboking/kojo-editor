/**
 * `# 对照表` / `# 池` 等值分派 **端到端**（K2-DISPATCH-WIRING / §6.3 / §7.1 / §16.2 C2.5–C2.6）。
 *
 * 与两个"计划单测"（`table-selectcase.test.ts` / `pool-selectcase.test.ts`）的分工：
 * - 那两个钉**判定**（纯数据、能力探测、fixture backend）；
 * - 本文件钉**接线**：真 eraTW backend（`@kojo/plugin-eratw-adapter` 的 `kojo2` 面）
 *   在契约字段 `program.tableDispatch` / `presentation.poolDispatch` 下真的落
 *   `SELECTCASE` 形态，逐字节断言；能力缺失（fixture backend / 摘掉字段）时既有
 *   `IF / ELSEIF / ELSE` 链逐字节不变（零强制）。
 *
 * 还钉三件容易漏的事实：
 * - `? 否` 兜底 = 分派块的 `CASE ELSE`（不是 IF 链的 `ELSE`）；
 * - 重复等值键 = fail-closed（诊断 + **零字节**，不静默"取第一个"）；
 * - 隐藏槽事实（`kind` / `role` / `valueType`）与 source map 行级口径与既有链一致。
 */
import { describe, expect, it } from 'vitest';
import type { KojoEmitBackend, PoolDispatchEmitRequest, TableDispatchEmitRequest } from '../src/index.js';
import { compileKojoSource } from '../src/compile.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';
import type { KojoSpan } from '../src/ast.js';

import {
  ERATW_GAME_ADAPTER,
  createEratwEmitBackend,
  emitPoolDispatch,
  emitTableDispatch,
} from '../../plugins/eratw-adapter/src/kojo2/index.js';

/* ============================== 夹具 ============================== */

const SPAN: KojoSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 8 } };

/** 真 eraTW backend：表达式端口用恒等替身（只钉产物结构，不重复 v1 expression 管线） */
function eratwBackend(): KojoEmitBackend {
  return createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo: '12' });
}

const linesOf = (erb: string): string[] => erb.slice(0, -1).split('\n');

/**
 * 从 `# 机` wrapper 里取出正文行（`IF LOCAL` … wrapper 的最后一个 `ENDIF` 之间），
 * 去掉 wrapper 加的那一层缩进——只对"正文有没有换形态"下断言，不重复钉 wrapper。
 */
function bodyOf(erb: string): string[] {
  const lines = linesOf(erb);
  const start = lines.indexOf('IF LOCAL');
  const end = lines.lastIndexOf('ENDIF');
  if (start < 0 || end <= start) throw new Error('产物里找不到 `IF LOCAL` … `ENDIF` 信封');
  return lines.slice(start + 1, end).map((line) => line.replace(/^ {4}/, ''));
}

const errorCodes = (result: { diagnostics: readonly { code: string; severity: string }[] }): string[] =>
  result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').map((diagnostic) => diagnostic.code);

/** `# 机` 是"有正文"的硬前提（core 的 parser 就拦）：正文夹具按事件名在这里拼头 */
const withMachine = (event: string, body: readonly string[]): string =>
  [`# 机 ${event}`, ...body, ''].join('\n');

/* ---------- 源：`# 对照表` ---------- */

/** 3 档精确整数 + `否`：`table-plan.ts` 判据下的正例（可证等值） */
const TABLE_BODY = [
  '# 对照表 心情 依据 恋慕',
  '    0 -> 疏远',
  '    5 -> 平常',
  '    10 -> 亲近',
  '    否 -> 未知',
  '> 她今天看起来{心情}。',
];
const TABLE_SOURCE = withMachine('初见', TABLE_BODY);

/** 2 档：`TABLE_DISPATCH_MIN_ARMS = 3` 的边界外 → IF 链 */
const TABLE_TWO_ARMS = withMachine('初见', [
  '# 对照表 心情 依据 恋慕',
  '    0 -> 疏远',
  '    5 -> 平常',
  '    否 -> 未知',
  '> 她看起来{心情}。',
]);

/** 闭区间：单条等值档表达不了 → IF 链 */
const TABLE_RANGE = withMachine('初见', [
  '# 对照表 档位 依据 好感度',
  '    0..99 -> 低',
  '    100.. -> 高',
  '    否 -> 未知',
  '> 目前{档位}。',
]);

/** 等值键重复：`validateTable` 的重叠闸先报 → 零字节 */
const TABLE_DUPLICATE = withMachine('初见', [
  '# 对照表 心情 依据 恋慕',
  '    5 -> 甲',
  '    5 -> 乙',
  '    7 -> 丙',
  '    否 -> 丁',
  '> 她看起来{心情}。',
]);

/* ---------- 源：`# 池` ---------- */

/** 3 个整数等值分支 + `? 否`：`pool-plan.ts` 判据下的正例 */
const POOL_BODY = [
  '# 池 等级问候',
  '    ? 好感 == 0',
  '        > ……嗯。',
  '    ? 好感 == 1',
  '        > 早上好。',
  '    ? 好感 == 2',
  '        > 亲爱的，早安。',
  '    ? 否',
  '        > ……？',
  '! 等级问候',
];
const POOL_SOURCE = withMachine('初见', POOL_BODY);

/** 2 分支（含 `否`）：`POOL_DISPATCH_MIN_BRANCHES = 3` 的边界外 → IF 链 */
const POOL_TWO_BRANCHES = withMachine('初见', [
  '# 池 问候',
  '    ? 好感 == 0',
  '        > 嗯。',
  '    ? 否',
  '        > ……？',
  '! 问候',
]);

/** 区间比较：同一主语但非整数等值 → IF 链 */
const POOL_RANGE = withMachine('初见', [
  '# 池 问候',
  '    ? 好感 < 100',
  '        > 嗯。',
  '    ? 好感 < 500',
  '        > 早上好。',
  '    ? 否',
  '        > ……？',
  '! 问候',
]);

/** 缺 `? 否`：池结构（core/pool/no-default）→ 零字节 */
const POOL_NO_DEFAULT = withMachine('初见', [
  '# 池 问候',
  '    ? 好感 == 0',
  '        > 嗯。',
  '    ? 好感 == 1',
  '        > 早上好。',
  '! 问候',
]);

/** 等值键重复：计划不自洽（运行期会静默取第一个）→ 零字节 */
const POOL_DUPLICATE = withMachine('初见', [
  '# 池 问候',
  '    ? 好感 == 0',
  '        > 嗯。',
  '    ? 好感 == 0',
  '        > 早上好。',
  '    ? 否',
  '        > ……？',
  '! 问候',
]);

/* ============================== 1. 契约能力面 ============================== */

describe('eraTW backend 的等值分派能力（契约 optional 方法）', () => {
  it('`program.tableDispatch` 与 `presentation.poolDispatch` 都是函数（正式接线，不是测试内就地接）', () => {
    const backend = eratwBackend();
    expect(typeof backend.program.tableDispatch).toBe('function');
    expect(typeof backend.presentation.poolDispatch).toBe('function');
  });

  it('`program.tableDispatch` 只转调 `emitTableDispatch`（同一请求 → 逐字节同一产物）', () => {
    const backend = eratwBackend();
    const request: TableDispatchEmitRequest = {
      plan: {
        style: 'selectcase',
        cases: [
          { value: 0, rowIndex: 0, span: SPAN },
          { value: 5, rowIndex: 1, span: SPAN },
        ],
        hasDefault: true,
        reason: 'fixture',
        diagnostics: [],
        span: SPAN,
      },
      subjectSlot: '__kojo_table_心情',
      valueSlot: '__kojo_table_心情__value',
      armLines: [['__kojo_table_心情__value = "疏远"'], ['__kojo_table_心情__value = "平常"']],
      elseLines: ['__kojo_table_心情__value = "未知"'],
    };
    const viaBackend = backend.program.tableDispatch?.(request);
    expect(viaBackend).toEqual(emitTableDispatch(request));
  });

  it('`presentation.poolDispatch` 只转调 `emitPoolDispatch`（同一请求 → 逐字节同一产物）', () => {
    const backend = eratwBackend();
    const request: PoolDispatchEmitRequest = {
      plan: {
        style: 'selectcase',
        cases: [
          { value: 0, branchIndex: 0, span: SPAN },
          { value: 1, branchIndex: 1, span: SPAN },
        ],
        hasDefault: true,
        defaultIndex: 2,
        subject: { text: '好感', span: SPAN },
        reason: 'fixture',
        diagnostics: [],
        span: SPAN,
      },
      subjectSlot: '__kojo_pool_等级问候',
      caseLines: [['PRINTFORMW 嗯。'], ['PRINTFORMW 早上好。']],
      elseLines: ['PRINTFORMW ……？'],
    };
    const viaBackend = backend.presentation.poolDispatch?.(request);
    expect(viaBackend).toEqual(emitPoolDispatch(request));
  });
});

/* ============================== 2. 表：真 backend 落 SELECTCASE ============================== */

describe('`# 对照表` 端到端（真 eraTW backend）', () => {
  it('3 档精确整数 + `# 机` → 逐字节 SELECTCASE 产物（wrapper / 槽声明 / 兜底档全对）', () => {
    const result = compileKojoSource({ source: TABLE_SOURCE, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    expect(errorCodes(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.erb).toBe(
      String.raw`;kojo2: # 机 初见
@M_KOJO_ENCOUNTER_K12
CALL M_KOJO_ENCOUNTER_K12_1
RETURN RESULT

@M_KOJO_ENCOUNTER_K12_1
#DIM __kojo_table_心情
#DIMS __kojo_table_心情__value
;-------------------------------------------------
;記入チェック（=0, 非表示、1, 表示）
LOCAL = 1
;-------------------------------------------------
IF LOCAL
    __kojo_table_心情 = 恋慕
    SELECTCASE __kojo_table_心情
        CASE 0
            __kojo_table_心情__value = "疏远"
        CASE 5
            __kojo_table_心情__value = "平常"
        CASE 10
            __kojo_table_心情__value = "亲近"
        CASE ELSE
            __kojo_table_心情__value = "未知"
    ENDSELECT
    PRINTFORMW 她今天看起来%__kojo_table_心情__value%。
ENDIF
RETURN 1
`,
    );
  });

  it('判别式只求值一次，且在分派块之前；不再有等值 IF/ELSEIF', () => {
    const result = compileKojoSource({ source: TABLE_SOURCE, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    const lines = linesOf(result.erb);
    const assignAt = lines.findIndex((line) => line.trim() === '__kojo_table_心情 = 恋慕');
    const selectAt = lines.findIndex((line) => line.includes('SELECTCASE __kojo_table_心情'));
    expect(assignAt).toBeGreaterThanOrEqual(0);
    expect(selectAt).toBe(assignAt + 1);
    expect(lines.filter((line) => line.includes('__kojo_table_心情 = 恋慕'))).toHaveLength(1);
    expect(lines.some((line) => line.includes('IF __kojo_table_心情'))).toBe(false);
    expect(lines.some((line) => line.includes('ELSEIF'))).toBe(false);
  });

  it('2 档（< 3）→ 能力在也走 IF 链（不可证/不划算，不是错误）', () => {
    const result = compileKojoSource({ source: TABLE_TWO_ARMS, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    expect(result.ok).toBe(true);
    expect(bodyOf(result.erb)).toEqual([
      '__kojo_table_心情 = 恋慕',
      'IF __kojo_table_心情 == 0',
      '__kojo_table_心情__value = "疏远"',
      'ELSEIF __kojo_table_心情 == 5',
      '__kojo_table_心情__value = "平常"',
      'ELSE',
      '__kojo_table_心情__value = "未知"',
      'ENDIF',
      'PRINTFORMW 她看起来%__kojo_table_心情__value%。',
    ]);
  });

  it('闭区间档 → 能力在也走 IF 链（`>=`/`<=` 形态不能被单条等值档表达）', () => {
    const result = compileKojoSource({ source: TABLE_RANGE, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    expect(result.ok).toBe(true);
    const body = bodyOf(result.erb);
    expect(body.some((line) => line.includes('SELECTCASE'))).toBe(false);
    expect(body).toContain('IF __kojo_table_档位 >= 0 && __kojo_table_档位 <= 99');
    expect(body).toContain('ELSEIF __kojo_table_档位 >= 100');
  });

  it('等值键重复 → fail-closed：诊断 + 零字节（不静默取第一个）', () => {
    const result = compileKojoSource({ source: TABLE_DUPLICATE, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.sourceMap.lineCount).toBe(0);
    expect(errorCodes(result)).toContain('core/table/overlap');
  });

  it('隐藏槽事实：判别槽 int / 值槽 string，kind=table，role=table-subject/table-value', () => {
    const result = compileKojoSource({ source: TABLE_SOURCE, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    expect(result.slots).toEqual([
      { name: '__kojo_table_心情', kind: 'table', valueType: 'int', role: 'table-subject' },
      { name: '__kojo_table_心情__value', kind: 'table', valueType: 'string', role: 'table-value' },
    ]);
  });
});

/* ============================== 3. 池：真 backend 落 SELECTCASE ============================== */

describe('`# 池` 端到端（真 eraTW backend）', () => {
  it('3 个整数等值分支 + `? 否` → 逐字节 SELECTCASE 产物（主语槽求值一次 + CASE ELSE）', () => {
    const result = compileKojoSource({ source: POOL_SOURCE, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    expect(errorCodes(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.erb).toBe(
      String.raw`;kojo2: # 机 初见
@M_KOJO_ENCOUNTER_K12
CALL M_KOJO_ENCOUNTER_K12_1
RETURN RESULT

@M_KOJO_ENCOUNTER_K12_1
#DIM __kojo_pool_等级问候
;-------------------------------------------------
;記入チェック（=0, 非表示、1, 表示）
LOCAL = 1
;-------------------------------------------------
IF LOCAL
    __kojo_pool_等级问候 = 好感
    SELECTCASE __kojo_pool_等级问候
        CASE 0
            PRINTFORMW ……嗯。
        CASE 1
            PRINTFORMW 早上好。
        CASE 2
            PRINTFORMW 亲爱的，早安。
        CASE ELSE
            PRINTFORMW ……？
    ENDSELECT
ENDIF
RETURN 1
`,
    );
  });

  it('2 分支（< 3）→ IF 链（含 `? 否` 的 ELSE）', () => {
    const result = compileKojoSource({ source: POOL_TWO_BRANCHES, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    expect(result.ok).toBe(true);
    expect(bodyOf(result.erb)).toEqual([
      'IF 好感 == 0',
      'PRINTFORMW 嗯。',
      'ELSE',
      'PRINTFORMW ……？',
      'ENDIF',
    ]);
  });

  it('区间条件（同一主语但非整数等值）→ IF 链，不发主语槽', () => {
    const result = compileKojoSource({ source: POOL_RANGE, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    expect(result.ok).toBe(true);
    const body = bodyOf(result.erb);
    expect(body.some((line) => line.includes('SELECTCASE'))).toBe(false);
    expect(body.some((line) => line.includes('__kojo_pool_'))).toBe(false);
    expect(body[0]).toBe('IF 好感 < 100');
  });

  it('缺 `? 否` → fail-closed：`core/pool/no-default` + 零字节', () => {
    const result = compileKojoSource({ source: POOL_NO_DEFAULT, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(errorCodes(result)).toContain('core/pool/no-default');
  });

  it('等值键重复 → 计划不自洽：诊断 + 零字节（不静默取第一个）', () => {
    const result = compileKojoSource({ source: POOL_DUPLICATE, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('重复出现');
  });

  it('隐藏槽事实：主语槽 int，kind=pool，role=pool-subject（不再借用 template）', () => {
    const result = compileKojoSource({ source: POOL_SOURCE, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    expect(result.slots).toEqual([
      { name: '__kojo_pool_等级问候', kind: 'pool', valueType: 'int', role: 'pool-subject' },
    ]);
  });
});

/* ============================== 4. 能力缺失：零强制 ============================== */

describe('能力缺失（fixture backend）→ 既有 IF 链逐字节不变', () => {
  it('表：fixture 没有 `program.tableDispatch` → 既有等值 IF 链（无 SELECTCASE / 无分派块）', () => {
    const backend: KojoEmitBackend = FIXTURE_BACKEND;
    expect(backend.program.tableDispatch).toBeUndefined();
    const result = compileKojoSource({
      source: withMachine('开场', TABLE_BODY),
      adapter: FIXTURE_ADAPTER,
      backend,
    });
    expect(result.ok).toBe(true);
    const lines = linesOf(result.erb);
    expect(lines).toContain('MACHINE 开场');
    expect(lines).toContain(';SLOT __kojo_table_心情 table int');
    expect(lines).toContain('SET __kojo_table_心情 = {恋慕}');
    expect(lines).toContain('IF {__kojo_table_心情 == 0}');
    expect(lines).toContain('ELSEIF {__kojo_table_心情 == 5}');
    expect(lines).toContain('ELSEIF {__kojo_table_心情 == 10}');
    expect(lines).toContain('ELSE');
    expect(lines).toContain('ENDIF');
    expect(lines.some((line) => line.includes('SELECTCASE'))).toBe(false);
  });

  it('池：fixture 没有 `presentation.poolDispatch` → 既有 IF/ELSEIF/ELSE 链', () => {
    const backend: KojoEmitBackend = FIXTURE_BACKEND;
    expect(backend.presentation.poolDispatch).toBeUndefined();
    const result = compileKojoSource({
      source: withMachine('开场', POOL_BODY),
      adapter: FIXTURE_ADAPTER,
      backend,
    });
    expect(result.ok).toBe(true);
    // 没有能力就没有主语槽（IF 链直接用条件表达式，不需要隐藏槽）
    expect(result.slots).toEqual([]);
    const lines = linesOf(result.erb);
    expect(lines).toContain('IF {好感 == 0}');
    expect(lines).toContain('ELSEIF {好感 == 1}');
    expect(lines).toContain('ELSEIF {好感 == 2}');
    expect(lines).toContain('ELSE');
    expect(lines.some((line) => line.includes('SELECTCASE'))).toBe(false);
    expect(lines.some((line) => line.includes('__kojo_pool_等级问候 = '))).toBe(false);
  });
});

/* ============================== 5. source map 行级口径 ============================== */

describe('source map：分派块行级映射与既有链一致（不产"无源"行）', () => {
  it('表分派块每行都映射到表声明的源行；后续文本行映射与 IF 链版本同一源行', () => {
    const wired = compileKojoSource({ source: TABLE_SOURCE, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    const base = eratwBackend();
    const stripped = compileKojoSource({
      source: TABLE_SOURCE,
      adapter: ERATW_GAME_ADAPTER,
      backend: { ...base, program: { ...base.program, tableDispatch: undefined } },
    });
    expect(wired.sourceMap.lineCount).toBe(linesOf(wired.erb).length);
    expect(stripped.sourceMap.lineCount).toBe(linesOf(stripped.erb).length);

    const wiredLines = linesOf(wired.erb);
    const selectAt = wiredLines.findIndex((line) => line.includes('SELECTCASE __kojo_table_心情'));
    const endAt = wiredLines.findIndex((line) => line.includes('ENDSELECT'));
    expect(selectAt).toBeGreaterThanOrEqual(0);
    expect(endAt).toBeGreaterThan(selectAt);
    // 整块（含各档赋值行）归到表声明 span（§10.7"展开块映射到块头"）
    for (let line = selectAt + 1; line <= endAt + 1; line++) {
      const mapped = wired.sourceMap.lineAt(line);
      expect(mapped?.source).not.toBeNull();
      const startLine = mapped?.source?.start.line ?? -1;
      expect(startLine).toBeGreaterThanOrEqual(2);
      expect(startLine).toBeLessThanOrEqual(6);
    }
    // 块之后的文本行：两版映射到**同一源行**（行级口径与既有链一致）
    const textLineAt = (erb: string): number =>
      linesOf(erb).findIndex((line) => line.includes('她今天看起来')) + 1;
    const wiredTextAt = textLineAt(wired.erb);
    const strippedTextAt = textLineAt(stripped.erb);
    expect(wiredTextAt).toBeGreaterThan(0);
    expect(strippedTextAt).toBeGreaterThan(0);
    expect(wired.sourceMap.lineAt(wiredTextAt)?.source?.start.line).toBe(7);
    expect(stripped.sourceMap.lineAt(strippedTextAt)?.source?.start.line).toBe(7);
    // 槽清单与能力无关（能力只改落点，不改槽事实）
    expect(wired.slots).toEqual(stripped.slots);
  });

  it('池分派块行级：kind=pool + 双向 origins（调用处 / 池定义处），主语求值行同口径', () => {
    const result = compileKojoSource({ source: POOL_SOURCE, adapter: ERATW_GAME_ADAPTER, backend: eratwBackend() });
    const lines = linesOf(result.erb);
    const assignAt = lines.findIndex((line) => line.trim() === '__kojo_pool_等级问候 = 好感');
    const selectAt = lines.findIndex((line) => line.includes('SELECTCASE __kojo_pool_等级问候'));
    const endAt = lines.findIndex((line) => line.includes('ENDSELECT'));
    expect(assignAt).toBeGreaterThanOrEqual(0);
    expect(selectAt).toBe(assignAt + 1);
    // 主语求值行与分派块同属"池展开"（既有链里它就是池的一段），映射口径一致
    expect(result.sourceMap.lineAt(assignAt + 1)?.kind).toBe('pool');
    for (let line = selectAt + 1; line <= endAt + 1; line++) {
      const mapped = result.sourceMap.lineAt(line);
      expect(mapped?.kind).toBe('pool');
      expect(mapped?.origins.map((origin) => origin.kind)).toEqual(['call-site', 'pool-definition']);
      expect(mapped?.source).not.toBeNull();
    }
    expect(result.sourceMap.lineCount).toBe(lines.length);
  });
});
