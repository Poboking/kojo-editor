/**
 * 写点 × 跳转可达性（2026-11-06 状态回放边界批 2 · 车道 W）。
 *
 * 本批给写点检测加了一层**可达性**（`reachability.ts`），本用例钉住三件事：
 *
 * 1. **静态 GOTO 建模**：`GOTO $标签` 只走标签边 ⇒ 跳过的死区间里的写不报、标签之后
 *    的写照报；前向跳转（标签在跳转行之后）必须解析得出来。
 * 2. **不确定面不撒谎**：动态跳转（目标算不出来 / 标签不存在）**不误杀**——其后全按
 *    可达；`jump` 只留给动态跳转，静态跳转不再进"不确定面"；`TRYGOTO*`/`TRYJUMP*`
 *    不限制可达性。
 * 3. **保守边界**：只有**无条件直线**的 `RETURN` 才终止；条件块里 / `SIF` 守护下的
 *    `RETURN`、`GOTO` 都按"可能不执行"处理（真语料 `IF … RETURN … ENDIF` 是主流写法，
 *    判死会把活代码藏起来——那才是这个标记最不能犯的错）。SKIP 区不建标签、不算跳转。
 *
 * 另钉 `extractCallTarget`（`kind:'call'` 的 `target` 来源）：只认 `CALL` / `TRYCALL`
 * 的静名字直调形，`CALLFORM` 一族与看不懂的尾巴一律 `null`。
 */
import { describe, expect, it } from 'vitest';
import { ERB_INSTRUCTION_NAMES } from '@kojo/plugin-erb-parser';
import {
  CONDITIONAL_JUMP_INSTRUCTIONS,
  RETURN_STOP_INSTRUCTIONS,
  analyzeReachability,
} from '../src/reachability';
import { detectUnmodeledWrites, extractCallTarget } from '../src/writes';

/** 整份文件的行（1 基行号 = 下标 + 1） */
function linesOf(...rows: string[]): string[] {
  return rows;
}

/** 写点读数压成 `[行号, 类别]`（断言顺序 + 类别，比逐条找对象清楚） */
function entries(...rows: string[]): [number, string | undefined][] {
  const lines = linesOf(...rows);
  return detectUnmodeledWrites(lines, 1, lines.length).map((w) => [w.line, w.kind]);
}

describe('可达性 · 静态 GOTO', () => {
  it('只走标签边：跳过的死区间不报，跳转前后的写照报，且不再报 jump', () => {
    const shown = entries(
      '@FN()', // 1
      'CFLAG:1 = 1', // 2 跳转前 ⇒ 可达
      'GOTO SKIP_ME', // 3 静态跳转（不报 jump）
      'CFLAG:2 = 2', // 4 跳过 ⇒ 不可达
      'SETBIT CFLAG:3, 1', // 5 跳过 ⇒ 不可达
      '$SKIP_ME', // 6 标签
      'CFLAG:4 = 4', // 7 标签后 ⇒ 可达
    );
    expect(shown).toEqual([
      [2, 'assign'],
      [7, 'assign'],
    ]);
  });

  it('前向跳转（标签在跳转行之后）也解析得出来 —— 两阶段解析', () => {
    const lines = linesOf('@FN()', 'GOTO LATER', 'CFLAG:1 = 1', '$LATER', 'CFLAG:2 = 2');
    const reading = analyzeReachability(lines, 1, lines.length);
    expect(reading.resolvedJumps).toEqual([2]);
    expect(reading.dynamicJumps).toEqual([]);
    expect(detectUnmodeledWrites(lines, 1, lines.length).map((w) => w.line)).toEqual([5]);
  });

  it('标签带 `:` 后缀、跳转目标带行尾注释，都仍算静态目标', () => {
    expect(
      entries(
        '@FN()',
        'GOTO L ; 给作者看的说明', // 2
        '$L:', // 3
        'CFLAG:1 = 1', // 4
      ),
    ).toEqual([[4, 'assign']]);
  });

  it('同名标签取第一处（第二处不再是跳转目标）', () => {
    const shown = entries(
      '@FN()', // 1
      'GOTO L', // 2 ⇒ 指向第一处 `$L`（4）
      'CFLAG:1 = 1', // 3 跳过 ⇒ 不可达
      '$L', // 4
      'CFLAG:2 = 2', // 5 可达
      '$L', // 6 同名第二处（不是目标）
      'CFLAG:3 = 3', // 7 顺序流可达
    );
    expect(shown).toEqual([
      [5, 'assign'],
      [7, 'assign'],
    ]);
  });

  it('跳到紧邻下一行的标签 ⇒ 等价于直线（不误杀）', () => {
    expect(entries('@FN()', 'GOTO NEXT', '$NEXT', 'CFLAG:1 = 1')).toEqual([[4, 'assign']]);
  });
});

describe('可达性 · 动态跳转（保守全可达）', () => {
  it('目标是表达式 ⇒ 其后一律可达（不误杀），且仍报 jump', () => {
    expect(entries('@FN()', 'GOTO %LOCAL%', 'CFLAG:1 = 1')).toEqual([
      [2, 'jump'],
      [3, 'assign'],
    ]);
  });

  it('目标标签不存在 ⇒ 保守全可达（不把整段判死）', () => {
    expect(entries('@FN()', 'GOTO MISSING', 'CFLAG:1 = 1', 'SETBIT CFLAG:2, 1')).toEqual([
      [2, 'jump'],
      [3, 'assign'],
      [4, 'instruction'],
    ]);
  });

  it('动态形态分类：`(X)` / `%X%` / 空 / 纯数字行号 / `X:Y` / FORM 变体', () => {
    const lines = linesOf(
      '@F()', // 1
      'GOTO (X)', // 2
      'GOTO %X%', // 3
      'GOTO', // 4
      'GOTO 123', // 5
      'GOTO FLAG:X', // 6
      'GOTOFORM %X%', // 7
      'JUMPFORM %X%', // 8
      'GOTO L', // 9（静态）
      '$L', // 10
    );
    expect(analyzeReachability(lines, 1, lines.length).dynamicJumps).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(analyzeReachability(lines, 1, lines.length).resolvedJumps).toEqual([9]);
  });

  it('动态跳转之后没有写点 ⇒ 不报 jump（防刷屏判据不变）', () => {
    expect(entries('@FN()', 'GOTO %X%', 'PRINTL 甲')).toEqual([]);
  });

  it('死代码里的动态跳转不复活后面的行（`RETURN` 之后仍是死的）', () => {
    expect(entries('@FN()', 'RETURN', 'GOTO %X%', 'CFLAG:1 = 1')).toEqual([]);
  });
});

describe('可达性 · 条件跳转与 RETURN', () => {
  it('`TRYGOTO` 不改变可达性、也不报 jump（两条边都可能）', () => {
    expect(
      entries(
        '@FN()', // 1
        'TRYGOTO L', // 2
        'CFLAG:1 = 1', // 3 顺序流可达
        '$L', // 4
        'CFLAG:2 = 2', // 5 可达（顺序流覆盖）
      ),
    ).toEqual([
      [3, 'assign'],
      [5, 'assign'],
    ]);
  });

  it('无条件 `RETURN` 之后的写不可达', () => {
    expect(
      entries(
        '@FN()', // 1
        'CFLAG:1 = 1', // 2 可达
        'RETURN', // 3 块终止
        'CFLAG:2 = 2', // 4 不可达
        'SETBIT CFLAG:3, 1', // 5 不可达
      ),
    ).toEqual([[2, 'assign']]);
  });

  it('`RETURNF` / `RETURNFORM` 同样按块终止', () => {
    expect(entries('@FN()', 'RETURNF 1', 'CFLAG:1 = 1')).toEqual([]);
    expect(entries('@FN()', 'RETURNFORM 1', 'CFLAG:1 = 1')).toEqual([]);
  });

  it('`IF … RETURN … ENDIF` 里的 RETURN 不判死 ENDIF 之后的代码（真语料主流写法）', () => {
    expect(
      entries(
        '@FN()', // 1
        'IF CFLAG:1 == 0', // 2
        '  RETURN', // 3 条件块里 ⇒ 不终止
        'ENDIF', // 4
        'CFLAG:2 = 2', // 5 可达
      ),
    ).toEqual([[5, 'assign']]);
  });

  it('`SIF` 守护的 RETURN 不判死下一行之后的代码', () => {
    expect(
      entries(
        '@FN()', // 1
        'SIF CFLAG:1 == 0', // 2
        '  RETURN', // 3 被 SIF 守护 ⇒ 不终止
        'CFLAG:2 = 2', // 4 可达
      ),
    ).toEqual([[4, 'assign']]);
  });

  it('条件块里的静态 GOTO 两条边都算（软跳转，不抹掉顺序边）', () => {
    const lines = linesOf(
      '@FN()', // 1
      'IF CFLAG:1 == 0', // 2
      '  GOTO RETRY', // 3 块内 ⇒ 软跳转
      'ENDIF', // 4
      'CFLAG:2 = 2', // 5 顺序边 ⇒ 可达
      '$RETRY', // 6 跳转边目标
      'CFLAG:3 = 3', // 7 可达
    );
    expect(analyzeReachability(lines, 1, lines.length).resolvedJumps).toEqual([3]);
    expect(detectUnmodeledWrites(lines, 1, lines.length).map((w) => [w.line, w.kind])).toEqual([
      [5, 'assign'],
      [7, 'assign'],
    ]);
  });

  it('`BREAK` / `CONTINUE` 仍落下一行（循环语义不建模）', () => {
    expect(entries('@FN()', 'BREAK', 'CFLAG:1 = 1')).toEqual([[3, 'assign']]);
    expect(entries('@FN()', 'CONTINUE', 'CFLAG:1 = 1')).toEqual([[3, 'assign']]);
  });
});

describe('可达性 · SKIP 区', () => {
  it('SKIP 区里的 `$LABEL` 不当标签（跳转因此是动态 ⇒ 全可达）', () => {
    const lines = linesOf(
      '@FN()', // 1
      'GOTO HIDDEN', // 2 标签在 SKIP 区里 ⇒ 等于不存在 ⇒ 动态
      'CFLAG:1 = 1', // 3 动态保守 ⇒ 可达（否则会被判死）
      '[SKIPSTART]', // 4
      '$HIDDEN', // 5
      '[SKIPEND]', // 6
      'CFLAG:2 = 2', // 7
    );
    const reading = analyzeReachability(lines, 1, lines.length);
    expect(reading.dynamicJumps).toEqual([2]);
    expect(reading.resolvedJumps).toEqual([]);
    expect(detectUnmodeledWrites(lines, 1, lines.length).map((w) => [w.line, w.kind])).toEqual([
      [2, 'jump'],
      [3, 'assign'],
      [7, 'assign'],
    ]);
  });

  it('SKIP 区里的 GOTO 不算跳转（不建边、不进 dynamicJumps）', () => {
    const lines = linesOf('@FN()', '[SKIPSTART]', 'GOTO NOWHERE', '$L', '[SKIPEND]', 'CFLAG:1 = 1');
    const reading = analyzeReachability(lines, 1, lines.length);
    expect(reading.dynamicJumps).toEqual([]);
    expect(reading.resolvedJumps).toEqual([]);
    expect(detectUnmodeledWrites(lines, 1, lines.length).map((w) => [w.line, w.kind])).toEqual([
      [6, 'assign'],
    ]);
  });
});

describe('可达性 · 区间边界与读数分类', () => {
  it('窗口外标签不算（按动态保守），窗口外写永不报', () => {
    const lines = linesOf('@FN()', 'GOTO L', 'CFLAG:1 = 1', '$L', 'CFLAG:2 = 2');
    // 2..3：标签在 4（窗口外）⇒ 动态 ⇒ 3 可达
    expect(detectUnmodeledWrites(lines, 2, 3).map((w) => [w.line, w.kind])).toEqual([
      [2, 'jump'],
      [3, 'assign'],
    ]);
    // 只判跳转行：后面没有写点 ⇒ 不报
    expect(detectUnmodeledWrites(lines, 2, 2)).toEqual([]);
    // 只判写行：与可达性无关
    expect(detectUnmodeledWrites(lines, 3, 3).map((w) => w.line)).toEqual([3]);
    // 1..4：标签在窗口内 ⇒ 静态 ⇒ 3 被跳过 ⇒ 不报
    expect(detectUnmodeledWrites(lines, 1, 4)).toEqual([]);
  });

  it('读数分类：resolved / conditional / dynamic 各归各', () => {
    const lines = linesOf(
      '@F()', // 1
      'GOTO A', // 2 静态
      'TRYGOTO B', // 3 条件
      'GOTO %X%', // 4 动态
      'GOTOFORM FOO', // 5 动态（FORM 恒动态）
      '$A', // 6
      '$B', // 7
    );
    const reading = analyzeReachability(lines, 1, lines.length);
    expect(reading.resolvedJumps).toEqual([2]);
    expect(reading.conditionalJumps).toEqual([3]);
    expect(reading.dynamicJumps).toEqual([4, 5]);
  });

  it('条件跳转词表 = 引擎表里 `TRYC?(GOTO|JUMP)` 一族（机械等式，防手写漂移）', () => {
    const fromTable = ERB_INSTRUCTION_NAMES.filter((n) => /^TRYC?(GOTO|JUMP)/.test(n));
    expect([...CONDITIONAL_JUMP_INSTRUCTIONS].sort()).toEqual([...fromTable].sort());
  });

  it('块终止候选表 = 引擎表里 `RETURN` 族（`writes.ts` 的触发位与可达性的 stops 同源）', () => {
    const fromTable = ERB_INSTRUCTION_NAMES.filter((n) => /^RETURN(F|FORM)?$/.test(n));
    expect([...RETURN_STOP_INSTRUCTIONS].sort()).toEqual([...fromTable].sort());
  });

  it('空 / 非法区间 ⇒ 空读数，不抛', () => {
    const lines = linesOf('CFLAG:1 = 1');
    expect(analyzeReachability(lines, 3, 2).reachable.size).toBe(0);
    expect(analyzeReachability([], 1, 10).reachable.size).toBe(0);
    expect([...analyzeReachability(lines, 1, 99).reachable]).toEqual([1]);
  });

  it('纯函数：不改入参、同输入同输出', () => {
    const lines = linesOf('@FN()', 'GOTO L', 'CFLAG:1 = 1', '$L', 'CFLAG:2 = 2');
    const snapshot = [...lines];
    const a = analyzeReachability(lines, 1, lines.length);
    const b = analyzeReachability(lines, 1, lines.length);
    expect(lines).toEqual(snapshot);
    expect([...a.reachable]).toEqual([...b.reachable]);
  });
});

describe('extractCallTarget（静态被调名）', () => {
  it('`CALL NAME(...)` / `CALL NAME` / `CALL NAME, args` / `TRYCALL` ⇒ 大写名字', () => {
    expect(extractCallTarget('CALL FOO()')).toBe('FOO');
    expect(extractCallTarget('CALL FOO')).toBe('FOO');
    expect(extractCallTarget('CALL FOO(1, 2)')).toBe('FOO');
    expect(extractCallTarget('CALL FOO, 1, 2')).toBe('FOO');
    expect(extractCallTarget('call foo')).toBe('FOO');
    expect(extractCallTarget('TRYCALL Bar(1)')).toBe('BAR');
    expect(extractCallTarget('CALL 名前(1)')).toBe('名前');
  });

  it('`$` 前缀 / 行内注释 / `;!;` 代码前缀都剥掉', () => {
    expect(extractCallTarget('CALL $FOO()')).toBe('FOO');
    expect(extractCallTarget('CALL FOO() ; 说明')).toBe('FOO');
    expect(extractCallTarget(';!;CALL FOO')).toBe('FOO');
  });

  it('动态 / 非直调形一律 null（宁少勿错）', () => {
    for (const code of [
      'CALLFORM BAR, 1',
      'TRYCALLFORM BAR',
      'CALLFORMF BAR',
      'CALLF BAZ',
      'CALLEVENT BAZ',
      'CALLSHARP BAZ',
      'CALLTRAIN BAZ',
      'TRYCALLLIST X',
      'CALL K1_%X%',
      'CALL X:1',
      'CALLFOO X',
      'CALL',
      '; CALL FOO',
      'PRINTL CALL FOO',
    ]) {
      expect(extractCallTarget(code), code).toBeNull();
    }
  });

  it('`detectUnmodeledWrites` 给可解析的 call 条目填 `target`（动态调用不填）', () => {
    const lines = linesOf('CALL FOO(1)', 'CALLFORM BAR, 1', 'CALL BAZ');
    expect(detectUnmodeledWrites(lines, 1, lines.length)).toEqual([
      { line: 1, text: 'CALL FOO(1)', kind: 'call', target: 'FOO' },
      { line: 2, text: 'CALLFORM BAR, 1', kind: 'call' },
      { line: 3, text: 'CALL BAZ', kind: 'call', target: 'BAZ' },
    ]);
  });
});
