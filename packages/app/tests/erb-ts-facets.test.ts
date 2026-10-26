import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, Query } from 'web-tree-sitter';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERB_BRACKET_PAIRS, ERB_LANGUAGE_ID, ERB_QUOTE_PAIR, registerErbLanguage } from '../src/monaco/erb-language';
import { erbEnterRulePatterns } from '../src/monaco/erb-enter';
import type * as Monaco from '../src/monaco/entry';
import {
  erbBaseIndentPatterns,
  erbMergedIndentConfig,
} from '../src/monaco/tree-sitter/erb-indent';
import { erbIndentPattern } from '../src/monaco/tree-sitter/erb-indent-patterns';
import {
  ERB_SEMANTIC_CAPTURE_TIERS,
  erbCaptureTier,
  erbSemanticTiers,
} from '../src/monaco/tree-sitter/erb-tiers';
import {
  ERB_SEMANTIC_FACET,
  ERB_SEMANTIC_LEGEND,
  createErbSemanticTokensProvider,
  encodeErbStructureTokens,
  registerErbSemanticTokensProvider,
  resetErbSemanticWarnings,
  splitErbStructureTokens,
} from '../src/monaco/tree-sitter/erb-semantic';
import { ERB_STRUCTURE_RUNTIME } from '../src/monaco/tree-sitter/erb-runtime';
import {
  erbCstDiagnostics,
  erbMissingName,
  erbSkipTagDiagnostics,
  erbStructureDiagnostics,
} from '../src/monaco/tree-sitter/erb-diagnostics';
import { StructureEngine, type StructureEngineAssets } from '../src/monaco/tree-sitter/engine';
import {
  degradationNoticeText,
  onStructureDegradation,
  resetStructureDegradationLedger,
} from '../src/monaco/tree-sitter/fallback';
import { lostStructureSpans } from '../src/monaco/tree-sitter/structure-runtime';
import { disposeStructureOverlay, installStructureOverlay, structureOverlayLanguageStates } from '../src/monaco/tree-sitter/providers';
import type { LanguageDescriptor } from '../src/monaco/language-registry';
import type {
  KojoStructureIndentRules,
  KojoStructureReply,
  KojoStructureToken,
} from '../src/monaco/tree-sitter/types';
import { decodeWithMonaco } from './helpers/monaco-semantic-decode';

/**
 * ERB-TS-FULL：ERB 结构层的四面（折叠 + 语义着色 + 缩进 + 结构诊断）。
 *
 * 真 wasm + 真查询（`packages/erb-syntax-tree/tree-sitter-erb.wasm` 与 `queries/*.scm`）在这里
 * 跑完整链路：查询编译 → CST 捕获 → 引擎回话 → 宿主编码 / 缩进合并 / 诊断映射。
 * 与 perf 池的分工：本文件判**形状与口径**（读数用 console.log 打出来），耗时不设阈值。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const ERB_PKG = join(repoRoot, 'packages', 'erb-syntax-tree');
const RUNTIME_WASM = join(repoRoot, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');

const readQuery = (name: string): string => readFileSync(join(ERB_PKG, 'queries', `${name}.scm`), 'utf8');
const grammarWasm = (): Buffer => readFileSync(join(ERB_PKG, 'tree-sitter-erb.wasm'));

let language: Language;

beforeAll(async () => {
  await Parser.init({ locateFile: () => RUNTIME_WASM });
  language = await Language.load(grammarWasm());
});

/* ------------------------------ 查询 / CST 工具 ------------------------------ */

function compileQuery(name: string): Query {
  return new Query(language, readQuery(name));
}

function parseErb(text: string) {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(text);
  if (tree === null) throw new Error('ERB 解析器没有产出语法树');
  return tree;
}

function capturesOf(name: string, text: string) {
  return compileQuery(name).captures(parseErb(text).rootNode);
}

/* -------------------------------- 引擎工具 -------------------------------- */

const liveEngines: StructureEngine[] = [];

function makeEngine(overrides: Partial<StructureEngineAssets> = {}): {
  engine: StructureEngine;
  replies: KojoStructureReply[];
} {
  const replies: KojoStructureReply[] = [];
  const engine = new StructureEngine({
    assets: {
      runtimeWasm: RUNTIME_WASM,
      grammarWasm: grammarWasm(),
      foldsQuery: readQuery('folds'),
      highlightsQuery: readQuery('highlights'),
      indentsQuery: readQuery('indents'),
      captureTier: erbCaptureTier,
      indentPattern: erbIndentPattern,
      ...overrides,
    },
    emit: (reply) => replies.push(reply),
  });
  liveEngines.push(engine);
  return { engine, replies };
}

async function runEngine(text: string, overrides: Partial<StructureEngineAssets> = {}) {
  const { engine, replies } = makeEngine(overrides);
  const ok = await engine.init();
  expect(ok).toBe(true);
  engine.parse(7, 1, text);
  return { engine, replies };
}

function lastReply<T extends KojoStructureReply['type']>(
  replies: readonly KojoStructureReply[],
  type: T,
): Extract<KojoStructureReply, { type: T }> | undefined {
  return replies.filter((reply): reply is Extract<KojoStructureReply, { type: T }> => reply.type === type).at(-1);
}

const errorReplies = (replies: readonly KojoStructureReply[]) =>
  replies.filter((reply) => reply.type === 'error') as Extract<KojoStructureReply, { type: 'error' }>[];

afterEach(() => {
  while (liveEngines.length > 0) liveEngines.pop()!.dispose();
});

/* --------------------------------- 夹具 --------------------------------- */

const FIXTURE = [
  '; 顶部注释',
  '#DIM NAME, 10',
  '@FUNC(A, B)',
  '    $LOOP',
  '    [IF_DEBUG]',
  '    IF A AND B',
  '        SELECTCASE A',
  '        CASE 1',
  '            PRINTL "台词{NAME}与%CALLNAME%"',
  '        CASEELSE',
  '            PRINTL other',
  '        ENDSELECT',
  '    ELSE',
  '        SIF A > 1',
  '        PRINTLX',
  '    ENDIF',
  '[SKIPSTART]',
  'IF 坏掉的未闭合 "',
  '[SKIPEND]',
].join('\n') + '\n';
const FIXTURE_LINES = FIXTURE.split('\n');

/**
 * 把 5 元增量数据读回来（**Monaco 自己的解码器**：`toMultilineTokens2`；编码错了这里就歪）。
 * 以前这里自写"从 line = 0 起算"的循环，与编码器同为 1 基 ⇒ 两边一起错、闸一直绿。
 */
async function decode(
  data: Uint32Array,
  legend: readonly string[],
): Promise<Array<{ line: number; startColumn: number; length: number; tier: string }>> {
  return (await decodeWithMonaco(data)).map((decoded) => ({
    line: decoded.line,
    startColumn: decoded.startColumn,
    length: decoded.endColumn - decoded.startColumn,
    tier: legend[decoded.type] ?? '<越界>',
  }));
}

const token = (over: Partial<KojoStructureToken>): KojoStructureToken => ({
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 3,
  tier: 'comment',
  ...over,
});

/* ======================================================================== */
/* ① 查询：编译 + 捕获（真 wasm）                                            */
/* ======================================================================== */

describe('ERB 查询 · 真 wasm 编译与捕获', () => {
  it.each(['folds', 'highlights', 'indents', 'brackets', 'diagnostics'])('%s.scm 能编译且捕获名非空', (name) => {
    const query = compileQuery(name);
    expect(query.patternCount()).toBeGreaterThan(0);
    expect(query.captureNames.length).toBeGreaterThan(0);
    console.log(`[erb-ts-facets] ${name}.scm 编译：patterns=${query.patternCount()} captures=${query.captureNames.join(',')}`);
  });

  it('indents.scm 只认三档 begin/end/enter（引擎另认同义 increase/decrease）', () => {
    const names = compileQuery('indents').captureNames;
    expect(names.sort()).toEqual(['indent.begin', 'indent.end', 'indent.enter']);
  });

  it('indents.scm 在嵌套夹具上捕到开块 / 分支 / 收束 / 单行形', () => {
    const captures = capturesOf('indents', FIXTURE);
    const byCapture = (name: string) => captures.filter((c) => c.name === name).map((c) => c.node.type);
    expect(byCapture('indent.begin')).toEqual(
      expect.arrayContaining(['if_line', 'selectcase_line', 'case_line', 'caseelse_line', 'else_line']),
    );
    expect(byCapture('indent.end')).toEqual(
      expect.arrayContaining(['endif_line', 'endselect_line', 'case_line', 'caseelse_line', 'else_line']),
    );
    expect(byCapture('indent.enter')).toEqual(['sif_line']);
    console.log(`[erb-ts-facets] indents 捕获：begin=${byCapture('indent.begin').length} end=${byCapture('indent.end').length} enter=${byCapture('indent.enter').length}`);
  });

  it('indents.scm 覆盖投影里的每个配对类别（块 + 开行 + 收束行）', () => {
    const structure = JSON.parse(readFileSync(join(ERB_PKG, 'src', 'structure.json'), 'utf8')) as {
      controlFlow: {
        pairs: Record<string, { open: string[]; close: string[]; branch: string[] }>;
      };
    };
    const source = readQuery('indents');
    const lineNode = (word: string) => `${word.toLowerCase()}_line`;
    for (const [pair, spec] of Object.entries(structure.controlFlow.pairs)) {
      expect(source, `indents.scm 缺 ${pair}_block`).toContain(`(${pair}_block`);
      for (const word of spec.open) expect(source, `indents.scm 缺 ${lineNode(word)}`).toContain(`(${lineNode(word)}) @indent.begin`);
      for (const word of spec.close) expect(source, `indents.scm 缺 ${lineNode(word)}`).toContain(`(${lineNode(word)}) @indent.end`);
      for (const word of spec.branch) expect(source, `indents.scm 缺 ${lineNode(word)}`).toContain(`(${lineNode(word)})`);
    }
  });

  it('brackets.scm 捕到块配对与 FORM 表达式括号', () => {
    const captures = capturesOf('brackets', FIXTURE);
    const names = new Set(captures.map((c) => c.name));
    expect(names).toEqual(new Set(['bracket.open', 'bracket.close', 'bracket.branch', 'bracket.expression', 'bracket.tag']));
    const expression = captures.filter((c) => c.name === 'bracket.expression').map((c) => c.node.type);
    expect(expression).toEqual(expect.arrayContaining(['form_interpolation', 'form_substitution']));
    const tags = captures.filter((c) => c.name === 'bracket.tag').map((c) => c.node.type);
    expect(tags).toEqual(expect.arrayContaining(['bracket_line', 'skip_start', 'skip_end']));
    console.log(`[erb-ts-facets] brackets 捕获：open=${captures.filter((c) => c.name === 'bracket.open').length} close=${captures.filter((c) => c.name === 'bracket.close').length} branch=${captures.filter((c) => c.name === 'bracket.branch').length} expression=${expression.length} tag=${tags.length}`);
  });

  it('brackets.scm 覆盖投影里的每个配对类别', () => {
    const structure = JSON.parse(readFileSync(join(ERB_PKG, 'src', 'structure.json'), 'utf8')) as {
      controlFlow: { pairs: Record<string, unknown> };
    };
    const source = readQuery('brackets');
    for (const pair of Object.keys(structure.controlFlow.pairs)) {
      expect(source, `brackets.scm 缺 ${pair}_block`).toContain(`(${pair}_block`);
    }
  });

  it('diagnostics.scm 捕到 MISSING（未配对块）并给出记号名', () => {
    const captures = capturesOf('diagnostics', 'IF X\nPRINTL hi\n');
    const missing = captures.filter((c) => c.name === 'diagnostic.missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.node.type).toBe('endif_line');
    expect(missing[0]!.node.startPosition.row).toBe(2);
    console.log(`[erb-ts-facets] diagnostics MISSING=${missing.map((c) => `${c.node.type}@${c.node.startPosition.row}`).join(',')}`);
  });

  it('diagnostics.scm 捕到 ERROR（嵌套错误）', () => {
    const captures = capturesOf('diagnostics', 'IF X\n  SELECTCASE Y\n  ENDIF\n');
    const errors = captures.filter((c) => c.name === 'diagnostic.error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.node.type).toBe('ERROR');
  });

  it('diagnostics.scm 在 [SKIPSTART] 死区里不误报（只有 skip 捕获）', () => {
    const captures = capturesOf('diagnostics', '[SKIPSTART]\nIF X\n"未闭合\n[SKIPEND]\n');
    expect(captures.filter((c) => c.name === 'diagnostic.error')).toHaveLength(0);
    expect(captures.filter((c) => c.name === 'diagnostic.missing')).toHaveLength(0);
    expect(captures.filter((c) => c.name === 'diagnostic.skip')).toHaveLength(1);
  });

  it('highlights.scm 的捕获名与 ERB 档位表逐一对得上', () => {
    const names = compileQuery('highlights').captureNames;
    for (const name of names) {
      expect(ERB_SEMANTIC_CAPTURE_TIERS[name], `捕获 @${name} 在 erb-tiers.ts 里没有档位`).toBeTypeOf('string');
    }
    expect(names).toEqual(expect.arrayContaining(['comment', 'keyword.directive', 'label', 'tag', 'function', 'keyword.control', 'string', 'string.special', 'raw']));
  });

  it('highlights.scm 不捕 statement_line（结构层对它没有比词法层更多的判断）', () => {
    expect(readQuery('highlights')).not.toContain('(statement_line)');
  });

  it('highlights.scm 覆盖投影里的每个控制词', () => {
    const structure = JSON.parse(readFileSync(join(ERB_PKG, 'src', 'structure.json'), 'utf8')) as {
      controlFlow: { open: object; branch: object; close: object; leaf: string[] };
    };
    const source = readQuery('highlights');
    const words = [
      ...Object.keys(structure.controlFlow.open),
      ...Object.keys(structure.controlFlow.branch),
      ...Object.keys(structure.controlFlow.close),
      ...structure.controlFlow.leaf,
    ];
    for (const word of words) {
      expect(source, `highlights.scm 缺控制行 ${word}`).toContain(`(${word.toLowerCase()}_line) @keyword.control`);
    }
  });

  it('括号配置数据：三对 ASCII 括号进 brackets / colorized，引号只进自动闭合与包裹', () => {
    expect(ERB_BRACKET_PAIRS).toEqual([
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ]);
    expect(ERB_QUOTE_PAIR).toEqual(['"', '"']);
    expect(ERB_BRACKET_PAIRS.map((pair) => pair.join(''))).not.toContain('""');
  });

  it('registerErbLanguage 把同一份括号表喂给 Monaco 的四格（additive）', () => {
    const configs: Array<{ id: string; config: Monaco.languages.LanguageConfiguration }> = [];
    const monaco = {
      languages: {
        getLanguages: () => [],
        register: () => undefined,
        IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
        setMonarchTokensProvider: () => ({ dispose: () => undefined }),
        setLanguageConfiguration: (id: string, config: Monaco.languages.LanguageConfiguration) => {
          configs.push({ id, config });
          return { dispose: () => undefined };
        },
      },
      editor: { defineTheme: () => undefined },
    } as unknown as typeof Monaco;
    registerErbLanguage(monaco);
    expect(configs).toHaveLength(1);
    expect(configs[0]!.id).toBe(ERB_LANGUAGE_ID);
    const config = configs[0]!.config;
    expect(config.brackets).toEqual([
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ]);
    expect(config.colorizedBracketPairs).toEqual([
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ]);
    expect(config.autoClosingPairs).toEqual(
      expect.arrayContaining([
        { open: '(', close: ')' },
        { open: '[', close: ']' },
        { open: '{', close: '}' },
        { open: '"', close: '"' },
      ]),
    );
    expect(config.surroundingPairs).toEqual(expect.arrayContaining([{ open: '"', close: '"' }]));
  });
});

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
    expect(byLine.get(0)).toContain('comment');
    expect(byLine.get(1)).toContain('keyword.preprocessor');
    expect(byLine.get(2)).toContain('entity.name.function');
    expect(byLine.get(3)).toContain('label');
    expect(byLine.get(4)).toContain('keyword.preprocessor');
    expect(byLine.get(5)).toContain('keyword.erb');
    expect(byLine.get(8)).toContain('string');
    expect(byLine.get(8)).toContain('sugar.interp');
    expect(semantic.tokens.some((t) => t.tier === 'keyword.raw')).toBe(true);
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
    const typed = semantic.tokens.filter((t) => t.tier === 'support.type');
    const text = ['#DIM CONST GLOBAL 心, 10', '#DIM DYNAMIC 计数', '#DIM 名字, 3', ''];
    const at = (t: (typeof typed)[number]): string =>
      text[t.startRow]!.slice(t.startCol, t.endCol).trim();
    // `dim_modifier` 的记号形是"词 + 其后至少一个空白"（语法层的 DIM_MODIFIER 就是这么切的），
    // 所以跨度带一个尾随空格；涂在空格上没有视觉差，判据只看词本身。
    expect(typed.map(at), '类型档打出的词').toEqual(['CONST', 'GLOBAL', 'DYNAMIC']);
    // 同一行的其余部分**一档不许糊平**：声明词仍走预处理档，作者写的名字不涂色
    expect(semantic.tokens.filter((t) => t.startRow === 0).map((t) => t.tier)).toEqual(
      expect.arrayContaining(['keyword.preprocessor']),
    );
    expect(semantic.tokens.some((t) => t.tier === 'support.type' && at(t) === '心')).toBe(false);
    // 第三枚 `#DIM 名字, 3` 没有任何限定词 ⇒ 该行零类型格（判据不是"有 #DIM 就涂"）
    expect(typed.some((t) => t.startRow === 2)).toBe(false);
    console.log(`[erb-ts-facets] support.type 命中=${typed.length} ${typed.map(at).join(',')}`);
  });

  it('语义 token 的坐标落在捕获节点上（IF 行从行首缩进起、串从引号起）', async () => {
    const { replies } = await runEngine(FIXTURE);
    const semantic = lastReply(replies, 'semantic');
    if (!semantic) throw new Error('没有 semantic 回话');
    const ifToken = semantic.tokens.find((t) => t.startRow === 5 && t.tier === 'keyword.erb');
    expect(ifToken).toMatchObject({ startCol: 4, endRow: 5, endCol: 14 });
    const stringToken = semantic.tokens.find((t) => t.startRow === 8 && t.tier === 'string');
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

  it('结构诊断：嵌套错配 ⇒ ERROR 一条（不逐子节点重复报）', async () => {
    const { replies } = await runEngine('IF X\n  SELECTCASE Y\n  ENDIF\n');
    const syntax = lastReply(replies, 'syntax');
    if (!syntax) throw new Error('没有 syntax 回话');
    expect(syntax.faults).toHaveLength(1);
    expect(syntax.faults[0]!.kind).toBe('unexpected-token');
  });

  it('结构诊断：[SKIPSTART] 死区里的坏行不报（体内不解析）', async () => {
    const { replies } = await runEngine('[SKIPSTART]\nIF X\n"未闭合\n[SKIPEND]\n');
    const syntax = lastReply(replies, 'syntax');
    if (!syntax) throw new Error('没有 syntax 回话');
    expect(syntax.faults).toEqual([]);
  });

  it('捕获表由语言入口注入：表外捕获报一次，其余照常着色', async () => {
    const { replies } = await runEngine('IF X\nENDIF\n', {
      highlightsQuery: '(if_line) @mystery\n(comment_line) @comment\n',
    });
    const errors = errorReplies(replies).filter((e) => e.capability === 'semantic');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('@mystery');
    const semantic = lastReply(replies, 'semantic');
    expect(semantic?.tokens.every((t) => t.tier === 'comment')).toBe(true);
  });

  it('`@none` 是有意不着色的哨兵：不产生回落告警', async () => {
    const { replies } = await runEngine('IF X\nENDIF\n', { highlightsQuery: '(if_line) @none\n' });
    expect(errorReplies(replies)).toEqual([]);
    const semantic = lastReply(replies, 'semantic');
    expect(semantic?.tokens).toEqual([]);
  });

  it('四条腿各自缺省：没有 indents 查询时不出 indent 回话，也不报错', async () => {
    const { replies } = await runEngine('IF X\nENDIF\n', { indentsQuery: undefined });
    expect(replies.some((r) => r.type === 'indent')).toBe(false);
    expect(errorReplies(replies)).toEqual([]);
  });

  it('ERB_STRUCTURE_RUNTIME 声明 semantic + baseIndentPatterns 两面', () => {
    expect(ERB_STRUCTURE_RUNTIME.semantic).toBe(ERB_SEMANTIC_FACET);
    expect(typeof ERB_STRUCTURE_RUNTIME.baseIndentPatterns).toBe('function');
    expect(ERB_STRUCTURE_RUNTIME.semantic?.legend).toBe(ERB_SEMANTIC_LEGEND);
    expect(ERB_STRUCTURE_RUNTIME.grammarWasmUrl).toContain('tree-sitter-erb.wasm');
  });

  it('ERB_STRUCTURE_RUNTIME 的基底接 erb-enter 既有层级（含 SIF / 注释两格）', () => {
    const base = ERB_STRUCTURE_RUNTIME.baseIndentPatterns!();
    const reference = erbEnterRulePatterns();
    expect(base.indentOnEnter.map((r) => r.source)).toEqual(reference.indentOnEnter.map((r) => r.source));
    expect(base.increaseIndentPattern.source).toBe(reference.increaseIndentPattern.source);
    expect(base.decreaseIndentPattern.source).toBe(reference.decreaseIndentPattern.source);
    expect(base.indentNextLinePattern?.source).toBe(reference.indentNextLinePattern?.source);
    expect(base.unIndentedLinePattern?.source).toBe(reference.unIndentedLinePattern?.source);
  });
});

/* ======================================================================== */
/* ③ 语义 facet：档位表 / legend / 编码 / provider                           */
/* ======================================================================== */

describe('ERB 语义 facet · 档位、编码与 provider 边界', () => {
  beforeEach(() => {
    resetErbSemanticWarnings();
    resetStructureDegradationLedger();
    vi.restoreAllMocks();
  });

  it('档位表的值全部能在主题里取到色（与 KOJO 档位同源）', () => {
    const legend = erbSemanticTiers();
    expect(legend).toEqual([...legend].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(legend).size).toBe(legend.length);
    expect(legend).toEqual(expect.arrayContaining(['comment', 'keyword.preprocessor', 'label', 'entity.name.function', 'keyword.erb', 'string', 'sugar.interp', 'keyword.raw']));
    expect(ERB_SEMANTIC_LEGEND.tokenTypes).toEqual(legend);
    expect(ERB_SEMANTIC_LEGEND.tokenModifiers).toEqual([]);
  });

  it('捕获表外返回 null（说一次并不着色）；none 返回 undefined（安静）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(erbCaptureTier('definitely-not-a-capture')).toBeNull();
    expect(erbCaptureTier('none')).toBeUndefined();
    expect(erbCaptureTier('comment')).toBe('comment');
    expect(encodeErbStructureTokens([token({ tier: 'sugar.nope' })], { lineCount: 1, maxColumn: () => 10 })).toMatchObject({ data: expect.any(Uint32Array) });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('编码：单行为区间按（行，列）升序，坐标从 1 起', async () => {
    const encoded = encodeErbStructureTokens([token({ startRow: 0, startCol: 0, endRow: 0, endCol: 5, tier: 'comment' })], {
      lineCount: 1,
      maxColumn: () => 12,
    });
    expect(await decode(encoded.data, ERB_SEMANTIC_LEGEND.tokenTypes)).toEqual([
      { line: 1, startColumn: 1, length: 5, tier: 'comment' },
    ]);
  });

  it('编码：内层优先——串里的插值不被整枚串吞掉，外层切开补写', async () => {
    const encoded = encodeErbStructureTokens(
      [
        token({ startRow: 0, startCol: 0, endRow: 0, endCol: 20, tier: 'string' }),
        token({ startRow: 0, startCol: 5, endRow: 0, endCol: 10, tier: 'sugar.interp' }),
      ],
      { lineCount: 1, maxColumn: () => 21 },
    );
    const decoded = await decode(encoded.data, ERB_SEMANTIC_LEGEND.tokenTypes);
    expect(decoded.map((d) => [d.startColumn, d.length, d.tier])).toEqual([
      [1, 5, 'string'],
      [6, 5, 'sugar.interp'],
      [11, 10, 'string'],
    ]);
    // 切开是**设计内的补写**（一段都没丢）⇒ 不许计入"丢弃"：算进去就变成每份带插值的口上都
    // 报一条"结构着色没顶上"（2026-10-25 修掉的那条误报）
    expect(encoded.droppedOverlaps).toBe(0);
    // 同一行不重叠（Monaco 的硬要求）：逐条校验
    let end = 0;
    for (const span of decoded) {
      expect(span.startColumn).toBeGreaterThanOrEqual(end);
      end = span.startColumn + span.length;
    }
  });

  it('编码：完全被覆盖的重叠区间丢掉并计数', async () => {
    const encoded = encodeErbStructureTokens(
      [
        token({ startRow: 0, startCol: 2, endRow: 0, endCol: 8, tier: 'comment' }),
        token({ startRow: 0, startCol: 2, endRow: 0, endCol: 8, tier: 'comment' }),
      ],
      { lineCount: 1, maxColumn: () => 10 },
    );
    expect(encoded.droppedOverlaps).toBe(1);
    expect(await decode(encoded.data, ERB_SEMANTIC_LEGEND.tokenTypes)).toHaveLength(1);
  });

  it('编码：结尾落在下一行第 0 列（裸控制词吃了换行）⇒ 收回上一行，不多铺一行', () => {
    const result = splitErbStructureTokens(
      [token({ startRow: 6, startCol: 0, endRow: 7, endCol: 0, tier: 'keyword.erb' })],
      { lineCount: 10, maxColumn: (lineNumber) => (lineNumber === 7 ? 5 : 9) },
    );
    // 修前：endRow 直接换行号 ⇒ 多铺第 8 行（宽度 0）⇒ droppedEmpty 1 条、每份口上都白报一次
    expect(result.droppedEmpty).toBe(0);
    expect(result.droppedRows).toBe(0);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({ line: 7, startColumn: 1, endColumn: 5 });
  });

  it('编码：文件以裸控制词 + 换行结尾时不再判越界（收回后正好落在末行）', () => {
    const result = splitErbStructureTokens([token({ startRow: 2, startCol: 0, endRow: 3, endCol: 0, tier: 'keyword.erb' })], {
      lineCount: 3,
      maxColumn: () => 8,
    });
    expect(result.droppedRows).toBe(0);
    expect(result.droppedEmpty).toBe(0);
    expect(result.spans).toHaveLength(1);
  });

  it('编码：行越界丢弃、列越界夹取', () => {
    const result = splitErbStructureTokens(
      [token({ startRow: 99, endRow: 99 }), token({ startCol: 2, endCol: 99 })],
      { lineCount: 1, maxColumn: () => 6 },
    );
    expect(result.droppedRows).toBe(1);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({ line: 1, startColumn: 3, endColumn: 6 });
  });

  it('编码：跨度超上限整条丢掉（错误恢复把块撑到全篇时不许糊屏）', () => {
    const result = splitErbStructureTokens(
      [token({ startRow: 0, endRow: 250, tier: 'string' })],
      { lineCount: 400, maxColumn: () => 10 },
    );
    expect(result.droppedWide).toBe(1);
    expect(result.spans).toHaveLength(0);
  });

  it('编码：空 token 表 ⇒ 长度 0 的数据（不是异常）', () => {
    const encoded = encodeErbStructureTokens([], { lineCount: 3, maxColumn: () => 5 });
    expect(encoded.data.length).toBe(0);
    expect(encoded.droppedRows + encoded.droppedEmpty + encoded.droppedWide + encoded.droppedOverlaps).toBe(0);
  });

  const fakeModel = (lines: readonly string[], languageId = ERB_LANGUAGE_ID): Monaco.editor.ITextModel =>
    ({
      getLanguageId: () => languageId,
      getLineCount: () => lines.length,
      getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1]?.length ?? 0) + 1,
    }) as unknown as Monaco.editor.ITextModel;

  const noCancel = { isCancellationRequested: false } as Monaco.CancellationToken;

  it('provider：只认 ERB 语言（别的语言连取数都不问）', async () => {
    let calls = 0;
    const provider = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => {
        calls++;
        return [];
      },
    });
    expect(await provider.provideDocumentSemanticTokens!(fakeModel(['x'], 'plaintext'), null, noCancel)).toBeNull();
    expect(calls).toBe(0);
  });

  it('provider：inactive / 取消 ⇒ null（不问取数）', async () => {
    let calls = 0;
    const inactive = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      isActive: () => false,
      tokens: async () => {
        calls++;
        return [];
      },
    });
    expect(await inactive.provideDocumentSemanticTokens!(fakeModel(['x']), null, noCancel)).toBeNull();
    const cancelled = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => {
        calls++;
        return [];
      },
    });
    expect(
      await cancelled.provideDocumentSemanticTokens!(fakeModel(['x']), null, {
        isCancellationRequested: true,
      } as Monaco.CancellationToken),
    ).toBeNull();
    expect(calls).toBe(0);
  });

  it('provider：取数 null / 空数组 ⇒ null（让名字分色的 provider 应答）', async () => {
    const nullProvider = createErbSemanticTokensProvider({ languageId: ERB_LANGUAGE_ID, tokens: async () => null });
    expect(await nullProvider.provideDocumentSemanticTokens!(fakeModel(['IF X']), null, noCancel)).toBeNull();
    const emptyProvider = createErbSemanticTokensProvider({ languageId: ERB_LANGUAGE_ID, tokens: async () => [] });
    expect(await emptyProvider.provideDocumentSemanticTokens!(fakeModel(['IF X']), null, noCancel)).toBeNull();
  });

  it('provider：有 token ⇒ 编成 Monaco 数据', async () => {
    const provider = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => [token({ startRow: 0, startCol: 0, endRow: 0, endCol: 5, tier: 'comment' })],
    });
    const result = (await provider.provideDocumentSemanticTokens!(fakeModel(['hello world']), null, noCancel)) as
      | { data: Uint32Array }
      | null;
    expect(result).not.toBeNull();
    expect(await decode(result!.data, ERB_SEMANTIC_LEGEND.tokenTypes)).toEqual([
      { line: 1, startColumn: 1, length: 5, tier: 'comment' },
    ]);
  });

  it('provider：裸控制词的换行尾不再触发回落（真文件的常态不许报"没顶上"）', async () => {
    resetStructureDegradationLedger();
    const notices: string[] = [];
    const unsubscribe = onStructureDegradation((d) => notices.push(d.message));
    const provider = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => [
        token({ startRow: 0, startCol: 0, endRow: 0, endCol: 4, tier: 'keyword.erb' }),
        token({ startRow: 1, startCol: 0, endRow: 2, endCol: 0, tier: 'keyword.erb' }),
      ],
    });
    const result = (await provider.provideDocumentSemanticTokens!(
      fakeModel(['IF X', 'ENDIF', 'RETURN 1']),
      null,
      noCancel,
    )) as { data: Uint32Array } | null;
    unsubscribe();
    expect(result).not.toBeNull();
    expect(notices).toEqual([]);
  });

  it('provider：真有段没涂上时文案说"几段没涂上"，不许说"这一面退回了原来的做法"', async () => {
    resetStructureDegradationLedger();
    const notices: string[] = [];
    const unsubscribe = onStructureDegradation((d) => notices.push(degradationNoticeText(d)));
    const provider = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => [
        token({ startRow: 0, startCol: 0, endRow: 0, endCol: 4, tier: 'comment' }),
        token({ startRow: 0, startCol: 0, endRow: 0, endCol: 4, tier: 'string' }), // 整段被先到的盖住
      ],
    });
    await provider.provideDocumentSemanticTokens!(fakeModel(['IF X']), null, noCancel);
    unsubscribe();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('有几段没涂上');
    expect(notices[0]).not.toContain('退回了原来的做法');
  });

  it('provider：取数抛错 ⇒ null + 回落台账说一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notices: string[] = [];
    const unsubscribe = onStructureDegradation((d) => notices.push(`${d.capability}/${d.stage}`));
    const provider = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => {
        throw new Error('client 取数失败（桩）');
      },
    });
    expect(await provider.provideDocumentSemanticTokens!(fakeModel(['IF X']), null, noCancel)).toBeNull();
    expect(await provider.provideDocumentSemanticTokens!(fakeModel(['IF X']), null, noCancel)).toBeNull();
    unsubscribe();
    expect(notices).toEqual(['semantic/parse']);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('client 取数失败'))).toBe(true);
  });

  it('provider：超时 ⇒ null + 回落台账说一次（不把 Monaco 的 promise 挂住）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notices: string[] = [];
    const unsubscribe = onStructureDegradation((d) => notices.push(`${d.capability}/${d.stage}`));
    const provider = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      timeoutMs: 10,
      tokens: () => new Promise(() => undefined),
    });
    const started = Date.now();
    expect(await provider.provideDocumentSemanticTokens!(fakeModel(['IF X']), null, noCancel)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    unsubscribe();
    expect(notices).toEqual(['semantic/parse']);
    expect(warn).toHaveBeenCalled();
  });

  it('registerErbSemanticTokensProvider：只挂 ERB id，dispose 可重复调用', () => {
    const ids: string[] = [];
    let disposed = 0;
    const monaco = {
      languages: {
        registerDocumentSemanticTokensProvider: (id: string) => {
          ids.push(id);
          return { dispose: () => void disposed++ };
        },
      },
    } as unknown as typeof Monaco;
    const registration = registerErbSemanticTokensProvider(monaco, {
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => [],
    });
    expect(ids).toEqual([ERB_LANGUAGE_ID]);
    registration.dispose();
    registration.dispose();
    // 桩的 dispose 不幂等（真 Monaco IDisposable 是）：这里只钉"连拆两次不抛"
    expect(disposed).toBe(2);
  });

  it('facet 与独立 provider 同源：legend / encode 是同一个函数', () => {
    expect(ERB_SEMANTIC_FACET.legend).toBe(ERB_SEMANTIC_LEGEND);
    expect(ERB_SEMANTIC_FACET.encode).toBe(encodeErbStructureTokens);
  });
});

/* ======================================================================== */
/* ④ 缩进 facet：基底接既有层级 + 合并只做加法                               */
/* ======================================================================== */

describe('ERB 缩进 · 基底接 erb-enter，合并只做加法', () => {
  const emptyRules: KojoStructureIndentRules = { increasePatterns: [], decreasePatterns: [], enterPatterns: [] };

  it('基底三格与 erbEnterRulePatterns 逐字相同（不另造）', () => {
    const base = erbBaseIndentPatterns();
    const reference = erbEnterRulePatterns();
    expect(base.indentOnEnter.map((r) => r.source)).toEqual(reference.indentOnEnter.map((r) => r.source));
    expect(base.increaseIndentPattern.source).toBe(reference.increaseIndentPattern.source);
    expect(base.decreaseIndentPattern.source).toBe(reference.decreaseIndentPattern.source);
  });

  it('基底带出 SIF 只抬一行 / 注释不参与继承两格', () => {
    const base = erbBaseIndentPatterns();
    expect(base.indentNextLinePattern).toBeInstanceOf(RegExp);
    expect(base.indentNextLinePattern!.test('SIF A > 1')).toBe(true);
    expect(base.unIndentedLinePattern).toBeInstanceOf(RegExp);
    expect(base.unIndentedLinePattern!.test('; 注释')).toBe(true);
  });

  it('每次调用新建基底（两门语言/两次装配不许串同一个可变对象）', () => {
    expect(erbBaseIndentPatterns()).not.toBe(erbBaseIndentPatterns());
  });

  it('结构规则缺席 / 三腿全空 ⇒ null（与没接这条线同一份行为）', () => {
    expect(erbMergedIndentConfig(null)).toBeNull();
    expect(erbMergedIndentConfig(emptyRules)).toBeNull();
  });

  it('合并：基底规则一条不少，结构规则加在后面，两格 optional 原样带出', async () => {
    const { replies } = await runEngine(FIXTURE);
    const rules = lastReply(replies, 'indent')!.rules;
    const merged = erbMergedIndentConfig(rules);
    if (!merged) throw new Error('结构规则没进合并（indents 查询或派生层漂了）');
    const base = erbBaseIndentPatterns();
    expect(merged.onEnterRules.slice(0, base.indentOnEnter.length).map((r) => r.beforeText.source)).toEqual(
      base.indentOnEnter.map((r) => r.source),
    );
    expect(merged.added).toBeGreaterThan(0);
    expect(merged.rejected).toBe(0);
    expect(merged.indentNextLinePattern?.source).toBe(base.indentNextLinePattern?.source);
    expect(merged.unIndentedLinePattern?.source).toBe(base.unIndentedLinePattern?.source);
    expect(merged.increaseIndentPattern.test('  IF A AND B')).toBe(true);
    expect(merged.increaseIndentPattern.test(base.increaseIndentPattern.source === '' ? '' : 'IF X')).toBe(true);
    console.log(`[erb-ts-facets] merged indent：onEnter=${merged.onEnterRules.length} added=${merged.added}`);
  });

  it('合并键稳定：同一批结构规则两次合并 ⇒ 同一个 key（不重复重发语言配置）', async () => {
    const { replies } = await runEngine(FIXTURE);
    const rules = lastReply(replies, 'indent')!.rules;
    expect(erbMergedIndentConfig(rules)!.key).toBe(erbMergedIndentConfig(rules)!.key);
  });

  it('erbIndentPattern：按节点 kind 取关键字（大小写 / 全角空白 / 词形边界）', () => {
    const ifPattern = erbIndentPattern('indent.begin', 'if_line', 'IF A AND B');
    expect(ifPattern).not.toBeNull();
    expect(new RegExp(ifPattern!).test('IF A AND B')).toBe(true);
    expect(new RegExp(ifPattern!).test('  if x')).toBe(true);
    expect(new RegExp(ifPattern!).test('　IF X')).toBe(true);
    expect(new RegExp(ifPattern!).test('IFX')).toBe(false);
    expect(erbIndentPattern('indent.end', 'endif_line', 'ENDIF')).toContain('[eE][nN][dD][iI][fF]');
    expect(erbIndentPattern('indent.enter', 'sif_line', 'SIF A')).toContain('[sS][iI][fF]');
  });

  it('erbIndentPattern：非缩进捕获 / 非控制行 ⇒ null（不产半成品规则）', () => {
    expect(erbIndentPattern('fold', 'if_block', 'IF X')).toBeNull();
    expect(erbIndentPattern('indent.begin', 'if_block', 'IF X')).toBeNull();
    expect(erbIndentPattern('indent.begin', 'comment_line', '; x')).toBeNull();
  });
});

/* ======================================================================== */
/* ⑤ 结构诊断映射：CST 事实 + 停用区标签                                     */
/* ======================================================================== */

describe('ERB 结构诊断 · 残缺标签 / 嵌套错误 / 死区不误报', () => {
  it('记号名 → 人话名（`endif_line` / `skip_end`；表外不编）', () => {
    expect(erbMissingName('endif_line')).toBe('ENDIF');
    expect(erbMissingName('endselect_line')).toBe('ENDSELECT');
    expect(erbMissingName('skip_end')).toBe('[SKIPEND]');
    expect(erbMissingName(undefined)).toBeNull();
    expect(erbMissingName('some_new_token')).toBeNull();
  });

  it('未配对块 ⇒ 一条 unclosed-block（文案带行号与收束词）', async () => {
    const { replies } = await runEngine('IF X\n  PRINTL hi\n');
    const syntax = lastReply(replies, 'syntax')!;
    const diagnostics = erbCstDiagnostics(syntax.faults);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ line: 1, kind: 'unclosed-block', code: 'erb.unclosed-block' });
    expect(diagnostics[0]!.message).toContain('「IF」');
    expect(diagnostics[0]!.message).toContain('「ENDIF」');
    expect(diagnostics[0]!.message).toContain('第 3 行'); // faultRow = 2（0 基）→ 3
  });

  it('读不通的内容 ⇒ unexpected-token 文案（不冒充缺收束词）', async () => {
    const { replies } = await runEngine('IF X\n  SELECTCASE Y\n  ENDIF\n');
    const syntax = lastReply(replies, 'syntax')!;
    const diagnostics = erbCstDiagnostics(syntax.faults);
    expect(diagnostics[0]!.kind).toBe('unexpected-token');
    expect(diagnostics[0]!.code).toBe('erb.unexpected-token');
    expect(diagnostics[0]!.message).toContain('读不通');
  });

  it('同一行多处 CST 残缺只留第一条（一处一行）', () => {
    const faults = [
      { row: 2, endRow: 2, column: 0, endColumn: 4, faultRow: 2, kind: 'unexpected-token' as const },
      { row: 2, endRow: 2, column: 8, endColumn: 10, faultRow: 2, kind: 'unterminated-interp' as const },
      { row: 1, endRow: 1, column: 0, endColumn: 3, faultRow: 1, kind: 'unexpected-token' as const },
    ];
    const diagnostics = erbCstDiagnostics(faults);
    expect(diagnostics.map((d) => d.line)).toEqual([2, 3]);
  });

  it('[SKIPSTART] 没有 [SKIPEND] ⇒ unpaired-skip（语法层 close 可选，这条由文本判据补）', () => {
    const diagnostics = erbSkipTagDiagnostics('[SKIPSTART]\nIF X\nPRINTL hi\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ line: 1, endLine: 3, kind: 'unpaired-skip', code: 'erb.unpaired-skip' });
    expect(diagnostics[0]!.message).toContain('[SKIPEND]');
  });

  it('落单的 [SKIPEND] ⇒ 一条 unpaired-skip；配对齐全 ⇒ 空', () => {
    const stray = erbSkipTagDiagnostics('PRINTL x\n[SKIPEND]\n');
    expect(stray).toHaveLength(1);
    expect(stray[0]).toMatchObject({ line: 2, kind: 'unpaired-skip' });
    expect(erbSkipTagDiagnostics('[SKIPSTART]\nIF X\n[SKIPEND]\n')).toEqual([]);
  });

  it('停用区里再写 [SKIPSTART] 不算新开区（与 scanner 的当前区判据同口径）', () => {
    const diagnostics = erbSkipTagDiagnostics('[SKIPSTART]\n[SKIPSTART]\n[SKIPEND]\n');
    expect(diagnostics).toEqual([]);
  });

  it('CST + 停用区合表：同码同行去重、按行排序', () => {
    const faults = [{ row: 0, endRow: 0, column: 0, endColumn: 3, faultRow: 0, kind: 'unexpected-token' as const }];
    const diagnostics = erbStructureDiagnostics(faults, 'IF X\n[SKIPEND]\n');
    expect(diagnostics.map((d) => [d.line, d.kind])).toEqual([
      [1, 'unexpected-token'],
      [2, 'unpaired-skip'],
    ]);
  });

  it('死区不误报：引擎 facts 为空 + 停用区标签配对齐全 ⇒ 一份诊断都不出', async () => {
    const text = '[SKIPSTART]\nIF X\n"未闭合\n[SKIPEND]\n';
    const { replies } = await runEngine(text);
    const syntax = lastReply(replies, 'syntax')!;
    expect(syntax.faults).toEqual([]);
    expect(erbStructureDiagnostics(syntax.faults, text)).toEqual([]);
  });

  it('残缺标签 [IF_DEBUG（少右括号）不被语法层当成块错误', async () => {
    const { replies } = await runEngine('[IF_DEBUG\nPRINTL x\n');
    const syntax = lastReply(replies, 'syntax')!;
    expect(syntax.faults).toEqual([]);
  });
});

/* ======================================================================== */
/* ⑥ 闸门：默认关 = 零注册；dispose 幂等；开 = 只挂 ERB 的两枚 provider      */
/* ======================================================================== */

const clientStub = vi.hoisted(() => ({
  indentRules: null as KojoStructureIndentRules | null,
  tokens: [] as KojoStructureToken[],
  folds: [] as Array<{ startRow: number; endRow: number }>,
  instances: 0,
}));

vi.mock('../src/monaco/tree-sitter/client', () => {
  class StubStructureClient {
    constructor(_options: unknown) {
      clientStub.instances++;
    }
    get state(): string {
      return 'ready';
    }
    get indent(): KojoStructureIndentRules | null {
      return clientStub.indentRules;
    }
    async tokens(): Promise<readonly KojoStructureToken[] | null> {
      return clientStub.tokens;
    }
    async foldingRanges(): Promise<readonly { startRow: number; endRow: number }[] | null> {
      return clientStub.folds;
    }
    dispose(): void {
      /* 桩不持有资源 */
    }
  }
  return { StructureClient: StubStructureClient, STRUCTURE_REQUEST_TIMEOUT_MS: 1_000 };
});

interface GatingCaptured {
  semanticId: string | null;
  semantic: Monaco.languages.DocumentSemanticTokensProvider | null;
  folding: Monaco.languages.FoldingRangeProvider | null;
  configs: number;
  lastConfig: Monaco.languages.LanguageConfiguration | null;
  disposed: number;
}

function gatingMonaco(): { monaco: typeof Monaco; captured: GatingCaptured } {
  const captured: GatingCaptured = {
    semanticId: null,
    semantic: null,
    folding: null,
    configs: 0,
    lastConfig: null,
    disposed: 0,
  };
  const monaco = {
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    languages: {
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      registerDocumentSemanticTokensProvider: (id: string, provider: Monaco.languages.DocumentSemanticTokensProvider) => {
        captured.semanticId = id;
        captured.semantic = provider;
        return { dispose: () => void captured.disposed++ };
      },
      registerFoldingRangeProvider: (_id: string, provider: Monaco.languages.FoldingRangeProvider) => {
        captured.folding = provider;
        return { dispose: () => void captured.disposed++ };
      },
      setLanguageConfiguration: (_id: string, config: Monaco.languages.LanguageConfiguration) => {
        captured.configs++;
        captured.lastConfig = config;
        return { dispose: () => void captured.disposed++ };
      },
    },
    editor: {
      getEditors: () => [
        {
          updateOptions: () => undefined,
          onDidChangeConfiguration: () => ({ dispose: () => undefined }),
        },
      ],
      onDidCreateEditor: () => ({ dispose: () => undefined }),
      getModelMarkers: () => [],
      setModelMarkers: () => undefined,
      onDidChangeMarkers: () => ({ dispose: () => undefined }),
    },
  } as unknown as typeof Monaco;
  return { monaco, captured };
}

const erbDescriptor = (load: () => Promise<unknown>): LanguageDescriptor => ({
  id: ERB_LANGUAGE_ID,
  label: 'ERB',
  matchesPath: () => false,
  register: () => undefined,
  structure: { load: load as LanguageDescriptor['structure'] extends { load: infer L } ? L : never },
});

function prefEnv(on: boolean): void {
  // TS-DEFAULT 起默认开：要判关必须显式存 off（空表 = 回默认开）
  const store = new Map<string, string>([['kojo.ui.treeSitter.v1', on ? 'on' : 'off']]);
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ERB 结构叠层的闸门 · 显式关零注册 / 开则只挂 ERB', () => {
  beforeEach(() => {
    clientStub.indentRules = null;
    clientStub.tokens = [];
    clientStub.folds = [];
    clientStub.instances = 0;
    resetStructureDegradationLedger();
    resetErbSemanticWarnings();
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    disposeStructureOverlay();
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it('偏好显式关：ERB descriptor 也不触发任何 Monaco 注册 / 资源装载', () => {
    prefEnv(false);
    const calls: string[] = [];
    const make = (path: string): unknown =>
      new Proxy(() => undefined, {
        get: (_target, prop) => (typeof prop === 'string' ? make(`${path}.${prop}`) : undefined),
        apply: () => {
          calls.push(path);
          return { dispose: () => undefined };
        },
      });
    let loaded = 0;
    installStructureOverlay(make('monaco') as unknown as typeof Monaco, [
      erbDescriptor(async () => {
        loaded++;
        throw new Error('不该加载');
      }),
    ]);
    expect(calls).toEqual([]);
    expect(loaded).toBe(0);
  });

  it('偏好开：只给 ERB 注册语义 + 折叠两枚 provider', async () => {
    prefEnv(true);
    clientStub.indentRules = null;
    const { monaco, captured } = gatingMonaco();
    installStructureOverlay(monaco, [
      erbDescriptor(async () => ({
        runtimeWasmUrl: 'runtime.wasm（桩）',
        grammarWasmUrl: 'erb.wasm（桩）',
        createWorker: () => {
          throw new Error('桩 client 不建线程');
        },
        semantic: ERB_SEMANTIC_FACET,
        baseIndentPatterns: erbBaseIndentPatterns,
      })),
    ]);
    await flush();
    expect(clientStub.instances).toBe(1);
    expect(captured.semanticId).toBe(ERB_LANGUAGE_ID);
    expect(captured.semantic).not.toBeNull();
    expect(captured.folding).not.toBeNull();
    expect(structureOverlayLanguageStates()[ERB_LANGUAGE_ID]).toBe('ready');
  });

  it('语义 provider 拿到空结果 ⇒ null，但缩进配置已同步（基底 SIF / 注释两格不丢）', async () => {
    prefEnv(true);
    clientStub.tokens = [];
    clientStub.indentRules = {
      increasePatterns: ['^[ \\t]*(?:[Ee][Ll][Ss][Ee])(?![A-Za-z_])'],
      decreasePatterns: [],
      enterPatterns: [],
    };
    const { monaco, captured } = gatingMonaco();
    installStructureOverlay(monaco, [
      erbDescriptor(async () => ({
        runtimeWasmUrl: 'runtime.wasm（桩）',
        grammarWasmUrl: 'erb.wasm（桩）',
        createWorker: () => {
          throw new Error('桩 client 不建线程');
        },
        semantic: ERB_SEMANTIC_FACET,
        baseIndentPatterns: erbBaseIndentPatterns,
      })),
    ]);
    await flush();
    const model = {
      getLanguageId: () => ERB_LANGUAGE_ID,
      getLineCount: () => 3,
      getLineMaxColumn: () => 20,
    } as unknown as Monaco.editor.ITextModel;
    expect(await captured.semantic!.provideDocumentSemanticTokens!(model, null, { isCancellationRequested: false } as Monaco.CancellationToken)).toBeNull();
    expect(captured.configs).toBe(1);
    const indentationRules = captured.lastConfig?.indentationRules;
    expect(indentationRules?.indentNextLinePattern).toBeInstanceOf(RegExp);
    expect(indentationRules?.unIndentedLinePattern).toBeInstanceOf(RegExp);
    expect(indentationRules?.increaseIndentPattern.test('ELSE')).toBe(true);
    expect(indentationRules?.increaseIndentPattern.test('IF X')).toBe(true); // 基底那条还在
    expect(captured.lastConfig?.onEnterRules?.length).toBeGreaterThanOrEqual(erbBaseIndentPatterns().indentOnEnter.length);
  });

  it('dispose 幂等：连拆两次不抛，状态回到"没开过"', () => {
    prefEnv(true);
    const { monaco } = gatingMonaco();
    installStructureOverlay(monaco, [erbDescriptor(async () => ({ runtimeWasmUrl: '', grammarWasmUrl: '', createWorker: () => { throw new Error('x'); } }))]);
    expect(() => disposeStructureOverlay()).not.toThrow();
    expect(() => disposeStructureOverlay()).not.toThrow();
    expect(structureOverlayLanguageStates()).toEqual({});
    expect(clientStub.instances).toBe(0); // 没发 parse 就拆：线程都没起
  });
});

afterAll(() => {
  resetStructureDegradationLedger();
});
