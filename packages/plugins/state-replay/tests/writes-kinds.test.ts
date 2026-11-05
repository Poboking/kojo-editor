/**
 * 写点**类别**（2026-11-05 状态回放边界批 · 车道 S2）。
 *
 * 契约 `ReplayWrite.kind` 的四族：`assign` / `instruction` / `call` / `jump`。
 * 本用例钉住三件事：
 *
 * 1. **类别判定**：赋值形 → `assign`；写指令 → `instruction`；调用族 → `call`；
 *    平跳形 → `jump`（旧断言兼容：赋值/写指令仍报在原来的行上，只是多了 `kind`）。
 * 2. **名字不猜**：`CALL_INSTRUCTIONS` / `JUMP_INSTRUCTIONS` 逐条对引擎指令表
 *    （`@kojo/plugin-erb-parser` 的 `ERB_INSTRUCTION_NAMES`）；调用族 = 表里所有
 *    `CALL*` / `TRYCALL*` 动词（机械等式，防手写漂移）。
 * 3. **jump 只留给动态跳转**（2026-11-06 可达性批收紧）：静态字面量标签的 `GOTO` / `JUMP`
 *    已由 `reachability.ts` 建模 ⇒ **不再报** `jump`（跳过的死区间里的写也不报）；
 *    只有动态跳转（目标算不出来 / 标签不存在）且其后仍有可达写点时才报。
 *    被"已建模"放过的本地量赋值不算写点。
 */
import { describe, expect, it } from 'vitest';
import { ERB_INSTRUCTION_NAMES, ERB_STATEMENT_DIRECTIVES } from '@kojo/plugin-erb-parser';
import {
  CALL_INSTRUCTIONS,
  JUMP_INSTRUCTIONS,
  WRITE_INSTRUCTIONS,
  detectUnmodeledWrites,
} from '../src/writes';

/** 整份文件的行（1 基行号 = 下标 + 1） */
function linesOf(...rows: string[]): string[] {
  return rows;
}

/** 行号 → kind 的速查（断言类别时读它，比逐条找对象清楚） */
function kindsByLine(lines: readonly string[]): Record<number, string | undefined> {
  const out: Record<number, string | undefined> = {};
  for (const w of detectUnmodeledWrites(lines, 1, lines.length)) out[w.line] = w.kind;
  return out;
}

describe('写点类别 · assign / instruction', () => {
  it('赋值形 → assign；写指令 → instruction（同一行只报一次）', () => {
    const lines = linesOf(
      'CFLAG:2 += 10',
      'SETBIT CFLAG:2, 1',
      'LOCAL = 0',
      'TFLAG\' = 1',
      'INPUT',
      'PRINTL 读类不报',
    );
    const writes = detectUnmodeledWrites(lines, 1, lines.length);
    expect(writes.map((w) => [w.line, w.kind])).toEqual([
      [1, 'assign'],
      [2, 'instruction'],
      [4, 'assign'],
      [5, 'instruction'],
    ]);
  });

  it('每条写点都带显式 kind（消费方不必再按缺省猜）', () => {
    const lines = linesOf('CFLAG:1 = 1', 'VARSET CFLAG:2, 1', 'CALL FOO', 'GOTO LBL', 'CFLAG:3 = 3');
    for (const w of detectUnmodeledWrites(lines, 1, lines.length)) {
      expect(w.kind).toBeDefined();
    }
  });
});

describe('写点类别 · call（调用族，不展开）', () => {
  it('调用族每个名字都识别为 call（大小写不敏感）', () => {
    const names = [...CALL_INSTRUCTIONS];
    const lines = linesOf(...names, ...names.map((n) => n.toLowerCase()));
    const writes = detectUnmodeledWrites(lines, 1, lines.length);
    expect(writes).toHaveLength(names.length * 2);
    expect(writes.every((w) => w.kind === 'call')).toBe(true);
    expect(writes.map((w) => w.line)).toEqual(
      Array.from({ length: names.length * 2 }, (_, i) => i + 1),
    );
  });

  it('调用行只报一行（不解析实参、不展开被调段）', () => {
    const lines = linesOf('CALL FOO(CFLAG:2, 1)', 'TRYCALLFORM BAR %CFLAG:2%', 'CALLFORMF BAZ, 1, 2');
    const writes = detectUnmodeledWrites(lines, 1, lines.length);
    expect(writes.map((w) => [w.line, w.kind, w.text])).toEqual([
      [1, 'call', 'CALL FOO(CFLAG:2, 1)'],
      [2, 'call', 'TRYCALLFORM BAR %CFLAG:2%'],
      [3, 'call', 'CALLFORMF BAZ, 1, 2'],
    ]);
  });

  it('调用族 = 引擎指令表里所有 CALL* / TRYCALL* / TRYCCALL* 动词（机械等式，防手写漂移）', () => {
    const fromTable = ERB_INSTRUCTION_NAMES.filter((n) => /^(CALL|TRYCALL|TRYCCALL)/.test(n));
    expect([...CALL_INSTRUCTIONS].sort()).toEqual([...fromTable].sort());
  });

  it('写指令短表 ⊆ 引擎词表（指令表 ∪ 语句提示表；EQUIP / MAP_SET 一族是内建语句）', () => {
    const engineWords = new Set<string>([...ERB_INSTRUCTION_NAMES, ...ERB_STATEMENT_DIRECTIVES]);
    for (const n of WRITE_INSTRUCTIONS) expect(engineWords.has(n)).toBe(true);
  });
});

describe('写点类别 · jump（动态跳转 + 防刷屏）', () => {
  it('跳转名字逐条对引擎表（只收平跳形，TRY* 条件跳转不在本表）', () => {
    expect([...JUMP_INSTRUCTIONS].sort()).toEqual(['GOTO', 'GOTOFORM', 'JUMP', 'JUMPFORM']);
    for (const n of JUMP_INSTRUCTIONS) expect(ERB_INSTRUCTION_NAMES).toContain(n);
  });

  it('静态跳转不再报 jump：可达性已建模，被跳过的写不报、标签之后的写照报', () => {
    const lines = linesOf(
      '@FN()',
      'GOTO SKIP_ALL',
      'CFLAG:2 = 1',
      '$SKIP_ALL',
      'CFLAG:3 = 2',
    );
    const writes = detectUnmodeledWrites(lines, 1, lines.length);
    expect(writes.map((w) => [w.line, w.kind])).toEqual([[5, 'assign']]);
  });

  it('动态跳转 + 后面还有写点 → 报 jump（可达性目标不可知）', () => {
    const lines = linesOf('@FN()', 'GOTO %LOCAL%', 'CFLAG:2 = 1');
    const writes = detectUnmodeledWrites(lines, 1, lines.length);
    expect(writes.map((w) => [w.line, w.kind])).toEqual([
      [2, 'jump'],
      [3, 'assign'],
    ]);
  });

  it('跳转行之后没有写点 → 不报 jump（纯前向跳转，不影响近似结论）', () => {
    const lines = linesOf(
      '@FN()',
      'CFLAG:2 = 1',
      'GOTO END',
      'PRINTL 甲',
      '$END',
    );
    const writes = detectUnmodeledWrites(lines, 1, lines.length);
    expect(writes.map((w) => [w.line, w.kind])).toEqual([[2, 'assign']]);
  });

  it('只有"已建模"的本地量赋值在后面 ⇒ 不算写点，jump 不报', () => {
    const lines = linesOf('GOTO L', 'LOCAL = 1', 'RESULT = 2', '$L');
    expect(detectUnmodeledWrites(lines, 1, lines.length)).toEqual([]);
  });

  it('多个静态跳转：都不报 jump，跳过的写点不报，结果只剩可达写点', () => {
    const lines = linesOf(
      'GOTO A', // 1：跳 2，静态 ⇒ 不报
      '$A', // 2
      'CALL FOO', // 3：可达写点
      'JUMP B', // 4：跳 7，静态 ⇒ 不报
      'SETBIT CFLAG:2, 1', // 5：跳过 ⇒ 不可达
      'JUMP C', // 6：跳过 ⇒ 不可达
      '$B', // 7
      '$C', // 8
    );
    const writes = detectUnmodeledWrites(lines, 1, lines.length);
    expect(writes.map((w) => [w.line, w.kind])).toEqual([[3, 'call']]);
  });

  it('跳转目标在窗口外 ⇒ 按动态保守（窗口内全可达）；窗口外写点不报', () => {
    const lines = linesOf('GOTO OUT', 'CFLAG:1 = 1', 'CFLAG:2 = 2', '$OUT');
    // 标签在 4（窗口外）⇒ 动态 ⇒ 窗口内全可达
    expect(detectUnmodeledWrites(lines, 1, 3).map((w) => [w.line, w.kind])).toEqual([
      [1, 'jump'],
      [2, 'assign'],
      [3, 'assign'],
    ]);
    // 标签进窗口 ⇒ 静态 ⇒ 1 只连 4，2 / 3 不可达 ⇒ 一条都不报
    expect(detectUnmodeledWrites(lines, 1, 4)).toEqual([]);
  });
});
