/**
 * 未建模状态写检测（2026-11-05 状态回放可用性批）。
 *
 * 回放按函数入口时刻的存档求值、不执行函数体 ⇒ 体内的 `CFLAG:2 += 10` / `SETBIT` /
 * `INPUT` 都不会被算进去。本用例钉住 `detectUnmodeledWrites` 的判据：
 *
 * - 赋值族（含复合赋值 / 动态下标 / SIF 内联形）要报；
 * - **语言局部量族**（LOCAL/LOCALS/RESULT/RESULTS/ARG/ARGS）不报——那些写已有直线
 *   数据流建模，不算"未建模"；
 * - 比较（`==` / `<=` / `>=` / `!=`）不报（`==` 是判据里最容易手滑的形状）；
 * - 注释 / `#DIM` / `@` / `$` / `[SKIPSTART]`…`[SKIPEND]` 不报；`;!;` 代码前缀剥掉后照报；
 * - 引擎写指令（`SETBIT` / `INPUT` / `RESETDATA` 一族）报；`PRINT` / `GETBIT` 这类读不报；
 * - 行号 1 基且只在 `[startLine, endLine]` 内报；同一行只报一次；`text` 去行内注释。
 */
import { describe, expect, it } from 'vitest';
import { detectUnmodeledWrites } from '../src/writes';

/** 整份文件的行（1 基行号 = 下标 + 1） */
function linesOf(...rows: string[]): string[] {
  return rows;
}

describe('detectUnmodeledWrites：赋值形', () => {
  it('游戏变量直线 / 复合赋值得报，行号与正文都对', () => {
    const lines = linesOf(
      '@FN()',
      'CFLAG:2 = 10',
      'CFLAG:2 += 10',
      'FLAG:1 -= 3',
      'CFLAG:3 *= 2',
      'TALENT:7 /= 4',
      'MARK:1 %= 5',
      'PALAM:2 |= 8',
      'PALAM:2 &= 7',
      'FLAG:4 ^= 3',
      'CFLAG:5 <<= 2',
      'CFLAG:5 >>= 1',
      'ENDIF',
    );
    const writes = detectUnmodeledWrites(lines, 1, lines.length);
    expect(writes.map((w) => w.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(writes[0]!.text).toBe('CFLAG:2 = 10');
    expect(writes[1]!.text).toBe('CFLAG:2 += 10');
    expect(writes[10]!.text).toBe('CFLAG:5 >>= 1');
  });

  it('动态 / 具名下标的赋值也报（落点未知不影响"这是一次写"）', () => {
    const lines = linesOf('CFLAG:LOCAL = 1', 'TALENT:恋慕 = 3', 'CFLAG:2:3 = 4');
    expect(detectUnmodeledWrites(lines, 1, 3).map((w) => w.text)).toEqual([
      'CFLAG:LOCAL = 1',
      'TALENT:恋慕 = 3',
      'CFLAG:2:3 = 4',
    ]);
  });

  it('语言局部量族不报（已有直线数据流建模）', () => {
    const lines = linesOf(
      'LOCAL = 0',
      'LOCAL:1 += 2',
      'LOCALS:1 = "甲"',
      'RESULT = 42',
      'RESULTS:2 = "乙"',
      'ARG = TARGET',
      'ARGS:1 = "丙"',
    );
    expect(detectUnmodeledWrites(lines, 1, lines.length)).toEqual([]);
  });

  it('带撇槽目标（引擎的字符串维度写法）一样报；带撇的本地量族仍按族放过', () => {
    const lines = linesOf(
      "TFLAG' = 1", // 1：非本地量族 ⇒ 报
      'CFLAG:2\' = "x"', // 2：非本地量族 + 带撇下标 ⇒ 报
      "TFLAG':1 = 2", // 3：带撇名字 + 下标 ⇒ 报
      'LOCAL\' = "x"', // 4：本地量族（字符串维）⇒ 按族规则放过（宁少勿错）
    );
    const writes = detectUnmodeledWrites(lines, 1, lines.length);
    expect(writes.map((w) => w.line)).toEqual([1, 2, 3]);
    expect(writes[1]!.text).toBe('CFLAG:2\' = "x"');
  });

  it('比较不算赋值（`==` / `<=` / `>=` / `!=` 一族）', () => {
    const lines = linesOf(
      'IF CFLAG:2 == 10',
      'ELSEIF CFLAG:2 >= 5',
      'SIF CFLAG:2 == 0',
      'SIF FLAG:3 != 9',
      'WHILE CFLAG:1 <= 3',
    );
    expect(detectUnmodeledWrites(lines, 1, lines.length)).toEqual([]);
  });

  it('`SIF <条件> 变量 = 值` 内联赋值形要报', () => {
    const lines = linesOf('SIF CFLAG:2 == 0 CFLAG:3 = 1', 'SIF A && B FLAG:1 += 2');
    const writes = detectUnmodeledWrites(lines, 1, 2);
    expect(writes.map((w) => w.text)).toEqual(['SIF CFLAG:2 == 0 CFLAG:3 = 1', 'SIF A && B FLAG:1 += 2']);
    expect(writes.map((w) => w.line)).toEqual([1, 2]);
  });
});

describe('detectUnmodeledWrites：引擎写指令', () => {
  it('写指令要报（位操作 / 输入 / 角色列表 / 重置 / 时间 / 存档 / 数组变量族）', () => {
    const lines = linesOf(
      'SETBIT CFLAG:2, 1',
      'CLEARBIT CFLAG:2, 2',
      'INVERTBIT CFLAG:2, 3',
      'INPUT',
      'INPUTS',
      'INPUTANY',
      'INPUTMOUSEKEY 0',
      'ONEINPUT',
      'BINPUT CFLAG:2',
      'BINPUTS',
      'TINPUT CFLAG:2',
      'TINPUTS',
      'TONEINPUT',
      'TONEINPUTS',
      'ADDCHARA 3',
      'DELCHARA 0',
      'ADDCOPYCHARA 1',
      'SWAPCHARA 0, 1',
      'SORTCHARA 1',
      'ADDVOIDCHARA',
      'RESETDATA',
      'RESETGLOBAL',
      'TIMES',
      'SAVEDATA 1',
      'SAVEGLOBAL',
      'LOADDATA 1',
      'LOADGLOBAL',
      'RANDOMIZE 1, 100',
      'VARSET CFLAG:2, 1',
      'CVARSET CFLAG:2, 1',
      'VARSIZE CFLAG:2, 10',
      'ARRAYCOPY CFLAG, 2, 0, 1, 10',
      'ARRAYSHIFT CFLAG, 1, 0, 10',
      'ARRAYREMOVE CFLAG, 0, 10',
      'ARRAYSORT CFLAG, 0, 10',
      'SWAP CFLAG:2, CFLAG:3',
      'EQUIP 1, 2',
      'UNEQUIP 1',
      'DT_CELL_SET "T", 0, 0, 1',
      'DT_ROW_ADD "T", 1',
      'MAP_SET "K", 1',
      'RESET_STAIN 2',
    );
    const writes = detectUnmodeledWrites(lines, 1, lines.length);
    expect(writes).toHaveLength(42);
    expect(writes.map((w) => w.line)).toEqual(Array.from({ length: 42 }, (_, i) => i + 1));
  });

  it('读类指令 / 纯表达式行不报（PRINT 族只读，GETBIT 是读）', () => {
    const lines = linesOf(
      'PRINTL あ',
      'PRINTFORM %CFLAG:2%',
      'PRINTW 100',
      'GETBIT CFLAG:2, 1',
      'FOO(1, 2)',
      'SETBIT2 CFLAG:2, 1',
      'INPUT_FOO()',
    );
    expect(detectUnmodeledWrites(lines, 1, lines.length)).toEqual([]);
  });

  it('小写动词同样识别（ERB 关键词大小写不敏感）', () => {
    expect(detectUnmodeledWrites(['setbit CFLAG:2, 1', 'cflag:2 = 1'], 1, 2)).toHaveLength(2);
  });
});

describe('detectUnmodeledWrites：跳过与边界', () => {
  it('注释 / 空行 / `@` `#` `$` 行不报；`;!;` 代码前缀剥掉后照报；行内注释进 text 前去掉', () => {
    const lines = linesOf(
      '; CFLAG:2 = 1',
      '',
      '@FN()',
      '#DIM CFLAG, 10',
      '$LABEL',
      ';!;CFLAG:9 = 1',
      'CFLAG:2 = 3 ; 给作者看的说明',
    );
    const writes = detectUnmodeledWrites(lines, 1, lines.length);
    expect(writes.map((w) => w.line)).toEqual([6, 7]);
    expect(writes[0]!.text).toBe('CFLAG:9 = 1'); // 前缀剥掉（与 loop-range.ts 同口径）
    expect(writes[1]!.text).toBe('CFLAG:2 = 3'); // 行内注释去掉
  });

  it('`[SKIPSTART]`…`[SKIPEND]` 区内的写不报，区外照报', () => {
    const lines = linesOf('CFLAG:1 = 1', '[SKIPSTART]', 'CFLAG:2 = 2', 'SETBIT CFLAG:3, 1', '[SKIPEND]', 'CFLAG:4 = 4');
    const writes = detectUnmodeledWrites(lines, 1, lines.length);
    expect(writes.map((w) => w.line)).toEqual([1, 6]);
  });

  it('只报区间内的行：自动扫描不会越界到函数外', () => {
    const lines = linesOf('CFLAG:1 = 1', '@FN()', 'CFLAG:2 = 2', 'SETBIT CFLAG:3, 1', 'CFLAG:4 = 4');
    const writes = detectUnmodeledWrites(lines, 2, 4);
    expect(writes.map((w) => w.line)).toEqual([3, 4]);
    // 区间外（1 / 5）即便有写也不报
    expect(writes.some((w) => w.line === 1 || w.line === 5)).toBe(false);
  });

  it('区间落空 / 非法（start > end / 超文件长度）⇒ 空数组，不抛', () => {
    const lines = linesOf('CFLAG:1 = 1');
    expect(detectUnmodeledWrites(lines, 3, 2)).toEqual([]);
    expect(detectUnmodeledWrites(lines, 1, 99)).toHaveLength(1); // 超长按文件长度截断
    expect(detectUnmodeledWrites([], 1, 10)).toEqual([]);
  });

  it('同一行只报一次', () => {
    const lines = linesOf('SIF CFLAG:2 == 0 CFLAG:3 = 1');
    expect(detectUnmodeledWrites(lines, 1, 1)).toHaveLength(1);
  });

  it('纯函数：不改入参', () => {
    const lines = linesOf('CFLAG:1 = 1', 'SETBIT CFLAG:2, 1');
    const snapshot = [...lines];
    detectUnmodeledWrites(lines, 1, 2);
    expect(lines).toEqual(snapshot);
  });
});
