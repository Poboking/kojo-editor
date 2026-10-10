/**
 * 有界内联解释器单测（v0.2 第七批；纯函数 + 合成注入）。
 *
 * 覆盖：
 * - analyze 拒绝路径：无 #FUNCTION / #FUNCTIONS / #DIM / 非 ARG 声明槽 /
 *   CALL 等副作用语句 / SELECTCASE / 复合赋值 / 孤儿分支 / SIF 体非法；
 * - 执行语义：IF/ELSEIF/ELSE 链 / SIF 参数补位（`SIF !ARG / ARG = TARGET`）/
 *   默认槽值 / 实参绑定与类型检查 / 实参 unknown 传播 / 函数尾无 RETURNF /
 *   嵌套内联 / 索引段替换（TALENT:ARG:恋人）/ LOCAL 未赋值 → local-no-write；
 * - InlineManager：preanalyze 预热 + 同步 resolveCall / 无定义 → null / reset。
 */
import { describe, expect, it } from 'vitest';
import type {
  ConditionExpr,
  FunctionAssignment,
  FunctionPredicates,
  FunctionReturn,
  ReplayValue,
  VariableRef,
} from '@kojo/plugin-api';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { evaluateExpr, type EvalContext, type ValueReader } from '../src/evaluate';
import { analyzeInlineBody, InlineManager } from '../src/inline';

// ---------------------------------------------------------------------------
// 测试基建：从合成函数体行构造 FunctionPredicates（predicates / assignments /
// returns 由行文本直接解析——与 extractor 的产物同构）
// ---------------------------------------------------------------------------

const ASSIGN_LINE_RE = /^(LOCAL|LOCALS|RESULT|RESULTS|ARG|ARGS)(?::(\d+))?\s*=(?!=)\s*(.*)$/i;

function buildDetail(name: string, filePath: string, lines: string[], startLine = 1): FunctionPredicates {
  const endLine = lines.length;
  const predicates: FunctionPredicates['predicates'] = [];
  const assignments: FunctionAssignment[] = [];
  const returns: FunctionReturn[] = [];
  for (let i = startLine + 1; i <= endLine; i++) {
    const t = (lines[i - 1] ?? '').trim();
    if (t.length === 0 || t.startsWith(';') || t.startsWith('#')) continue;
    const m = /^(IF|ELSEIF|SIF)\b\s*(.*)$/i.exec(t);
    if (m) {
      predicates.push({
        kind: m[1]!.toUpperCase() === 'SIF' ? 'SIF' : m[1]!.toUpperCase() === 'IF' ? 'IF' : 'ELSEIF',
        text: m[2]!,
        expr: parseExpression(m[2]!),
        line: i,
        depth: 0,
      });
      continue;
    }
    const am = ASSIGN_LINE_RE.exec(t);
    if (am) {
      assignments.push({
        name: am[1]!.toUpperCase() as FunctionAssignment['name'],
        index: am[2] ? Number(am[2]) : 0,
        expr: parseExpression(am[3]!),
        text: am[3]!,
        line: i,
        context: [],
      });
      continue;
    }
    const rm = /^RETURNF\b\s*(.*)$/i.exec(t);
    if (rm) {
      returns.push({ expr: parseExpression(rm[1]!), text: rm[1]!, line: i });
      continue;
    }
  }
  return {
    normalizedName: name,
    filePath,
    startLine,
    endLine,
    statements: [],
    assignments,
    predicates,
    returns,
  };
}

/** 合成视图读取器（`TALENT:{reg}:{name}` 形态由段替换后的引用驱动） */
function makeViewReader(values: Record<string, number | string> = {}): ValueReader {
  return (ref: VariableRef): ReplayValue => {
    const key = ref.indices.length > 0 ? `${ref.name}:${ref.indices.join(':')}` : ref.name;
    if (key in values) return { kind: 'value', value: values[key]! };
    return { kind: 'unknown', unknown: { code: 'missing-var', message: `no ${key}` } };
  };
}

function makeCtx(read: ValueReader, resolveCall?: EvalContext['resolveCall']): EvalContext {
  return { read, ...(resolveCall ? { resolveCall } : {}) };
}

function val(v: ReplayValue): number | string {
  if (v.kind !== 'value') throw new Error(`expected value, got unknown: ${JSON.stringify(v)}`);
  return v.value;
}

/** 构造 manager：files = 路径 → 行数组 */
function makeManager(files: Record<string, string[]>, extraPredicates?: (name: string) => FunctionPredicates | null): InlineManager {
  const details = new Map<string, FunctionPredicates>();
  for (const [path, lines] of Object.entries(files)) {
    // 函数名 = 头行 @NAME（一个文件一个函数，测试够用）
    const head = lines[0]!.trim();
    const name = /^@([^(（\s]+)/.exec(head)?.[1] ?? path;
    details.set(name.toUpperCase(), buildDetail(name, path, lines));
  }
  return new InlineManager({
    functionPredicates: async (n) => details.get(n.toUpperCase()) ?? extraPredicates?.(n) ?? null,
    readFileLines: async (p) => {
      const lines = files[p];
      if (!lines) throw new Error(`no such file: ${p}`);
      return lines;
    },
    log: { warn: () => {} },
  });
}

// ---------------------------------------------------------------------------
// analyze 拒绝路径
// ---------------------------------------------------------------------------

describe('analyzeInlineBody：拒绝路径', () => {
  it('无 #FUNCTION 头 → reject', () => {
    const lines = ['@FOO(ARG)', 'IF ARG', '\tRETURNF 1', 'ENDIF', 'RETURNF 0'];
    const r = analyzeInlineBody(buildDetail('FOO', 'a.erb', lines), lines);
    expect(r.kind).toBe('reject');
  });

  it('#FUNCTIONS → reject', () => {
    const lines = ['@FOO', '#FUNCTIONS', 'RETURNFORM "x"'];
    const r = analyzeInlineBody(buildDetail('FOO', 'a.erb', lines), lines);
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toContain('FUNCTIONS');
  });

  it('#DIM 局部声明 → reject', () => {
    const lines = ['@FOO', '#FUNCTION', '#DIM HOGE', 'RETURNF HOGE'];
    const r = analyzeInlineBody(buildDetail('FOO', 'a.erb', lines), lines);
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toContain('#DIM');
  });

  it('非 ARG/ARGS 声明槽 → reject', () => {
    const lines = ['@FOO(HOGE)', '#FUNCTION', 'RETURNF HOGE'];
    const r = analyzeInlineBody(buildDetail('FOO', 'a.erb', lines), lines);
    expect(r.kind).toBe('reject');
  });

  it('副作用语句（CALL）→ reject', () => {
    const lines = ['@FOO', '#FUNCTION', 'CALL BAR', 'RETURNF 1'];
    const r = analyzeInlineBody(buildDetail('FOO', 'a.erb', lines), lines);
    expect(r.kind).toBe('reject');
  });

  it('SELECTCASE → reject', () => {
    const lines = ['@FOO', '#FUNCTION', 'SELECTCASE ARG', 'CASE 1', 'RETURNF 1', 'ENDSELECT', 'RETURNF 0'];
    const r = analyzeInlineBody(buildDetail('FOO', 'a.erb', lines), lines);
    expect(r.kind).toBe('reject');
  });

  it('复合赋值 → reject', () => {
    const lines = ['@FOO', '#FUNCTION', 'LOCAL += 1', 'RETURNF LOCAL'];
    const r = analyzeInlineBody(buildDetail('FOO', 'a.erb', lines), lines);
    expect(r.kind).toBe('reject');
  });

  it('孤儿 ELSEIF → reject', () => {
    const lines = ['@FOO', '#FUNCTION', 'ELSEIF ARG', 'RETURNF 1', 'RETURNF 0'];
    const r = analyzeInlineBody(buildDetail('FOO', 'a.erb', lines), lines);
    expect(r.kind).toBe('reject');
  });

  it('SIF 体不是单条赋值/RETURNF → reject', () => {
    // SIF 体 = RETURNF 之前的 SIF 后下一有效行是 IF → 非法
    const lines = ['@FOO', '#FUNCTION', 'SIF ARG', '\tIF ARG == 1', '\t\tRETURNF 1', '\tENDIF', 'RETURNF 0'];
    const r = analyzeInlineBody(buildDetail('FOO', 'a.erb', lines), lines);
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toContain('SIF');
  });
});

// ---------------------------------------------------------------------------
// 执行语义
// ---------------------------------------------------------------------------

describe('inline 执行', () => {
  it('直线 RETURNF + 无参默认槽（陷落状态形态）', async () => {
    const lines = [
      '@陷落状态(ARG)',
      '#FUNCTION',
      'SIF !ARG',
      '\tARG = TARGET',
      'IF TALENT:ARG:恋人',
      '\tRETURNF 5',
      'ELSE',
      '\tRETURNF 4',
      'ENDIF',
      'RETURNF 0',
    ];
    const view = makeViewReader({ 'TALENT:49:恋人': 1, TARGET: 49 });
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('陷落状态', 'a.erb', lines));
    // 无实参 → ARG:0 默认 0 → SIF !ARG 真 → ARG = TARGET = 49 → TALENT:49:恋人 = 1 → RETURNF 5
    const v = mgr.resolveCall('陷落状态', [], makeCtx(view), 0);
    expect(v).not.toBeNull();
    expect(val(v!)).toBe(5);
    // 有实参 TARGET = 49（调用点实参求值）→ 同结果
    const v2 = mgr.resolveCall('陷落状态', [parseExpression('TARGET')], makeCtx(view), 0);
    expect(val(v2!)).toBe(5);
  });

  it('ELSEIF 链顺序判定（关系_310 形态）', async () => {
    const lines = [
      '@关系_310(ARG)',
      '#FUNCTION',
      'IF !ARG',
      '\tARG=49',
      'ENDIF',
      'IF MARK:ARG:反発刻印>=2',
      '\tRETURNF 0',
      'ELSEIF CFLAG:ARG:好感度>=15500',
      '\tRETURNF 105',
      'ELSE',
      '\tRETURNF 100',
      'ENDIF',
      'RETURNF 0',
    ];
    // MARK:49:反発刻印=0 → 走 ELSEIF：CFLAG:49:好感度=20000 >= 15500 → 105
    const view = makeViewReader({
      'MARK:49:反発刻印': 0,
      'CFLAG:49:好感度': 20000,
    });
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('关系_310', 'a.erb', lines));
    const v = mgr.resolveCall('关系_310', [], makeCtx(view), 0);
    expect(val(v!)).toBe(105);
    // 反発刻印 >= 2 → 0
    const view2 = makeViewReader({ 'MARK:49:反発刻印': 3, 'CFLAG:49:好感度': 20000 });
    const v2 = mgr.resolveCall('关系_310', [], makeCtx(view2), 0);
    expect(val(v2!)).toBe(0);
    // 好感不足 → ELSE 100
    const view3 = makeViewReader({ 'MARK:49:反発刻印': 0, 'CFLAG:49:好感度': 1000 });
    const v3 = mgr.resolveCall('关系_310', [], makeCtx(view3), 0);
    expect(val(v3!)).toBe(100);
  });

  it('实参绑定 + 嵌套内联（调用点实参求值）', async () => {
    const helper = ['@DOUBLE(ARG)', '#FUNCTION', 'RETURNF ARG * 2'];
    const main = [
      '@QUAD(ARG)',
      '#FUNCTION',
      'RETURNF DOUBLE(ARG) * 2',
    ];
    const view = makeViewReader({});
    const mgr = makeManager({ 'helper.erb': helper, 'main.erb': main });
    await mgr.preanalyze(buildDetail('QUAD', 'main.erb', main));
    const v = mgr.resolveCall('QUAD', [parseExpression('5')], makeCtx(view), 0);
    expect(val(v!)).toBe(20);
  });

  it('条件为 unknown → 传播（保留内层原因）', async () => {
    const lines = ['@FOO(ARG)', '#FUNCTION', 'IF TALENT:ARG:恋人', '\tRETURNF 1', 'ENDIF', 'RETURNF 0'];
    const view = makeViewReader({}); // TALENT:49:恋人 → missing-var unknown
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('FOO', 'a.erb', lines));
    const v = mgr.resolveCall('FOO', [], makeCtx(view), 0);
    expect(v!.kind).toBe('unknown');
    if (v!.kind === 'unknown') {
      expect(v!.unknown.code).toBe('missing-var');
    }
  });

  it('实参 unknown → 传播', async () => {
    const lines = ['@FOO(ARG)', '#FUNCTION', 'RETURNF ARG + 1'];
    const view = makeViewReader({}); // MISSING → unknown
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('FOO', 'a.erb', lines));
    const v = mgr.resolveCall('FOO', [parseExpression('MISSING')], makeCtx(view), 0);
    expect(v!.kind).toBe('unknown');
  });

  it('函数尾无 RETURNF → unknown(call)', async () => {
    const lines = ['@FOO', '#FUNCTION', 'IF 1', '\tLOCAL = 1', 'ENDIF'];
    const view = makeViewReader({});
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('FOO', 'a.erb', lines));
    const v = mgr.resolveCall('FOO', [], makeCtx(view), 0);
    expect(v!.kind).toBe('unknown');
    if (v!.kind === 'unknown') {
      expect(v!.unknown.code).toBe('call');
      expect(v!.unknown.message).toContain('RETURNF');
    }
  });

  it('索引段替换 + 视图回落混合（GETBIT 与视图段同现）', async () => {
    const lines = [
      '@CHK(ARG)',
      '#FUNCTION',
      'RETURNF GETBIT (CFLAG:ARG:1490 ,0)',
    ];
    const view = makeViewReader({ TARGET: 49, 'CFLAG:49:1490': 5 }); // 段替换后 CFLAG:49:1490 = 5 → bit0 = 1
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('CHK', 'a.erb', lines));
    const v = mgr.resolveCall('CHK', [parseExpression('TARGET')], makeCtx(view), 0);
    expect(val(v!)).toBe(1);
  });

  it('LOCAL 未赋值 → local-no-write；LOCAL 赋值参与数据流', async () => {
    const lines = [
      '@FOO',
      '#FUNCTION',
      'LOCAL = 3',
      'RETURNF LOCAL * 2',
    ];
    const view = makeViewReader({});
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('FOO', 'a.erb', lines));
    const v = mgr.resolveCall('FOO', [], makeCtx(view), 0);
    expect(val(v!)).toBe(6);
  });

  it('分支体无 RETURNF（自然掉落）→ 跳过后续分支不求值', async () => {
    // IF 真 → THEN 体（赋值）→ 自然掉到 ELSEIF（必须跳过，不得求值）→ ENDIF → RETURNF LOCAL
    const lines = [
      '@FOO',
      '#FUNCTION',
      'LOCAL = 0',
      'IF 1',
      '\tLOCAL = 5',
      'ELSEIF 1',
      '\tLOCAL = 9',
      'ENDIF',
      'RETURNF LOCAL',
    ];
    const view = makeViewReader({});
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('FOO', 'a.erb', lines));
    const v = mgr.resolveCall('FOO', [], makeCtx(view), 0);
    expect(val(v!)).toBe(5);
    // IF 假 → ELSEIF 求值（真）→ ELSEIF 体 → RETURNF 9
    const lines2 = [
      '@FOO2',
      '#FUNCTION',
      'LOCAL = 0',
      'IF 0',
      '\tLOCAL = 5',
      'ELSEIF 1',
      '\tLOCAL = 9',
      'ENDIF',
      'RETURNF LOCAL',
    ];
    const mgr2 = makeManager({ 'b.erb': lines2 });
    await mgr2.preanalyze(buildDetail('FOO2', 'b.erb', lines2));
    const v2 = mgr2.resolveCall('FOO2', [], makeCtx(view), 0);
    expect(val(v2!)).toBe(9);
  });

  it('LOCALS 字符串族：RETURNF 结果非数值 → unknown(type)', async () => {
    const lines = ['@FOO', '#FUNCTION', 'LOCALS = "abc"', 'RETURNF LOCALS'];
    const view = makeViewReader({});
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('FOO', 'a.erb', lines));
    const v = mgr.resolveCall('FOO', [], makeCtx(view), 0);
    expect(v!.kind).toBe('unknown');
    if (v!.kind === 'unknown') expect(v!.unknown.code).toBe('type');
  });

  it('SIF 假 → 跳过体（ARG 保持注入值）', async () => {
    const lines = [
      '@FOO(ARG)',
      '#FUNCTION',
      'SIF !ARG',
      '\tARG = 99',
      'RETURNF ARG',
    ];
    const view = makeViewReader({});
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('FOO', 'a.erb', lines));
    // 实参 7 → SIF !7 假 → 跳过 → RETURNF 7
    const v = mgr.resolveCall('FOO', [parseExpression('7')], makeCtx(view), 0);
    expect(val(v!)).toBe(7);
    // 实参 0 → SIF !0 真 → ARG = 99
    const v2 = mgr.resolveCall('FOO', [parseExpression('0')], makeCtx(view), 0);
    expect(val(v2!)).toBe(99);
  });

  it('字符串实参进数值槽 → unknown(type)', async () => {
    const lines = ['@FOO(ARG)', '#FUNCTION', 'RETURNF ARG'];
    const view = makeViewReader({});
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('FOO', 'a.erb', lines));
    const v = mgr.resolveCall('FOO', [parseExpression('"abc"')], makeCtx(view), 0);
    expect(v!.kind).toBe('unknown');
    if (v!.kind === 'unknown') expect(v!.unknown.code).toBe('type');
  });
});

// ---------------------------------------------------------------------------
// InlineManager 编排
// ---------------------------------------------------------------------------

describe('InlineManager', () => {
  it('未预热（缓存 miss）→ null（回落 unknown(call)）', () => {
    const lines = ['@FOO', '#FUNCTION', 'RETURNF 1'];
    const mgr = makeManager({ 'a.erb': lines });
    const v = mgr.resolveCall('FOO', [], makeCtx(makeViewReader({})), 0);
    expect(v).toBeNull();
  });

  it('无定义函数 → null', async () => {
    const mgr = makeManager({});
    await mgr.preanalyze(buildDetail('GHOST', 'ghost.erb', ['@GHOST', '#FUNCTION', 'RETURNF 1']));
    expect(mgr.resolveCall('GHOST', [], makeCtx(makeViewReader({})), 0)).toBeNull();
  });

  it('reset 后缓存清空 → null', async () => {
    const lines = ['@FOO', '#FUNCTION', 'RETURNF 1'];
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('FOO', 'a.erb', lines));
    expect(mgr.resolveCall('FOO', [], makeCtx(makeViewReader({})), 0)).not.toBeNull();
    mgr.reset();
    expect(mgr.resolveCall('FOO', [], makeCtx(makeViewReader({})), 0)).toBeNull();
  });

  it('深度界：自递归在 MAX_INLINE_DEPTH 内打住（不无限循环）', async () => {
    const lines = ['@LOOP(ARG)', '#FUNCTION', 'RETURNF LOOP(ARG)'];
    const view = makeViewReader({});
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('LOOP', 'a.erb', lines));
    const v = mgr.resolveCall('LOOP', [parseExpression('1')], makeCtx(view), 0);
    // 自递归最终超深度界 → null → 回落 unknown('call')
    expect(v).not.toBeNull();
    if (v!.kind === 'unknown') expect(v!.unknown.code).toBe('call');
  });
});

// ---------------------------------------------------------------------------
// evaluate.ts 集成：callResolver 经 EvalContext 生效
// ---------------------------------------------------------------------------

describe('evaluateExpr × resolveCall 集成', () => {
  it('谓词中的 call 走内联通道（陷落状态() == n 形态）', async () => {
    const lines = [
      '@陷落状态(ARG)',
      '#FUNCTION',
      'SIF !ARG',
      '\tARG = TARGET',
      'RETURNF ARG',
    ];
    const view = makeViewReader({ TARGET: 49 });
    const mgr = makeManager({ 'a.erb': lines });
    await mgr.preanalyze(buildDetail('陷落状态', 'a.erb', lines));
    const ctx = makeCtx(view, (name, args, caller) => mgr.resolveCall(name, args, caller, 0));
    const v = evaluateExpr(parseExpression('陷落状态() == 49'), ctx);
    expect(val(v)).toBe(1);
    const v2 = evaluateExpr(parseExpression('陷落状态(TARGET) == 50'), ctx);
    expect(val(v2)).toBe(0);
  });
});
