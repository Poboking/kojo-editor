/**
 * 引擎指令名全集（A3 前置真源）· 表自身的不变量。
 *
 * 这张表是"`#DIM` 不得与指令同名"的判据底座，所以它自己的形状也得被钉住：
 * 条数、全大写、字典序、以及**四个必须不在表里的名字**（每一个都对应一次
 * 误报风险，出处见 `src/instructions.ts` 表头）。
 *
 * 语料口径（eraNAS / eraTW / eraKoumakan / eraSQC / eraSQN / eratohoK / eraNTR / erafl
 * 共 8 盘）留在 `declarations.test.ts` 的名字撞车用例里，本文件只管表。
 */
import { describe, expect, it } from 'vitest';
import { ERB_INSTRUCTION_NAMES, isInstructionName } from '../src/instructions';
import { BUILTIN_FUNCTION_NAMES } from '../src/builtins';

describe('ERB_INSTRUCTION_NAMES · 表的形状', () => {
  it('301 条（= enum FunctionCode 305 成员 − __NULL__ / SET / VARS / VARI）', () => {
    expect(ERB_INSTRUCTION_NAMES).toHaveLength(301);
  });

  it('全大写、无重复、字典序（改表时按这三条自检）', () => {
    for (const n of ERB_INSTRUCTION_NAMES) expect(n, n).toMatch(/^[A-Z_0-9]+$/);
    expect(new Set(ERB_INSTRUCTION_NAMES).size).toBe(ERB_INSTRUCTION_NAMES.length);
    expect([...ERB_INSTRUCTION_NAMES].sort()).toEqual([...ERB_INSTRUCTION_NAMES]);
  });

  it('四个"看着像指令但引擎不注册"的名字不在表里', () => {
    // __NULL__ 空值哨兵 / SET 走 setFunc / VARS·VARI 被 UseScopedVariableInstruction 门控
    for (const n of ['__NULL__', 'SET', 'VARS', 'VARI']) {
      expect(ERB_INSTRUCTION_NAMES, n).not.toContain(n);
      expect(isInstructionName(n), n).toBe(false);
    }
    // OUTPUTLOG 在枚举里被注释掉
    expect(isInstructionName('OUTPUTLOG')).toBe(false);
  });

  it('族样本抽查（PRINT 系是按码位逐个注册的，不是交替式展开）', () => {
    for (const n of ['PRINT', 'PRINTL', 'PRINTW', 'PRINTVW', 'PRINTSW', 'PRINTDATAW', 'PRINTSINGLEFORMSK']) {
      expect(isInstructionName(n), n).toBe(true);
    }
    // wiki 的交替式若直接展开会造出这些引擎里没有的名字
    expect(isInstructionName('PRINTKS')).toBe(false);
    expect(isInstructionName('PRINTSK')).toBe(true);
  });

  it('与内建式中函数表是两张表（并集在规则处做，互不吞并）', () => {
    const meth = new Set(BUILTIN_FUNCTION_NAMES.map((n) => n.toUpperCase()));
    // 有交集（引擎里 SystemMethod 先 Add，撞名也算致命），但两表各自独立
    expect(ERB_INSTRUCTION_NAMES.filter((n) => meth.has(n)).length).toBeGreaterThan(0);
    expect(meth.has('MAX')).toBe(true);
    expect(isInstructionName('MAX')).toBe(false);
  });
});

describe('isInstructionName · 归一化', () => {
  it('大小写不敏感、两端空白自动裁掉', () => {
    expect(isInstructionName('print')).toBe(true);
    expect(isInstructionName('  Print  ')).toBe(true);
    expect(isInstructionName('PRIN')).toBe(false);
    expect(isInstructionName('')).toBe(false);
  });
});
