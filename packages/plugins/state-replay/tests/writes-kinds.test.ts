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
 * 3. **jump 防刷屏**：只有跳转行**之后**还有 `assign` / `instruction` / `call` 写点时才报；
 *    后面没写点（纯前向跳转）不报。被"已建模"放过的本地量赋值不算写点。
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

describe('写点类别 · jump（平跳形 + 防刷屏）', () => {
  it('跳转名字逐条对引擎表（只收平跳形，TRY* 条件跳转不在本表）', () => {
    expect([...JUMP_INSTRUCTIONS].sort()).toEqual(['GOTO', 'GOTOFORM', 'JUMP', 'JUMPFORM']);
    for (const n of JUMP_INSTRUCTIONS) expect(ERB_INSTRUCTION_NAMES).toContain(n);
  });

  it('跳转行之后还有写点 → 报 jump（可达性会影响结论）', () => {
    const lines = linesOf(
      '@FN()',
      'GOTO SKIP_ALL',
      'CFLAG:2 = 1',
      '$SKIP_ALL',
      'PRINTL 甲',
    );
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

  it('多个跳转各按"自己之后有没有写点"判；结果按行序合并', () => {
    const lines = linesOf(
      'GOTO A', // 1：后面有写点（5）⇒ 报
      '$A',
      'CALL FOO', // 3：call 写点
      'JUMP B', // 4：后面有写点（6）⇒ 报
      'SETBIT CFLAG:2, 1', // 5：写点
      'JUMP C', // 6：后面没有写点 ⇒ 不报
      '$B',
      '$C',
    );
    const writes = detectUnmodeledWrites(lines, 1, lines.length);
    expect(writes.map((w) => [w.line, w.kind])).toEqual([
      [1, 'jump'],
      [3, 'call'],
      [4, 'jump'],
      [5, 'instruction'],
    ]);
  });

  it('函数区间外（endLine 之后）的写点不算数：jump 仍按本区间判', () => {
    const lines = linesOf('GOTO END', '$END', 'PRINTL 甲', 'CFLAG:2 = 1');
    expect(detectUnmodeledWrites(lines, 1, 3)).toEqual([]);
    expect(detectUnmodeledWrites(lines, 1, 4).map((w) => w.kind)).toEqual(['jump', 'assign']);
  });
});
