import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Node, Parser } from 'web-tree-sitter';
import { buildRowTable, createParser, lineNodes, rowOfLastChar } from '../src/index';

/**
 * 错误恢复闸（第二波：块嵌套后的"错误必须局部"）。
 *
 * 本包两条硬口径在这里钉住（与 `tools/parse-corpus.mjs` 同一批取数，但拆进程的那层在这里不需要
 * ——本文件只解析小样本与逐文件独立解析，累积量远不到 web-tree-sitter 0.27 的退出 OOM 门槛）：
 *
 * 1. **真实语料零 ERROR / 零 MISSING**（块嵌套让语法比"逐行"更严，这条就是严到没严出误报的证据）；
 * 2. **故意残缺的 fixtures 必须可定位、被限制、不崩**：
 *    · `broken-unclosed-block.kojo`：`循环：` / `出错处理：` 两枚有显式收束词的块没收盘 ⇒
 *      在回缩点 / EOF 处各插一枚 MISSING 收束词（可定位），而残块之后的 `时机` 块、台词行、
 *      以及那枚**靠回缩收盘**的 `如果` 块（本 DSL 没有 `如果结束` 这个写形 ⇒ 不是残缺）全部照常解析；
 *    · 另三枚（未闭合 `「」` / `{}`）仍各落一枚可定位 ERROR。
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const wasmPath = join(pkgRoot, 'tree-sitter-kojo.wasm');
const FIXTURE_DIR = join(pkgRoot, 'tests', 'fixtures');

function collect(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.name.endsWith('.kojo')) out.push(p);
  }
  return out;
}

const brokenFixtures = collect(FIXTURE_DIR, []).sort();
const realCorpus: string[] = [];
for (const top of ['packages', 'fixtures']) {
  for (const p of collect(join(repoRoot, top), [])) {
    if (p === FIXTURE_DIR || p.startsWith(`${FIXTURE_DIR}/`) || p.startsWith(`${FIXTURE_DIR}\\`)) continue;
    realCorpus.push(p);
  }
}
realCorpus.sort();
const relOf = (file: string): string => file.slice(repoRoot.length + 1).replaceAll('\\', '/');

/** 全文走一遍，收 ERROR / MISSING 节点（含坐标与所在行文本，报错时人能直接读）。 */
function findFaults(root: Node, rows: number[], text: string): Array<{ type: string; row: number; snippet: string }> {
  const out: Array<{ type: string; row: number; snippet: string }> = [];
  const walk = (node: Node): void => {
    if (node.type === 'ERROR' || node.isMissing) {
      const row = rowOfLastChar(node, rows);
      const line = text.split('\n')[row] ?? '';
      out.push({ type: node.isMissing ? `MISSING:${node.type}` : 'ERROR', row, snippet: line.trim().slice(0, 50) });
    }
    for (const c of node.children) walk(c);
  };
  walk(root);
  return out;
}

let parser: Parser | null = null;

beforeAll(async () => {
  parser = await createParser(wasmPath);
}, 180_000);

describe('真实语料：块嵌套后仍然零 ERROR / 零 MISSING', () => {
  it(`19 个语料文件全绿`, async () => {
    const p = parser as Parser;
    expect(realCorpus.length).toBeGreaterThanOrEqual(19);
    const offenders: string[] = [];
    for (const file of realCorpus) {
      const text = readFileSync(file, 'utf8');
      const tree = p.parse(text);
      const faults = tree ? findFaults(tree.rootNode, buildRowTable(text), text) : [];
      tree?.delete();
      if (faults.length > 0) offenders.push(`${relOf(file)} :: ${faults.map((f) => `${f.type}@${f.row}`).join(', ')}`);
    }
    console.log(`真实语料文件 ${realCorpus.length} / 有故障的文件 ${offenders.length}`);
    for (const o of offenders) console.log(`  !! ${o}`);
    expect(offenders, '真实语料出现 ERROR/MISSING ⇒ 语法比真源更严，必须修语法').toEqual([]);
  }, 240_000);
});

describe('故意残缺 fixtures：可定位、被限制、不崩', () => {
  it('每枚残缺样本都有可定位的 ERROR/MISSING', async () => {
    const p = parser as Parser;
    expect(brokenFixtures.length).toBeGreaterThanOrEqual(4);
    for (const file of brokenFixtures) {
      const text = readFileSync(file, 'utf8');
      const tree = p.parse(text);
      expect(tree, `解析没产出树：${file}`).not.toBeNull();
      const faults = tree ? findFaults(tree.rootNode, buildRowTable(text), text) : [];
      tree?.delete();
      console.log(`${file.slice(FIXTURE_DIR.length + 1)} :: 故障 ${faults.length} 处 ${faults.map((f) => `${f.type}@行${f.row + 1}`).join(', ')}`);
      expect(faults.length, `${file} 应至少有一处可定位故障`).toBeGreaterThan(0);
    }
  }, 120_000);

  it('未收盘的块：MISSING 落在收束词应有的位置，后续无关行照常解析', async () => {
    const p = parser as Parser;
    const file = join(FIXTURE_DIR, 'broken-unclosed-block.kojo');
    const text = readFileSync(file, 'utf8');
    const rows = buildRowTable(text);
    const tree = p.parse(text);
    expect(tree).not.toBeNull();
    const root = tree!.rootNode;
    const faults = findFaults(root, rows, text);
    // ① 两枚有显式收束词的块（循环 / 出错处理）各插一枚 MISSING 收束词
    const missingCloses = faults.filter((f) => f.type === 'MISSING:loop_end' || f.type === 'MISSING:catch_end');
    console.log(`残缺块故障清单：${faults.map((f) => `${f.type}@行${f.row + 1}`).join(', ') || '（无）'}`);
    expect(missingCloses.length, '未收盘的块必须各留一枚可定位的 MISSING 收束词').toBe(2);
    // ② 收束缺失把错误锁在自己块内：残块之后的 `时机 指令 901：` 仍成块、其正文台词仍在
    const blocks = root.namedChildren.filter((c) => c.type === 'block');
    const after = blocks.find((b) => (b.childForFieldName('open')?.text ?? '').includes('901'));
    expect(after ?? null, '残块之后的 时机 块必须仍被解析成块').not.toBeUndefined();
    const speeches = lineNodes(root)
      .filter((n) => n.type === 'string')
      .map((n) => n.text);
    expect(speeches.some((t) => t.includes('与上面的残块无关')), '残块之后的台词行必须仍解析成 string 节点').toBe(true);
    // ③ 靠回缩收盘的 `如果` 块不是残缺：它必须成块且零故障
    const ifBlock = blocks
      .flatMap((b) => [b, ...b.namedChildren.filter((c) => c.type === 'block')])
      .find((b) => (b.childForFieldName('open')?.type ?? '') === 'if_head');
    expect(ifBlock ?? null, '如果 块（无显式收束词族）应由回缩收盘成块').not.toBeUndefined();
    expect(faults.some((f) => f.row >= rows.length), '故障不该跑到文外').toBe(false);
    const ifRange = faults.filter((f) => f.row >= (ifBlock?.startPosition.row ?? -1) && f.row <= (ifBlock?.endPosition.row ?? -1));
    expect(ifRange, `回缩收盘的 如果 块内不应有故障：${JSON.stringify(ifRange)}`).toEqual([]);
    tree!.delete();
  }, 120_000);
});
