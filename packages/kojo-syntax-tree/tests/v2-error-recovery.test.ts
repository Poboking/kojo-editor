import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Language, Parser, type Node } from 'web-tree-sitter';

/**
 * Kojo 2.0 CST 错误恢复闸（U6 语法树 · v2）。
 *
 * 目标不是"报错"，而是**错误必须局部**：
 *  1. 未闭合台词 ⇒ 行末可定位的 `MISSING:speech_close`，下一行照常解析；
 *  2. 未闭合插值 ⇒ 定位在作者那一行，不跨行、不整篇 ERROR；
 *  3. 声明块/`@原生` 缺体 ⇒ 故障落在块头那一行（ERROR 包住块头，块头节点仍在 CST 里）；
 *  4. `# 表` 缺值 ⇒ `MISSING:table_value`；
 *  5. 结构区 Tab 缩进 ⇒ 只打 Tab 那一行，后面的 `>` 行照常解析。
 *
 * 通用硬口径：每一枚故障节点的 startRow === endRow（不跨行），且故障行之后
 * 仍能见到正常节点（除 EOF 结尾的 fixture 外）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const wasmPath = join(pkgRoot, 'tree-sitter-kojo2.wasm');
const BROKEN = join(pkgRoot, 'tests', 'v2-fixtures', 'broken');

let parser: Parser;
let language: Language;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(wasmPath);
  parser = new Parser();
  parser.setLanguage(language);
}, 120_000);

interface Fault {
  type: string;
  row: number;
  stRow: number;
  enRow: number;
}

function parseText(text: string): Node {
  const tree = parser.parse(text);
  if (!tree) throw new Error('解析没产出树');
  return tree.rootNode;
}

function faultsOf(root: Node): Fault[] {
  const out: Fault[] = [];
  const walk = (n: Node): void => {
    if (n.type === 'ERROR' || n.isMissing) {
      out.push({ type: n.isMissing ? `MISSING:${n.type}` : 'ERROR', row: n.startPosition.row, stRow: n.startPosition.row, enRow: n.endPosition.row });
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function parseFixture(name: string): { root: Node; rows: string[]; faults: Fault[] } {
  const text = readFileSync(join(BROKEN, name), 'utf8');
  const root = parseText(text);
  return { root, rows: text.split('\n'), faults: faultsOf(root) };
}

/** 某节点 type 在整棵树里的数量。 */
function count(root: Node, type: string): number {
  return root.descendantsOfType(type).length;
}

describe('未闭合台词：MISSING 落在行末，下一行照常解析', () => {
  it('broken-unclosed-speech.kojo2', () => {
    const { root, rows, faults } = parseFixture('broken-unclosed-speech.kojo2');
    // 只有一枚 MISSING:speech_close，且落在作者那一行（第 5 行，0 基 4）
    expect(faults.map((f) => f.type)).toEqual(['MISSING:speech_close']);
    const target = rows.findIndex((l) => l.includes('这句话没有收束'));
    expect(target).toBeGreaterThanOrEqual(0);
    expect(faults[0]!.row).toBe(target);
    // 台词节点仍在（span 延伸到行末），后续旁白与触发照常解析
    expect(count(root, 'speech')).toBe(1);
    expect(count(root, 'narration')).toBe(2);
    expect(count(root, 'trigger')).toBe(1);
    expect(rows[faults[0]!.row]).toContain('这句话没有收束');
  });
});

describe('未闭合插值：故障定位在插值那一行', () => {
  it('broken-unclosed-interp.kojo2', () => {
    const { root, rows, faults } = parseFixture('broken-unclosed-interp.kojo2');
    expect(faults.length).toBe(1);
    const target = rows.findIndex((l) => l.includes('她今天看起来{心情'));
    expect(target).toBeGreaterThanOrEqual(0);
    expect(faults[0]!.row).toBe(target);
    expect(faults[0]!.stRow, '错误不得跨行').toBe(faults[0]!.enRow);
    // 下一行照常解析
    expect(count(root, 'narration')).toBe(2);
    expect(rows[target + 1]).toContain('这一行必须照常解析');
  });
});

describe('缺体的声明块 / @原生：故障落在块头行，块头节点仍可定位', () => {
  it('broken-without-body.kojo（# 池 缺体）', () => {
    const { root, rows, faults } = parseFixture('broken-without-body.kojo2');
    expect(faults.length).toBeGreaterThanOrEqual(1);
    const target = rows.findIndex((l) => l.includes('# 池'));
    expect(target).toBeGreaterThanOrEqual(0);
    expect(faults.every((f) => f.row === target)).toBe(true);
    // 块头节点没被静默吞掉：CST 里仍能按名找到
    expect(count(root, 'pool_head')).toBe(1);
    // 前缀正文照常解析（错误不往前扩散）
    expect(count(root, 'narration')).toBe(1);
    // 也没有整篇 ERROR：故障行之前/之后的内容都在
    expect(root.type).toBe('source_file');
  });

  it('broken-unclosed-native.kojo（@原生 空块）', () => {
    const { root, rows, faults } = parseFixture('broken-unclosed-native.kojo2');
    expect(faults.length).toBeGreaterThanOrEqual(1);
    const target = rows.findIndex((l) => l.trim() === '@原生');
    expect(target).toBeGreaterThanOrEqual(0);
    expect(faults.every((f) => f.row === target)).toBe(true);
    expect(count(root, 'native_head')).toBe(1);
    expect(count(root, 'narration')).toBe(1);
  });

  it('broken-table-missing-value.kojo（缺值 ⇒ MISSING:table_value）', () => {
    const { root, rows, faults } = parseFixture('broken-table-missing-value.kojo2');
    expect(faults.length).toBe(1);
    expect(faults[0]!.type).toBe('MISSING:table_value');
    const target = rows.findIndex((l) => l.trim().startsWith('否'));
    expect(faults[0]!.row).toBe(target);
    // 表块本体与前面合法的行都在
    expect(count(root, 'table_row')).toBe(2);
    expect(count(root, 'table_value')).toBe(2);
  });
});

describe('结构区 Tab 缩进：只打 Tab 那一行', () => {
  it('broken-tab-indent.kojo2', () => {
    const { root, rows, faults } = parseFixture('broken-tab-indent.kojo2');
    expect(faults.length).toBeGreaterThanOrEqual(1);
    const target = rows.findIndex((l) => l.startsWith('\t'));
    expect(target).toBeGreaterThanOrEqual(0);
    expect(faults.every((f) => f.row === target), 'Tab 缩进错误必须只落在那一行').toBe(true);
    // @算 头仍在（空体退化形），Tab 那一行之后的旁白照常解析
    expect(count(root, 'calc_head')).toBe(1);
    expect(count(root, 'narration')).toBe(1);
    expect(rows[target + 1]).toContain('这一行必须照常解析');
  });
});

describe('错误恢复总口径：不跨行、不整篇崩', () => {
  const names = [
    'broken-unclosed-speech.kojo2',
    'broken-unclosed-interp.kojo2',
    'broken-without-body.kojo2',
    'broken-unclosed-native.kojo2',
    'broken-tab-indent.kojo2',
    'broken-table-missing-value.kojo2',
  ];

  it(`每份残缺样本都可解析、有可定位故障（${names.length} 份）`, () => {
    for (const name of names) {
      const { root, faults } = parseFixture(name);
      expect(root.type).toBe('source_file');
      expect(faults.length, `${name} 应有可定位故障`).toBeGreaterThanOrEqual(1);
      for (const f of faults) {
        expect(f.stRow, `${name}: ${f.type} 跨了多行（错误扩散）`).toBe(f.enRow);
      }
    }
  });

  it('故障行之外仍有正常节点（错误被限制，不吞后续正文）', () => {
    const cases: Array<[string, number]> = [
      // [fixture, 故障行之后必须出现的正常节点数下界；故障落在文件末行时为 0]
      ['broken-unclosed-speech.kojo2', 1],
      ['broken-unclosed-interp.kojo2', 1],
      ['broken-without-body.kojo2', 0],
      ['broken-tab-indent.kojo2', 1],
      ['broken-table-missing-value.kojo2', 0],
    ];
    for (const [name, minAfter] of cases) {
      const { root, rows, faults } = parseFixture(name);
      const maxFaultRow = Math.max(...faults.map((f) => f.row));
      const after = root
        .descendantsOfType(['narration', 'speech', 'trigger', 'assignment', 'table_row'])
        .filter((n) => n.startPosition.row > maxFaultRow);
      expect(after.length, `${name}: 故障之后必须还有正常节点`).toBeGreaterThanOrEqual(minAfter);
      expect(maxFaultRow).toBeLessThan(rows.length);
    }
  });
});
