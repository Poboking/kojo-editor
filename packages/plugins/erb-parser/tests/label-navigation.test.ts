/**
 * `$` 标签作用域读数（W-2，2026-10-19）：`labelScopeAt` 的定义 / 跳转点全集，
 * 以及 `definitionTargetsAt` 的三条腿（定义自跳 / 跳转目标 / 函数名）。
 *
 * 判据口径（与 scanner 的 `ErbLabel` 完全同源）：
 * - 标签是**函数局部**作用域，跨函数同名各归各的；
 * - `[SKIPSTART]…[SKIPEND]` 内的定义与跳转一律不计（引擎不编译）；
 * - 跳转目标只认"关键字后只隔空白 + 整段标识符"的裸形态，动态表达式不猜；
 * - 标签名允许 CJK（与反向索引同一枚 Unicode 记号集），大小写不敏感。
 */
import { describe, expect, it } from 'vitest';
import type { ErbFunctionRef, ErbIndex } from '@kojo/plugin-api';
import { definitionTargetsAt, labelScopeAt } from '../src/symbols';

const PATH = '/a.ERB';

const idx = (byName: Record<string, ErbFunctionRef[]> = {}): ErbIndex =>
  ({ files: new Map(), byName: new Map(Object.entries(byName)) }) as unknown as ErbIndex;

const fnRef = (name: string, startLine = 9): ErbFunctionRef => ({
  name,
  normalizedName: name.toUpperCase(),
  filePath: PATH,
  startLine,
  endLine: startLine + 1,
});

describe('labelScopeAt · 定义 + 跳转点全集', () => {
  const TEXT = '@F\n$NEXT\n\tPRINTL A\n\tGOTO NEXT\n';

  it('跳转目标入口：给出定义与全部跳转（行/列/kind 齐全）', () => {
    expect(labelScopeAt(TEXT, PATH, 4, 7)).toEqual({
      name: 'NEXT',
      normalizedName: 'NEXT',
      functionStartLine: 1,
      occurrences: [
        { name: 'NEXT', normalizedName: 'NEXT', filePath: PATH, line: 2, column: 2, endColumn: 6, kind: 'definition' },
        { name: 'NEXT', normalizedName: 'NEXT', filePath: PATH, line: 4, column: 7, endColumn: 11, kind: 'jump' },
      ],
      siblingNames: [],
    });
  });

  it('定义行入口：光标在名字内或词尾后一格都算', () => {
    expect(labelScopeAt(TEXT, PATH, 2, 3)?.occurrences.length).toBe(2);
    expect(labelScopeAt(TEXT, PATH, 2, 6)?.occurrences.length).toBe(2);
    // `$` 自身不是名字
    expect(labelScopeAt(TEXT, PATH, 2, 1)).toBeNull();
  });

  it('大小写不敏感：`goto next` 命中 `$Next`，展示保留各处原形', () => {
    const scope = labelScopeAt('@F\n$Next\n\tgoto next\n', PATH, 3, 7);
    expect(scope?.name).toBe('Next');
    expect(scope?.occurrences.map((o) => o.name)).toEqual(['Next', 'next']);
  });

  it('CJK 标签名：定义与跳转都认（Unicode 记号集）', () => {
    const scope = labelScopeAt('@F\n$开始\n\tGOTO 开始\n', PATH, 3, 7);
    expect(scope?.normalizedName).toBe('开始');
    expect(scope?.occurrences.map((o) => [o.line, o.kind])).toEqual([
      [2, 'definition'],
      [3, 'jump'],
    ]);
  });

  it('跨函数不认：标签是函数局部作用域', () => {
    expect(labelScopeAt('@F\n$NEXT\n@G\n\tGOTO NEXT\n', PATH, 4, 7)).toBeNull();
  });

  it('动态目标不认：`(X)` / `{X}` / `%X%` / 成员访问', () => {
    expect(labelScopeAt('@F\n$NEXT\n\tGOTO (NEXT)\n', PATH, 3, 8)).toBeNull();
    expect(labelScopeAt('@F\n$NEXT\n\tGOTO {NEXT}\n', PATH, 3, 8)).toBeNull();
    expect(labelScopeAt('@F\n$NEXT\n\tGOTO %NEXT%\n', PATH, 3, 9)).toBeNull();
    expect(labelScopeAt('@F\n$NEXT\n\tGOTO FLAG:NEXT\n', PATH, 3, 7)).toBeNull();
  });

  it('[SKIPSTART] 区内的定义不认、跳转不计', () => {
    const text = '@F\n$NEXT\n[SKIPSTART]\n\tGOTO NEXT\n[SKIPEND]\n\tGOTO NEXT\n';
    const scope = labelScopeAt(text, PATH, 6, 7);
    expect(scope?.occurrences.map((o) => [o.line, o.kind])).toEqual([
      [2, 'definition'],
      [6, 'jump'],
    ]);
    // 定义在禁用区 ⇒ 跳转目标无从证明
    expect(labelScopeAt('@F\n[SKIPSTART]\n$NEXT\n[SKIPEND]\n\tGOTO NEXT\n', PATH, 5, 7)).toBeNull();
  });

  it('siblingNames：同函数内其它标签（大小写归一、去重、保留首个原形）', () => {
    const text = '@F\n$Next\n$OTHER\n$other\n\tGOTO NEXT\n';
    expect(labelScopeAt(text, PATH, 5, 7)?.siblingNames).toEqual(['OTHER']);
  });

  it('形状不整的标签名不认（含标点 / 裸数字），避免改名误伤', () => {
    expect(labelScopeAt('@F\n$FOO(BAR)\n\tGOTO FOO\n', PATH, 2, 2)).toBeNull();
    expect(labelScopeAt('@F\n$123\n\tGOTO 123\n', PATH, 2, 2)).toBeNull();
  });
});

describe('definitionTargetsAt · 标签定义自跳与跳转目标', () => {
  const TEXT = '@F\n$NEXT\n\tPRINTL A\n\tGOTO NEXT\n';

  it('光标在 `$NEXT` 定义名上 → 定义自跳（不再落函数名腿）', () => {
    const index = idx({ NEXT: [fnRef('NEXT')] });
    expect(definitionTargetsAt(index, PATH, TEXT, 2, 3)).toEqual([
      { name: 'NEXT', normalizedName: 'NEXT', filePath: PATH, startLine: 2, endLine: 2 },
    ]);
  });

  it('跳转目标 → 本函数标签定义；CJK 同样命中', () => {
    expect(definitionTargetsAt(idx(), PATH, TEXT, 4, 7)).toEqual([
      { name: 'NEXT', normalizedName: 'NEXT', filePath: PATH, startLine: 2, endLine: 2 },
    ]);
    expect(definitionTargetsAt(idx(), PATH, '@F\n$开始\n\tGOTO 开始\n', 3, 7)).toEqual([
      { name: '开始', normalizedName: '开始', filePath: PATH, startLine: 2, endLine: 2 },
    ]);
  });

  it('四个跳转关键字同判据', () => {
    for (const word of ['JUMP', 'GOTO', 'TRYJUMP', 'TRYGOTO']) {
      const text = `@F\n$NEXT\n\t${word} NEXT\n`;
      expect(definitionTargetsAt(idx(), PATH, text, 3, word.length + 3)?.[0]?.startLine).toBe(2);
    }
  });

  it('跳转槽找不到标签 → 空数组，绝不落到函数名（哪怕同名函数在索引里）', () => {
    const index = idx({ ALPHA: [fnRef('ALPHA')] });
    expect(definitionTargetsAt(index, PATH, '@F\n\tGOTO ALPHA\n', 2, 7)).toEqual([]);
  });

  it('动态目标里的记号也不落函数名', () => {
    const index = idx({ X: [fnRef('X')] });
    expect(definitionTargetsAt(index, PATH, '@F\n\tGOTO (X)\n', 2, 8)).toEqual([]);
    expect(definitionTargetsAt(index, PATH, '@F\n\tGOTO FLAG:X\n', 2, 7)).toEqual([]);
  });

  it('光标在跳转关键字自身 → 空（关键字不是收录名）', () => {
    expect(definitionTargetsAt(idx(), PATH, '@F\n\tGOTO NEXT\n', 2, 3)).toEqual([]);
  });

  it('非跳转行照旧走函数名腿（回归：CALL FOO）', () => {
    const index = idx({ FOO: [fnRef('FOO')] });
    expect(definitionTargetsAt(index, PATH, '@F\n\tCALL FOO\n', 2, 7)).toEqual([fnRef('FOO')]);
  });

  it('`$FOO(BAR)` 这类定义名不让位给同名函数', () => {
    const index = idx({ FOO: [fnRef('FOO')] });
    expect(definitionTargetsAt(index, PATH, '@F\n$FOO(BAR)\n', 2, 2)).toEqual([]);
  });
});
