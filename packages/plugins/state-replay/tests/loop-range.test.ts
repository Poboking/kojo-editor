/**
 * 循环量逐值试算 单测（KW-15C 1103）。
 *
 * 判据面（三值口径的诚实边界，红线＝值域有限 ≠ 判定得出）：
 * - 区间内**每个**候选值都判成同一个 true / false ⇒ 收进来（真语料 `FOR LOCAL,0,5`
 *   紧接 `IF PALAM:LOCAL + CUP:LOCAL > 9000` 的形状）；
 * - 结论不一致 ⇒ 仍 unknown，但换更准的机器码 `local-range`（不再谎报「具名索引
 *   无法解析」）；
 * - 候选值一律同因判不出 ⇒ 原样透传（`RAND` 那类真随机继续记 `pseudo`，不被改写）；
 * - 使用点不是体内第一条真代码行 / 循环量不属本地量族 / 组合超限 ⇒ 逐字回落改动前。
 *
 * KW-15D 1103 加档（窗口档，判性三条前提见 `loop-range.ts` 文件头）：
 * - 使用点在体内更深行也收，代价=「循环头→使用点」每行被证明写不到循环量（白名单制）；
 * - 判脏形态逐字回落改动前路径，**不许**借窗口收成 `local-range` 之外的新假象。
 */
import { describe, expect, it } from 'vitest';
import type { ConditionExpr, FunctionLoopCounter, FunctionPredicates, ReplayValue, VariableRef } from '@kojo/plugin-api';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { judgePredicateWithLoops, loopWindowIsClean } from '../src/loop-range';
import type { OverlayPosition } from '../src/locals';

/** 合成视图：`PALAM:n` = n*1000（n=0 假、n≥1 视阈值而定）；`CUP:n` = 0 */
function readTable(table: Record<string, number | string>): (r: VariableRef) => ReplayValue {
  return (r) => {
    const key = `${r.name}:${r.indices.join(':')}`;
    if (key in table) return { kind: 'value', value: table[key]! };
    if (r.name === 'LOCAL' || r.name === 'PALAM' || r.name === 'CUP') {
      return { kind: 'unknown', unknown: { code: 'named-index', message: `具名索引无法解析：${r.text}` } };
    }
    return { kind: 'unknown', unknown: { code: 'missing-var', message: `无 ${r.text}` } };
  };
}

function detail(loopCounters: FunctionLoopCounter[]): FunctionPredicates {
  return {
    normalizedName: 'TEST',
    filePath: 'a.erb',
    startLine: 1,
    endLine: 50,
    statements: [],
    predicates: [],
    assignments: [],
    returns: [],
    loopCounters,
  };
}

/** `FOR LOCAL,0,5` 的循环量事实（体内第一条真代码行 = 第 3 行） */
const FOR_LOCAL_0_5: FunctionLoopCounter = {
  name: 'LOCAL',
  index: 0,
  openLine: 2,
  closeLine: 6,
  lo: 0,
  hi: 5,
  firstBodyLine: 3,
};

const AT_BODY_HEAD: OverlayPosition = { line: 3, context: ['s1'] };
const AT_LATER_LINE: OverlayPosition = { line: 4, context: ['s1'] };

const judge = (src: string, counters: FunctionLoopCounter[], at: OverlayPosition, table: Record<string, number | string> = {}) =>
  judgePredicateWithLoops(parseExpression(src), { read: readTable(table) }, detail(counters), at);

describe('循环量逐值试算 · 收得进来的形状', () => {
  it('区间内全假 → false（下标位是循环量：PALAM:LOCAL > 3000）', () => {
    // PALAM:0=0、PALAM:1..5 缺表 ⇒ 用显式数值表：全部 ≤3000
    const table: Record<string, number> = {
      'PALAM:0': 0,
      'PALAM:1': 1000,
      'PALAM:2': 2000,
      'PALAM:3': 3000,
      'PALAM:4': 3000,
      'PALAM:5': 3000,
    };
    expect(judge('PALAM:LOCAL > 3000', [FOR_LOCAL_0_5], AT_BODY_HEAD, table)).toEqual({ kind: 'false' });
  });

  it('区间内全真 → true', () => {
    const table: Record<string, number> = {
      'PALAM:0': 9,
      'PALAM:1': 9,
      'PALAM:2': 9,
      'PALAM:3': 9,
      'PALAM:4': 9,
      'PALAM:5': 9,
    };
    expect(judge('PALAM:LOCAL > 3', [FOR_LOCAL_0_5], AT_BODY_HEAD, table)).toEqual({ kind: 'true' });
  });

  it('裸槽形态（LOCAL 自己作值）同样试算：全真 → true', () => {
    expect(judge('LOCAL >= 0', [FOR_LOCAL_0_5], AT_BODY_HEAD)).toEqual({ kind: 'true' });
  });
});

describe('循环量逐值试算 · 收不进来的诚实呈现', () => {
  it('值域内结论不一致 → unknown(local-range)，且理由带区间与逐值结果', () => {
    const table: Record<string, number> = {
      'PALAM:0': 0,
      'PALAM:1': 5,
      'PALAM:2': 5,
      'PALAM:3': 5,
      'PALAM:4': 5,
      'PALAM:5': 5,
    };
    const out = judge('PALAM:LOCAL > 3', [FOR_LOCAL_0_5], AT_BODY_HEAD, table);
    expect(out.kind).toBe('unknown');
    if (out.kind !== 'unknown') return;
    expect(out.unknown.code).toBe('local-range');
    expect(out.unknown.message).toContain('LOCAL:0∈[0,5]');
    expect(out.unknown.message).toContain('FOR 第 2 行');
    expect(out.unknown.message).toContain('LOCAL:0=0→假');
    expect(out.unknown.message).toContain('LOCAL:0=1→真');
  });

  it('候选值一律同因判不出 → 原样透传那枚未知（不改写机器码、不新增一档）', () => {
    const out = judge('FOO:LOCAL > 3', [FOR_LOCAL_0_5], AT_BODY_HEAD);
    expect(out).toEqual({ kind: 'unknown', unknown: { code: 'missing-var', message: expect.any(String) } });
  });

  it('使用点不是体内第一条真代码行 → 逐字回落改动前（named-index 原样）', () => {
    expect(judge('PALAM:LOCAL > 3', [FOR_LOCAL_0_5], AT_LATER_LINE)).toEqual({
      kind: 'unknown',
      unknown: { code: 'named-index', message: expect.any(String) },
    });
  });

  it('循环量不属本地量族（用户 #DIM 变量）→ 不消费（抽取侧记的是结构事实）', () => {
    const counters: FunctionLoopCounter[] = [{ ...FOR_LOCAL_0_5, name: 'HOGE' }];
    expect(judge('PALAM:LOCAL > 3', counters, AT_BODY_HEAD)).toEqual({
      kind: 'unknown',
      unknown: { code: 'named-index', message: expect.any(String) },
    });
  });

  it('没有循环量事实 → 与改动前逐字相同（零行为漂移）', () => {
    expect(judge('PALAM:LOCAL > 3', [], AT_BODY_HEAD)).toEqual({
      kind: 'unknown',
      unknown: { code: 'named-index', message: expect.any(String) },
    });
  });

  it('两枚循环量各 6 值（36 组合）超上限 → 回落原路径，绝不硬猜', () => {
    const counters: FunctionLoopCounter[] = [
      FOR_LOCAL_0_5,
      { ...FOR_LOCAL_0_5, name: 'RESULT', index: 1, lo: 0, hi: 5 },
    ];
    const expr: ConditionExpr = {
      kind: 'binary',
      op: '>',
      left: { kind: 'ref', name: 'PALAM', indices: ['LOCAL'], text: 'PALAM:LOCAL' },
      right: { kind: 'ref', name: 'CUP', indices: ['RESULT:1'], text: 'CUP:RESULT:1' },
    };
    expect(
      judgePredicateWithLoops(expr, { read: readTable({}) }, detail(counters), AT_BODY_HEAD),
    ).toEqual({ kind: 'unknown', unknown: { code: 'named-index', message: expect.any(String) } });
  });
});

// ---------------------------------------------------------------------------
// KW-15D 窗口档：使用点在体内更深行，「循环头→使用点」每行都被证明写不到循环量才试算。
// 白名单 = 注释/空行/SKIP 区、无调用形的纯结构行、BREAK/CONTINUE、异槽字面赋值；
// 其余（同槽写/动态下标写/CALL/FOR/PRINT/SIF/未知动词）一律脏。判脏的形态必须
// 逐字回落到改动前的 `named-index`——**不许**因为"大概没事"就收成 local-range。
// ---------------------------------------------------------------------------

/** 真语料 K49 计数器惯用形（`FOR LOCAL,0,5` + IF 判据 + 异槽记号 + BREAK + ELSEIF） */
function counterIdiomLines(overrides: { line: number; text: string }[]): string[] {
  const lines = [
    '@FOO', // 1
    'FOR LOCAL,0,5', // 2
    'IF PALAM:LOCAL + CUP:LOCAL > 9000', // 3
    'LOCAL:1 = 2', // 4
    'BREAK', // 5
    'ELSEIF PALAM:LOCAL + CUP:LOCAL >= 5000', // 6
    'LOCAL:1 = 1', // 7
    'ENDIF', // 8
    'NEXT', // 9
  ];
  for (const b of overrides) lines[b.line - 1] = b.text;
  return lines;
}

/** 窗口档循环量事实：区间 (2,9)，第一条行 = 3，使用点 = 6（ELSEIF） */
const WINDOW_COUNTER: FunctionLoopCounter = {
  name: 'LOCAL',
  index: 0,
  openLine: 2,
  closeLine: 9,
  lo: 0,
  hi: 5,
  firstBodyLine: 3,
};

const AT_ELSEIF: OverlayPosition = { line: 6, context: ['s1'] };

const judgeWindow = (
  src: string,
  lines: string[],
  table: Record<string, number | string> = {},
  counters: FunctionLoopCounter[] = [WINDOW_COUNTER],
  at: OverlayPosition = AT_ELSEIF,
) => judgePredicateWithLoops(parseExpression(src), { read: readTable(table) }, detail(counters), at, lines);

/** PALAM:i = v、CUP:i = 0（i=0..5） */
const allTable = (v: number): Record<string, number> => {
  const t: Record<string, number> = {};
  for (let i = 0; i <= 5; i++) {
    t[`PALAM:${i}`] = v;
    t[`CUP:${i}`] = 0;
  }
  return t;
};

/** 判脏 = 逐字回落改动前路径（对 PALAM:LOCAL / LOCAL 读取即 named-index） */
const dirtyFallback = {
  kind: 'unknown',
  unknown: { code: 'named-index', message: expect.any(String) },
} as const;

describe('循环量窗口档 · 收得进来的干净窗口', () => {
  it('真语料惯用形（异槽写+BREAK 在窗口）→ 全体同假判假（named-index 残余 20 枚的收口形状）', () => {
    expect(judgeWindow('PALAM:LOCAL + CUP:LOCAL >= 5000', counterIdiomLines([]), allTable(0))).toEqual({ kind: 'false' });
  });

  it('全体同真判真', () => {
    expect(judgeWindow('PALAM:LOCAL + CUP:LOCAL >= 5000', counterIdiomLines([]), allTable(9999))).toEqual({ kind: 'true' });
  });

  it('红线不动：窗口干净但候选结论不一致 → 仍 local-range，不硬收', () => {
    const table = allTable(9999);
    table['PALAM:0'] = 0; // v=0 假、v=1..5 真
    const out = judgeWindow('PALAM:LOCAL + CUP:LOCAL >= 5000', counterIdiomLines([]), table);
    expect(out.kind).toBe('unknown');
    if (out.kind !== 'unknown') return;
    expect(out.unknown.code).toBe('local-range');
  });

  it('异槽复合赋值（LOCAL:1 += 2）写不到本槽位 → 窗口仍干净', () => {
    expect(judgeWindow('LOCAL >= 0', counterIdiomLines([{ line: 4, text: 'LOCAL:1 += 2' }]))).toEqual({ kind: 'true' });
  });

  it('注释与 SKIP 区内的赋值不执行 → 窗口干净（SKIP 判据与抽取侧 codeAt 同源）', () => {
    const manual = [
      '@FOO', // 1
      'FOR LOCAL,0,5', // 2
      'IF PALAM:LOCAL > 9000', // 3
      ';纯注释', // 4
      '[SKIPSTART]', // 5
      'LOCAL = 99', // 6 —— SKIP 区内，不执行
      '[SKIPEND]', // 7
      'ELSEIF PALAM:LOCAL >= 5000', // 8 ← 使用点
      'ENDIF', // 9
      'NEXT', // 10
    ];
    const counters = [{ ...WINDOW_COUNTER, closeLine: 10, firstBodyLine: 3 }];
    expect(judgeWindow('PALAM:LOCAL >= 5000', manual, allTable(0), counters, { line: 8, context: ['s1'] })).toEqual({ kind: 'false' });
  });

  it('CONTINUE 与纯结构行都不碰循环量 → 窗口干净', () => {
    expect(judgeWindow('LOCAL >= 0', counterIdiomLines([{ line: 5, text: 'CONTINUE' }]))).toEqual({ kind: 'true' });
  });
});

describe('循环量窗口档 · 脏窗口逐字回落改动前', () => {
  const dirty = (text: string) => judgeWindow('PALAM:LOCAL >= 0', counterIdiomLines([{ line: 4, text }]));

  it('同槽裸赋值 LOCAL = 2 → 脏（值不再受循环头支配，收 [0,5] 会假成立）', () => {
    expect(dirty('LOCAL = 2')).toEqual(dirtyFallback);
  });

  it('同槽复合赋值 LOCAL += 2 → 脏', () => {
    expect(dirty('LOCAL += 2')).toEqual(dirtyFallback);
  });

  it('同槽带号写 LOCAL:0 = 2 → 脏（与裸 LOCAL 同槽位）', () => {
    expect(dirty('LOCAL:0 = 2')).toEqual(dirtyFallback);
  });

  it('动态下标写 LOCAL:TEMP = 2 → 脏（语料反例：落点未知，assignments 也看不见它）', () => {
    expect(dirty('LOCAL:TEMP = 2')).toEqual(dirtyFallback);
  });

  it('SIF 内联同槽写 SIF CFLAG:1 LOCAL = 2 → 脏（抽取侧 ASSIGN_RE 同样不收录的形态）', () => {
    expect(dirty('SIF CFLAG:1 LOCAL = 2')).toEqual(dirtyFallback);
  });

  it(';!; 前缀藏的真代码 LOCAL = 2 → 脏（erbCodeBodyOf 剥前缀后照判）', () => {
    expect(dirty(';!;LOCAL = 2')).toEqual(dirtyFallback);
  });

  it('窗口里的 CALL → 脏（引擎作用域事实无出处，一律不吃）', () => {
    expect(dirty('CALL FOO')).toEqual(dirtyFallback);
  });

  it('结构行里的调用形 IF FOO(1) > 2 → 脏（表达式调用同样不硬吃作用域）', () => {
    expect(dirty('IF FOO(1) > 2')).toEqual(dirtyFallback);
  });

  it('异槽内层 FOR（FOR LOCAL:3, 0, 2）→ 也脏：FOR/NEXT 行不进白名单，嵌套语义零断言', () => {
    expect(dirty('FOR LOCAL:3, 0, 2')).toEqual(dirtyFallback);
  });

  it('PRINT 行 → 脏（FORM 插值求值面不建模）', () => {
    expect(dirty('PRINTFORMW %CFLAG:1%')).toEqual(dirtyFallback);
  });

  it('裸 SIF 守卫行 → 脏（守卫的语句是什么不作判据，整行判脏）', () => {
    expect(dirty('SIF CFLAG:1 PRINTL x')).toEqual(dirtyFallback);
  });

  it('未知动词行 → 脏（白名单制：判不准就脏）', () => {
    expect(dirty('SETBIT CFLAG:1, 0')).toEqual(dirtyFallback);
  });

  it('使用点不落在区间内（= NEXT 行）→ 区间检查先于窗口，回落原路径', () => {
    expect(
      judgeWindow('PALAM:LOCAL >= 0', counterIdiomLines([]), {}, [WINDOW_COUNTER], { line: 9, context: [] }),
    ).toEqual(dirtyFallback);
  });

  it('使用点在循环体外（FIRST 行之前 / close 之后同样）→ 零档命中', () => {
    expect(
      judgeWindow('PALAM:LOCAL >= 0', counterIdiomLines([]), {}, [WINDOW_COUNTER], { line: 1, context: [] }),
    ).toEqual(dirtyFallback);
  });
});

describe('循环量窗口档 · 接入面', () => {
  it('不给行文本 = 窗口档整体关闭（第二条行之后的旧形状逐字不变）', () => {
    expect(
      judgePredicateWithLoops(parseExpression('PALAM:LOCAL >= 0'), { read: readTable({}) }, detail([WINDOW_COUNTER]), AT_ELSEIF),
    ).toEqual(dirtyFallback);
  });

  it('loopWindowIsClean：空窗口恒干净；纯结构/异槽写/BREAK 干净；同槽写脏', () => {
    const lines = counterIdiomLines([]);
    expect(loopWindowIsClean(lines, 2, 3, { name: 'LOCAL', index: 0 })).toBe(true); // 紧邻头
    expect(loopWindowIsClean(lines, 2, 4, { name: 'LOCAL', index: 0 })).toBe(true); // 只过 IF 判据行
    expect(loopWindowIsClean(lines, 2, 6, { name: 'LOCAL', index: 0 })).toBe(true); // IF + 异槽写 + BREAK
    expect(loopWindowIsClean(['x', 'FOR LOCAL,0,5', 'LOCAL = 1', 'USE'], 2, 4, { name: 'LOCAL', index: 0 })).toBe(false);
  });
});
