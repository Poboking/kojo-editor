import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Language, Parser, Query, type Node } from 'web-tree-sitter';

/**
 * Kojo 2.0 查询闸（U6 语法树 · v2）：`queries/v2/{folds,highlights,indents}.scm`
 * 必须能被出货 wasm 的语言**编译**，且捕获名/命中行为与语法结构一致。
 *
 * 这里不碰宿主色板（宿主是后续批次的事）；本闸只钉三件事：
 *  1. 三份查询都能编译（query 语法与节点名没错）；
 *  2. folds 只捕 `block`，且每枚折叠区间确实跨行（endRow > startRow）；
 *  3. highlights 的捕获名全部是官方命名约定下的档位，且每档在 full.kojo2 上都有命中
 *     （"capture 名有档位"不是写了就算——得真落在节点上）；
 *  4. indents（K2-INDENT-BRACKETS 起）有真捕获：`indent.increase` 只落开体行，
 *     `indent.align` 只落并列容器，且没有任何捕获落在 `@原生` 体内；
 *  5. highlights 的**节点覆盖**：`src/node-types.v2.json` 里每个具名节点都要有捕获，
 *     容器 / 零宽记号例外但必须逐条写理由（白名单）。原先只查"档位名存在"⇒ 漏掉
 *     `(dialect_decl) @keyword` 也全绿，`# 方言 erafl` 那一行完全不上色而闸毫无反应。
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const wasmPath = join(pkgRoot, 'tree-sitter-kojo2.wasm');
const QUERY_DIR = join(pkgRoot, 'queries', 'v2');
const fullPath = join(pkgRoot, 'tests', 'v2-fixtures', 'full.kojo2');

let language: Language;
let parser: Parser;
let root: Node;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(wasmPath);
  parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(readFileSync(fullPath, 'utf8'));
  if (!tree) throw new Error('full.kojo2 解析失败');
  root = tree.rootNode;
}, 120_000);

function loadQuery(name: string): Query {
  return new Query(language, readFileSync(join(QUERY_DIR, `${name}.scm`), 'utf8'));
}

/** 一棵树上的全部捕获名（去重）。 */
function capturesOn(query: Query, node: Node): Set<string> {
  const names = new Set<string>();
  for (const m of query.matches(node)) {
    for (const c of m.captures) names.add(c.name);
  }
  return names;
}

describe('三份查询都能编译（query 语法 + 节点名与语法一致）', () => {
  it('folds.scm / highlights.scm / indents.scm', () => {
    for (const name of ['folds', 'highlights', 'indents']) {
      const q = loadQuery(name);
      expect(q.captureNames, `${name}.scm 的捕获名`).toBeInstanceOf(Array);
      q.delete();
    }
  });
});

describe('folds：只折 block，且折叠区间真的跨行', () => {
  it('捕获名 = fold；命中节点全是 block；endRow > startRow', () => {
    const q = loadQuery('folds');
    const matches = q.matches(root);
    expect(matches.length, 'full.kojo2 的折叠区间数').toBeGreaterThanOrEqual(15);
    for (const m of matches) {
      for (const c of m.captures) {
        expect(c.name).toBe('fold');
        expect(c.node.type).toBe('block');
        expect(c.node.endPosition.row, `第 ${c.node.startPosition.row + 1} 行的 block 折叠区间不跨行`).toBeGreaterThan(
          c.node.startPosition.row,
        );
      }
    }
    // 文档顺序 + 区间合法（起点行递增；允许同起点由嵌套造成）
    const starts = matches.map((m) => m.captures[0]!.node.startPosition.row);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    q.delete();
  });
});

describe('highlights：捕获名有档位，且每档在 full.kojo2 上都有命中', () => {
  it('档位集合', () => {
    const q = loadQuery('highlights');
    const names = new Set(q.captureNames);
    const wanted = [
      'comment',
      'keyword',
      'keyword.control',
      'keyword.function',
      'keyword.directive',
      'label',
      'function.call',
      'punctuation.special',
      'string',
      'string.special',
      'variable',
      'keyword.operator',
      'operator',
      'number',
      'embedded',
      // 类型 / 结构名（2026-10-27 第三色批）：`# 表` / `# 池` / `# 模` 三枚结构定义头
      'type',
      'none',
    ];
    const missing = wanted.filter((n) => !names.has(n));
    expect(missing, `highlights 缺档位：${missing.join(', ')}`).toEqual([]);
    q.delete();
  });

  it('每一档都真的落在节点上（不是空捕获）', () => {
    const q = loadQuery('highlights');
    const hit = capturesOn(q, root);
    const wanted = [
      'comment',
      'keyword',
      'keyword.control',
      'keyword.function',
      'keyword.directive',
      'label',
      'function.call',
      'punctuation.special',
      'string',
      'string.special',
      'variable',
      'keyword.operator',
      'operator',
      'number',
      'embedded',
      'type',
      'none',
    ];
    const noHit = wanted.filter((n) => !hit.has(n));
    expect(noHit, `这些档位在 full.kojo2 上零命中：${noHit.join(', ')}`).toEqual([]);
    // 关键档位的命中数下界（防止只命中最稀疏的一枚就过闸）
    const all = q.matches(root).flatMap((m) => m.captures.map((c) => c.name));
    const countOf = (n: string): number => all.filter((x) => x === n).length;
    // 类型档的地板：full.kojo2 里 `# 表` / `# 池` / `# 模` 各一枚 = 3。这一枚之所以单独立一条，
    // 是因为"theme 里有 support.type 这个键"零成本、屏上有没有它是另一件事（2026-10-27 第三色批）。
    expect(countOf('type'), 'full.kojo2 上 @type 命中数').toBeGreaterThanOrEqual(3);
    expect(countOf('string')).toBeGreaterThanOrEqual(15); // 旁白段 + 台词串
    expect(countOf('keyword.control')).toBeGreaterThanOrEqual(10); // @ / ? 块头族
    expect(countOf('string.special')).toBeGreaterThanOrEqual(5); // 插值 + 表演提示
    expect(countOf('embedded')).toBeGreaterThanOrEqual(5); // @原生 raw 行
    expect(countOf('number')).toBeGreaterThanOrEqual(3); // 表范围
    q.delete();
  });
});

/* ============================== highlights 节点覆盖闸 ============================== */

/**
 * 明确允许**不上色**的具名节点：只有两类——容器（子节点各自上色）与零宽记号
 * （scanner 产出的 `indent`/`dedent`、闭合记号，本身没有可视文本）。每条都必须写理由。
 *
 * 白名单**不许**收语义行节点（`*_decl` / `*_head` / `*_stmt`）：那一族是"整行是哪一档"的
 * 上游判据，漏一枚的表现就是整行无色——只能补捕获，不能免责。
 */
const NO_HIGHLIGHT_WHITELIST: Readonly<Record<string, string>> = {
  source_file: '根容器：整文件不对应任何可视行，子节点各自上色',
  block: '块容器：块头（*_head）与体内各行各自上色，容器本身没有独立文本',
  block_body: '块体容器：体内每一行都有自己的捕获',
  table_body: '`# 表` 体容器：表行由 table_row 及其子节点上色',
  table_row: '表行容器：范围 table_range / 默认分支 table_else / 值列 table_value 已各自捕获',
  narration: '旁白容器：narration_marker（`>`）与 narration_text 已各自捕获',
  speech: '台词容器：speaker 与 speech_string 已各自捕获',
  bare_speech: '池内无符号台词容器：其 text 字段是 speech_string（已捕获）',
  speech_text: '台词正文字段：随整个 speech_string 一起上 @string，不单独拆色',
  speech_close: '台词收尾记号：零宽，无可视文本',
  interp_body: '插值体内文：整个 interpolation 已上 @string.special，内部不拆（语义层再涂）',
  interp_close: '插值右花括号记号：零宽，无可视文本',
  // LAU-6：`native_body` 由 `(native_body) @none` 捕获（@none = 不上色，只把节点区间交给
  // 注入层做子 parse）⇒ 不再是"无捕获容器"，从白名单移出。
  indent: '缩进记号：scanner 产出的零宽节点，无可视文本',
  dedent: '回退缩进记号：scanner 产出的零宽节点，无可视文本',
};

const V2_NODE_TYPES = (
  JSON.parse(readFileSync(join(pkgRoot, 'src', 'node-types.v2.json'), 'utf8')) as Array<{
    type: string;
    named: boolean;
  }>
).filter((n) => n.named);

/** 从 scm 源文本里读"被捕获的节点名"（`(node) @capture` 形态，判据是静态覆盖而非命中率）。 */
function capturedNodeTypes(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/^\s*\(([A-Za-z_][\w]*)\)\s*@/gm)) out.add(m[1]!);
  return out;
}

const HIGHLIGHTS_SOURCE = readFileSync(join(QUERY_DIR, 'highlights.scm'), 'utf8');
const SEMANTIC_LINE_RE = /_(?:decl|head|stmt)$/;

describe('highlights 覆盖：node-types.v2.json 的每个具名节点都有捕获或白名单理由', () => {
  it('语义行节点（*_decl / *_head / *_stmt）一枚不许漏，且不许靠白名单免责', () => {
    const lineish = V2_NODE_TYPES.map((n) => n.type).filter((t) => SEMANTIC_LINE_RE.test(t));
    expect(lineish.length, '语义行节点少得离谱 ⇒ 读法失效').toBeGreaterThanOrEqual(25);
    const captured = capturedNodeTypes(HIGHLIGHTS_SOURCE);
    const missing = lineish.filter((t) => !captured.has(t));
    expect(missing, `highlights 漏了语义行节点（整行不上色）：${missing.join(', ')}`).toEqual([]);
    const excused = Object.keys(NO_HIGHLIGHT_WHITELIST).filter((t) => SEMANTIC_LINE_RE.test(t));
    expect(excused, '语义行节点只许补捕获，白名单只给容器/零宽记号用').toEqual([]);
  });

  it('具名节点全集：既没捕获也不在白名单的节点 ⇒ 红；白名单不许有僵尸项 / 空理由', () => {
    const named = V2_NODE_TYPES.map((n) => n.type);
    const captured = capturedNodeTypes(HIGHLIGHTS_SOURCE);
    const missing = named.filter((t) => !captured.has(t) && !(t in NO_HIGHLIGHT_WHITELIST));
    expect(missing, `既没捕获也没白名单理由：${missing.join(', ')}`).toEqual([]);
    const namedSet = new Set(named);
    const stale = Object.keys(NO_HIGHLIGHT_WHITELIST).filter((t) => !namedSet.has(t));
    expect(stale, `白名单里这些节点已不在 node-types.v2.json：${stale.join(', ')}`).toEqual([]);
    const alreadyCaptured = Object.keys(NO_HIGHLIGHT_WHITELIST).filter((t) => captured.has(t));
    expect(alreadyCaptured, `这些节点已有捕获，白名单项该删：${alreadyCaptured.join(', ')}`).toEqual([]);
    const blankReasons = Object.entries(NO_HIGHLIGHT_WHITELIST)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([t]) => t);
    expect(blankReasons, '白名单理由不许为空').toEqual([]);
  });

  it('`# 方言 erafl` 真上色（不是只把节点名写进 capture 表）', () => {
    const q = loadQuery('highlights');
    const tree = parser.parse('# 方言 erafl\n');
    if (!tree) throw new Error('`# 方言 erafl` 解析失败');
    const hits: Array<{ type: string; name: string }> = [];
    for (const m of q.matches(tree.rootNode)) {
      for (const c of m.captures) hits.push({ type: c.node.type, name: c.name });
    }
    expect(hits, '`# 方言` 那一行一个捕获都没有 ⇒ 该行完全不上色').toContainEqual({
      type: 'dialect_decl',
      name: 'keyword',
    });
    q.delete();
  });
});

describe('indents：真捕获（K2-INDENT-BRACKETS）', () => {
  it('捕获名只有 increase / align；increase 只落开体节点，且每枚都是所在 block 的 open', () => {
    const q = loadQuery('indents');
    expect(q.patternCount(), 'indents.scm 必须有真模式').toBeGreaterThan(0);
    expect([...new Set(q.captureNames)].sort()).toEqual(['indent.align', 'indent.increase']);
    const increaseTypes = new Set<string>();
    for (const match of q.matches(root)) {
      for (const capture of match.captures) {
        if (capture.name !== 'indent.increase') continue;
        increaseTypes.add(capture.node.type);
        expect(capture.node.parent?.type, `${capture.node.type} 不是块头`).toBe('block');
        const open = capture.node.parent?.childForFieldName('open');
        expect(open?.startIndex).toBe(capture.node.startIndex);
      }
    }
    // 五锚点里除 `>` / `!` 外的开体形状（`#`/`@` 块 + `?` 链）+ `@原生` 围栏头
    // （`!` 的 trigger 节点在 block_body 里也当裸调用行出现，按节点捕会误伤，见 indents.scm 头注）
    expect([...increaseTypes].sort()).toEqual([
      'calc_head',
      'color_head',
      'condition_head',
      'else_head',
      'foreach_head',
      'function_head',
      'group_head',
      'native_head',
      'pool_head',
      'random_head',
      'repeat_head',
      'table_head',
      'template_head',
      'weave_head',
      'while_head',
    ]);
    q.delete();
  });

  it('align 落在并列容器的首项上：表行 + `# 池` 首分支 / `@随机` 首候选 / `@组` 组首行', () => {
    const q = loadQuery('indents');
    const alignRows = new Set<number>();
    for (const match of q.matches(root)) {
      for (const capture of match.captures) {
        if (capture.name === 'indent.align') alignRows.add(capture.node.startPosition.row + 1);
      }
    }
    // full.kojo2：表行 12–15、池首分支 18、随机首候选 62、组首行 64
    for (const row of [12, 13, 14, 15, 18, 62, 64]) {
      expect(alignRows.has(row), `第 ${row} 行没有并列捕获`).toBe(true);
    }
    q.delete();
  });

  it('`@原生` 围栏体内零捕获（围栏里长得像块头的行不会进捕获表）', () => {
    const q = loadQuery('indents');
    const fenceRanges: Array<{ from: number; to: number }> = [];
    const walk = (node: Node): void => {
      if (node.type === 'native_body') {
        // `native_body` 起点是栏头行末的零宽 `indent` 记号 ⇒ 体内从下一行起
        fenceRanges.push({ from: node.startPosition.row + 1, to: node.endPosition.row });
      }
      for (const child of node.children) walk(child);
    };
    walk(root);
    expect(fenceRanges.length).toBeGreaterThan(0);
    for (const match of q.matches(root)) {
      for (const capture of match.captures) {
        const row = capture.node.startPosition.row;
        for (const range of fenceRanges) {
          expect(
            row >= range.from && row <= range.to,
            `第 ${row + 1} 行的 ${capture.name} 落在 @原生 体内`,
          ).toBe(false);
        }
      }
    }
    q.delete();
  });
});
