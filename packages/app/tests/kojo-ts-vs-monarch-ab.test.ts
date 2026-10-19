import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Language, Parser, Query } from 'web-tree-sitter';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { kojoFoldingRanges } from '../../plugins/kojo-sugar/src/folding';
import { KOJO_TOKEN_TIERS, registerKojoLanguage } from '../src/monaco/kojo-language';
import { compileMonarch, driveLexer, stubMonaco, type Emit } from './monarch-harness';
import { structureLegendTypes, tierForCapture, type KojoStructureToken } from '../src/monaco/tree-sitter/types';
import { splitStructureTokensToSpans } from '../src/monaco/tree-sitter/semantic';

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
 * ## 折叠（第四段，实测与"100% 线"的差距写在下方的地板注释里）
 *
 * `queries/folds.scm` 本批是**合法空查询**（行式语法不产跨行容器，见该文件头注）⇒ 结构层
 * 现在一个折叠区间都不产，worker 走的是"这一面回落、折叠继续由原有供给器负责"。本段因此量三件：
 * ① `folds.scm` 经 `Query` 真跑出来的区间数（实测 0，钉住"回落成立"）；
 * ② 由 CST 的**结构行节点**（块头 + 更深层正文）现推的折叠区间，与真转译器的
 *   `kojoFoldingRanges`（`.kojo` 折叠唯一真源）对照**起点**（语法层认不认得这是块头）；
 * ③ 同起点区间的**终点**一致率（行式语法没有块容器 ⇒ 止行只能按缩进推，量出来是结构事实）。
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
    else if (e.name.endsWith('.kojo')) out.push(p);
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
const monarchDef = captured.monarchs.get('kojo-sugar');
if (!monarchDef) throw new Error('没捕获到 kojo-sugar 的 Monarch def（装配面漂 = 本文件整个红）');

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

/** 捕获名 → 档位；表外（`@keyword.control` 等）= `null`，与 worker 同一条判据。 */
function captureTier(name: string): string | null {
  return tierForCapture(name);
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
    const tier = captureTier(capture.name);
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
  lexer = await compileMonarch('kojo-sugar', monarchDef);
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
        const stripped = token === null ? null : token.replace(/\.kojo-sugar$/, '');
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
    console.log(`highlights.scm 捕获名 ${query!.captureNames.length} 支，其中在宿主档位表里有档的: ${query!.captureNames.filter((n) => captureTier(n) !== null).join(', ') || '—'}`);
    console.log(`（表外捕获 = 结构层这一格不涂色，走 worker 的一次性告警：${query!.captureNames.filter((n) => captureTier(n) === null).length} 支）`);
  });

  it('逐格一致率读数（≥98% 线）', () => {
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
    const tierTokens = new Set(KOJO_TOKEN_TIERS.flatMap((t) => [...t.tokens]));
    for (const tier of used) {
      expect(tierTokens.has(tier) || tier === 'comment', `档位 ${tier} 在屏上无处取色`).toBe(true);
    }
    console.log(`结构层实际用到的档位名: ${[...used].sort().join(', ')}`);
  });
});

/* ============================ 折叠对照 ============================ */

/**
 * 会开块体的 **CST 节点名**（语法词，宿主侧口径）。
 * 名单对应 `kojo-sugar/enter.ts` 的 `BODY_OPEN_KINDS` 那一族"下一行该更深"的行类，
 * 但按 `grammar.js` 的规则名给出——`if_head`（无行内体的块头形）、三族收束词不开块体。
 */
const CST_BODY_OPEN_NODES: ReadonlySet<string> = new Set([
  'timing_head',
  'custom_command_head',
  'when_head',
  'case_head',
  'random_head',
  'random_inline',
  'group_head',
  'branch_head',
  'rule_tag',
  'section_head',
  'once_head',
  'choice_head',
  'menu_head',
  'ask_m_head',
  'ask_yn_head',
  'color_head',
  'heart_head',
  'function_head',
  'expr_head',
  'if_head',
  'loop_head',
  'catch_head',
  'data_head',
  'heart_text',
]);

/** 该行缩进（前导水平空白长度；全角空格按 2 格算，同 `indentLevel` 的折算方向）。 */
const indentOf = (line: string): number => {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else if (ch === '\u3000') width += 2;
    else break;
  }
  return width;
};

describe('折叠：folds.scm 回落 + CST 结构区间 vs 转译器真源', () => {
  it('folds.scm 现在产 0 个折叠区间（回落面钉住），CST 结构推导区间与 kojoFoldingRanges 对照', () => {
    const svc = createSugarTranspileService({});
    let scmFolds = 0;
    let cstFolds = 0;
    let baselineFolds = 0;
    let exactAgreed = 0;
    let startAgreed = 0;
    let endAgreed = 0;
    let missedStarts = 0;
    let totalStartsBaseline = 0;
    const sampleDiffs: string[] = [];
    const endDiffs: string[] = [];
    for (const file of fixtures) {
      const rel = relOf(file);
      const text = readFileSync(file, 'utf8');
      const tree = parser!.parse(text);
      if (tree === null) throw new Error(`没产出树：${rel}`);
      // ① folds.scm 真跑（worker 侧同一条 `foldsFrom`：无 @fold 捕获 ⇒ 该面回落）
      const hasFoldCapture = foldsQuery!.captureNames.includes('fold');
      for (const capture of foldsQuery!.captures(tree.rootNode)) {
        if (hasFoldCapture && capture.name !== 'fold') continue;
        if (capture.node.endPosition.row > capture.node.startPosition.row) scmFolds += 1;
      }
      // ② CST 结构行节点现推：块头行 → 直到出现**更浅缩进**的行为止（同级分支头算在本块内）
      //    这里只用 **CST 节点名**（语言词），不取 `NODE_TO_KIND`：宿主侧不许认识 `classifyLine`
      //    的内部 kind（架构铁律 1/3），折叠的"这是块头"判定本来就属于语法形状。
      const starts = lineStarts(text);
      const lines = splitLines(text);
      const headRow = new Set<number>();
      for (const child of tree.rootNode.namedChildren) {
        const last = child.endIndex - 1;
        if (last < child.startIndex) continue;
        if (!CST_BODY_OPEN_NODES.has(child.type)) continue;
        headRow.add(rowOf(starts, last));
      }
      const cstRanges: Array<[number, number]> = [];
      for (let row = 0; row < lines.length; row++) {
        if (!headRow.has(row)) continue;
        const baseIndent = indentOf(lines[row] ?? '');
        let end = row;
        for (let next = row + 1; next < lines.length; next++) {
          const line = lines[next]!;
          if (line.trim().length === 0) {
            end = next; // 空行不断块（转译器同样跨过空行）
            continue;
          }
          if (indentOf(line) <= baseIndent) break;
          end = next;
          // 尾随空行不该把区间无限拉长：往后没有更深正文时就停在最后一行正文
          let hasBodyAfter = false;
          for (let probe = next + 1; probe < lines.length; probe++) {
            if (lines[probe]!.trim().length === 0) continue;
            hasBodyAfter = indentOf(lines[probe]!) > baseIndent;
            break;
          }
          if (!hasBodyAfter) {
            end = next - 1;
            break;
          }
        }
        if (end > row) cstRanges.push([row, end]);
      }
      // ③ 真源：转译器符号树摊平的折叠区间（`.kojo` 折叠唯一口径），1 基 → 0 基
      const baseline = kojoFoldingRanges(svc.parse(text, { filePath: file })).map(
        (r) => [r.startLine - 1, r.endLine - 1] as [number, number],
      );
      const baselineKeys = new Set(baseline.map(([s, e]) => `${s}\u0000${e}`));
      const baselineEndByStart = new Map<number, number>();
      for (const [s, e] of baseline) baselineEndByStart.set(s, Math.max(e, baselineEndByStart.get(s) ?? -1));
      cstFolds += cstRanges.length;
      baselineFolds += baseline.length;
      for (const [s, e] of cstRanges) {
        if (baselineKeys.has(`${s}\u0000${e}`)) exactAgreed += 1;
        const be = baselineEndByStart.get(s);
        if (be !== undefined) {
          startAgreed += 1;
          if (be === e) endAgreed += 1;
          else if (endDiffs.length < 30) endDiffs.push(`${rel} 起点 ${s + 1} 两侧都在：CST 止 ${e + 1} / 真源 止 ${be + 1}`);
        } else if (sampleDiffs.length < 30) {
          sampleDiffs.push(`${rel} CST 现推块头 ${s + 1}..${e + 1}：真源没有以 ${s + 1} 为起点的区间`);
        }
      }
      const cstStartKeys = new Set(cstRanges.map(([s]) => `${s}`));
      for (const [s] of baseline) if (!cstStartKeys.has(`${s}`)) missedStarts += 1;
      totalStartsBaseline += baseline.length;
      tree.delete();
    }
    const startPrecision = cstFolds === 0 ? 0 : (startAgreed / cstFolds) * 100;
    const startRecall = totalStartsBaseline === 0 ? 0 : ((totalStartsBaseline - missedStarts) / totalStartsBaseline) * 100;
    const endAgreement = startAgreed === 0 ? 0 : (endAgreed / startAgreed) * 100;
    const exactPrecision = cstFolds === 0 ? 0 : (exactAgreed / cstFolds) * 100;
    console.log(`\n===== ④ 折叠对照 =====`);
    console.log(`folds.scm 查询捕获名       : ${foldsQuery!.captureNames.join(', ') || '（无捕获）'}`);
    console.log(`folds.scm 真跑出的区间数   : ${scmFolds}  ⇒ 结构层这一面回落到原有折叠（worker 回一条 query 阶段告警）`);
    console.log(`CST 结构行节点现推区间数   : ${cstFolds}`);
    console.log(`转译器真源区间数           : ${baselineFolds}`);
    console.log(`逐字同区间（起 + 止都等）  : ${exactAgreed}（精确率 ${exactPrecision.toFixed(2)}%）`);
    console.log(`起点落在真源起点集里       : ${startAgreed}/${cstFolds}（起点精确率 ${startPrecision.toFixed(2)}%）`);
    console.log(`真源起点被 CST 认出        : ${totalStartsBaseline - missedStarts}/${totalStartsBaseline}（起点召回 ${startRecall.toFixed(2)}%）`);
    console.log(`同起点区间的终点一致       : ${endAgreed}/${startAgreed}（${endAgreement.toFixed(2)}%）`);
    console.log('终点不一致的样本（前 30）:');
    for (const d of endDiffs) console.log(`  · ${d}`);
    console.log('CST 现推块头在真源里找不到起点的样本（前 30）:');
    for (const d of sampleDiffs) console.log(`  · ${d}`);
    expect(scmFolds, 'folds.scm 若开始产折叠，本批"回落面钉住"的读数要一起改').toBe(0);
    expect(cstFolds).toBeGreaterThan(0);
    expect(startPrecision, `起点精确率 ${startPrecision.toFixed(2)}% 低于地板`).toBeGreaterThanOrEqual(FOLD_START_FLOOR);
    expect(startRecall, `起点召回 ${startRecall.toFixed(2)}% 低于地板`).toBeGreaterThanOrEqual(FOLD_RECALL_FLOOR);
  });
});

/**
 * Token A/B 地板：实测 **99.20%**（分母 97,143 个内容格 / 19 个语料文件；
 * 同格同名 93,788 + 同族子档 2,579 + 异档 774 + 词法层未着色 2）。任务线 98% ⇒ 地板就取 98，不放宽。
 * 剩下 0.80% 的两类分歧都是**结构层这一批的真实缺口**，逐条在上方读数里点名：
 * ① 台词串内的 `{插值}`：语法把整支 `「…」` 认成一枚 `string`（`@string` → `sugar.speech`），
 *    词法层在 `{}` 上换档到 `sugar.interp` ⇒ 结构层把插值涂成台词；
 * ② `@keyword` 三支行（`着色` / `心形` / `空行` / `隐藏情景`）经宿主表翻成 `keyword.erb`
 *    （引擎指令档，最扎眼的外来色），而词法层判它们是中文关键字 / 台词 / 名字层 ⇒
 *    **表里那一格映射选错了档**（`types.ts` 的 `keyword → keyword.erb`）。
 */
const TOKEN_AB_FLOOR = 98;

/**
 * 折叠地板（取数写死，只升不降）：CST 现推区间 788 条，其中 **98.35%**（775）的起点确实是真源折叠
 * 的起点（语法层认块头认得准）；真源 1,251 条起点里 **69.54%**（870）被现推认出——漏的都是嵌套 /
 * 分支层，行式语法没有块容器 ⇒ 现推只能看见"缩进更深的一段"。
 * 起点两侧的**终点**逐字一致只有 4.52%（35/775）：真源的止行按转译器配对规则走到"所属层末尾"
 * （含尾随空行），现推只能走到最后一行更深正文。
 * **这两条量不到 100% 是结构事实，不是取数没做**：`folds.scm` 本批 0 捕获 ⇒ 结构层不供折叠，
 * 宿主按 `providers.ts` 的回落面继续用原有折叠供给器。要抬到 100% 需要 `scanner.c` 产 `block`
 * 容器 + `(block) @fold`，届时把这两条地板一次抬到 100 并按"逐字同区间"断言。
 */
const FOLD_START_FLOOR = 95;
const FOLD_RECALL_FLOOR = 60;
