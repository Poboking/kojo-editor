import { afterEach, afterAll, describe, expect, it } from 'vitest';
import { encodeErbStructureTokens } from '../src/monaco/tree-sitter/erb-semantic';
import { lostStructureSpans } from '../src/monaco/tree-sitter/structure-runtime';
import {
  FIXTURE,
  disposeAllEngines,
  errorReplies,
  lastReply,
  resetFacetLedgers,
  runEngine,
} from './helpers/erb-ts-facets-kit';

/**
 * ERB-TS-FULL 面②：引擎的语义 / 缩进 / 折叠四面回话（真 wasm）。
 * 拆文件批（2026-10-28）：引擎的 `afterEach` 真 teardown 从模块级挪到每面各自注册——
 * 同一份 worker 里攒十几台 StructureEngine 就是 `Fatal process out of memory: Zone` 的主凶。
 *
 * 2026-11-07 再拆第二刀：结构诊断 / 捕获注入 / 运行时常量七例搬到
 * `erb-ts-facets-engine-structure.test.ts`。`web-tree-sitter` 0.27 的 `Language` 没有 free
 * API ⇒ 装载次数（不是引擎台数）才是阈值；本枚 8 次、那一枚 6 次（详见 PITFALLS §249）。
 * 用例名与断言一字未改，两枚合计与拆前逐字相等。
 */

afterEach(disposeAllEngines);
afterAll(resetFacetLedgers);

/* ======================================================================== */
/* ② runtime facets：引擎的语义 / 缩进 / 折叠 / 诊断四面                       */
/* ======================================================================== */

describe('ERB 引擎 facets · 真 wasm 的四面回话', () => {
  it('三份查询齐全时四面都活（semantic / folds / indent / syntax）', async () => {
    const { engine, replies } = await runEngine(FIXTURE);
    expect(engine.capabilities).toEqual(expect.arrayContaining(['semantic', 'folds', 'indent', 'syntax']));
    expect(replies.some((r) => r.type === 'semantic')).toBe(true);
    expect(replies.some((r) => r.type === 'folds')).toBe(true);
    expect(replies.some((r) => r.type === 'indent')).toBe(true);
    expect(replies.some((r) => r.type === 'syntax')).toBe(true);
    expect(errorReplies(replies)).toEqual([]);
  });

  it('语义 token 分档：注释 / 指令 / 函数名 / 标签 / 控制行 / 串 / 插值 / 停用区原文', async () => {
    const { replies } = await runEngine(FIXTURE);
    const semantic = lastReply(replies, 'semantic');
    if (!semantic) throw new Error('没有 semantic 回话');
    const byLine = new Map<number, Set<string>>();
    for (const t of semantic.tokens) {
      if (!byLine.has(t.startRow)) byLine.set(t.startRow, new Set());
      byLine.get(t.startRow)!.add(t.tier);
    }
    expect(byLine.get(0)).toContain('role.comment');
    expect(byLine.get(1)).toContain('role.directive');
    expect(byLine.get(2)).toContain('role.decl');
    expect(byLine.get(3)).toContain('role.label');
    expect(byLine.get(4)).toContain('role.directive');
    expect(byLine.get(5)).toContain('role.engine');
    expect(byLine.get(8)).toContain('role.string');
    expect(byLine.get(8)).toContain('role.interp');
    expect(semantic.tokens.some((t) => t.tier === 'role.raw')).toBe(true);
    const histogram = new Map<string, number>();
    for (const t of semantic.tokens) histogram.set(t.tier, (histogram.get(t.tier) ?? 0) + 1);
    console.log(`[erb-ts-facets] semantic tokens=${semantic.tokens.length} 分档=${JSON.stringify(Object.fromEntries(histogram))}`);
  });

  /**
   * 第三色批（2026-10-27）的**取证用例**：`support.type` 这一档不是"theme 里有这个键"就算数，
   * 得在真 wasm + 真查询上把 `#DIM` 的型 / 存储限定词**逐列**打出来。
   *
   * 样本写形照真语料（eraTW 系语料实测：38,608 条 `#DIM` 族声明行里 11,521 行带限定词，
   * 共 11,896 枚，分布在 992 份文件；高频词 `CONST` 4,317 / `DYNAMIC` 3,664 / `CHARA` 1,530 /
   * `SAVEDATA` 1,055 / `REF` 853）。真盘路径不入仓，只走 `tools/corpus.mjs` 的环境变量。
   */
  it('#DIM 的型 / 存储限定词单独吃类型档，同一行的声明词与声明名各归各档', async () => {
    const { replies } = await runEngine(
      ['#DIM CONST GLOBAL 心, 10', '#DIM DYNAMIC 计数', '#DIM 名字, 3', ''].join('\n'),
    );
    const semantic = lastReply(replies, 'semantic');
    if (!semantic) throw new Error('没有 semantic 回话');
    const typed = semantic.tokens.filter((t) => t.tier === 'role.type');
    const text = ['#DIM CONST GLOBAL 心, 10', '#DIM DYNAMIC 计数', '#DIM 名字, 3', ''];
    const at = (t: (typeof typed)[number]): string =>
      text[t.startRow]!.slice(t.startCol, t.endCol).trim();
    // `dim_modifier` 的记号形是"词 + 其后至少一个空白"（语法层的 DIM_MODIFIER 就是这么切的），
    // 所以跨度带一个尾随空格；涂在空格上没有视觉差，判据只看词本身。
    expect(typed.map(at), '类型档打出的词').toEqual(['CONST', 'GLOBAL', 'DYNAMIC']);
    // 同一行的其余部分**一档不许糊平**：声明词仍走预处理档，作者写的名字不涂色
    expect(semantic.tokens.filter((t) => t.startRow === 0).map((t) => t.tier)).toEqual(
      expect.arrayContaining(['role.directive']),
    );
    expect(semantic.tokens.some((t) => t.tier === 'role.type' && at(t) === '心')).toBe(false);
    // 第三枚 `#DIM 名字, 3` 没有任何限定词 ⇒ 该行零类型格（判据不是"有 #DIM 就涂"）
    expect(typed.some((t) => t.startRow === 2)).toBe(false);
    console.log(`[erb-ts-facets] role.type 命中=${typed.length} ${typed.map(at).join(',')}`);
  });

  it('语义 token 的坐标落在捕获节点上（IF 行从行首缩进起、串从引号起）', async () => {
    const { replies } = await runEngine(FIXTURE);
    const semantic = lastReply(replies, 'semantic');
    if (!semantic) throw new Error('没有 semantic 回话');
    const ifToken = semantic.tokens.find((t) => t.startRow === 5 && t.tier === 'role.engine');
    expect(ifToken).toMatchObject({ startCol: 4, endRow: 5, endCol: 14 });
    const stringToken = semantic.tokens.find((t) => t.startRow === 8 && t.tier === 'role.string');
    expect(stringToken?.startCol).toBe(19);
  });

  it('编码：真语法下裸控制词（ENDIF / RETURN）不再白记空区间', async () => {
    const text = 'IF X\n  PRINTL hi\nENDIF\nRETURN 1\n';
    const { replies } = await runEngine(text);
    const semantic = lastReply(replies, 'semantic');
    if (!semantic) throw new Error('没有 semantic 回话');
    const lines = text.split('\n');
    const encoded = encodeErbStructureTokens(semantic.tokens, {
      lineCount: lines.length,
      maxColumn: (lineNumber) => (lines[lineNumber - 1] ?? '').length + 1,
    });
    console.log(
      `[erb-ts-facets] 编码：spans=${encoded.data.length / 5} droppedEmpty=${encoded.droppedEmpty} lost=${lostStructureSpans(encoded)}`,
    );
    expect(encoded.data.length).toBeGreaterThan(0);
    expect(encoded.droppedEmpty).toBe(0);
    expect(lostStructureSpans(encoded)).toBe(0);
  });

  it('缩进：begin/end/enter 翻成关键字行首锚（不把条件原文写进规则）', async () => {
    const { replies } = await runEngine(FIXTURE);
    const indent = lastReply(replies, 'indent');
    if (!indent) throw new Error('没有 indent 回话');
    const rules = indent.rules;
    const test = (sources: readonly string[], line: string) => sources.some((s) => new RegExp(s).test(line));
    expect(test(rules.increasePatterns, '  IF A AND B')).toBe(true);
    expect(test(rules.increasePatterns, ' if x')).toBe(true); // 大小写不敏感
    expect(test(rules.increasePatterns, '　SELECTCASE A')).toBe(true); // 全角空白缩进
    expect(test(rules.increasePatterns, 'IFX')).toBe(false); // 词形边界
    expect(test(rules.increasePatterns, '        ELSE')).toBe(true); // 分支同抬
    expect(test(rules.decreasePatterns, '    ENDIF')).toBe(true);
    expect(test(rules.decreasePatterns, 'ENDIFX')).toBe(false);
    expect(test(rules.enterPatterns, '        SIF A > 1')).toBe(true);
    for (const source of [...rules.increasePatterns, ...rules.decreasePatterns, ...rules.enterPatterns]) {
      expect(source).not.toContain('A AND B');
      expect(source.startsWith('^')).toBe(true);
    }
    console.log(`[erb-ts-facets] indent rules：increase=${rules.increasePatterns.length} decrease=${rules.decreasePatterns.length} enter=${rules.enterPatterns.length}`);
  });

  it('缩进规则稳定：只改条件文本，规则集合不变（下一份文档不失效）', async () => {
    const a = await runEngine('IF ALPHA\n  PRINTL a\nENDIF\n');
    const b = await runEngine('IF BETA > 3\n  PRINTL b\nENDIF\n');
    const ra = lastReply(a.replies, 'indent')!.rules;
    const rb = lastReply(b.replies, 'indent')!.rules;
    expect(ra).toEqual(rb);
  });

  it('结构诊断：未配对块 ⇒ 一条 unclosed-block（落点 = 块头行、带收束记号名）', async () => {
    const { replies } = await runEngine('IF X\n  PRINTL hi\n');
    const syntax = lastReply(replies, 'syntax');
    if (!syntax) throw new Error('没有 syntax 回话');
    expect(syntax.faults).toHaveLength(1);
    expect(syntax.faults[0]).toMatchObject({
      row: 0,
      kind: 'unclosed-block',
      expectedToken: 'endif_line',
      blockHeadText: 'IF X',
      faultRow: 2,
    });
    console.log(`[erb-ts-facets] syntax unclosed-block=${JSON.stringify(syntax.faults[0])}`);
  });
});
