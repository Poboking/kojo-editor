import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Language, Parser, Query } from 'web-tree-sitter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERB_BRACKET_PAIRS, ERB_LANGUAGE_ID, ERB_QUOTE_PAIR, registerErbLanguage } from '../src/monaco/erb-language';
import type * as Monaco from '../src/monaco/entry';
import { ERB_SEMANTIC_CAPTURE_TIERS } from '../src/monaco/tree-sitter/erb-tiers';
import {
  ERB_PKG,
  FIXTURE,
  RUNTIME_WASM,
  grammarWasm,
  readQuery,
  resetFacetLedgers,
} from './helpers/erb-ts-facets-kit';

/**
 * ERB-TS-FULL 面①：查询编译 + 捕获（真 wasm）。
 *
 * 真 wasm + 真查询（`packages/erb-syntax-tree/tree-sitter-erb.wasm` 与 `queries/*.scm`）在这里
 * 跑完整链路：查询编译 → CST 捕获。与 perf 池的分工：本文件判**形状与口径**（读数用 console.log
 * 打出来），耗时不设阈值。
 *
 * teardown 纪律（2026-10-28 欠账批）：Parser / Tree / Query 全是 wasm 堆上的活物，
 * **读完必须当场 delete**——以前一处一份、同进程攒到最后就是 `Fatal process out of memory: Zone`。
 */

let language: Language;

beforeAll(async () => {
  await Parser.init({ locateFile: () => RUNTIME_WASM });
  language = await Language.load(grammarWasm());
});

afterAll(() => {
  // web-tree-sitter 0.27 的 Language 没有 free API（语法表常驻 wasm 堆），
  // 能当场收的只有 Parser / Tree / Query——上面已全部 delete。
  resetFacetLedgers();
});

/* ------------------------------ 查询 / CST 工具 ------------------------------ */

/** 编译一份查询、用完即删（Query 持 wasm 堆，不许留在断言链上） */
function withQuery<T>(name: string, fn: (query: Query) => T): T {
  const query = new Query(language, readQuery(name));
  try {
    return fn(query);
  } finally {
    query.delete();
  }
}

/** 捕获的纯数据快照：节点引用出不了树，delete 之前先把判据要读的字段抄下来 */
interface Captured {
  name: string;
  node: { type: string; startPosition: { row: number; column: number } };
}

function capturesOf(name: string, text: string): Captured[] {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(text);
  if (tree === null) throw new Error('ERB 解析器没有产出语法树');
  const query = new Query(language, readQuery(name));
  try {
    return query
      .captures(tree.rootNode)
      .map((c) => ({
        name: c.name,
        node: { type: c.node.type, startPosition: { row: c.node.startPosition.row, column: c.node.startPosition.column } },
      }));
  } finally {
    query.delete();
    tree.delete();
    parser.delete();
  }
}

/* ======================================================================== */
/* ① 查询：编译 + 捕获（真 wasm）                                            */
/* ======================================================================== */

describe('ERB 查询 · 真 wasm 编译与捕获', () => {
  it.each(['folds', 'highlights', 'indents', 'brackets', 'diagnostics'])('%s.scm 能编译且捕获名非空', (name) => {
    withQuery(name, (query) => {
      expect(query.patternCount()).toBeGreaterThan(0);
      expect(query.captureNames.length).toBeGreaterThan(0);
      console.log(`[erb-ts-facets] ${name}.scm 编译：patterns=${query.patternCount()} captures=${query.captureNames.join(',')}`);
    });
  });

  it('indents.scm 只认三档 begin/end/enter（引擎另认同义 increase/decrease）', () => {
    const names = withQuery('indents', (query) => query.captureNames);
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
    const names = withQuery('highlights', (query) => query.captureNames);
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
