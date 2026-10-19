import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyLine, splitLogicalLines, type LineClass } from '@kojo/plugin-kojo-sugar';
import {
  buildRowTable,
  classifyLines,
  createParser,
  KIND_TO_NODE,
  NODE_TO_KIND,
  rowOfLastChar,
  type KojoKind,
} from '../src/index';
import type { Node, Parser } from 'web-tree-sitter';

/**
 * CST ↔ `classifyLine` 逐行一致率闸（TSIT-M2 ①，第二波口径）。
 *
 * ## 这条闸在量什么
 *
 * `grammar.js` 自称"语法的第二份真源"。第二份真源只有在**与第一份逐行同判**时才配叫真源，
 * 否则它是第三条路、比没有更坏。本文件把两份判据喂给**同一批真实语料**，逐逻辑行对照：
 * 第一真源 = `kojo-sugar/lexer.classifyLine`（转译、缩进、回车全部在用它）；
 * 第二真源 = tree-sitter CST 的行节点经 `NODE_TO_KIND` 反查出的 kind。
 * 两侧都不许为对方让路（不改 classifyLine、不改 node-types.ts 的冻结值），只报实测数。
 *
 * ## 口径（写死在这里，避免"分母漂移"）
 *
 * 1. **行单位 = 逻辑行**：折行（行尾 `\`）由 `splitLogicalLines` 合并成一条逻辑行，
 *    对照锚点取该逻辑行的**首个物理行**；跨多个物理行的逻辑行单列为 `折行`、不入分母。
 * 2. **`grammar-finer`（语法更细）不算失配**：CST 把行首 `「…」` 认成 `string`、`{…}` 认成
 *    `interpolation`，而 `classifyLine` 只说 `text`。两侧不冲突 ⇒ 走此桶并逐条打印。
 * 3. **`context-only`（只在块上下文里成立）同样不算失配**：`choiceItem` / `switchItem` /
 *    `arrowCase` / `arrowElse` 四形在第一真源的 `LineClass` 联合里**声明了 kind，但 classifyLine
 *    从不产出**（下方 `无上下文四形零产出` 断言把这条实测钉死：9,120 逻辑行全量跑一遍，四形产出 0）。
 *    它们只在所属块体内合法——`选项/菜单/询问/确认` 的条目、`开关:` 的条目、`当` 的箭头分支。
 *    第一波没有块嵌套，这四形是"按形状抢跑"⇒ 记真冲突；第二波有了 scanner 的缩进记号，
 *    它们在块外**词法上就不可达**（落回 `text_line` / `string`），在块内才是本形 ⇒
 *    这是"语法层比无上下文词法层多知道一层上下文"，与 `grammar-finer` 同一性质，单列成桶。
 * 4. **两条读数分开**：`一致率 =（同判 + 语法更细 + 上下文专属）/ 分母`（地板钉这条）；
 *    `严格同判率 = 同判 / 分母`（只报不钉）。
 * 5. **坐标口径**：行锚点 = 节点**末字符**所在行（`rowOfLastChar`）。本语法每行一条原子记号，
 *    记号前的 extras（缩进）会被吞进 span ⇒ `startPosition.row` 对块内首行仍可能偏一行；
 *    末字符锚点对所有形都成立。`src/index.ts` 的 `classifyLines()` 走同一枚 `rowOfLastChar`
 *    （第一波那个 `node.startRow` 字段名缺陷本波已修：web-tree-sitter 0.27 只有
 *    `startPosition.row`）。
 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/kojo-syntax-tree/tests
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const wasmPath = join(pkgRoot, 'tree-sitter-kojo.wasm');
/**
 * 故意残缺的 fixtures（错误恢复样本）不进取数闸——它们的行本就解不干净。
 * 只排除这一目录（`tests/fixtures/`）：`tests/coverage-fixtures/` 下的覆盖面样本
 * 必须**完整可解析**，因此照常计入分母——三形（heartHead / statementCall / controlMalformed）
 * 在真实语料里原本一次都没出现过，覆盖面就靠那批文件钉。
 */
const BROKEN_DIR = join(pkgRoot, 'tests', 'fixtures');

/**
 * 一致率地板（**取数后写死**）。现测 20 个语料 / 9,120 逻辑行（参与对照 9,119，折行 1）
 * 一致率 100.00%（同判 + 语法更细 + 上下文专属 = 分母），真冲突 0 行。
 * 地板留 0.1pt 余量给"新语料进来先红一条"的抖动；跌破地板 = 语法层与词法层开始分叉，
 * 必须在 grammar.js / node-types.ts 一侧修，不许回头改这里。
 */
const FLOOR_RATE = 99.9;

/** 真冲突预算（只降不升的棘轮）。本波实测 0 行——第一波的 30 行全部拆到了「上下文专属」与词形补齐。 */
const CONFLICT_BUDGET = 0;

/** 上下文专属预算（只升不降的反向棘轮：这四形的行数掉了 = 块嵌套退化，当场拦住）。实测 27 行。 */
const CONTEXT_FLOOR = 27;

/** 合成单行面的真分歧预算（实测 0 条：第一波那枚 `exprHead` 漏判已随 `is` / 半角冒号口径修好）。 */
const SYNTHETIC_BUDGET = 0;

/** 与 `tools/parse-corpus.mjs` 的 `collect()` 同一份发现规则（递归、跳 node_modules、可排除目录）。 */
function collect(dir: string, out: string[], exclude: string | null): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (exclude && (p === exclude || p.startsWith(`${exclude}/`) || p.startsWith(`${exclude}\\`))) continue;
    if (e.isDirectory()) collect(p, out, exclude);
    else if (e.name.endsWith('.kojo')) out.push(p);
  }
  return out;
}

const fixtures: string[] = [];
for (const top of ['packages', 'fixtures']) collect(join(repoRoot, top), fixtures, BROKEN_DIR);
fixtures.sort();
const relOf = (file: string): string => file.slice(repoRoot.length + 1).replaceAll('\\', '/');

/** CST 比 `classifyLine` 更细的行级节点（台词串 / 插值整行）——单列，不混进失配。 */
const FINER_NODES = new Set(['string', 'interpolation']);

/** 只在块上下文里成立的四形（定义与理由见 `node-types.ts` 的 `CONTEXT_ONLY_KINDS`）。 */
const CONTEXT_ONLY = new Set<KojoKind>(['choiceItem', 'switchItem', 'arrowCase', 'arrowElse']);

const kindOfNode = (nodeType: string): KojoKind | null =>
  (NODE_TO_KIND as Record<string, KojoKind>)[nodeType] ?? null;

/**
 * 物理行 → 该行**正文**行节点。本语法把换行交给 `blank_line` 逐条认领（见 grammar.js 头注），
 * 于是一行必然有两枚节点（正文 + 它的换行）——这不是争抢，`blank_line` 让位给正文节点，
 * 只有两枚**正文**行节点抢同一行才计争抢（第二波的口径修正；第一波换行走 extras，没这项噪声）。
 */
function rowsToNodes(
  entries: { row: number; nodeType: string; kind: KojoKind | null }[],
): { map: Map<number, string>; collisions: Map<string, number> } {
  const map = new Map<number, string>();
  const collisions = new Map<string, number>();
  for (const entry of entries) {
    const kept = map.get(entry.row);
    if (!kept) {
      map.set(entry.row, entry.nodeType);
      continue;
    }
    if (entry.nodeType === 'blank_line') continue; // 本行的换行记号，不算争抢
    if (kept === 'blank_line') {
      map.set(entry.row, entry.nodeType); // 正文节点取代先占的空行记号（同步行内先后无涉）
      continue;
    }
    const key = `${kept} ⇄ ${entry.nodeType}`;
    collisions.set(key, (collisions.get(key) ?? 0) + 1);
  }
  return { map, collisions };
}

type Verdict = 'match' | 'grammar-finer' | 'context-only' | 'folded' | 'cst-missing' | 'cst-null' | 'mismatch';

interface RowStat {
  verdict: Verdict;
  fixture: string;
  line: number;
  truth: string;
  cst: string;
  /** 该行正文（截断；失配清单要能被人力直接读，不是一串 kind） */
  text?: string;
}

const EMPTY_COUNTS: Record<Verdict, number> = {
  match: 0,
  'grammar-finer': 0,
  'context-only': 0,
  folded: 0,
  'cst-missing': 0,
  'cst-null': 0,
  mismatch: 0,
};

interface FileStat {
  readonly rel: string;
  readonly logicalLines: number;
  readonly cstNodes: number;
  readonly counts: Record<Verdict, number>;
}

const mismatches: RowStat[] = [];
const finer: RowStat[] = [];
const contextOnly: RowStat[] = [];
const cstMissing: RowStat[] = [];
const nullKinds = new Set<string>();
/** `classifyLine kind ⇄ CST 无 kind 节点名` 的配对计数（判断"语法更细"还是"表缺一格"的原料） */
const cstNullPairs = new Map<string, number>();
/** 真实语料里出现过的 kind（合成覆盖的分母基线；任一侧判到即计入） */
const kindsSeenInCorpus = new Set<string>();
/**
 * 真实语料里**两侧同判**（逐字同一 kind）出现过的 kind = 覆盖面的硬口径：
 * 这一形既被第一真源判到、又被 CST 判到对应节点，才算"被对账过"。
 * 只有 `CONTEXT_ONLY` 四形允许缺席（第一真源无上下文，永不产出它们）。
 */
const kindsPairedInCorpus = new Set<string>();
/** 第一真源在全量语料里对四枚"上下文形"的产出计数（必须恒为 0，否则 context-only 桶不成立） */
const oracleContextEmission: Record<string, number> = { choiceItem: 0, switchItem: 0, arrowCase: 0, arrowElse: 0 };
/** 包导出面 `classifyLines()` 的自证读数 */
const exportedDrift = { kindDriftFiles: 0, rowsUndefined: 0 };
/** 同一物理行争抢到的节点配对（`留下的 ⇄ 丢掉的`）——非 `blank_line` 的争抢必须看得见 */
const rowCollisionPairs = new Map<string, number>();

describe('CST ↔ classifyLine 逐行一致率（真实语料全量）', () => {
  const perFile: FileStat[] = [];

  beforeAll(async () => {
    const p = await createParser(wasmPath);
    for (const file of fixtures) {
      const rel = relOf(file);
      const text = readFileSync(file, 'utf8');
      const tree = p.parse(text);
      if (tree === null) throw new Error(`解析器没有产出树：${rel}`);
      const rows = buildRowTable(text);
      // 走树：与 `classifyLines()` 同一条判据（容器下钻、行节点取末字符锚点）
      const walked = tree.rootNode ? collectLineNodes(tree.rootNode, rows) : [];
      tree.delete();
      const { map: byRow, collisions } = rowsToNodes(walked);
      for (const [pair, n] of collisions) rowCollisionPairs.set(pair, (rowCollisionPairs.get(pair) ?? 0) + n);
      const counts: Record<Verdict, number> = { ...EMPTY_COUNTS };
      let logicalLines = 0;
      const push = (stat: RowStat): void => {
        counts[stat.verdict] += 1;
        logicalLines += 1;
        if (stat.verdict === 'mismatch') mismatches.push(stat);
        if (stat.verdict === 'grammar-finer') finer.push(stat);
        if (stat.verdict === 'context-only') contextOnly.push(stat);
        if (stat.verdict === 'cst-missing') cstMissing.push(stat);
      };
      for (const logical of splitLogicalLines(text)) {
        const truth: LineClass = classifyLine(logical);
        kindsSeenInCorpus.add(truth.kind);
        if (truth.kind in oracleContextEmission) oracleContextEmission[truth.kind] = (oracleContextEmission[truth.kind] ?? 0) + 1;
        const nodeType = byRow.get(logical.line - 1) ?? null;
        const cstKind = nodeType === null ? null : kindOfNode(nodeType);
        if (cstKind !== null) kindsSeenInCorpus.add(cstKind);
        if (nodeType === null) {
          // 空行在 CST 里由 blank_line 记号认领；该行没有节点时只认 classifyLine 的 blank
          if (truth.kind === 'blank') push({ verdict: 'match', fixture: rel, line: logical.line, truth: truth.kind, cst: '<无节点/blank>' });
          else push({ verdict: 'cst-missing', fixture: rel, line: logical.line, truth: truth.kind, cst: '<无节点>' });
          continue;
        }
        if (FINER_NODES.has(nodeType) && (truth.kind === 'text' || truth.kind === 'heartText' || truth.kind === 'blank')) {
          push({ verdict: 'grammar-finer', fixture: rel, line: logical.line, truth: truth.kind, cst: nodeType });
          continue;
        }
        if (logical.endLine > logical.line) {
          // 折行逻辑行：CST 只看得到首物理行（含行尾 `\`），两侧输入本就不同串 ⇒ 不入分母
          push({ verdict: 'folded', fixture: rel, line: logical.line, truth: truth.kind, cst: cstKind ?? nodeType });
          continue;
        }
        if (cstKind === null) {
          nullKinds.add(nodeType);
          const pair = `${truth.kind} ⇄ <${nodeType} 无 kind>`;
          cstNullPairs.set(pair, (cstNullPairs.get(pair) ?? 0) + 1);
          push({ verdict: 'cst-null', fixture: rel, line: logical.line, truth: truth.kind, cst: `<${nodeType} 无 kind>` });
          continue;
        }
        if (cstKind === truth.kind) {
          kindsPairedInCorpus.add(truth.kind);
          push({ verdict: 'match', fixture: rel, line: logical.line, truth: truth.kind, cst: cstKind });
          continue;
        }
        if (CONTEXT_ONLY.has(cstKind) && truth.kind === 'text') {
          push({ verdict: 'context-only', fixture: rel, line: logical.line, truth: truth.kind, cst: cstKind, text: logical.text.trim().slice(0, 60) });
          continue;
        }
        push({
          verdict: 'mismatch',
          fixture: rel,
          line: logical.line,
          truth: truth.kind,
          cst: cstKind,
          text: logical.text.trim().slice(0, 60),
        });
      }
      perFile.push({ rel, logicalLines, cstNodes: walked.length, counts });
    }
  }, 240_000);

  /** 走树取行节点（与 `src/index.ts` 的 `lineNodes()` 同一套容器表，测试里复刻以免循环依赖）。 */
  function collectLineNodes(root: Node, rows: number[]): { row: number; nodeType: string; kind: KojoKind | null }[] {
    const CONTAINERS = new Set(['source_file', 'block', 'item_block', 'block_body', 'switch_body', 'choice_body', 'when_body']);
    const out: { row: number; nodeType: string; kind: KojoKind | null }[] = [];
    const walk = (node: Node): void => {
      if (CONTAINERS.has(node.type)) {
        for (const child of node.namedChildren) walk(child);
        return;
      }
      const head = node.childForFieldName('open');
      const lineNode = head ?? node;
      out.push({ row: rowOfLastChar(lineNode, rows), nodeType: lineNode.type, kind: kindOfNode(lineNode.type) });
    };
    walk(root);
    return out;
  }

  it('语料在位（分母 = 文件数；取数规则同 tools/parse-corpus.mjs）', () => {
    console.log(`\n===== ① CST ↔ classifyLine 逐行一致率 =====`);
    console.log(`语料文件数（分母）: ${fixtures.length}`);
    for (const file of fixtures) console.log(`  · ${relOf(file)}`);
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    // 覆盖面夹具必须在发现面里——它一被排除，三形覆盖读数就退回"从未对账"（静默失效）。
    expect(
      fixtures.some((f) => relOf(f).startsWith('packages/kojo-syntax-tree/tests/coverage-fixtures/')),
      'coverage-fixtures 不在语料发现面里 ⇒ heartHead / statementCall / controlMalformed 三形又没人对账了',
    ).toBe(true);
  });

  it('逐行对照读数：一致率 + 分母 + 失配清单', () => {
    const summed = (v: Verdict): number => perFile.reduce((n, s) => n + s.counts[v], 0);
    const total = perFile.reduce((n, s) => n + s.logicalLines, 0);
    const folded = summed('folded');
    const judged = total - folded;
    const match = summed('match');
    const grammarFiner = summed('grammar-finer');
    const contextBuckets = summed('context-only');
    const cstMiss = summed('cst-missing');
    const cstNull = summed('cst-null');
    const realMismatch = summed('mismatch');
    const rate = judged === 0 ? 0 : ((match + grammarFiner + contextBuckets) / judged) * 100;
    const strictRate = judged === 0 ? 0 : (match / judged) * 100;

    console.log(`逻辑行总数（含折行）      : ${total}`);
    console.log(`参与对照（去折行）        : ${judged}`);
    console.log(`折行逻辑行（不入分母）    : ${folded}`);
    console.log(`同判（两侧同一 kind）     : ${match}`);
    console.log(`grammar-finer（语法更细） : ${grammarFiner}`);
    console.log(`context-only（块上下文专属）: ${contextBuckets}`);
    console.log(`真冲突（判到不同层）      : ${realMismatch}`);
    console.log(`CST 无节点而行非空        : ${cstMiss}`);
    console.log(`CST 节点反查不到 kind     : ${cstNull}（节点名 ${[...nullKinds].join(', ') || '—'}）`);
    console.log(`==> 一致率 ${rate.toFixed(2)}%（同判 + 语法更细 + 上下文专属，分母 ${judged} 行 / ${fixtures.length} 个语料文件）`);
    console.log(`==> 严格同判率 ${strictRate.toFixed(2)}%（只算两侧逐字同一 kind）`);

    console.log('每文件严格同判率（升序，最低 8 个）:');
    for (const s of [...perFile]
      .map((f) => {
        const j = f.logicalLines - f.counts.folded;
        const ok = f.counts.match + f.counts['grammar-finer'] + f.counts['context-only'];
        return { rel: f.rel, j, ok, strict: f.counts.match };
      })
      .sort((a, b) => a.strict / Math.max(a.j, 1) - b.strict / Math.max(b.j, 1))
      .slice(0, 8)) {
      console.log(
        `  一致 ${((s.ok / Math.max(s.j, 1)) * 100).toFixed(1)}%（${s.ok}/${s.j}）· 逐字同判 ${((s.strict / Math.max(s.j, 1)) * 100).toFixed(1)}%  ${s.rel}`,
      );
    }

    if (mismatches.length > 0) {
      console.log(`真冲突清单（全部 ${mismatches.length} 条）:`);
      for (const m of mismatches) {
        console.log(`  ${m.fixture}:${m.line}  classifyLine=${m.truth}  CST=${m.cst}  | ${m.text}`);
      }
      const byPair = new Map<string, number>();
      for (const m of mismatches) byPair.set(`${m.truth} ⇄ ${m.cst}`, (byPair.get(`${m.truth} ⇄ ${m.cst}`) ?? 0) + 1);
      console.log('真冲突按「classifyLine ⇄ CST」配对归并:');
      for (const [pair, n] of [...byPair].sort((a, b) => b[1] - a[1])) console.log(`  ${n} × ${pair}`);
    }
    if (finer.length > 0) {
      const byPair = new Map<string, number>();
      for (const f of finer) byPair.set(`${f.truth} ⇄ ${f.cst}`, (byPair.get(`${f.truth} ⇄ ${f.cst}`) ?? 0) + 1);
      console.log(`grammar-finer 归类（共 ${finer.length} 行，不算失配）:`);
      for (const [pair, n] of [...byPair].sort((a, b) => b[1] - a[1])) console.log(`  ${n} × ${pair}`);
    }
    if (contextOnly.length > 0) {
      const byPair = new Map<string, number>();
      for (const c of contextOnly) byPair.set(`${c.truth} ⇄ ${c.cst}`, (byPair.get(`${c.truth} ⇄ ${c.cst}`) ?? 0) + 1);
      console.log(`context-only 归类（共 ${contextOnly.length} 行，第一真源无上下文判不出这四形）:`);
      for (const [pair, n] of [...byPair].sort((a, b) => b[1] - a[1])) console.log(`  ${n} × ${pair}`);
      console.log('context-only 清单（前 30 条）:');
      for (const c of contextOnly.slice(0, 30)) console.log(`  ${c.fixture}:${c.line}  classifyLine=${c.truth}  CST=${c.cst}  | ${c.text}`);
    }
    if (cstMissing.length > 0) {
      console.log(`CST 无节点清单（前 20 / 共 ${cstMissing.length}）:`);
      for (const m of cstMissing.slice(0, 20)) console.log(`  ${m.fixture}:${m.line} classifyLine=${m.truth}`);
    }
    if (cstNullPairs.size > 0) {
      console.log(`CST 节点反查不到 kind 的配对（前 20，按行数降序）:`);
      for (const [pair, n] of [...cstNullPairs].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${n} × ${pair}`);
    }
    const collisionTotal = [...rowCollisionPairs.values()].reduce((n, v) => n + v, 0);
    console.log(`同一物理行争抢到多个行节点 : ${collisionTotal} 次（留第一个，其余按配对列出）`);
    for (const [pair, n] of [...rowCollisionPairs].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${n} × ${pair}`);
    console.log(`第一真源对四枚上下文形的产出计数（必须全 0，否则本桶判据不成立）: ${JSON.stringify(oracleContextEmission)}`);

    // 断言 1：真冲突有预算、只降不升。第一波 30 行 → 本波实测 0 行：
    //   · 27 行是"形状只在块内成立"四形 ⇒ 进 context-only（性质与 grammar-finer 相同，见口径 3）；
    //   · 3 行是词形缺口（裸 `if`、`is`、表达式当的半角冒号）⇒ grammar.js 补齐，实测已同判。
    expect(realMismatch, `真冲突 ${realMismatch} 行 > 预算 ${CONFLICT_BUDGET}，见上方清单`).toBeLessThanOrEqual(
      CONFLICT_BUDGET,
    );
    // 断言 2：一致率地板（同判 + 语法更细 + 上下文专属）。取数 100.00%，地板 99.9 留抖动余量。
    expect(rate, `一致率 ${rate.toFixed(2)}% 低于地板 ${FLOOR_RATE}`).toBeGreaterThanOrEqual(FLOOR_RATE);
    // 断言 3：两侧都不许有"判不出 kind"的行（有 = 对照面缺一格，不是"没颜色"这么轻）。
    expect(cstMiss, 'CST 无节点而行非空：有行没被任何行节点认领').toBe(0);
    expect(cstNull, `CST 节点反查不到 kind：${[...nullKinds].join(', ')}`).toBe(0);
    // 断言 4：context-only 桶的前提——第一真源在全量语料里从不产出那四枚 kind。
    for (const [kind, n] of Object.entries(oracleContextEmission)) {
      expect(n, `classifyLine 竟产出了 ${kind}（无上下文判据被改？context-only 桶不再成立）`).toBe(0);
    }
    // 断言 5：反向棘轮——块嵌套退化（条目/箭头形不再在块内命中）会先把这条打红。
    expect(contextBuckets, `context-only ${contextBuckets} 行 < 下限 ${CONTEXT_FLOOR} ⇒ 块上下文退化`).toBeGreaterThanOrEqual(
      CONTEXT_FLOOR,
    );
  });

  it('KIND_TO_NODE 表闭合（一 kind 一节点、可反查）', () => {
    // 表规模取数：56 类（冻结词表；第二波只加容器与行内节点，不加 kind）。
    expect(Object.keys(KIND_TO_NODE).length).toBe(56);
    const nodes = new Set(Object.values(KIND_TO_NODE));
    expect(nodes.size).toBe(Object.keys(KIND_TO_NODE).length);
    for (const [kind, node] of Object.entries(KIND_TO_NODE)) {
      expect(NODE_TO_KIND[node as keyof typeof NODE_TO_KIND], `kind ${kind} 反查不回来`).toBe(kind);
    }
  });

  it('包导出面 classifyLines() 与走树判据同源（row 已是数字、kind 序列等长同序）', async () => {
    const p = await createParser(wasmPath);
    for (const file of fixtures.slice(0, 6)) {
      const text = readFileSync(file, 'utf8');
      const viaExport = await classifyLines(p, text);
      const rows = buildRowTable(text);
      const tree = p.parse(text);
      const walked = tree ? collectExportComparison(tree.rootNode, rows) : [];
      tree?.delete();
      for (const entry of viaExport) if (typeof entry.row !== 'number') exportedDrift.rowsUndefined++;
      const a = viaExport.map((e) => e.kind ?? `<${e.nodeType}>`).join('|');
      const b = walked.map((e) => e.kind ?? `<${e.nodeType}>`).join('|');
      if (a !== b) exportedDrift.kindDriftFiles++;
    }
    console.log(
      `\n导出面 classifyLines() 自证：kind 序列与走树判据不一致的文件数 = ${exportedDrift.kindDriftFiles}；` +
        `row 非数字的条目数 = ${exportedDrift.rowsUndefined}`,
    );
    expect(exportedDrift.kindDriftFiles).toBe(0);
    expect(exportedDrift.rowsUndefined).toBe(0);
  });

  it('真实语料覆盖面读数（哪些 kind 在语料里根本没出现）', () => {
    const all = Object.keys(KIND_TO_NODE) as KojoKind[];
    const missed = all.filter((k) => !kindsSeenInCorpus.has(k));
    // 同判面缺席的 kind 只许是"上下文专属"四形（第一真源无上下文，永不产出 ⇒ 见口径 3）。
    const unpaired = all.filter((k) => !kindsPairedInCorpus.has(k));
    const unpairedReal = unpaired.filter((k) => !CONTEXT_ONLY.has(k));
    console.log(
      `真实语料覆盖 kind（任一侧判到）: ${all.length - missed.length}/${all.length}` +
        (missed.length ? `；未覆盖: ${missed.join(', ')}` : '（56 形全覆盖）'),
    );
    console.log(
      `真实语料同判覆盖 kind（两侧逐字同一 kind）: ${all.length - unpaired.length}/${all.length}` +
        `；只在 CST 侧出现的上下文专属形: ${unpaired.join(', ') || '—'}`,
    );
    // 断言：覆盖面不留白名单——每一 kind 都必须在语料面里被判到（旧读数 53/56，
    // heartHead / statementCall / controlMalformed 三形从未出现 ⇒ 由 `tests/coverage-fixtures/` 补上）。
    expect(missed, `这些 kind 在全部语料里一次都没出现（缺一枚夹具）: ${missed.join(', ')}`).toEqual([]);
    const unpairedMsg = `这些 kind 从未被两侧同判（又不是上下文专属形 ⇒ 判据没对上）: ${unpairedReal.join(', ')}`;
    expect(unpairedReal, unpairedMsg).toEqual([]);
    for (const k of unpaired) expect(CONTEXT_ONLY.has(k), `${k} 不在上下文专属四形里，必须补夹具`).toBe(true);
    expect(all.length - missed.length).toBe(all.length);
  });
});

/** 与测试内 `collectLineNodes` 同判据的导出（供导出面自证比对）。 */
function collectExportComparison(root: Node, rows: number[]) {
  const CONTAINERS = new Set(['source_file', 'block', 'item_block', 'block_body', 'switch_body', 'choice_body', 'when_body']);
  const out: { row: number; nodeType: string; kind: KojoKind | null }[] = [];
  const walk = (node: Node): void => {
    if (CONTAINERS.has(node.type)) {
      for (const child of node.namedChildren) walk(child);
      return;
    }
    const head = node.childForFieldName('open');
    const lineNode = head ?? node;
    out.push({ row: rowOfLastChar(lineNode, rows), nodeType: lineNode.type, kind: kindOfNode(lineNode.type) });
  };
  walk(root);
  return out;
}

/* ============================ 合成单行覆盖 ============================ */

/**
 * 覆盖面夹具（`tests/coverage-fixtures/`）把语料面推到 56/56 之后，这里仍逐类给一支
 * **能构造得出**的单行样本：先让 `classifyLine` 自证判到该类（判不到就记 `未构造出`、不入分母，
 * 不硬凑），再与 CST 对照。合成样本的读数单列，不与语料混进同一条分母。
 */
const SYNTHETIC: ReadonlyArray<readonly [KojoKind, string]> = [
  ['blank', ''],
  ['comment', '; 这是一条注释'],
  ['rawLine', 'SETCOLOR 8, 8, 20'],
  ['rawLine', '$ラベル開始'],
  ['rawBlockStart', '@GMF_SOMETHING'],
  ['headDecl', '角色: 12'],
  ['headDecl', '口上: 破空'],
  ['aliasDecl', '别名 她 = 角色 12'],
  ['constDecl', '常量 上限 = 1022'],
  ['switchItem', '开关 EnableA: 1'],
  ['timingHead', '时机 指令 310：'],
  ['customCommandHead', '自定指令 摸屁股：'],
  ['ifHead', '如果 教養 > 30：'],
  ['ifHead', '否则：'],
  ['whenHead', '当 TFLAG:193：'],
  ['caseHead', '是 1：'],
  ['randomHead', '随机：'],
  ['randomInline', '随机 「甲」,「乙」'],
  ['branchHead', '分支：'],
  ['ruleTag', '[教養 > 30]'],
  ['randomShapeDecl', '随机形: 直出'],
  ['groupHead', '组：'],
  ['sectionHead', '若 NOWEX:噴乳：'],
  ['onceHead', '初回 "key1"：'],
  ['choiceHead', '选项：'],
  ['menuHead', '菜单：'],
  ['askMHead', '询问 "要不要"：'],
  ['askYNHead', '确认 "可以吗"：'],
  ['choiceItem', '「要不要」 教養>30：'],
  ['colorHead', '着色 红：'],
  ['heartHead', '心形：'],
  ['exprHead', '她的心情 = 当 TFLAG:1：'],
  ['messageCheck', '隐藏情景: 如果 她睡着'],
  ['settle', '结算 Ｍ经验 += 1'],
  ['mutator', '增减 CFLAG:TARGET:2 += 1'],
  ['statementCall', '设置标记 她的既成事実, 0'],
  ['assign', 'LOCAL = 3'],
  ['blankLine', '空行'],
  ['heartText', '心形 「跳动的东西」'],
  ['text', '旁白一句'],
  ['functionHead', '函数 现在位置(引, 出)：'],
  ['callStatement', '调用 现在位置(1, 2)'],
  ['returnStatement', '返回 3'],
  ['singleIfHead', '如果 天晴 则 等待'],
  ['loopHead', '循环 计数 I 从 0 到 5：'],
  ['loopEnd', '循环结束'],
  ['catchHead', '出错处理：'],
  ['catchEnd', '出错处理结束'],
  ['dataHead', '数据表：'],
  ['dataEnd', '数据表结束'],
  ['dataEntry', '条目 「甲」'],
  ['jumpStatement', '跳到 拉贝尔'],
  ['functionJump', '函数跳转 GMF_MAP_METHOD(CFLAG:ARG:現在位置, 1)'],
  ['labelDecl', '标签 拉贝尔'],
  ['loopFlow', '跳出循环'],
  ['loopStep', '步进 I 加 1'],
  ['controlMalformed', '跳到'],
];

describe('CST ↔ classifyLine（合成单行·覆盖面）', () => {
  let parser: Parser | null = null;

  beforeAll(async () => {
    parser = await createParser(wasmPath);
  }, 180_000);

  it('合成覆盖读数：每类一行，先自证 classifyLine 判到该类，再与 CST 对照', async () => {
    const p = parser as Parser;
    let judged = 0;
    let agreed = 0;
    const notBuilt: Array<[string, string, string]> = [];
    const diverged: Array<[string, string, string]> = [];
    const finerList: Array<[string, string, string]> = [];
    for (const [expectKind, source] of SYNTHETIC) {
      const [logical] = splitLogicalLines(source);
      const truth = classifyLine(logical as Parameters<typeof classifyLine>[0]);
      if (truth.kind !== expectKind) {
        notBuilt.push([expectKind, source, truth.kind]);
        continue;
      }
      const entries = await classifyLines(p, source);
      const head = entries.find((e) => e.nodeType !== 'blank_line') ?? null;
      const cstKind = head ? kindOfNode(head.nodeType) : null;
      // 空行与语料同口径：CST 由换行记号认领、classifyLine 给 `blank` ⇒ 判一致
      if (!head && truth.kind === 'blank') {
        judged += 1;
        agreed += 1;
        continue;
      }
      judged += 1;
      if (cstKind === truth.kind) {
        agreed += 1;
        continue;
      }
      const shown = cstKind ?? `<${head?.nodeType ?? '无节点'}>`;
      if (head && FINER_NODES.has(head.nodeType) && truth.kind === 'text') finerList.push([expectKind, source, shown]);
      else diverged.push([expectKind, source, shown]);
    }
    const rate = judged === 0 ? 0 : (agreed / judged) * 100;
    console.log(`\n===== ② 合成单行覆盖率 =====`);
    console.log(`构造成功（classifyLine 判到该类）: ${judged}/${SYNTHETIC.length}`);
    console.log(`合成一致率                       : ${rate.toFixed(2)}%  分母 ${judged} 行`);
    console.log(`grammar-finer（台词/插值整行）    : ${finerList.length}`);
    for (const [k, s, c] of finerList) console.log(`  · ${k} | ${s} → CST ${c}`);
    console.log(`未构造出（词形与预期不同判）      : ${notBuilt.length}`);
    for (const [k, s, t] of notBuilt) console.log(`  · 期望 ${k} | ${JSON.stringify(s)} → classifyLine 判 ${t}`);
    console.log(`真分歧                           : ${diverged.length}`);
    for (const [k, s, c] of diverged) console.log(`  · ${k} | ${s} → CST ${c}`);
    // 合成面真分歧预算 = 0：第一波那枚 `她的心情 = 当 TFLAG:1：`（expr_head 吃不下半角冒号，
    // 被更长的 assign 抢走）已随词形口径修好。只降不升。
    expect(diverged.length, `合成单行真分歧 ${diverged.length} 条 > 预算 ${SYNTHETIC_BUDGET}`).toBeLessThanOrEqual(
      SYNTHETIC_BUDGET,
    );
    expect(judged).toBeGreaterThan(40);
  });
});
