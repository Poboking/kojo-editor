import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Language, Parser, Query, type Node as TreeSitterNode } from 'web-tree-sitter';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { kojoFoldingRanges } from '../../plugins/kojo-sugar/src/folding';
import { KOJO_LANGUAGE_ID, KOJO_TOKEN_TIERS, registerKojoLanguage } from '../src/monaco/kojo-language';
import { compileMonarch, driveLexer, stubMonaco, type Emit } from './monarch-harness';
import {
  KOJO_STRUCTURE_BASELINE_TOKENS,
  KOJO_STRUCTURE_NODE_TIERS,
  structureLegendTypes,
  tierForCapture,
  type KojoStructureToken,
} from '../src/monaco/tree-sitter/types';
import { splitStructureTokensToSpans } from '../src/monaco/tree-sitter/semantic';
import { extendFoldOverTrailingBlanks } from '../src/monaco/tree-sitter/engine';

/**
 * 结构层 vs Monarch 的 **A/B 取数**（TSIT-M2 ②）：同一批语料、同一套档位名，两份判据各跑一遍。
 *
 * ## 比的是什么（两条读数，一条不许少）
 *
 * - **A（词法层）**：`kojo-language.ts` 的 Monarch 定义经 monaco 同版本真编译器（`monarch-harness`
 *   的 `compileMonarch` + `driveLexer`，与 `kojo-token-tiers.test.ts` 同一套执行机制）逐行发射，
 *   按发射顺序把 token 文本映回列区间；
 * - **B（结构层）**：同一份文本进 tree-sitter，跑 `queries/highlights.scm` 捕获，捕获名经
 *   **宿主同一张 `tierForCapture` 表**翻成档位，再经 `semantic.ts` 的 `splitStructureTokensToSpans`
 *   翻成逐行 Monaco 区间。
 * 两侧档位名同源（`types.ts` 头注：档位名**就是**词法 token 名），所以比的是**判据**而不是调色板。
 *
 * ## 一致率口径（为什么按"CST 认领的格子"算）
 *
 * 本批 `highlights.scm` 的捕获名里只有 `comment` / `keyword` / `string` 三支在宿主的
 * `KOJO_STRUCTURE_CAPTURE_TIERS` 表里有档位（其余 20 余支 `@keyword.control` / `@function` /
 * `@operator` / `@none` … 一律"表里没有 ⇒ 不着色 + 说一次"）。⇒ 结构层实际只涂**注释 / 台词串 /
 * 少量关键字行**三族，词法层则逐词着色。拿"全篇每一格"做分母会把"结构层这一格根本不涂"
 * 记成不一致，量出来的不是判据差异而是覆盖面差异。故：
 *
 * - **分母 = 结构层涂了色的内容格数**；捕获跨度先**削掉行前空白**（本语法的 token 把 extras
 *   吞进自己的 span，不削就会连缩进一起涂，而词法层对空白一律不发 token），
 *   **空格类分隔格再剔出分母**（同一理由：量的是判据，不是"整段 vs 逐词"的表示法差异，
 *   剔掉多少单独报数）；
 * - **同格同名** = 词法层在该格发出与结构层**同一档位名**；
 * - **同族子档** = 词法层发出 `<档位>.xxx`（如台词串首尾的 `sugar.speech.delimiter`）——
 *   同一跨度内的深浅细分，属同一判据家族，算一致并单独报数；
 * - **异档 / 词法层未着色** = 不一致，逐条列出行号与两侧档位。
 *
 * ## 折叠（第四段：两侧都是真判据，读数与地板写在下方的 FOLD_* 注释里）
 *
 * `queries/folds.scm` 自第二波起有真块容器：`(block) @fold` + `(item_block) @fold`，行跨度由
 * `src/scanner.c` 的缩进记号精确界定 ⇒ 结构层**自己供折叠**，worker 那条"查询里没捕获 ⇒ 该面回落"
 * 的分支不再触发（`indents.scm` 仍无捕获，回落只发生在缩进那一面）。本段因此量三件事，全部按
 * CST 真跑出的区间 vs `kojoFoldingRanges`（`.kojo` 折叠唯一真源 = 转译器符号树摊平）对照：
 * ① **起点精确率**（语法层会不会把不是块头的行折上）；② **起点召回**（真源能折的块语法层认了多少）；
 * ③ **同起点区间的终点一致率**（两侧的止行口径差多少行）。三率的取数与"差在哪一族"逐条见下方。
 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/app/tests
const repoRoot = resolve(here, '..', '..', '..');
const syntaxPkg = join(repoRoot, 'packages', 'kojo-syntax-tree');
const wasmPath = join(syntaxPkg, 'tree-sitter-kojo.wasm');
const highlightsPath = join(syntaxPkg, 'queries', 'highlights.scm');
const foldsPath = join(syntaxPkg, 'queries', 'folds.scm');
const brokenDir = join(syntaxPkg, 'tests', 'fixtures');

/** 语料发现规则同 `tools/parse-corpus.mjs`（递归 packages+fixtures、跳 node_modules、排除残缺样本）。 */
function collect(dir: string, out: string[], exclude: string | null): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (exclude && (p === exclude || p.startsWith(`${exclude}/`) || p.startsWith(`${exclude}\\`))) continue;
    if (e.isDirectory()) collect(p, out, exclude);
    else if (e.name.endsWith('.kojo1') || e.name.endsWith('.kojo')) out.push(p);
  }
  return out;
}

const fixtures: string[] = [];
for (const top of ['packages', 'fixtures']) collect(join(repoRoot, top), fixtures, brokenDir);
fixtures.sort();
const relOf = (file: string): string => file.slice(repoRoot.length + 1).replaceAll('\\', '/');

const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/);
/** 偏移 →（0 基行, 0 基列）表：行首偏移 + 二分，列 = 偏移 - 行首偏移。 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}
function rowOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/* ==================== A 侧：Monarch（与 kojo-token-tiers 同一套执行机制） ==================== */

const { monaco, captured } = stubMonaco();
// registerKojoLanguage 会调 monaco.languages.register / setMonarchTokensProvider（桩接得住）
registerKojoLanguage(monaco as never);
const monarchDef = captured.monarchs.get('kojo-legacy');
if (!monarchDef) throw new Error('没捕获到 kojo1（kojo-legacy）的 Monarch def（装配面漂 = 本文件整个红）');

/** 档位名 → 档（`KOJO_TOKEN_TIERS` 原表）；报告"同档异名"用 */
const TIER_OF_TOKEN = new Map<string, string>();
for (const tier of KOJO_TOKEN_TIERS) for (const token of tier.tokens) TIER_OF_TOKEN.set(token, tier.tier);

/**
 * `driveLexer` 只回 `{text, token}`（不带列），按发射顺序把文本映回列：从游标起 `indexOf`
 * 找该段文本的首个出现位置。未被任何 token 认领的字符（defaultToken 为空的空格/标点）
 * 落在间隙里——真实语料里间隙只有空白与标点，故还原出的列与 Monaco 屏上一致；
 * 还原失败（找不到 / 倒退）的行整行进 `rebuildFailed` 计数，不猜列。
 */
function emitCells(emits: readonly Emit[], lineText: string): { cells: (string | null)[]; ok: boolean } {
  const cells: (string | null)[] = new Array<string | null>(lineText.length).fill(null);
  let cursor = 0;
  for (const emit of emits) {
    if (emit.text.length === 0) continue;
    const at = lineText.indexOf(emit.text, cursor);
    if (at < 0) return { cells: new Array<string | null>(lineText.length).fill(null), ok: false };
    for (let i = at; i < at + emit.text.length; i++) cells[i] = emit.token;
    cursor = at + emit.text.length;
  }
  return { cells, ok: true };
}

/* ==================== B 侧：tree-sitter 捕获 → 档位 → 逐行区间 ==================== */

/** 捕获名（带节点类型）→ 档位；表外（`@keyword.control` 等）= `null`，与 worker 同一条判据。 */
function captureTier(name: string, nodeType?: string): string | null {
  return tierForCapture(name, nodeType);
}

/**
 * CST 捕获 → `KojoStructureToken[]`。
 * **削掉前导空白**：本语法的 token 把行前 extras（换行 + 缩进）吞进自己的 span（实测见
 * `packages/kojo-syntax-tree/tests/cst-classifyline-parity.test.ts` 头注）。不削的话，结构层
 * 会把**缩进**也涂成档位色，而词法层对空白一律不发 token（`defaultToken: ''`）——那不是判据分歧，
 * 是表示法差异。统一从"该行第一个非空白字符"起算，两侧都在内容列上比。
 */
function structureTokens(query: Query, text: string, starts: number[]): KojoStructureToken[] {
  const tree = parser!.parse(text);
  if (tree === null) throw new Error('解析器没有产出树');
  const out: KojoStructureToken[] = [];
  for (const capture of query.captures(tree.rootNode)) {
    const tier = captureTier(capture.name, capture.node.type);
    if (tier === null) continue;
    let start = capture.node.startIndex;
    const end = capture.node.endIndex;
    while (start < end && isSpace(text[start]!)) start++;
    if (end <= start) continue;
    out.push({
      startRow: rowOf(starts, start),
      startCol: start - starts[rowOf(starts, start)]!,
      endRow: rowOf(starts, end - 1),
      endCol: end - 1 - starts[rowOf(starts, end - 1)]! + 1,
      tier,
    });
  }
  tree.delete();
  return out;
}

/** 水平空白（口径同 lexer 的 `[ \t\u3000]` + 表单符） */
const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\u3000' || ch === '\f';

type CellKey = string; // `行\u0000列`

interface Diff {
  readonly fixture: string;
  readonly line: number;
  readonly column: number;
  readonly cst: string;
  readonly monarch: string | null;
  readonly kind: '异档' | '词法层未着色';
  readonly text: string;
}

const diffs: Diff[] = [];
const cells = { total: 0, same: 0, family: 0, otherTier: 0, monarchBlank: 0, spaceSkipped: 0 };
/** 按**结构层档位族**各自记一格（总比率随覆盖面扩大而变，分族比率才是防回归的那把尺） */
const perTier = new Map<string, { total: number; agree: number }>();
const monarchOnlyCells = { total: 0 };
let rebuildFailed = 0;
let paintedLines = 0;
let totalLines = 0;
const perFile: Array<{ rel: string; total: number; agree: number }> = [];
let parser: Parser | null = null;
let query: Query | null = null;
let foldsQuery: Query | null = null;
let lexer: Awaited<ReturnType<typeof compileMonarch>> | null = null;

/**
 * wasm 与查询**直接经 `web-tree-sitter` 装载**，不 import `@kojo/kojo-syntax-tree` 的 TS 入口：
 * 宿主侧（含宿主测试）只认 worker 那套资源面（`tree-sitter/assets.ts` 用 `?url` / `?raw` 取同一批
 * 文件），本测试在 node 里跑，故用 `fs` 读同样两枚资源——少一条跨包 import，也少一份类型面耦合
 * （语法包 `src/index.ts` 的坐标字段缺陷已在其自己的测试头注登记，不在这里二次传染）。
 */
beforeAll(async () => {
  await Parser.init();
  const language = await Language.load(wasmPath);
  parser = new Parser();
  parser.setLanguage(language);
  query = new Query(language, readFileSync(highlightsPath, 'utf8'));
  foldsQuery = new Query(language, readFileSync(foldsPath, 'utf8'));
  lexer = await compileMonarch('kojo-legacy', monarchDef);
  const legend = structureLegendTypes();
  for (const file of fixtures) {
    const rel = relOf(file);
    const text = readFileSync(file, 'utf8');
    const starts = lineStarts(text);
    const lines = splitLines(text);
    const tokens = structureTokens(query, text, starts);
    const spans = splitStructureTokensToSpans(tokens, {
      lineCount: lines.length,
      maxColumn: (lineNumber) => (lines[lineNumber - 1]?.length ?? 0) + 1,
    }).spans;
    /** 结构层涂色格：`行\u0000列 → 档位名`（同行重叠留先到的，与 `semantic.ts` 编码同口径） */
    const painted = new Map<CellKey, string>();
    for (const span of spans) {
      const tier = legend[span.typeIndex] ?? null;
      if (tier === null) continue;
      for (let column = span.startColumn; column < span.endColumn; column++) {
        const key = `${span.line}\u0000${column}`;
        if (!painted.has(key)) painted.set(key, tier);
      }
    }
    let fileTotal = 0;
    let fileAgree = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const lineText = lines[i]!;
      if (lineText.length === 0) continue;
      totalLines += 1;
      const emits = driveLexer(lexer, lineText);
      const { cells: monarchCells, ok } = emitCells(emits, lineText);
      if (!ok) rebuildFailed += 1;
      for (const token of monarchCells) if (token !== null) monarchOnlyCells.total += 1;
      let linePainted = false;
      for (let column = 1; column <= lineText.length; column++) {
        const tier = painted.get(`${lineNo}\u0000${column}`);
        if (tier === undefined) continue;
        // 分隔格不进分母：词法层对空白一律不发 token（`defaultToken: ''`），结构层按整段涂。
        // 这一类差异量的是"整段 vs 逐词"的表示法，不是判据 ⇒ 剔出分母并单独报数。
        if (isSpace(lineText[column - 1]!)) {
          cells.spaceSkipped += 1;
          continue;
        }
        linePainted = true;
        fileTotal += 1;
        cells.total += 1;
        const token = monarchCells[column - 1] ?? null;
        const stripped = token === null ? null : token.replace(new RegExp(`\\.${KOJO_LANGUAGE_ID}$`), '');
        if (stripped === null) {
          cells.monarchBlank += 1;
        } else if (stripped === tier) {
          cells.same += 1;
          fileAgree += 1;
        } else if (stripped.startsWith(`${tier}.`)) {
          cells.family += 1;
          fileAgree += 1;
        } else {
          cells.otherTier += 1;
        }
        const tierAgg = perTier.get(tier) ?? { total: 0, agree: 0 };
        tierAgg.total += 1;
        if (stripped !== null && (stripped === tier || stripped.startsWith(`${tier}.`))) tierAgg.agree += 1;
        perTier.set(tier, tierAgg);
        if (diffs.length < 400 && (stripped === null || (stripped !== tier && !stripped.startsWith(`${tier}.`)))) {
          diffs.push({
            fixture: rel,
            line: lineNo,
            column,
            cst: tier,
            monarch: stripped,
            kind: stripped === null ? '词法层未着色' : '异档',
            text: lineText.trim().slice(0, 50),
          });
        }
      }
      if (linePainted) paintedLines += 1;
    }
    perFile.push({ rel, total: fileTotal, agree: fileAgree });
  }
}, 240_000);

describe('结构层 ↔ Monarch 逐格 A/B（同语料、同档位名）', () => {
  it('语料在位 + 两侧装配成立', () => {
    console.log(`\n===== ③ Token A/B（tree-sitter 结构层 vs Monarch 词法层）=====`);
    console.log(`语料文件数（分母）: ${fixtures.length}`);
    expect(fixtures.length).toBeGreaterThanOrEqual(19);
    expect(query).not.toBeNull();
    expect(lexer).not.toBeNull();
    console.log(`highlights.scm 捕获名 ${query!.captureNames.length} 支，其中**捕获级**有档的: ${query!.captureNames.filter((n) => captureTier(n) !== null).join(', ') || '—'}`);
    console.log(`（捕获级表外 ${query!.captureNames.filter((n) => captureTier(n) === null).length} 支；另有**节点级**覆盖按节点类型再分档 ⇒ 有效有档/表外与覆盖面读数见 kojo-ts-capture-coverage.test.ts，别拿这一行当覆盖面）`);
  });

  it('逐格一致率读数（地板见 TOKEN_AB_FLOOR，实测 99.58%）', () => {
    const agree = cells.same + cells.family;
    const rate = cells.total === 0 ? 0 : (agree / cells.total) * 100;
    console.log(`扫描行总数            : ${totalLines}`);
    console.log(`结构层涂色的行        : ${paintedLines}`);
    console.log(`词法层列区间还原失败  : ${rebuildFailed} 行`);
    console.log(`分母（结构层涂色的内容格）: ${cells.total}`);
    console.log(`  同格同名            : ${cells.same}`);
    console.log(`  同族子档            : ${cells.family}（台词首尾 delimiter 一类）`);
    console.log(`  异档                : ${cells.otherTier}`);
    console.log(`  词法层未着色        : ${cells.monarchBlank}`);
    console.log(`  剔出的分隔格        : ${cells.spaceSkipped}（空白：词法层不发 token、结构层整段涂 ⇒ 不计入判据）`);
    console.log(`  词法层涂色格子总数（覆盖面参照，不进分母）: ${monarchOnlyCells.total}`);
    console.log(`==> 逐格一致率 ${rate.toFixed(2)}%（分母 ${cells.total} 格 / ${fixtures.length} 个语料文件）`);
    console.log('分族一致率（总比率随覆盖面扩大而变 ⇒ 防回归看分族）:');
    for (const [tierName, agg] of [...perTier].sort((a, b) => b[1].total - a[1].total)) {
      console.log(`  ${((agg.agree / agg.total) * 100).toFixed(2)}%  ${agg.agree}/${agg.total}  ${tierName}`);
    }
    for (const [tierName, floor] of Object.entries(TOKEN_AB_TIER_FLOORS)) {
      const agg = perTier.get(tierName);
      expect(agg, `分族地板点了 ${tierName}，但这次一面都没涂到它`).toBeDefined();
      const tierRate = ((agg as { total: number; agree: number }).agree / (agg as { total: number; agree: number }).total) * 100;
      expect(tierRate, `${tierName} 分族一致率 ${tierRate.toFixed(2)}% 低于地板 ${floor}%`).toBeGreaterThanOrEqual(floor);
    }
    expect(cells.total, '分母缩小＝覆盖面被偷（只许扩不许缩）').toBeGreaterThanOrEqual(TOKEN_AB_MIN_CELLS);
    const worst = [...perFile]
      .filter((f) => f.total > 0)
      .map((f) => ({ ...f, rate: (f.agree / f.total) * 100 }))
      .sort((a, b) => a.rate - b.rate)
      .slice(0, 8);
    console.log('每文件一致率（最低 8 个，只统计有涂色的文件）:');
    for (const f of worst) console.log(`  ${f.rate.toFixed(1)}%  ${f.agree}/${f.total}  ${f.rel}`);
    const pairCount = new Map<string, number>();
    for (const d of diffs) pairCount.set(`${d.kind} ${d.cst} ⇄ ${d.monarch ?? '<无色>'}`, (pairCount.get(`${d.kind} ${d.cst} ⇄ ${d.monarch ?? '<无色>'}`) ?? 0) + 1);
    console.log(`分歧配对（按格数降序，最多 400 格样本 / 共 ${diffs.length} 条样本）:`);
    for (const [pair, n] of [...pairCount].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${n} × ${pair}`);
    console.log('前 30 条具体分歧（行, 词法层档, 结构层档）:');
    for (const d of diffs.slice(0, 30)) {
      console.log(`  ${d.fixture}:${d.line} 第${d.column}列  Monarch=${d.monarch ?? '<无色>'}  CST=${d.cst}  | ${d.text}`);
    }
    expect(cells.total, '结构层一个格子都没涂 ⇒ A/B 没有可比面').toBeGreaterThan(0);
    expect(rate, `逐格一致率 ${rate.toFixed(2)}% 低于 98% 线`).toBeGreaterThanOrEqual(TOKEN_AB_FLOOR);
  });

  it('档位名同源：结构层用到的每个档位名都在 KOJO_TOKEN_TIERS 或基线 token 里', () => {
    const used = new Set<string>();
    for (const name of query!.captureNames) {
      const tier = captureTier(name);
      if (tier !== null) used.add(tier);
    }
    // 节点类型级覆盖用到的档名也要一起验（漏掉就等于"legend 里没有 ⇒ 悄悄不涂色"）
    for (const [capture, byNode] of Object.entries(KOJO_STRUCTURE_NODE_TIERS)) {
      for (const nodeType of Object.keys(byNode)) {
        const tier = captureTier(capture, nodeType);
        if (tier !== null) used.add(tier);
      }
    }
    const tierTokens = new Set<string>(KOJO_TOKEN_TIERS.flatMap((t) => [...t.tokens]));
    const legend = new Set<string>(structureLegendTypes());
    for (const tier of used) {
      expect(
        tierTokens.has(tier) || (KOJO_STRUCTURE_BASELINE_TOKENS as readonly string[]).includes(tier),
        `档位 ${tier} 在屏上无处取色`,
      ).toBe(true);
      expect(legend.has(tier), `档位 ${tier} 不在 legend 里 ⇒ 编码时无处落 index`).toBe(true);
    }
    console.log(`结构层实际用到的档位名: ${[...used].sort().join(', ')}`);
  });
});

/* ============================ 折叠对照 ============================ */

/**
 * 折叠两侧的**真口径**（第二波：块容器落地后重写）。
 *
 * - **CST 侧**：直接把 `queries/folds.scm` 经 `Query` 跑在每份语料的树上，取 `@fold` 捕获节点
 *   （`block` / `item_block`）的行跨度——止行口径**调用 worker 那一条**
 *   `engine.ts::extendFoldOverTrailingBlanks`（本批起不再抄一份"看起来一样的"判据：抄来的判据量不出
 *   引擎的行为）。`@fold` 之外的捕获不产折叠、`endRow <= startRow` 的单行跨度不产折叠，两条都照旧。
 *   这里不再"由结构行节点现推"：
 *   第一波那种手工代理（块头 + 更深层正文 + 自写的 `for probe` 前瞻）量的是代理自己，不是语法，
 *   所以它给出的 100% / 2.80% 那组数**描述的是代理，不是块容器**，全部作废。
 * - **真源侧**：`kojoFoldingRanges(svc.parse(text, { filePath }))`——`.kojo` 折叠的唯一供给器
 *   （转译器符号树摊平，`folding.ts` 只收 `endLine > startLine` 的节点），1 基 → 0 基。
 *
 * 三个口径各报各的，一个不许少：**起点精确率**（CST 起点落在真源起点集里）/ **起点召回**
 * （真源起点被 CST 认出）/ **同起点区间的终点一致率**（真源同一起点可能有多个止行，故按"集合命中"计）。
 *
 * 为什么住本文件而不新建 `packages/kojo-syntax-tree/tests/fold-ranges.test.ts`：对照的**真源侧**要
 * `createSugarTranspileService` + `kojoFoldingRanges`（kojo-sugar 的插件内部），语法包的纪律是
 * "零游戏知识、只在构建期借词表单源"，不该在测试里 import 插件 src；本文件已经有这条 import 面。
 *
 * ## 分歧的形状（19 份语料实测：1,103 个 CST 区间 vs 1,251 个真源区间）
 *
 * 真源折叠的**来源只有一个**：`document-symbols.ts::rawSymbol` 的 switch 认得的 16 族结构节点
 * （时机 / 函数 / 自定指令 / 若 / 初回 / 如果链 / 当链 / 表达式如果·当 / 随机 / 组 / 选项 / 菜单 /
 * 着色 / 原生函数块 `@…` / 别名），区间 = 块头行 → 正文末行，且 `finish()` 会把父区间**拉长到子项末行**、
 * `rangeOf` 的 `loc.end` 又把块后的**尾随空行**算进来。语法层的来源是 `grammar.js` 的块规则
 * （三族带收束词 + 其余靠回缩 + `@` 族靠 `_raw_close` 前瞻 + `switch_body` / `choice_body` /
 * `when_body` + `item_block`）。两套覆盖面不重合，三个方向的差各有名字：
 *
 * 1. **只在真源有（召回缺口 35 条，全部是口径差不是族缺口）**——
 *    · `timing_head` **35 条**：空体 时机 块（`时机 …：` 光杆，下一行不是更深正文）。语法层按
 *      "没有正文就没有可折的行跨度"的口径故意不产 `block`（见 `folds.scm` 头注），真源却把块后的尾随空行
 *      折进区间（`start..start+1`）⇒ 折起来的只是一行空行，这是**口径差不是缺口**；`folds.scm`
 *      那条"零行跨度不产折叠"的约定保持原样，不为这 35 条改口径。
 *    · **已经补掉的两处族缺口**（本批语法批落地，读数从 89.05% 抬到 97.20%）：
 *      ① `raw_block_start` **93 条**——`@函数名` 原生块此前只有单行节点、没有容器，现在 `block`
 *        多一档 `open: raw_block_start` + `_raw_body`，范围由 `src/scanner.c` 的 `_raw_close`
 *        前瞻"下一条 `@` 行 / 文件尾"决定（与转译器 `readRawFunctionBlock` 同判据），93 条起点
 *        与 93 条止行**一并对齐**（含尾随空行的口径也一致：`终点一致` 随召回同步上涨）；
 *        最差文件 `corpus-k12-lumia-climax.kojo` 的起点召回 0/51 ⇒ 51/51。
 *      ② `"标签":` 形条目 **3 条**（`release-check.kojo:460/463/466`）——`choice_item` 词形补上
 *        原生双引号标签支，条目因此成 `item_block`。
 *    · `expr_head` 的**起点错位**（此前记 4 条精确率缺口 + 6 条召回缺口）已随词形修复：首字符类
 *      `[^W=]` 不含 `\n` ⇒ 从上一行的换行起匹配、块节点早一行。现在 `[^W\r\n=]`，
 *      `release-check.kojo:159/163`、`teaching-full.kojo:102/108` 四处起点与真源逐行对齐。
 * 2. **只在 CST 有（精确率缺口 31 条）**——全是**转译器 AST 里存在、但 `rawSymbol` 的 switch 没登记**的族
 *   （循环 / 出错处理 / 数据表 / 询问 / 确认 / 分支规则池 / `开关:` 头 / 表达式块的分支体）。结构层折得上，
 *   大纲里却没有——宿主 `providers.ts` 把多枚折叠供给器的结果**并起来**（结构折叠是加法），所以这一类
 *   不判为错；上面 `expr_head` 那 4 条错位已经不再属于这一类（`cstOnlyByOpen` 里 `expr_head` 归零）。
 * 3. **同起点、终点不同（上一批 87 条）——本批已收口到 0**。差值分布曾经是 **86 条正好差 1 行**
 *   （真源把块后的尾随空行算进止行，CST 止于最后一行正文；`folds.scm` 头注写明 `_dedent` 不跨换行
 *   就是为这个），另 1 条差 2 行。即：**止行的口径差 = 尾随空行归谁**，与块识别本身无关。
 *   收口方式在结构层一侧：折叠终点向真源伸过去吞掉尾随空行（`engine.ts::extendFoldOverTrailingBlanks`，
 *   本文件的 CST 侧直接调这同一枚函数，不抄第二遍）。三条界一条不满足就不伸：
 *   ① 只伸**最外层块**（父节点即根；真源里只有"外层循环收尾"的那几族会吞空行，嵌套分支停在正文末行
 *   ——把嵌套块也伸过去实测过伸 6 条）；② 只吞**整行空白**的行，不许越过下一个带内容兄弟的起点行；
 *   ③ 最多吞到**文件末行**（`"x\n"` 之后 Monaco 那行空的算数，再往后没有行）。
 *   实测余下 0 条 ⇒ `FOLD_END_FLOOR` 从 91 抬到 97。
 */

/** 结构容器节点名（`grammar.js` 的词，宿主侧零依赖语法包 TS 入口 ⇒ 这里按名字硬编码）。 */
const CONTAINER_NODE_NAMES: ReadonlySet<string> = new Set([
  'source_file',
  'block',
  'item_block',
  'block_body',
  'switch_body',
  'choice_body',
  'when_body',
]);

/** `folds.scm` → 折叠区间（终点口径直接调引擎的 `extendFoldOverTrailingBlanks`，不抄第二遍）。 */
function cstFoldRanges(
  query: Query,
  root: TreeSitterNode,
  text: string,
): Array<{ startRow: number; endRow: number; openType: string }> {
  const preferred = query.captureNames.includes('fold') ? 'fold' : null;
  const out: Array<{ startRow: number; endRow: number; openType: string }> = [];
  for (const capture of query.captures(root)) {
    if (preferred !== null && capture.name !== preferred) continue;
    const startRow = capture.node.startPosition.row;
    const endRow = capture.node.endPosition.row;
    if (endRow <= startRow) continue;
    const open = capture.node.childForFieldName('open') ?? capture.node.firstNamedChild;
    // 止行吞掉尾随空行——引擎 `foldSlot()` 用的就是这同一枚函数
    const extendedRow = extendFoldOverTrailingBlanks(text, capture.node, endRow).endRow;
    out.push({ startRow, endRow: extendedRow, openType: open?.type ?? capture.node.type });
  }
  return out;
}

/**
 * 逐行反查该行的**最外层非容器节点名**（一次遍历建表，供"真源有、CST 没认成块"的分类用）。
 * 名字全是语法词，不借 `classifyLine` 的内部 kind（架构铁律 1/3）。
 */
function lineNodeByRow(root: TreeSitterNode): Map<number, string> {
  const found = new Map<number, string>();
  const stack: TreeSitterNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const row = node.startPosition.row;
    if (!CONTAINER_NODE_NAMES.has(node.type) && !found.has(row)) found.set(row, node.type);
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child !== null) stack.push(child);
    }
  }
  return found;
}

describe('折叠：folds.scm 块容器区间 vs kojoFoldingRanges 真源', () => {
  it('folds.scm 真跑出块容器区间（不再回落），起点精确率 / 起点召回 / 终点一致率一并取数', () => {
    const svc = createSugarTranspileService({});
    let scmFolds = 0;
    let baselineFolds = 0;
    let startAgreed = 0;
    let endAgreed = 0;
    let missedStarts = 0;
    const cstOnlyByOpen = new Map<string, number>();
    const missedByLineNode = new Map<string, number>();
    const endDiffByOpen = new Map<string, number>();
    /** 族 → 落点点名（供组长排期用，每族最多 6 处） */
    const spotsByFamily = new Map<string, string[]>();
    const noteSpot = (family: string, spot: string): void => {
      let list = spotsByFamily.get(family);
      if (list === undefined) {
        list = [];
        spotsByFamily.set(family, list);
      }
      if (list.length < 6) list.push(spot);
    };
    const endDeltaHist = new Map<number, number>();
    const thSpanHist = new Map<number, number>();
    const sampleDiffs: string[] = [];
    const missedSamples: string[] = [];
    const endDiffs: string[] = [];
    const perFile: Array<{ rel: string; cst: number; base: number; hit: number; miss: number; endHit: number }> = [];

    for (const file of fixtures) {
      const rel = relOf(file);
      const text = readFileSync(file, 'utf8');
      const tree = parser!.parse(text);
      if (tree === null) throw new Error(`没产出树：${rel}`);
      const lines = splitLines(text);
      const lineNode = lineNodeByRow(tree.rootNode);
      // ① CST 侧：folds.scm 真跑（worker 用的同一条判据）
      const cst = cstFoldRanges(foldsQuery!, tree.rootNode, text);
      // ② 真源侧：转译器符号树摊平的折叠区间，1 基 → 0 基
      const baseline = kojoFoldingRanges(svc.parse(text, { filePath: file })).map(
        (r) => [r.startLine - 1, r.endLine - 1] as [number, number],
      );
      const baselineStarts = new Map<number, Set<number>>();
      for (const [s, e] of baseline) {
        const set = baselineStarts.get(s) ?? new Set<number>();
        set.add(e);
        baselineStarts.set(s, set);
      }
      const cstStarts = new Set(cst.map((r) => r.startRow));

      let fileHit = 0;
      let fileEndHit = 0;
      let fileMiss = 0;
      for (const { startRow, endRow, openType } of cst) {
        const ends = baselineStarts.get(startRow);
        if (ends === undefined) {
          cstOnlyByOpen.set(openType, (cstOnlyByOpen.get(openType) ?? 0) + 1);
          noteSpot(`仅 CST（${openType}）`, `${rel}:${startRow + 1}..${endRow + 1}`);
          if (sampleDiffs.length < 30) {
            sampleDiffs.push(
              `${rel} CST 块 ${startRow + 1}..${endRow + 1}（头形 ${openType}）：真源没有以 ${startRow + 1} 为起点的折叠｜${(lines[startRow] ?? '').trim().slice(0, 40)}`,
            );
          }
          continue;
        }
        fileHit += 1;
        if (ends.has(endRow)) fileEndHit += 1;
        else {
          endDiffByOpen.set(openType, (endDiffByOpen.get(openType) ?? 0) + 1);
          const be = Math.max(...ends);
          endDeltaHist.set(be - endRow, (endDeltaHist.get(be - endRow) ?? 0) + 1);
          if (endDiffs.length < 30) {
            endDiffs.push(
              `${rel} 起点 ${startRow + 1}（头形 ${openType}）两侧都在：CST 止 ${endRow + 1} / 真源止行 {${[...ends].sort((x, y) => x - y).map((x) => x + 1).join(', ')}}｜${(lines[startRow] ?? '').trim().slice(0, 40)}`,
            );
          }
        }
      }
      for (const [s, e] of baseline) {
        if (cstStarts.has(s)) continue;
        fileMiss += 1;
        const nodeType = lineNode.get(s) ?? '<该行无 CST 节点>';
        missedByLineNode.set(nodeType, (missedByLineNode.get(nodeType) ?? 0) + 1);
        noteSpot(`仅真源（该行节点 ${nodeType}）`, `${rel}:${s + 1}..${e + 1}`);
        if (nodeType === 'timing_head') thSpanHist.set(e - s, (thSpanHist.get(e - s) ?? 0) + 1);
        if (missedSamples.length < 30) {
          missedSamples.push(
            `${rel} 真源 ${s + 1}..${e + 1} 的起点没成块（该行节点 ${nodeType}）｜${(lines[s] ?? '').trim().slice(0, 40)}`,
          );
        }
      }

      scmFolds += cst.length;
      baselineFolds += baseline.length;
      startAgreed += fileHit;
      endAgreed += fileEndHit;
      missedStarts += fileMiss;
      perFile.push({ rel, cst: cst.length, base: baseline.length, hit: fileHit, miss: fileMiss, endHit: fileEndHit });
      tree.delete();
    }

    const startPrecision = scmFolds === 0 ? 0 : (startAgreed / scmFolds) * 100;
    const startRecall = baselineFolds === 0 ? 0 : ((baselineFolds - missedStarts) / baselineFolds) * 100;
    const endAgreement = startAgreed === 0 ? 0 : (endAgreed / startAgreed) * 100;

    console.log(`\n===== ④ 折叠对照（CST 块容器 vs 转译器真源）=====`);
    console.log(`folds.scm 查询捕获名       : ${foldsQuery!.captureNames.join(', ') || '（无捕获）'}`);
    console.log(`folds.scm 真跑出的区间数   : ${scmFolds} ⇒ 结构层自己供折叠，worker 的 folds 回落分支不再触发`);
    console.log(`转译器真源区间数           : ${baselineFolds}`);
    console.log(`起点落在真源起点集里       : ${startAgreed}/${scmFolds}（起点精确率 ${startPrecision.toFixed(2)}%）`);
    console.log(`真源起点被 CST 认出        : ${baselineFolds - missedStarts}/${baselineFolds}（起点召回 ${startRecall.toFixed(2)}%）`);
    console.log(`同起点区间的终点一致       : ${endAgreed}/${startAgreed}（终点一致率 ${endAgreement.toFixed(2)}%）`);
    console.log(`CST 有、真源没有的起点（按块头形）: ${[...cstOnlyByOpen].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / ') || '—'}`);
    console.log(`真源有、CST 没成块的起点（按该行 CST 节点名）: ${[...missedByLineNode].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / ') || '—'}`);
    console.log(`终点不一致（按块头形）     : ${[...endDiffByOpen].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / ') || '—'}`);
    console.log(`终点差多少行（真源最远止 − CST 止）: ${[...endDeltaHist].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} 行 × ${v}`).join(' / ') || '—'}`);
    const ratios = perFile.map((f) => ({
      ...f,
      precision: f.cst === 0 ? 1 : (f.hit / f.cst) * 100,
      recall: f.base === 0 ? 1 : ((f.base - f.miss) / f.base) * 100,
      endRate: f.hit === 0 ? 0 : (f.endHit / f.hit) * 100,
    }));
    console.log('每文件读数（起点精确率最低 8 个）:');
    for (const f of [...ratios].sort((a, b) => a.precision - b.precision).slice(0, 8)) {
      console.log(
        `  精确 ${f.precision.toFixed(1)}%（${f.hit}/${f.cst}）  召回 ${f.recall.toFixed(1)}%（${f.base - f.miss}/${f.base}）  终点 ${f.endRate.toFixed(1)}%（${f.endHit}/${f.hit}）  ${f.rel}`,
      );
    }
    console.log('每文件读数（起点召回最低 8 个）:');
    for (const f of [...ratios].sort((a, b) => a.recall - b.recall).slice(0, 8)) {
      console.log(
        `  召回 ${f.recall.toFixed(1)}%（${f.base - f.miss}/${f.base}）  精确 ${f.precision.toFixed(1)}%（${f.hit}/${f.cst}）  终点 ${f.endRate.toFixed(1)}%（${f.endHit}/${f.hit}）  ${f.rel}`,
      );
    }
    console.log(`（口径核对）仅真源的 timing_head 跨度分布（止 − 起）: ${[...thSpanHist].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k} 行 × ${v}`).join(' / ') || '—'}`);
    console.log('落点点名（每族最多 6 处，供排期）:');
    for (const [family, spots] of spotsByFamily) console.log(`  ${family}: ${spots.join(' , ')}`);
    console.log('CST 成块但真源无此起点的样本（前 30）:');
    for (const d of sampleDiffs) console.log(`  · ${d}`);
    console.log('真源有起点但 CST 没成块的样本（前 30）:');
    for (const d of missedSamples) console.log(`  · ${d}`);
    console.log('同起点但终点不一致的样本（前 30）:');
    for (const d of endDiffs) console.log(`  · ${d}`);

    // ① 回落面已经翻篇：folds.scm 有 @fold 捕获 ⇒ `engine.ts::compileQueries` 那条
    //    "folds 查询里没有带捕获的模式 ⇒ 折叠这一面不由结构层供"的分支不再触发。
    expect(foldsQuery!.captureNames, 'folds.scm 必须带 @fold 捕获（worker 的 foldsFrom 按这个名字取）').toContain('fold');
    expect(scmFolds, 'CST 块区间数跌破棘轮 ⇒ 折叠这一面又回落到原有供给器').toBeGreaterThanOrEqual(FOLD_RANGE_FLOOR);
    expect(baselineFolds).toBeGreaterThan(0);
    expect(startPrecision, `起点精确率 ${startPrecision.toFixed(2)}% 低于地板`).toBeGreaterThanOrEqual(FOLD_START_FLOOR);
    expect(startRecall, `起点召回 ${startRecall.toFixed(2)}% 低于地板`).toBeGreaterThanOrEqual(FOLD_RECALL_FLOOR);
    expect(endAgreement, `终点一致率 ${endAgreement.toFixed(2)}% 低于地板`).toBeGreaterThanOrEqual(FOLD_END_FLOOR);
  });
});

/**
 * Token A/B 地板。
 *
 * - **wave 1 实测**：99.20%（分母 97,143 个内容格 / 19 个语料文件；同格同名 93,788 + 同族子档 2,579
 *   + 异档 774 + 词法层未着色 2）；
 * - **本批实测（改档后）**：**99.58%**（同格同名 94,133 + 同族子档 2,598 + 异档 410 + 词法层未着色 2，
 *   分母不变 97,143）。涨的 364 格全部来自 `types.ts` 那一格错档：`@keyword` 原本映射成
 *   `keyword.erb`（引擎指令档），而查询里挂 `@keyword` 的五支节点说的都是**已经中文化**的行，
 *   词法层在同样格子上发 `sugar.keyword` / `sugar.speech` / `sugar.cont`。逐类命中分布
 *   （改动前用临时取数量出来的，留在这里当下次的对照）：
 *   · `blank_line_cmd` 293 格 —— `sugar.keyword` 族 227 格（77.5%，含 `sugar.keyword.alias` 5）；
 *   · `heart_text` 161 格 —— `sugar.speech` 族 109 格（67.7%） vs `sugar.keyword` 族只有 29 格
 *     ⇒ 这一支走 `KOJO_STRUCTURE_NODE_TIERS` 的节点级覆盖；
 *   · `message_check` 97 格 —— `sugar.keyword` 族 28 格（其余散在 `operator` / `sugar.slot` /
 *     `identifier` / `number`，一支整行捕获给不出第二个档）；
 *   · `color_head` 44 格 —— `number.hex` 32 格最多，但那是**参数**（`着色 0xFF8080：` 的色值），
 *     行身份是中文关键字 ⇒ 仍按 `sugar.keyword`（8/44），没为多捞 24 格去借基线数字档。
 *
 * 剩下 410 格的两类**都是结构层的真实覆盖面缺口**，读数里逐条点名：
 * ① 台词串内的 `{插值}`：语法把整支 `「…」` 认成一枚 `string`（`@string` → `sugar.speech`），
 *    词法层在 `{}` 上换档到 `sugar.interp` ⇒ 192 格（`sugar.speech ⇄ sugar.interp` 136 +
 *    `⇄ sugar.interp.delimiter` 56）。修法在语法/查询那一侧（`interpolation` 单独成支并且
 *    让它的格子在外层 `string` 之前落位），不在档位表；
 * ② `sugar.keyword ⇄ sugar.cont` 58 格（`空行 等待` 的"等待/续"标记）、`⇄ number.hex` 32 格、
 *    `⇄ operator/sugar.slot/identifier` 各 17–18 格：整行一支捕获 vs 逐词换档的表示法差异。
 *
 * 地板取 **99.4**（实测 99.58 之下留 0.18 个百分点）：**只升不降**。语法批（块嵌套）落地后
 * 若这一格因为"块容器改变了涂色跨度"而翻线，正确动作是重跑取数、把上面的读数与地板一起改写，
 * 而不是默默把地板调回去。
 */
/**
 * 总比率地板：**2026-10-20 口径变更后重标**。上一版 99.4 量在"结构层只涂 3 族"的窄面上（分母 100,462 格）；
 * 本波把 `keyword.control` 光杆形与 `raw_block_start` 两族登记进真表后，涂色面扩到 5 族、分母涨到 104,215 格，
 * 总比率随之从 99.59% 落到 99.29% —— **这不是判据变差，是以前不进分母的格子进来了**。
 * ⇒ 防回归改由三把尺承担：①**分族地板**（每族只降不升，见下）②**分母只增不减** ③有档/表外捕获数绝对值。
 * 总比率继续打印，地板按实测重标留余量；任何"面变了"的批次都不许拿总比率当唯一依据（PITFALLS 141）。
 */
const TOKEN_AB_FLOOR = 99.2;
/**
 * 分族地板：只降不升（2026-10-20 按本波实测重标；新登记的族取首测值）。
 *
 * 读数要跟着看：`comment` 100.00% 是基线档；`sugar.speech` 98.79% 是老面；
 * `keyword.raw` 94.04% 与 **`sugar.keyword` 66.27%** 是新登记两族的**首测代价**——
 * 后者低是因为 `keyword.control` 只登记了 12 枚**光杆块头**（跨度里 34% 是冒号/间隔，
 * 词法层给 `sugar.colon` 一类子档），整段一档涂必然对不齐。这是"覆盖面 vs 逐格精度"的
 * 取舍：不登记＝那些格子干脆不涂（覆盖率 58.7%），登记＝涂对主体、冒号跟着整段走。
 * ⇒ 两个方向都记在账上，**不许**为了抬高总比率把不一致的族偷偷摘掉。
 */
const TOKEN_AB_TIER_FLOORS: Readonly<Record<string, number>> = {
  comment: 100,
  'sugar.speech': 98.7,
  'keyword.raw': 94.0,
  'sugar.keyword': 66.2,
};
/** 分母只增不减（本波实测 104,177；缩了就是覆盖面被偷） */
const TOKEN_AB_MIN_CELLS = 104177;

/**
 * 折叠地板（**`@` 族容器落地 + `expr_head` 起点错位修好 + `"标签":` 条目补形后重取的数**，只升不降）。
 *
 * 19 份语料 / 9,102 行真跑读数（`folds.scm` 的 `@fold` vs `kojoFoldingRanges`）：
 * - **区间数**：CST **1,103** 条（上一批 1,007 ⇒ +93 枚 `@函数名` 块 +3 枚双引号条目块）、真源 1,251 条；
 * - **起点精确率 97.19%**（1,072/1,103）——漏的 31 条全是"转译器 AST 有节点、`rawSymbol` 没登记"的族
 *   （循环 5 / 询问条目 8 + 询问头 2 / 规则标签 6 / 分支 2 / 数据表 1 / 出错处理 1 / 开关头 2 /
 *   `if` 2…），属**加法折叠**不是错折；`expr_head` 那 4 条起点早一行的真缺陷已经归零。
 *   （旧文里"排期落地后抬到 99"这条达不到：剩下的 31 条不是语法层的错，是大纲那一侧没登记族，
 *   要抬到 99 得由 kojo-sugar 的 `rawSymbol` 补登记，不在语法批。）
 * - **起点召回 97.20%**（1,216/1,251）——只剩 35 条，全部是空体 时机 块的**口径差**
 *   （语法层"零行跨度不产折叠"，`folds.scm` 头注写明，不改）；上一批的三处缺口（`raw_block_start` 93、
 *   `expr_head` 连带 6、`"标签":` 条目 3）已一并补掉；
 * - **终点一致率 100.00%**（1,072/1,072；上一批 91.88%，不一致的 87 条里 86 条差 1 行）——那 1 行的差
 *   就是"块后的尾随空行归谁"（真源算进止行，CST 止于最后一行正文：`scanner.c` 的 `_dedent` 不跨换行，
 *   `folds.scm` 头注写明的口径）。本批由结构层伸过去吞掉尾随空行收口（判据与三条界见上方"分歧的形状"第 3 条）；
 *   新增的 93 枚 `@` 块**止行本来就逐行对齐**（`_raw_close` 的 mark 落在区内最后一行，与 `loc.end` 同口径），
 *   所以这条比率上涨与召回互不稀释。
 *
 * 地板取法（都留得出解释）：**区间数 1,100**（实测 1,103，掉了就说明 `@` 族容器或查询又退化）；
 * **精确率 97**（实测 97.19，剩 0.19 个百分点给新语料抖动）；
 * **召回 97**（实测 97.20；上一批是 85，那 4 个百分点的余量本来是留给 `@` 族的，族已经落地 ⇒ 余量收回）；
 * **终点一致 97**（实测 100.00；留 3 个百分点给新语料——止行口径刚改完，新族/新形状一旦复现"尾随空行
 * 归谁"之外的差，线要能说出事，不许贴着实测放）。
 * 还剩一件事可再抬召回：空体 时机 的 35 条属口径之争，动它要先动 `folds.scm` 那条"零行跨度不产折叠"的约定。
 */
const FOLD_RANGE_FLOOR = 1100;
const FOLD_START_FLOOR = 97;
const FOLD_RECALL_FLOOR = 97;
const FOLD_END_FLOOR = 97;
