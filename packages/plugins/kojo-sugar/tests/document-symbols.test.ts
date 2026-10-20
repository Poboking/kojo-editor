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

  it('段块成节；命名参数进副标题（副标题只解释，不改名）', () => {
    const [named] = symbols('角色: 12\n时机 指令 310 成否: 游戏判定：\n    「甲」\n');
    expect(named).toMatchObject({ name: '时机 指令 310', detail: '成否: 游戏判定' });
    const [timing] = symbols(
      '角色: 12\n时机 指令 310：\n    若 NOWEX:噴乳：\n        「甲」\n    若 TFLAG:193：\n        「乙」\n',
    );
    expect((timing!.children ?? []).map((c) => [c.name, c.kind, c.detail])).toEqual([
      ['若 NOWEX:噴乳', 'section', undefined],
      ['若 TFLAG:193', 'section', undefined],
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

  it('分支：规则池成块，每条分支一个子项（大纲名与 如果/否则如果/否则 同源）', () => {
    const src = [
      '角色: 12', // 1
      '时机 指令 310：', // 2
      '    分支：', // 3
      '        [她的恋慕 >= 30]', // 4
      '            「甲」', // 5
      '            她侧过身。', // 6
      '        [她的反発刻印 超过 1]', // 7
      '            「乙」', // 8
      '        [其他]', // 9
      '            「丙」', // 10
      '    「丁」', // 11
      '',
    ].join('\n');
    const [timing] = symbols(src);
    const pool = (timing!.children ?? [])[0]!;
    expect([pool.name, pool.kind, pool.startLine, pool.endLine]).toEqual(['分支', 'block', 3, 10]);
    // 分支名走 `ifBranchName` 同一枚函数：按**书写顺序**取 `如果` / `否则如果` / `否则`
    // （§3.11 的自动重排只发生在产物侧，大纲说的这一行就是源码这一行写了什么）
    expect((pool.children ?? []).map(shape)).toEqual([
      ['如果 她的恋慕 >= 30', 4, 6],
      ['否则如果 她的反発刻印 超过 1', 7, 8],
      ['否则', 9, 10],
    ]);
    expect(pool.children?.[0]?.children).toBeUndefined();
    assertContained(symbols(src));
  });

  it('分支：的英文别名块头 `branch:` 与 `[else]` 出同一张中文大纲（作者面零机器名）', () => {
    const src = [
      '角色: 12', // 1
      '时机 指令 310：', // 2
      '    branch:', // 3
      '        [她的好感度 >= 100]', // 4
      '            「甲」', // 5
      '        [else]', // 6
      '            「乙」', // 7
      '',
    ].join('\n');
    const pool = (symbols(src)[0]!.children ?? [])[0]!;
    expect([pool.name, pool.startLine, pool.endLine]).toEqual(['分支', 3, 7]);
    expect((pool.children ?? []).map((c) => c.name)).toEqual(['如果 她的好感度 >= 100', '否则']);
    // 作者面（每一枚大纲名）不许出现转译器机器名
    const names: string[] = [];
    const walk = (list: readonly EditorDocumentSymbol[]): void => {
      for (const s of list) {
        names.push(s.name);
        walk(s.children ?? []);
      }
    };
    walk(symbols(src));
    expect(names.filter((name) => /rulepool|branch_head|rule_tag|block\.branch/i.test(name))).toEqual([]);
  });

  it('心形：成一枚叶子（块体只许文本行与注释——按顶层同一判据都不进大纲）', () => {
    const src = [
      '角色: 12', // 1
      '时机 指令 310：', // 2
      '    心形：', // 3
      '        「甲」', // 4
      '        她侧过身。', // 5
      '    「乙」', // 6
      '',
    ].join('\n');
    const [timing] = symbols(src);
    const heart = (timing!.children ?? [])[0]!;
    expect([heart.name, heart.kind, heart.startLine, heart.endLine]).toEqual(['心形', 'block', 3, 5]);
    // 块体没有结构节点 ⇒ 不许留空 `children`（Monaco 会画成点不开的假箭头）
    expect(heart.children).toBeUndefined();
    assertContained(symbols(src));
  });

  it('心形：的英文块头 `heart:` 出同一张中文大纲（族名按中文给，与 `branch:` 同一口径）', () => {
    const src = ['角色: 12', '时机 指令 310：', '    heart:', '        「甲」', ''].join('\n');
    const heart = (symbols(src)[0]!.children ?? [])[0]!;
    expect([heart.name, heart.startLine, heart.endLine]).toEqual(['心形', 3, 4]);
  });

  it('循环：成块，区间含收束行，块体里的族各成子项（循环体内的 如果 此前整族不可见）', () => {
    const src = [
      '角色: 12', // 1
      '时机 指令 310：', // 2
      '    循环 计数 I 从 0 到 2：', // 3
      '        「甲」', // 4
      '        如果 教養 > 30：', // 5
      '            「乙」', // 6
      '    循环结束', // 7
      '    循环 3 次：', // 8
      '        「丙」', // 9
      '    「丁」', // 10
      '',
    ].join('\n');
    const [timing] = symbols(src);
    const loops = (timing!.children ?? []).filter((c) => c.name === '循环');
    expect(loops.map((c) => [c.name, c.kind, c.startLine, c.endLine])).toEqual([
      // 写了 `循环结束` ⇒ 收束行属于这一块（折叠要连它一起藏），区间 3..7
      ['循环', 'block', 3, 7],
      // 没写收束行（缩进收口是糖的既有纪律）⇒ 只到正文末行
      ['循环', 'block', 8, 9],
    ]);
    // 块体里的结构族照 `组` / `着色` 的口径成为子项：台词行不进大纲，`如果` 要进
    expect((loops[0]!.children ?? []).map(shape)).toEqual([['如果 教養 > 30', 5, 6]]);
    expect(loops[1]!.children).toBeUndefined();
    assertContained(symbols(src));
  });

  it('收束形与开块模态不配对的 循环 块仍在大纲里（报错进 diagnostics，大纲不跟着静默）', () => {
    // `循环 计数 …：` 配的闭合词 `NEXT` 不吃条件 ⇒ parser 报 error、codegen 一条字节都不产；
    // 但源码确实写了这一块，大纲按源码给（与 `分支：` 池级校验失败的同一口径）。
    const src = [
      '角色: 12', // 1
      '时机 指令 310：', // 2
      '    循环 计数 I 从 0 到 3：', // 3
      '        「甲」', // 4
      '    循环结束 当 1', // 5
      '',
    ].join('\n');
    const loop = (symbols(src)[0]!.children ?? [])[0]!;
    expect([loop.name, loop.kind, loop.startLine, loop.endLine]).toEqual(['循环', 'block', 3, 5]);
  });

  it('循环 块嵌在别的块里：收束行算进外层区间（区间口径一处定，两族一起对）', () => {
    const src = [
      '角色: 12', // 1
      '时机 指令 310：', // 2
      '    着色 0xFF8080：', // 3
      '        循环 3 次：', // 4
      '            「甲」', // 5
      '        循环结束', // 6
      '',
    ].join('\n');
    const color = (symbols(src)[0]!.children ?? [])[0]!;
    expect([color.name, color.startLine, color.endLine]).toEqual(['着色 0xFF8080', 3, 6]);
    expect((color.children ?? []).map(shape)).toEqual([['循环', 4, 6]]);
    assertContained(symbols(src));
  });

  it('数据表：成一枚叶子、区间含收束行；出错处理：成块且块体里的族各成子项', () => {
    const src = [
      '角色: 12', // 1
      '时机 指令 310：', // 2
      '    数据表：', // 3
      '        条目 「甲」', // 4
      '        条目 原形 PRINTDATADL 「乙」', // 5
      '    数据表结束', // 6
      '    出错处理：', // 7
      '        「丙」', // 8
      '        如果 教養 > 30：', // 9
      '            「丁」', // 10
      '    出错处理结束', // 11
      '    「戊」', // 12
      '',
    ].join('\n');
    const children = symbols(src)[0]!.children ?? [];
    expect(children.map((c) => [c.name, c.kind, c.startLine, c.endLine])).toEqual([
      // 条目行（数据）按顶层同一判据不进大纲 ⇒ 叶子；收束行 `数据表结束` 属于这一块
      ['数据表', 'block', 3, 6],
      // 出错处理的块体是语句 ⇒ 形状照 `组`：块一枚 + 块体里的族各成子项
      ['出错处理', 'block', 7, 11],
    ]);
    expect(children[0]!.children).toBeUndefined();
    expect((children[1]!.children ?? []).map(shape)).toEqual([['如果 教養 > 30', 9, 10]]);
    assertContained(symbols(src));
  });

  it('没写收束行的 数据表 / 出错处理 只到正文末行（收束行可选，与 循环 同口径）', () => {
    const src = [
      '角色: 12', // 1
      '时机 指令 310：', // 2
      '    数据表：', // 3
      '        条目 「甲」', // 4
      '    出错处理：', // 5
      '        「乙」', // 6
      '',
    ].join('\n');
    const children = symbols(src)[0]!.children ?? [];
    expect(children.map(shape)).toEqual([
      ['数据表', 3, 4],
      ['出错处理', 5, 6],
    ]);
  });

  it('询问： / 确认：成块，每条「标签」一个子项（与 选项 / 菜单 同构）', () => {
    const src = [
      '角色: 12', // 1
      '时机 指令 310：', // 2
      '    询问 "要不要一起？"：', // 3
      '        「好呀」 1：', // 4
      '            「嗯！」', // 5
      '        「下次吧」 0：', // 6
      '            「……算了。」', // 7
      '    ask "英文别名："：', // 8
      '        「要」 1：', // 9
      '            「那就开始吧。」', // 10
      '    确认 "要开启了吗？"：', // 11
      '        「开启」：', // 12
      '            「好。」', // 13
      '    confirm "英文别名："：', // 14
      '        「是」：', // 15
      '            「嗯。」', // 16
      '',
    ].join('\n');
    const children = symbols(src)[0]!.children ?? [];
    expect(children.map((c) => [c.name, c.kind, c.startLine, c.endLine])).toEqual([
      ['询问', 'block', 3, 7],
      ['询问', 'block', 8, 10],
      ['确认', 'block', 11, 13],
      ['确认', 'block', 14, 16],
    ]);
    expect((children[0]!.children ?? []).map(shape)).toEqual([
      ['「好呀」', 4, 5],
      ['「下次吧」', 6, 7],
    ]);
    expect((children[1]!.children ?? []).map(shape)).toEqual([['「要」', 9, 10]]);
    expect((children[2]!.children ?? []).map(shape)).toEqual([['「开启」', 12, 13]]);
    expect((children[3]!.children ?? []).map(shape)).toEqual([['「是」', 15, 16]]);
    // 作者面（每一枚大纲名）不许出现英文块头 / 契约机器名：中文族名按族给
    const names: string[] = [];
    const walk = (list: readonly EditorDocumentSymbol[]): void => {
      for (const s of list) {
        names.push(s.name);
        walk(s.children ?? []);
      }
    };
    walk(symbols(src));
    expect(names.filter((name) => /ask|confirm|Block/.test(name))).toEqual([]);
    assertContained(symbols(src));
  });

  it('长条件截断带省略号（大纲一行一项，不许折行）', () => {
    const long = `角色: 12\n时机 指令 310：\n    若 ${'条'.repeat(90)}：\n        「甲」\n`;
    const name = symbols(long)[0]!.children?.[0]?.name ?? '';
    expect(name.length).toBeLessThanOrEqual(70);
    expect(name.endsWith('…')).toBe(true);
  });
});
