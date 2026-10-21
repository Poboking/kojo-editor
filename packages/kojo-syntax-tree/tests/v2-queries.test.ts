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
 *     （"capture 名有档位"不是写了就算——得真落在节点上）。
 * indents 是本批**有意零捕获**（见该文件头注），这里钉"零 pattern / 零 capture"不被误加。
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
      'none',
    ];
    const noHit = wanted.filter((n) => !hit.has(n));
    expect(noHit, `这些档位在 full.kojo2 上零命中：${noHit.join(', ')}`).toEqual([]);
    // 关键档位的命中数下界（防止只命中最稀疏的一枚就过闸）
    const all = q.matches(root).flatMap((m) => m.captures.map((c) => c.name));
    const countOf = (n: string): number => all.filter((x) => x === n).length;
    expect(countOf('string')).toBeGreaterThanOrEqual(15); // 旁白段 + 台词串
    expect(countOf('keyword.control')).toBeGreaterThanOrEqual(10); // @ / ? 块头族
    expect(countOf('string.special')).toBeGreaterThanOrEqual(5); // 插值 + 表演提示
    expect(countOf('embedded')).toBeGreaterThanOrEqual(5); // @原生 raw 行
    expect(countOf('number')).toBeGreaterThanOrEqual(3); // 表范围
    q.delete();
  });
});

describe('indents：本批显式零捕获（按设计，不是漏写）', () => {
  it('零 pattern / 零 capture；命中为空', () => {
    const q = loadQuery('indents');
    expect(q.patternCount(), 'indents.scm 本批有意零模式（见文件头注）').toBe(0);
    expect(q.captureNames).toEqual([]);
    expect(q.matches(root)).toEqual([]);
    q.delete();
  });
});
