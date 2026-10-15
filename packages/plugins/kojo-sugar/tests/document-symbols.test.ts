/**
 * `.kojo` 文档大纲（B3）单测。
 *
 * 走**真解析器**（`sugar.transpile`.`parse`）而不是手搓 AST：大纲的全部价值建立在
 * "节点 `loc` 与源行对得上"这件事上，手搓 AST 只能证明映射函数自洽，证明不了行号。
 * 装配面（贡献确实注册、`.kojo` 之外不认）在 `language-service.test.ts`。
 */

import { describe, expect, it } from 'vitest';
import type { EditorDocumentSymbol, KojoFaceTable } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { kojoDocumentSymbols } from '../src/document-symbols';
import { stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ faceTable: stubFaceTable() as KojoFaceTable });

const symbols = (src: string) => kojoDocumentSymbols(svc().parse(src, { filePath: 'C:\\p\\a.kojo' }));

/** [名称, 起行, 止行] —— 大纲断言就读这个三元组 */
const shape = (symbol: EditorDocumentSymbol): [string, number, number] => [
  symbol.name,
  symbol.startLine,
  symbol.endLine,
];

/** 大纲树的基本不变量：父含子、子不重叠（Monaco 与吸顶都按这个假设渲染） */
const assertContained = (symbols: readonly EditorDocumentSymbol[], within?: [number, number]): void => {
  for (const symbol of symbols) {
    if (within) {
      expect(symbol.startLine).toBeGreaterThanOrEqual(within[0]);
      expect(symbol.endLine).toBeLessThanOrEqual(within[1]);
    }
    assertContained(symbol.children ?? [], [symbol.startLine, symbol.endLine]);
  }
};

describe('kojo-sugar · 文档大纲（documentSymbol）', () => {
  it('纯头声明文件 → 空大纲（认这个文件，但不编结构）', () => {
    expect(symbols('角色: 12\n')).toEqual([]);
  });

  it('一个时机块 = 一条顶层项（区间含到块尾）', () => {
    const [timing] = symbols('角色: 12\n时机 指令 310：\n    「嗯。」\n    「哦？」\n');
    expect(shape(timing!)).toEqual(['时机 指令 310', 2, 5]);
    expect(timing!.kind).toBe('function');
  });

  it('层次：如果分支 / 当分支 / 选项条目各成子项，父项区间含得住子项', () => {
    const src = [
      '角色: 12',
      '时机 指令 310：', // 2
      '    如果 教養 > 30：', // 3
      '        「乙」', // 4
      '    否则：', // 5
      '        「丙」', // 6
      '    当 TFLAG:193：', // 7
      '        是 1：', // 8
      '            「丁」', // 9
      '        否则：', // 10
      '            「戊」', // 11
      '    选项：', // 12
      '        「继续」：', // 13
      '            「己」', // 14
      '',
    ].join('\n');
    const [timing] = symbols(src);
    expect(timing!.name).toBe('时机 指令 310');
    const children = timing!.children ?? [];
    expect(children.map((c) => [c.name, c.kind, c.startLine, c.endLine])).toEqual([
      ['如果 教養 > 30', 'block', 3, 6],
      ['当 TFLAG:193', 'block', 7, 11],
      ['选项', 'block', 12, 14],
    ]);
    expect((children[0]!.children ?? []).map(shape)).toEqual([
      ['如果 教養 > 30', 3, 4],
      ['否则', 5, 6],
    ]);
    expect((children[1]!.children ?? []).map(shape)).toEqual([
      ['是 1', 8, 9],
      ['否则', 10, 11],
    ]);
    expect((children[2]!.children ?? []).map(shape)).toEqual([['「继续」', 13, 14]]);
    assertContained(symbols(src));
  });

  it('段块成节；`若 …（关）` 标"停用"；命名参数进副标题（副标题只解释，不改名）', () => {
    const [named] = symbols('角色: 12\n时机 指令 310 成否: 游戏判定：\n    「甲」\n');
    expect(named).toMatchObject({ name: '时机 指令 310', detail: '成否: 游戏判定' });
    const [timing] = symbols(
      '角色: 12\n时机 指令 310：\n    若 NOWEX:噴乳：\n        「甲」\n    若 TFLAG:193（关）：\n        「乙」\n',
    );
    expect((timing!.children ?? []).map((c) => [c.name, c.kind, c.detail])).toEqual([
      ['若 NOWEX:噴乳', 'section', undefined],
      ['若 TFLAG:193', 'section', '停用'],
    ]);
  });

  it('台词行与注释不进大纲（大纲是层次导航，不是第二份正文）', () => {
    const [timing] = symbols('角色: 12\n时机 指令 310：\n    ; 分节线\n    「甲」\n    TFLAG:192 = 0\n');
    expect(timing!.children).toBeUndefined();
  });

  it('别名声明 / 用户函数 / 原生直通块都收（顶层结构一个不漏）', () => {
    const src = [
      '角色: 12',
      '别名 她的态度 = CALLNAME:12',
      '函数 我的检查(值)：',
      '    返回 值 > 10',
      '@RAW_HEAD(ARGS)',
      '    RETURN 1',
      '',
    ].join('\n');
    const out = symbols(src);
    expect(out.map(shape)).toEqual([
      ['别名 她的态度', 2, 2],
      ['函数 我的检查', 3, 4],
      ['@RAW_HEAD(ARGS)', 5, 7],
    ]);
    expect(out[0]!.kind).toBe('declaration');
    expect(out[1]!.detail).toBe('(值)');
  });

  it('用户函数形参默认值进大纲 detail（`函数 甲(次数 = 1, 名字)：` → `(次数 = 1, 名字)`）', () => {
    const src = ['角色: 12', '函数 甲(次数 = 1, 名字)：', '    返回 名字', ''].join('\n');
    expect(symbols(src)[0]!.detail).toBe('(次数 = 1, 名字)');
    // 无默认值的形参（既有口径）不带 `=`，产物逐字不变
    expect(symbols('角色: 12\n函数 乙(值)：\n    返回 值\n')[0]!.detail).toBe('(值)');
  });

  it('空 children 一律摘掉（Monaco 会画成点不开的假箭头）', () => {
    const [timing] = symbols('角色: 12\n时机 指令 310：\n    随机：\n        「甲」\n        「乙」\n');
    const random = (timing!.children ?? [])[0];
    expect(random).toMatchObject({ name: '随机', startLine: 3 });
    expect((random!.children ?? []).map((c) => c.name)).toEqual(['候选 1', '候选 2']);
    expect(random!.children?.[0]?.children).toBeUndefined();
  });

  it('长条件截断带省略号（大纲一行一项，不许折行）', () => {
    const long = `角色: 12\n时机 指令 310：\n    若 ${'条'.repeat(90)}：\n        「甲」\n`;
    const name = symbols(long)[0]!.children?.[0]?.name ?? '';
    expect(name.length).toBeLessThanOrEqual(70);
    expect(name.endsWith('…')).toBe(true);
  });
});
