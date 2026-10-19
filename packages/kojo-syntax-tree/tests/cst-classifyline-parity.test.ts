import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyLine, splitLogicalLines, type LineClass } from '@kojo/plugin-kojo-sugar';
import { classifyLines, createParser, KIND_TO_NODE, NODE_TO_KIND, type KojoKind } from '../src/index';
import type { Node, Parser } from 'web-tree-sitter';

/**
 * CST ↔ `classifyLine` 逐行一致率闸（TSIT-M2 ①）。
 *
 * ## 这条闸在量什么
 *
 * `grammar.js` 自称"语法的第二份真源"。第二份真源只有在**与第一份逐行同判**时才配叫真源，
 * 否则它是第三条路、比没有更坏。本文件把两份判据喂给**同一批真实语料**，逐逻辑行对照：
 * 第一真源 = `kojo-sugar/lexer.classifyLine`（转译、缩进、回车全部在用它）；
 * 第二真源 = tree-sitter CST 的顶层行节点经 `NODE_TO_KIND` 反查出的 kind。
 * 两侧都不许为对方让路（不改 classifyLine、不改 node-types.ts），只报实测数。
 *
 * ## 口径三条（写死在这里，避免"分母漂移"）
 *
 * 1. **行单位 = 逻辑行**：折行（行尾 `\`）由 `splitLogicalLines` 合并成一条逻辑行，
 *    对照锚点取该逻辑行的**首个物理行**（CST 只能按物理行给节点）。跨多个物理行的逻辑行
 *    单列为 `折行` 类、不计入分母（两侧看到的文本本就不同串）。
 * 2. **`grammar-finer`（语法更细）不算失配**：CST 把行首 `「…」` 认成 `string`、`{…}` 认成
 *    `interpolation`，而 `classifyLine` 那一侧只说 `text`（它不做台词/插值的行级分型，
 *    行内结构在 AST 层）。两侧不冲突、CST 多说一层 ⇒ 走 `grammar-finer` 桶并逐条打印。
 * 3. **分母 = 两侧都给出判定的逻辑行数**（真实语料全量；合成单行样本另列一条读数）。
 * 4. **两条读数分开**：`一致率 =（逐字同判 + 语法更细）/ 分母`（"两侧不冲突"的比例，地板钉这条）；
 *    `严格同判率 = 逐字同判 / 分母`（语法层比词法层多说一层的规模，只报不钉）。
 *
 * ## 已知缺陷（本批只报不改，`src/index.ts` 属"只消费不许动"）
 *
 * `classifyLines()` 用 `node.startRow` / `endRow` 取坐标，而 web-tree-sitter 0.27 的 `Node`
 * **没有**这两个字段（只有 `startPosition.row` / `endPosition.row`）⇒ 它回传的 `row` 与
 * `range` 恒为 `undefined`（实测 `sample-310.kojo` 的 16 个顶层节点 `row` 全 undefined）。
 * `nodeType` / `kind` 两栏不受影响，故本闸仍走同一条 `lineNodeOf` + `NODE_TO_KIND` 判据，
 * 只是坐标改从 `startPosition` 取（否则无法与逻辑行对齐）。修法归语法批：一行字段名替换。
 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/kojo-syntax-tree/tests
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const wasmPath = join(pkgRoot, 'tree-sitter-kojo.wasm');
/** 故意残缺的 fixtures（错误恢复样本）不进取数闸——它们的行本就解不干净 */
const BROKEN_DIR = join(pkgRoot, 'tests', 'fixtures');

/**
 * 一致率地板（**取数后写死**，不是许愿）。本批 19 个语料文件 / 9,102 行实测
 * 一致率 99.67%（同判 7,784 + 语法更细 1,288），严格同判率 85.52%（差的 1,288 行全是
 * `「…」` 台词整行被语法认成 `string`/`interpolation` —— classifyLine 只说 `text`）。
 * 地板留 0.17pt 余量给"新语料进来先红一条"的抖动；跌破地板 = 语法层与词法层开始分叉，
 * 必须在 grammar.js / node-types.ts 一侧修，不许回头改这里。
 */
const FLOOR_RATE = 99.5;

/** 真冲突预算（只降不升的棘轮）。本批实测 30 行，全部是语法层"按形状抢跑、无块上下文"一族。 */
const CONFLICT_BUDGET = 30;

/** 合成单行面的真分歧预算（实测 1 条，见下方读数注释）。 */
const SYNTHETIC_BUDGET = 1;

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

/** `block` 容器取块头子节点，其余取自身（同 `src/index.ts` 的 `lineNodeOf`，只是这里要拿到节点本体）。 */
function lineNodeOf(node: Node): Node {
  if (node.type === 'block') {
    const head = node.namedChildren.find((c) => c.type !== 'block_body');
    if (head) return head;
  }
  return node;
}

/**
 * **坐标口径（本闸的地基，实测得来）**：本语法的每个 token 都把**前置换行/空白（extras）
 * 吞进自己的 span**（实测 `fixtures/scaffold/事件.kojo`：`timing_head` 的 span 文本是
 * `"\n\n时机 事件 22："`，`startPosition.row` 因此指到上一行）。⇒ `startPosition.row`
 * 不能当行号用，`classifyLines()` 的 `row` 更是恒 `undefined`（见文件头缺陷条）。
 * 可靠锚点 = **节点末字符所在的行**（`rowOfOffset(endIndex - 1)`）：单行 token 的末字符必然
 * 落在正文行上；`choice_item` 这类把行尾 `\n` 也吃进去的形同样落回正文行。
 */
function rowTable(text: string): number[] {
  const rows: number[] = [];
  let row = 0;
  for (let i = 0; i < text.length; i++) {
    rows.push(row);
    if (text[i] === '\n') row++;
  }
  return rows;
}

/** 物理行号（0 基）→ 该行第一个（也通常是唯一一个）顶层行节点；同行争抢按「留下谁」计数。 */
function firstNodePerRow(
  root: Node,
  rows: number[],
): { map: Map<number, Node>; collisions: Map<string, number> } {
  const map = new Map<number, Node>();
  const collisions = new Map<string, number>();
  for (const child of root.namedChildren) {
    const lastChar = child.endIndex - 1;
    if (lastChar < child.startIndex) continue; // 零宽节点不参与逐行对照
    const row = rows[Math.min(lastChar, rows.length - 1)] ?? child.endPosition.row;
    const kept = map.get(row);
    if (kept) {
      const key = `${kept.type} ⇄ ${lineNodeOf(child).type}`;
      collisions.set(key, (collisions.get(key) ?? 0) + 1);
      continue;
    }
    map.set(row, lineNodeOf(child));
  }
  return { map, collisions };
}

const kindOfNode = (nodeType: string): KojoKind | null =>
  (NODE_TO_KIND as Record<string, KojoKind>)[nodeType] ?? null;

type Verdict = 'match' | 'grammar-finer' | 'folded' | 'cst-missing' | 'cst-null' | 'mismatch';

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
const cstMissing: RowStat[] = [];
const nullKinds = new Set<string>();
/** `classifyLine kind ⇄ CST 无 kind 节点名` 的配对计数（判断"语法更细"还是"表缺一格"的原料） */
const cstNullPairs = new Map<string, number>();
/** 真实语料里出现过的 kind（合成覆盖的分母基线） */
const kindsSeenInCorpus = new Set<string>();
/** 包导出面 `classifyLines()` 的自证读数（缺陷登记，见文件头） */
const exportedDrift = { kindDriftFiles: 0, rowsAllUndefined: true };
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
      const rows = rowTable(text);
      const { map: byRow, collisions } = firstNodePerRow(tree.rootNode, rows);
      for (const [pair, n] of collisions) rowCollisionPairs.set(pair, (rowCollisionPairs.get(pair) ?? 0) + n);
      const counts: Record<Verdict, number> = { ...EMPTY_COUNTS };
      let logicalLines = 0;
      const push = (stat: RowStat): void => {
        counts[stat.verdict] += 1;
        logicalLines += 1;
        if (stat.verdict === 'mismatch') mismatches.push(stat);
        if (stat.verdict === 'grammar-finer') finer.push(stat);
        if (stat.verdict === 'cst-missing') cstMissing.push(stat);
      };
      for (const logical of splitLogicalLines(text)) {
        const truth: LineClass = classifyLine(logical);
        kindsSeenInCorpus.add(truth.kind);
        const node = byRow.get(logical.line - 1);
        const cstKind = node ? kindOfNode(node.type) : null;
        if (cstKind !== null) kindsSeenInCorpus.add(cstKind);
        if (!node) {
          // 空行在 CST 里由 extras（换行）消化、不产行节点；classifyLine 对空内容给 `blank`
          if (truth.kind === 'blank') push({ verdict: 'match', fixture: rel, line: logical.line, truth: truth.kind, cst: '<无节点/blank>' });
          else push({ verdict: 'cst-missing', fixture: rel, line: logical.line, truth: truth.kind, cst: '<无节点>' });
          continue;
        }
        if (FINER_NODES.has(node.type) && (truth.kind === 'text' || truth.kind === 'heartText' || truth.kind === 'blank')) {
          push({ verdict: 'grammar-finer', fixture: rel, line: logical.line, truth: truth.kind, cst: `${node.type}` });
          continue;
        }
        if (logical.endLine > logical.line) {
          // 折行逻辑行：CST 只看得到首物理行（含行尾 `\`），两侧输入本就不同串 ⇒ 不入分母
          push({ verdict: 'folded', fixture: rel, line: logical.line, truth: truth.kind, cst: cstKind ?? node.type });
          continue;
        }
        if (cstKind === null) {
          nullKinds.add(node.type);
          const pair = `${truth.kind} ⇄ <${node.type} 无 kind>`;
          cstNullPairs.set(pair, (cstNullPairs.get(pair) ?? 0) + 1);
          push({ verdict: 'cst-null', fixture: rel, line: logical.line, truth: truth.kind, cst: `<${node.type} 无 kind>` });
          continue;
        }
        push({
          verdict: cstKind === truth.kind ? 'match' : 'mismatch',
          fixture: rel,
          line: logical.line,
          truth: truth.kind,
          cst: cstKind,
          text: logical.text.trim().slice(0, 60),
        });
      }
      perFile.push({ rel, logicalLines, cstNodes: tree.rootNode.namedChildren.length, counts });

      // 包导出面单独自证：`classifyLines` 的 kind 序列必须与本地走树判据逐行等长同序，
      // 否则对照面就不是同一条判据（`row` 恒 undefined 一并在下方读数里登记）。
      const viaExport = await classifyLines(p, text);
      for (const entry of viaExport) {
        if (entry.row !== undefined) exportedDrift.rowsAllUndefined = false;
      }
      const walkKinds = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => kindOfNode(n.type) ?? `<${n.type}>`);
      const exportKinds = viaExport.map((e) => e.kind ?? `<${e.nodeType}>`);
      if (walkKinds.join('|') !== exportKinds.join('|')) exportedDrift.kindDriftFiles++;
      tree.delete();
    }
  }, 180_000);

  it('语料在位（分母 = 文件数；取数规则同 tools/parse-corpus.mjs）', () => {
    console.log(`\n===== ① CST ↔ classifyLine 逐行一致率 =====`);
    console.log(`语料文件数（分母）: ${fixtures.length}`);
    for (const f of fixtures) console.log(`  · ${relOf(f)}`);
    expect(fixtures.length).toBeGreaterThanOrEqual(19);
  });

  it('逐行对照读数：一致率 + 分母 + 失配清单', () => {
    const summed = (v: Verdict): number => perFile.reduce((n, s) => n + s.counts[v], 0);
    const total = perFile.reduce((n, s) => n + s.logicalLines, 0);
    const folded = summed('folded');
    const judged = total - folded;
    const match = summed('match');
    const grammarFiner = summed('grammar-finer');
    const cstMiss = summed('cst-missing');
    const cstNull = summed('cst-null');
    const realMismatch = summed('mismatch');
    const rate = judged === 0 ? 0 : ((match + grammarFiner) / judged) * 100;
    const strictRate = judged === 0 ? 0 : (match / judged) * 100;

    console.log(`逻辑行总数（含折行）      : ${total}`);
    console.log(`参与对照（去折行）        : ${judged}`);
    console.log(`折行逻辑行（不入分母）    : ${folded}`);
    console.log(`同判（两侧同一 kind）     : ${match}`);
    console.log(`grammar-finer（语法更细） : ${grammarFiner}`);
    console.log(`真冲突（判到不同层）      : ${realMismatch}`);
    console.log(`CST 无节点而行非空        : ${cstMiss}`);
    console.log(`CST 节点反查不到 kind     : ${cstNull}（节点名 ${[...nullKinds].join(', ') || '—'}）`);
    console.log(`==> 一致率 ${rate.toFixed(2)}%（同判 + 语法更细，分母 ${judged} 行 / ${fixtures.length} 个语料文件）`);
    console.log(`==> 严格同判率 ${strictRate.toFixed(2)}%（只算两侧逐字同一 kind）`);

    console.log('每文件严格同判率（升序，最低 8 个）:');
    for (const s of [...perFile]
      .map((f) => {
        const j = f.logicalLines - f.counts.folded;
        const ok = f.counts.match + f.counts['grammar-finer'];
        return { rel: f.rel, j, ok, strict: f.counts.match };
      })
      .sort((a, b) => a.strict / Math.max(a.j, 1) - b.strict / Math.max(b.j, 1))
      .slice(0, 8)) {
      console.log(
        `  同判+更细 ${((s.ok / Math.max(s.j, 1)) * 100).toFixed(1)}%（${s.ok}/${s.j}）· 逐字同判 ${((s.strict / Math.max(s.j, 1)) * 100).toFixed(1)}%  ${s.rel}`,
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
    if (cstMissing.length > 0) {
      console.log(`CST 无节点清单（前 20 / 共 ${cstMissing.length}）:`);
      for (const m of cstMissing.slice(0, 20)) console.log(`  ${m.fixture}:${m.line} classifyLine=${m.truth}`);
    }
    if (cstNullPairs.size > 0) {
      console.log(`CST 节点反查不到 kind 的配对（前 20，按行数降序）:`);
      for (const [pair, n] of [...cstNullPairs].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${n} × ${pair}`);
    }
    const collisionTotal = [...rowCollisionPairs.values()].reduce((n, v) => n + v, 0);
    console.log(`同一物理行争抢到多个顶层节点 : ${collisionTotal} 次（留第一个，其余按配对列出）`);
    for (const [pair, n] of [...rowCollisionPairs].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${n} × ${pair}`);
    console.log(
      `导出面 classifyLines() 自证：kind 序列与走树判据不一致的文件数 = ${exportedDrift.kindDriftFiles}；` +
        `row 全为 undefined = ${exportedDrift.rowsAllUndefined}（缺陷登记见文件头）`,
    );

    // 断言 1：真冲突有预算、只降不升。本批实测 30 行，全部落在"语法层按形状抢跑、
    // classifyLine 要块上下文才认"的三族（choiceItem / switchItem / arrowCase|arrowElse）
    // 加 3 行反方向（`如果 …：` / `是 …：` 被语法判成 text）。预算变大自然红 ⇒ 语法批修一条就降一条，
    // 新写法带来新冲突也当场拦住（不许静默涨回去）。
    expect(realMismatch, `真冲突 ${realMismatch} 行 > 预算 ${CONFLICT_BUDGET}，见上方清单`).toBeLessThanOrEqual(
      CONFLICT_BUDGET,
    );
    // 断言 2：一致率地板（同判 + 语法更细）。取数 99.67%，地板 99.5 留 0.17pt 抖动余量。
    expect(rate, `一致率 ${rate.toFixed(2)}% 低于地板 ${FLOOR_RATE}`).toBeGreaterThanOrEqual(FLOOR_RATE);
    // 断言 3：两侧都不许有"判不出 kind"的行（有 = 对照面缺一格，不是"没颜色"这么轻）。
    expect(cstMiss, 'CST 无节点而行非空：有行没被任何顶层节点认领').toBe(0);
    expect(cstNull, `CST 节点反查不到 kind：${[...nullKinds].join(', ')}`).toBe(0);
  });

  it('KIND_TO_NODE 表闭合（一 kind 一节点、可反查）', () => {
    // 表规模取数：本批实测 56 类（任务书按 64 记，以仓库现状为准——表里少的是
    // `LineClass` 里从不作为行分类出现的形态，不影响对照面闭合）。
    expect(Object.keys(KIND_TO_NODE).length).toBe(56);
    const nodes = new Set(Object.values(KIND_TO_NODE));
    expect(nodes.size).toBe(Object.keys(KIND_TO_NODE).length);
    for (const [kind, node] of Object.entries(KIND_TO_NODE)) {
      expect(NODE_TO_KIND[node as keyof typeof NODE_TO_KIND], `kind ${kind} 反查不回来`).toBe(kind);
    }
  });

  it('真实语料覆盖面读数（哪些 kind 在语料里根本没出现）', () => {
    const all = Object.keys(KIND_TO_NODE);
    const missed = all.filter((k) => !kindsSeenInCorpus.has(k));
    console.log(
      `真实语料覆盖 kind: ${all.length - missed.length}/${all.length}` +
        (missed.length ? `；未覆盖: ${missed.join(', ')}` : ''),
    );
    expect(all.length - missed.length).toBeGreaterThan(0);
  });
});

/* ============================ 合成单行覆盖 ============================ */

/**
 * 语料不覆盖全部 64 类（如 `菜单：` / `确认 …：` / `初回 "key"：` 一类）。这里每类给一支
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

  it('合成覆盖读数：每类一行，先自证 classifyLine 判到该类，再与 CST 对照', () => {
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
      const tree = p.parse(source);
      const head = tree?.rootNode.namedChildren.map(lineNodeOf).find((n) => n.type !== 'blank_line') ?? null;
      const cstKind = head ? kindOfNode(head.type) : null;
      tree?.delete();
      // 空行与语料同口径：CST 由 extras 消化换行、不产行节点 ⇒ 判一致
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
      const shown = cstKind ?? `<${head?.type ?? '无节点'}>`;
      if (head && FINER_NODES.has(head.type) && truth.kind === 'text') finerList.push([expectKind, source, shown]);
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
    // 合成面真分歧预算 = 1（`她的心情 = 当 TFLAG:1：`：语法的 expr_head 吃不下含 `:` 的
    // 变量引用，被更长的 `assign` 抢走）。只降不升。
    expect(diverged.length, `合成单行真分歧 ${diverged.length} 条 > 预算 ${SYNTHETIC_BUDGET}`).toBeLessThanOrEqual(
      SYNTHETIC_BUDGET,
    );
    expect(judged).toBeGreaterThan(40);
  });
});
