/**
 * B0 · 位置 → 符号（`functionAt` / `definitionTargetsAt`）单测。
 *
 * 纯函数、索引为唯一真源：本文件用 `parseErbText` + `aggregateIndex` 走**生产路径**
 * 建索引（不手搓 `ErbIndex` 字面量——手搓的夹具会把"索引长什么样"钉死在测试里，
 * 真实解析一旦变化测试仍绿，那就白测了）。
 *
 * 覆盖边界（任务书点名的那一串）：空文件 / 行号越界（0 / 负 / NaN / 超文件行数）/
 * 一行多个符号 / 无 `@` 定义 / 行首行尾；以及 definition 目标解析（跨文件 / 大小写 /
 * 未收录 / 非记号处一律不猜）。
 */

import { describe, expect, it } from 'vitest';
import type { ErbFile, ErbIndex } from '@kojo/plugin-api';
import { parseErbText } from '../src/scanner';
import { aggregateIndex } from '../src/snapshot';
import { definitionTargetsAt, functionAt } from '../src/symbols';

/** 由多份文本建索引（生产路径：解析 → 聚合） */
function indexOf(files: { path: string; text: string }[]): ErbIndex {
  const parsed: ErbFile[] = files.map((f) => parseErbText(f.text, f.path));
  const agg = aggregateIndex(parsed);
  return { files: agg.files, byName: agg.byName };
}

const A = 'C:\\proj\\A.ERB';
const B = 'C:\\proj\\B.ERB';

/** A: @ALPHA 占 1..3；@BETA 占 5..6（第 4 行空行落在两函数之间） */
const TEXT_A = ['@ALPHA(ARG)', '\tPRINTFORMW "a"', '\tRETURN 1', '', '@BETA', '\tRETURN 1'].join('\n');

describe('functionAt · 包围反查', () => {
  const idx = indexOf([{ path: A, text: TEXT_A }]);

  it('空文件（无 `@` 定义）→ undefined', () => {
    const empty = indexOf([{ path: A, text: '; 只有注释\n#DIM X\n' }]);
    expect(functionAt(empty, A, 1)).toBeUndefined();
  });

  it('文件不在索引里 → undefined', () => {
    expect(functionAt(idx, 'C:\\proj\\NOPE.ERB', 1)).toBeUndefined();
  });

  it('行首行尾：`@` 行与函数体末行都命中本人；两函数之间的空行归**前**一个（endLine = 下一个定义前一行）', () => {
    expect(functionAt(idx, A, 1)?.name).toBe('ALPHA'); // @ALPHA 行（startLine）
    expect(functionAt(idx, A, 2)?.name).toBe('ALPHA'); // 函数体内
    expect(functionAt(idx, A, 3)?.name).toBe('ALPHA'); // 函数体末行
    expect(functionAt(idx, A, 4)?.name).toBe('ALPHA'); // endLine（下一个 @ 之前一行；空行也归它）
    expect(functionAt(idx, A, 5)?.name).toBe('BETA'); // 第二个 @ 行
    expect(functionAt(idx, A, 6)?.name).toBe('BETA'); // 文件尾仍在 BETA 体内（endLine = lineCount）
  });

  it('行号越界：0 / 负数 / NaN / 超过文件行数 → undefined（**不夹取**）', () => {
    expect(functionAt(idx, A, 0)).toBeUndefined();
    expect(functionAt(idx, A, -3)).toBeUndefined();
    expect(functionAt(idx, A, Number.NaN)).toBeUndefined();
    expect(functionAt(idx, A, Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(functionAt(idx, A, 6)).toBeDefined();
    expect(functionAt(idx, A, 999)).toBeUndefined();
  });

  it('文件名（第一行之前）不属于任何函数', () => {
    const withHeader = indexOf([{ path: A, text: ['; 文件头注释', '', '@ONLY', '\tRETURN 1'].join('\n') }]);
    expect(functionAt(withHeader, A, 1)).toBeUndefined();
    expect(functionAt(withHeader, A, 2)).toBeUndefined();
    expect(functionAt(withHeader, A, 3)?.name).toBe('ONLY');
  });
});

describe('definitionTargetsAt · 引用反查（复用 byName）', () => {
  const idx = indexOf([
    { path: A, text: TEXT_A },
    // B 里调用 A 的 ALPHA / 本文件的 BETA；第 5 行调用未定义的名字
    {
      path: B,
      text: ['@CALLER', '\tCALL ALPHA(1)', '\tSIF beta(2)', '\tCALL NOT_DEFINED', '\tX = 1'].join('\n'),
    },
  ]);

  /** 用 `|` 标光标（1 基列 = 标记在原文里的 0 基下标 + 1） */
  const at = (text: string, path: string, line: number, marked: string) =>
    definitionTargetsAt(idx, path, text, line, marked.indexOf('|') + 1);

  const TEXT_B = ['@CALLER', '\tCALL ALPHA(1)', '\tSIF beta(2)', '\tCALL NOT_DEFINED', '\tX = 1'].join('\n');

  it('跨文件：`CALL ALPHA` 命中另一个文件里的 @ALPHA 定义行', () => {
    const refs = at(TEXT_B, B, 2, '\tCALL AL|PHA(1)');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.filePath).toBe(A);
    expect(refs[0]!.startLine).toBe(1);
  });

  it('大小写不敏感：`beta(...)` 命中 `@BETA`', () => {
    const refs = at(TEXT_B, B, 3, '\tSIF be|ta(2)');
    expect(refs.map((r) => r.name)).toEqual(['BETA']);
  });

  it('光标停在定义行上 → 命中自己（行首 `@` 不是记号字符，取整串名字）', () => {
    const refs = at(TEXT_B, B, 1, '@CAL|LER');
    expect(refs.map((r) => r.name)).toEqual(['CALLER']);
  });

  it('未收录的名字 / 变量名 / 空白 / 标点 → 空数组（**不猜**）', () => {
    expect(at(TEXT_B, B, 4, '\tCALL NOT_DEF|INED')).toEqual([]); // 未收录
    expect(at(TEXT_B, B, 5, '\tX |= 1')).toEqual([]); // 变量名不在 byName
    expect(at(TEXT_B, B, 2, '\t|CALL ALPHA(1)')).toEqual([]); // 行首缩进空白
    expect(at(TEXT_B, B, 2, '\tCALL| ALPHA(1)')).toEqual([]); // 关键字 CALL 不在索引里
  });

  it('行号越界（0 / 超行数 / NaN）→ 空数组', () => {
    expect(definitionTargetsAt(idx, B, TEXT_B, 0, 3)).toEqual([]);
    expect(definitionTargetsAt(idx, B, TEXT_B, 99, 3)).toEqual([]);
    expect(definitionTargetsAt(idx, B, TEXT_B, Number.NaN, 3)).toEqual([]);
  });

  it('重名函数多处定义 → 全部返回（不替作者裁决）', () => {
    const dup = indexOf([
      { path: A, text: '@DUP\n\tRETURN 1' },
      { path: B, text: '@DUP\n\tRETURN 2\n@USER\n\tCALL DUP' },
    ]);
    const refs = definitionTargetsAt(dup, B, '@DUP\n\tRETURN 2\n@USER\n\tCALL DUP', 4, 8);
    expect(refs.map((r) => r.filePath)).toEqual([A, B]);
    expect(refs.map((r) => r.startLine)).toEqual([1, 1]);
  });

  it('一行多个符号：只命中光标下的那一个（不是"整行里有啥就给啥"）', () => {
    const multi = indexOf([
      { path: A, text: '@ONE\n\tRETURN 1\n@TWO\n\tRETURN 2' },
      { path: B, text: '@USER\n\tCALL ONE, TWO' },
    ]);
    const textB = '@USER\n\tCALL ONE, TWO';
    expect(definitionTargetsAt(multi, B, textB, 2, 8).map((r) => r.name)).toEqual(['ONE']);
    expect(definitionTargetsAt(multi, B, textB, 2, 13).map((r) => r.name)).toEqual(['TWO']);
  });
});
