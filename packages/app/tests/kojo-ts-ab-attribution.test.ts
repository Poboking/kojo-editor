import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyLine, splitLogicalLines } from '@kojo/plugin-kojo-sugar';
import { KOJO_LANGUAGE_ID, KOJO_TOKEN_TIERS, registerKojoLanguage } from '../src/monaco/kojo-language';
import { compileMonarch, driveLexer, stubMonaco, type Emit } from './monarch-harness';
import {
  KOJO_STRUCTURE_NODE_TIERS,
  structureLegendTypes,
  tierForCapture,
  type KojoStructureToken,
} from '../src/monaco/tree-sitter/types';
import { isKnownStructureTier, MAX_STRUCTURE_TOKEN_SPAN, splitStructureTokensToSpans } from '../src/monaco/tree-sitter/semantic';
import { KIND_TO_NODE, NON_LINE_NODES } from '../../kojo-syntax-tree/src/node-types';

/**
 * TSIT4-B：结构层 ↔ 词法层**逐格差异的归因**（不是第二道总数闸）。
 *
 * ## 这份文件回答什么问题
 *
 * 既有 A/B（`kojo-ts-vs-monarch-ab.test.ts`）量到 token 逐格一致 99.58% / 分母 97,143 格，
 * 于是有约 412 格差异**从没被解释过**：谁更对、差在哪一族、"默认能不能开"有没有账。
 * 本文件把两腿**每一格不同**按三元组 `(真源 classifyLine 判到的 kind, 词法层给的 tier,
 * 结构层给的 tier)` 分桶，再按可证伪的口径判三桶，并落一条「说不清」只降不升的棘轮。
 *
 * **它不判一致率**：比率与四块地板仍以既有 A/B 文件为准（这里连 `99.4` 都不抄）。本文件的
 * 唯一钉值是"说不清桶只降不升"，两把"谁更对"的桶**只报数不钉值**（钉死会诱导读数往一边靠）。
 *
 * ## 语料：既有夹具，且**显式不吃并行批的新增**
 *
 * 分母 = `packages` + `fixtures` 递归、跳 `node_modules`，但**整棵 `packages/kojo-syntax-tree/tests`
 * 子树都排除**（既有 A/B 只排除其中的 `tests/fixtures` 残缺样本；本批 TSIT4-A 正在往
 * `tests/coverage-fixtures/` 加夹具，那目录**不在 git 里**，落进了 A/B 的排除面之外）。
 * 本文件只归因既有 19 份语料，才能和 A/B 公布的 97,143 格 / 412 差异格逐格对账；被排掉的
 * `.kojo` 一律打印出来（吃了哪几份、为什么不吃，一眼可查）。既有夹具一字未改（本文件只读）。
 *
 * ## 期望档位从哪来（**没有第四份映射**）
 *
 * 判"谁更对"必须有一把不偏向任何一侧的尺。本文件不自造 kind→档位表（那是第二套判据，
 * 本仓库明令禁止），而是把**三张已有的真表串起来**：
 *
 * 1. `packages/kojo-syntax-tree/src/node-types.ts` 的 `KIND_TO_NODE`：`classifyLine` 的 kind → CST 节点名；
 * 2. `packages/kojo-syntax-tree/queries/highlights.scm`：该节点名挂着哪支捕获——**读的是那份文件自己的
 *    `(节点) @捕获` 声明**（一行多捕获的嵌套形态不采信并计数），同时拿全语料 `Query.captures`
 *    实测到的 `(节点, 捕获)` 对**对账**（实测有一对不在读表结果里 = 读表器漏了形态 ⇒ 当场红）。
 *    两读法同源同文件，本文件仍不写第四份映射；
 * 3. `packages/app/src/monaco/tree-sitter/types.ts` 的 `tierForCapture`（含 `KOJO_STRUCTURE_NODE_TIERS`
 *    的节点级覆盖）：捕获名（+ 节点名）→ 档位名。
 *
 * 末端再回 `kojo-language.ts` 的 `KOJO_TOKEN_TIERS` 验一次"这一档在屏上取得到色"，取不到色 = 无期望。
 * 链条里任何一环给不出唯一档位（节点没被捕获 / 捕获在档位表外 / 同节点挂两支不同档 / kind 不在
 * `KIND_TO_NODE`）⇒ 该 kind **没有确定的期望档位** ⇒ 落"说不清"。真表覆盖不到就是覆盖不到，不猜。
 *
 * ## 三桶口径（可证伪）
 *
 * 记 `E` = 该 kind 的期望档位、`M` = 词法层在该格的 token（剥掉 `.<语言 id>` 后缀（LAU-3 起是 `.kojo-legacy`），同 A/B）、
 * `S` = 结构层在该格的档位：
 *
 * - **结构层更对** ＝ `S` 命中 `E` 且 `M` 不命中 `E`；
 * - **词法层更对** ＝ `M` 命中 `E` 且 `S` 不命中 `E`；
 * - **说不清** ＝ `E` 不存在，或两边都不命中 `E`（含两边都命中）。
 *
 * "命中"沿用既有 A/B 的**同族子档**约定：`token === E || token.startsWith(E + '.')`
 * （`sugar.speech.delimiter` 算命中 `sugar.speech`）——两把尺一个口径，否则归因与总数互相打脸。
 * 严格同名（不带族）的读数一并打印，方便看这条约定吃了多少格。
 *
 * ## 证据强度（本文件对自己最不客气的一段）
 *
 * `E` 是按**本行 kind** 算的，而结构层涂这一格的可能是别的节点（嵌套 `string`、跨行整段）。
 * 于是"结构层更对"里混着两种性质完全不同的格：
 * - `自证` ＝ 涂这一格的节点**正是** `KIND_TO_NODE[kind]`（结构层忠于它对这一行的那一支捕获）；
 * - `独立` ＝ 涂这一格的来自别的节点，`S == E` 是撞上的，不是同一条声明。
 * 两桶分别报数。**`自证` 那一半不构成"结构层更对"的独立证据**——它只说明结构层与档位表自洽；
 * 真正的判据分歧要看 `独立` 那一半与"词法层更对"。默认能不能开的结论必须按这条来写，别拿
 * 桶的总量充数（见文件末的"人话"汇总）。
 *
 * ## 隐私与打印纪律
 *
 * 语料里有真实口上摘录（`goldens/corpus-*`）。样例一律**掩形**：长度 ≥ 2 的 CJK 串折成 `█`，
 * 只留下结构记号（`{}`、`「」`、`：`、`@`、`$`、全大写 ERB 指令、数字）。定位靠
 * `文件名:行号 第N列` + kind + 两侧档位名，不靠抄原文。
 *
 * ## 为什么 CST 要经子进程拿（PITFALLS 138）
 *
 * web-tree-sitter 0.27 + Node（Win）在同一进程解过 `.kojo` 后**退出必** `Fatal process out of memory:
 * Zone`（本机实测：连单文件、连 `process.exit(0)` 都炸；既有 A/B 文件在本池就是这个形状——屏上
 * `4 passed` 而 `rc=3`，正是本仓点名过的假绿）。⇒ 本文件（父进程）**零 wasm**，逐份文件起一枚子进程
 * （`helpers/tsit4b-attribution-child.ts`），**只认 stdout 的 JSON、不看子进程退出码**；拿不到合法
 * JSON 才判崩溃。父进程自己的退出码必须为 0。
 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/app/tests
const repoRoot = resolve(here, '..', '..', '..');
const syntaxPkg = join(repoRoot, 'packages', 'kojo-syntax-tree');
const wasmPath = join(syntaxPkg, 'tree-sitter-kojo.wasm');
const highlightsPath = join(syntaxPkg, 'queries', 'highlights.scm');
/** 语法包自己的测试子树（残缺样本 + 并行批 TSIT4-A 正在新增的 coverage-fixtures）：本文件的分母一律不吃 */
const syntaxTestsDir = join(syntaxPkg, 'tests');
const childPath = join(here, 'helpers', 'tsit4b-attribution-child.ts');

/** 发现规则同 `kojo-ts-vs-monarch-ab.test.ts` 的 `collect`，只是排除面更宽（见头注"语料"一节）。 */
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
for (const top of ['packages', 'fixtures']) collect(join(repoRoot, top), fixtures, syntaxTestsDir);
fixtures.sort();
/** 被排掉的那几份也列出来（"吃了什么"要说得出口） */
const excludedFixtures: string[] = [];
collect(syntaxTestsDir, excludedFixtures, null);
excludedFixtures.sort();
const relOf = (file: string): string => file.slice(repoRoot.length + 1).replaceAll('\\', '/');

const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/);
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
/** 水平空白（口径同 A/B 与 lexer 的 `[ \t\u3000]` + 表单符） */
const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\u3000' || ch === '\f';

/* ==================== CST 侧：子进程供事实 ==================== */

interface CstCapture {
  readonly capture: string;
  readonly node: string;
  readonly sr: number;
  readonly sc: number;
  readonly er: number;
  readonly ec: number;
}

interface ChildPayload {
  readonly file: string;
  readonly captures: CstCapture[];
  readonly crashed: boolean;
  readonly note: string;
}

/** 子进程回话的形状（读不到就当崩溃，绝不"猜"缺字段） */
interface ChildReply {
  file?: string;
  fatal?: string;
  captureNames?: string[];
  nodeTypes?: string[];
  cells?: number[][];
}

/** 一文件一进程；判据只看 stdout 最后一行能不能解出 JSON（子进程退出码不作判据，见头注）。 */
function runChild(file: string): ChildPayload {
  const r = spawnSync(process.execPath, [childPath, wasmPath, highlightsPath, file], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const last = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  let parsed: ChildReply | null = null;
  try {
    parsed = JSON.parse(last) as ChildReply;
  } catch {
    parsed = null;
  }
  const reply = parsed;
  if (reply === null || reply.fatal !== undefined || !Array.isArray(reply.cells)) {
    return { file, captures: [], crashed: true, note: `${last.slice(0, 120) || `stderr ${(r.stderr ?? '').slice(0, 120)}`}` };
  }
  const captureNames = reply.captureNames ?? [];
  const nodeTypes = reply.nodeTypes ?? [];
  const captures: CstCapture[] = reply.cells.map((row: number[]) => ({
    capture: captureNames[row[0]!] ?? '',
    node: nodeTypes[row[1]!] ?? '',
    sr: row[2]!,
    sc: row[3]!,
    er: row[4]!,
    ec: row[5]!,
  }));
  return { file, captures, crashed: false, note: '' };
}

/* ==================== B 侧：捕获 → 档位 → 逐行区间（与 A/B 同一条判据） ==================== */

/** `KojoStructureToken` + provenance（`node` / `capture`）；A/B 不需要这两枚字段，归因需要。 */
interface PaintToken extends KojoStructureToken {
  readonly node: string;
  readonly capture: string;
}

/** 逐字抄 A/B 的 `structureTokens`（削前导空白 + 丢空跨度），只是数据来自子进程、并带 provenance。 */
function paintTokens(captures: readonly CstCapture[], text: string, starts: number[]): PaintToken[] {
  const out: PaintToken[] = [];
  for (const capture of captures) {
    const tier = tierForCapture(capture.capture, capture.node);
    if (tier === null) continue;
    // 偏移从 (sr,sc) 推不出来，故按"行首偏移 + 列"取；`ec` 是排他列（tree-sitter 原生口径同 A/B）
    let start = starts[capture.sr]! + capture.sc;
    const end = starts[capture.er]! + capture.ec;
    while (start < end && isSpace(text[start]!)) start++;
    if (end <= start) continue;
    out.push({
      startRow: rowOf(starts, start),
      startCol: start - starts[rowOf(starts, start)]!,
      endRow: rowOf(starts, end - 1),
      endCol: end - 1 - starts[rowOf(starts, end - 1)]! + 1,
      tier,
      node: capture.node,
      capture: capture.capture,
    });
  }
  return out;
}

/** 生产几何（`semantic.ts` 的 `splitStructureTokensToSpans`）+ 同一条几何的 provenance 影子。 */
interface MirroredSpan {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly typeIndex: number;
  readonly tokenIndex: number;
}

const LEGEND = structureLegendTypes();
const TYPE_INDEX = new Map<string, number>(LEGEND.map((t, i) => [t, i]));

/**
 * 影子几何：逐字镜像 `semantic.ts:116-149` 的分支（跳表外档位、跳超宽跨度、行越界丢、列越界夹、
 * 逐行拆段），只多带一枚 `tokenIndex`。**这份影子不当判据用**——每个文件都拿生产
 * `splitStructureTokensToSpans` 的输出逐格对账（长度 + `line/startColumn/endColumn/typeIndex`），
 * 漂一格就当场红；生产几何改了而这里没跟上 = 红，不会静默给出错 provenance。
 */
function spansWithOrigin(tokens: readonly PaintToken[], lineCount: number, maxColumn: (line: number) => number): MirroredSpan[] {
  const spans: MirroredSpan[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!isKnownStructureTier(token.tier)) continue;
    const typeIndex = TYPE_INDEX.get(token.tier);
    if (typeIndex === undefined) continue;
    const startLine = token.startRow + 1;
    const endLine = token.endRow + 1;
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine > lineCount || endLine < startLine) continue;
    if (endLine - startLine + 1 > MAX_STRUCTURE_TOKEN_SPAN) continue; // 跨度上限取生产那枚常量，不抄第二份数
    for (let line = startLine; line <= endLine; line++) {
      const cap = maxColumn(line);
      const from = line === startLine ? token.startCol + 1 : 1;
      const to = line === endLine ? token.endCol + 1 : cap;
      const startColumn = Math.min(Math.max(1, Math.trunc(from) || 1), cap);
      const endColumn = Math.min(Math.max(startColumn, Math.trunc(to) || startColumn), cap);
      if (endColumn <= startColumn) continue;
      spans.push({ line, startColumn, endColumn, typeIndex, tokenIndex: index });
    }
  }
  return spans;
}

/* ==================== A 侧：Monarch（与 A/B 同一套执行机制） ==================== */

const { monaco, captured } = stubMonaco();
registerKojoLanguage(monaco as never);
const monarchDef = captured.monarchs.get('kojo-legacy');
if (!monarchDef) throw new Error('没捕获到 kojo1（kojo-legacy）的 Monarch def（装配面漂 = 本文件整个红）');

/** 逐字抄 A/B 的 `emitCells`（列还原；失败行进计数、不猜列）。 */
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

/* ==================== 期望档位：kind →（node-types × highlights × types）==================== */

/** `KIND_TO_NODE` 的值域（节点名）→ 该节点在全语料里被 `highlights.scm` 挂到的捕获名集合 */
const capturesByNode = new Map<string, Set<string>>();
/** 真表串出来的期望档位：kind → 档位名；不在表里的 kind 没有这一格（落"说不清"），成因一并记着 */
const expectationByKind = new Map<string, string>();

/** 屏上取得到色的档位名（`KOJO_TOKEN_TIERS` 的 `tokens`；档位表在这里是终点校验，不是新映射） */
const TIERABLE_TOKENS = new Set<string>(KOJO_TOKEN_TIERS.flatMap((t) => [...t.tokens]));

/**
 * `highlights.scm` 的 `(节点名) @捕获名` 声明读成表（**读表，不是造表**）：
 * 逐行剥掉 `;` 注释后，一行里所有 `(name)` 共享该行唯一的 `@capture`；一行挂多个捕获
 * （嵌套模式）→ 该行不采信，计入"派生不确定"并在读数里说出来。
 * 采信面另拿"全语料 `Query.captures` 实测到的 `(节点, 捕获)` 对"对账（实测 ⊆ 派生，红则说明
 * 这份读表器在凭空加格子）。两读法都从**同一份文件**来，本文件仍不写第四份 kind→档位映射。
 */
function readHighlightsDeclarations(scm: string): { map: Map<string, Set<string>>; skippedLines: number } {
  const map = new Map<string, Set<string>>();
  let skippedLines = 0;
  for (const rawLine of scm.split(/\r?\n/)) {
    const line = rawLine.split(';')[0]!;
    if (line.trim().length === 0) continue;
    const nodes = [...line.matchAll(/\(\s*([a-z_][a-z0-9_]*)\s*\)/g)].map((m) => m[1]!);
    const captures = [...line.matchAll(/@([a-zA-Z][a-zA-Z0-9_.]*)/g)].map((m) => m[1]!);
    if (nodes.length === 0 || captures.length !== 1) {
      if (captures.length > 1) skippedLines += 1;
      continue;
    }
    for (const node of nodes) {
      const set = map.get(node) ?? new Set<string>();
      set.add(captures[0]!);
      map.set(node, set);
    }
  }
  return { map, skippedLines };
}

const declared = readHighlightsDeclarations(readFileSync(highlightsPath, 'utf8'));

/** 归因链用的"节点 → 捕获"取派生表；同时留下实测表做对账（见 `buildExpectations`） */
function tiersFrom(captures: ReadonlySet<string> | undefined, node: string): Set<string> {
  const tiers = new Set<string>();
  if (captures === undefined) return tiers;
  for (const capture of captures) {
    const tier = tierForCapture(capture, node);
    if (tier !== null) tiers.add(tier);
  }
  return tiers;
}

/** 无期望档位的成因（闭集，便于人话归并打印） */
type GapReason =
  | 'highlights.scm 没给这一节点挂捕获'
  | '挂的捕获在 types.ts 档位表里是表外（结构层根本不涂）'
  | '同一节点挂出多个档位（期望不唯一）'
  | '派生档位与全语料实测档位冲突（两种读法不一致）'
  | '期望档位名在 KOJO_TOKEN_TIERS 里取不到色';

const expectationGapReasons = new Map<string, GapReason>();
const expectationGapDetails = new Map<string, string>();
/** 实测 `(节点, 捕获)` 对里不被派生表覆盖的条数（必须恒 0，否则读表器在漏） */
let observedOutsideDeclared = 0;

function buildExpectations(): void {
  const kindToNode = KIND_TO_NODE as Readonly<Record<string, string>>;
  for (const [node, observed] of capturesByNode) {
    const caps = declared.map.get(node);
    for (const capture of observed) {
      if (caps === undefined || !caps.has(capture)) observedOutsideDeclared += 1;
    }
  }
  for (const kind of Object.keys(kindToNode)) {
    const node = kindToNode[kind]!;
    const declaredCaps = declared.map.get(node);
    const declaredTiers = tiersFrom(declaredCaps, node);
    const observedTiers = tiersFrom(capturesByNode.get(node), node);
    if (declaredCaps === undefined || declaredCaps.size === 0) {
      expectationGapReasons.set(kind, 'highlights.scm 没给这一节点挂捕获');
      expectationGapDetails.set(kind, `节点 ${node}`);
      continue;
    }
    if (declaredTiers.size === 0) {
      expectationGapReasons.set(kind, '挂的捕获在 types.ts 档位表里是表外（结构层根本不涂）');
      expectationGapDetails.set(kind, `节点 ${node} 挂 ${[...declaredCaps].join(', ')}`);
      continue;
    }
    if (declaredTiers.size > 1) {
      expectationGapReasons.set(kind, '同一节点挂出多个档位（期望不唯一）');
      expectationGapDetails.set(kind, `节点 ${node} ⇒ ${[...declaredTiers].join(', ')}`);
      continue;
    }
    if (observedTiers.size === 1 && observedTiers !== declaredTiers && ![...observedTiers].every((t) => declaredTiers.has(t))) {
      expectationGapReasons.set(kind, '派生档位与全语料实测档位冲突（两种读法不一致）');
      expectationGapDetails.set(kind, `节点 ${node}：派生 ${[...declaredTiers].join(', ')} / 实测 ${[...observedTiers].join(', ')}`);
      continue;
    }
    const tier = [...declaredTiers][0]!;
    if (!TIERABLE_TOKENS.has(tier) && tier !== 'comment') {
      expectationGapReasons.set(kind, '期望档位名在 KOJO_TOKEN_TIERS 里取不到色');
      expectationGapDetails.set(kind, `${tier}`);
      continue;
    }
    expectationByKind.set(kind, tier);
  }
}

/** 同族命中口径（与既有 A/B 的"同族子档算一致"同一条尺）。 */
const matches = (token: string | null, expected: string | undefined): boolean =>
  expected !== undefined && token !== null && (token === expected || token.startsWith(`${expected}.`));

/* ==================== 差异格与三桶 ==================== */

type Verdict = '结构层更对' | '词法层更对' | '说不清';

interface DiffCell {
  readonly fixture: string;
  readonly line: number;
  readonly column: number;
  readonly kind: string;
  readonly monarch: string | null;
  readonly structure: string;
  readonly expected: string | undefined;
  readonly paintedNode: string;
  readonly evidence: '自证' | '独立';
  readonly verdict: Verdict;
  readonly strictMonarch: boolean;
  readonly strictStructure: boolean;
  /** 词法层在这一格给的是**作者档位表里登记过**的档（`KOJO_TOKEN_TIERS`），不是 Monaco 基线 token */
  readonly monarchIsAuthorTier: boolean;
  readonly shape: string;
}

const diffCells: DiffCell[] = [];
const cells = { total: 0, same: 0, family: 0, otherTier: 0, monarchBlank: 0, spaceSkipped: 0 };
const perFileCells: Array<{ rel: string; total: number; diffs: number }> = [];
let rebuildFailed = 0;
let childCrashes = 0;
let geometryDrift = 0;
let totalLines = 0;
const kindSeen = new Set<string>();
/**
 * TSIT4-C 取证计数器①：台词串 `string` 跨度**内部**还能捕到几枚别的节点。
 * `highlights.scm` 只能给"CST 里存在的节点"挂捕获 ⇒ 这一枚是"结构层有没有落点登记行内插值"的唯一事实。
 */
let capturesInsideString = 0;
/** TSIT4-C 取证计数器②：语料里 `interpolation` 节点的枚数，以及其中"行首整行形"（`{…}` 独占一行）的枚数 */
let interpolationCells = 0;
let interpolationCellsLineInitial = 0;
/** 取证用的跨度索引：把 `string` 节点按行归桶，只用于"是否真子区间"判定，不作任何判据 */
function indexStringRanges(captures: readonly CstCapture[]): Map<number, Array<[number, number, number, number]>> {
  const byRow = new Map<number, Array<[number, number, number, number]>>();
  for (const c of captures) {
    if (c.node !== 'string') continue;
    for (let row = c.sr; row <= c.er; row++) {
      const list = byRow.get(row) ?? [];
      list.push([c.sr, c.sc, c.er, c.ec]);
      byRow.set(row, list);
    }
  }
  return byRow;
}
/** `x` 的跨度是否是某枚 `string` 跨度的**真子区间**（同点同终点不算内含） */
function insideSomeString(
  strings: ReadonlyMap<number, ReadonlyArray<readonly [number, number, number, number]>>,
  x: { sr: number; sc: number; er: number; ec: number },
): boolean {
  for (let row = x.sr; row <= x.er; row++) {
    for (const [ssr, ssc, ser, sec] of strings.get(row) ?? []) {
      const afterStart = x.sr > ssr || (x.sr === ssr && x.sc > ssc);
      const beforeEnd = x.er < ser || (x.er === ser && x.ec < sec);
      if (afterStart && beforeEnd) return true;
    }
  }
  return false;
}

/** 掩形：≥2 字的 CJK 串折成 `█`（真实口上不整段抄出，见头注"隐私与打印纪律"）。 */
function maskShape(lineText: string): string {
  const trimmed = lineText.trim();
  const capped = trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
  return capped
    .replace(/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\uff66-\uff9f]{2,}/g, '█')
    .replaceAll(' ', '·');
}

let lexer: Awaited<ReturnType<typeof compileMonarch>> | null = null;

beforeAll(async () => {
  lexer = await compileMonarch('kojo-legacy', monarchDef);
  const payloads = new Map<string, ChildPayload>();
  for (const file of fixtures) {
    const payload = runChild(file);
    payloads.set(file, payload);
    if (payload.crashed) childCrashes += 1;
    for (const capture of payload.captures) {
      const set = capturesByNode.get(capture.node) ?? new Set<string>();
      set.add(capture.capture);
      capturesByNode.set(capture.node, set);
    }
  }
  buildExpectations();

  for (const file of fixtures) {
    const rel = relOf(file);
    const text = readFileSync(file, 'utf8');
    const starts = lineStarts(text);
    const lines = splitLines(text);
    const payload = payloads.get(file)!;
    /** TSIT4-C 取证：逐份文件数两件事实——`string` 跨度内部有无其它可捕获节点、`interpolation` 是否只有行首形 */
    const stringsByRow = indexStringRanges(payload.captures);
    for (const capture of payload.captures) {
      if (capture.node === 'interpolation') {
        interpolationCells += 1;
        // "行首形"= 削掉行前空白后从这一行第一格开始（本语法的 token 会把 extras 吞进自己的跨度，
        // 故两侧都要先削空白再比 —— 削法与 `paintTokens` / A/B 同一条口径）
        const row = lines[capture.sr] ?? '';
        let nodeCol = capture.sc;
        let firstCol = 0;
        while (nodeCol < row.length && isSpace(row[nodeCol]!)) nodeCol++;
        while (firstCol < row.length && isSpace(row[firstCol]!)) firstCol++;
        if (nodeCol === firstCol) interpolationCellsLineInitial += 1;
      }
      if (capture.node === 'string') continue;
      if (insideSomeString(stringsByRow, capture)) capturesInsideString += 1;
    }
    const tokens = paintTokens(payload.captures, text, starts);
    const geometry = {
      lineCount: lines.length,
      maxColumn: (lineNumber: number) => (lines[lineNumber - 1]?.length ?? 0) + 1,
    };
    const production = splitStructureTokensToSpans(tokens, geometry).spans;
    const mirrored = spansWithOrigin(tokens, geometry.lineCount, geometry.maxColumn);
    if (mirrored.length !== production.length) geometryDrift += 1;
    for (let i = 0; i < Math.min(mirrored.length, production.length); i++) {
      const m = mirrored[i]!;
      const p = production[i]!;
      if (m.line !== p.line || m.startColumn !== p.startColumn || m.endColumn !== p.endColumn || m.typeIndex !== p.typeIndex) {
        geometryDrift += 1;
        break;
      }
    }
    /** 结构层涂色格：`行\0列 → {tier, node}`（同行重叠留先到的，与 `semantic.ts` 编码同口径） */
    const painted = new Map<string, { tier: string; node: string }>();
    for (const span of mirrored) {
      const tier = LEGEND[span.typeIndex] ?? null;
      if (tier === null) continue;
      const token = tokens[span.tokenIndex]!;
      for (let column = span.startColumn; column < span.endColumn; column++) {
        const key = `${span.line}\u0000${column}`;
        if (!painted.has(key)) painted.set(key, { tier, node: token.node });
      }
    }
    /** 物理行 → 逻辑行（`classifyLine` 只吃逻辑行；折行的续接行归同一条逻辑行） */
    const logicalByRow = new Map<number, ReturnType<typeof splitLogicalLines>[number]>();
    for (const logical of splitLogicalLines(text)) {
      for (let row = logical.line; row <= logical.endLine; row++) {
        if (!logicalByRow.has(row)) logicalByRow.set(row, logical);
      }
    }
    let fileDiffs = 0;
    let fileTotal = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const lineText = lines[i]!;
      if (lineText.length === 0) continue;
      totalLines += 1;
      const emits = driveLexer(lexer, lineText);
      const { cells: monarchCells, ok } = emitCells(emits, lineText);
      if (!ok) rebuildFailed += 1;
      for (let column = 1; column <= lineText.length; column++) {
        const paint = painted.get(`${lineNo}\u0000${column}`);
        if (paint === undefined) continue;
        if (isSpace(lineText[column - 1]!)) {
          cells.spaceSkipped += 1;
          continue;
        }
        cells.total += 1;
        fileTotal += 1;
        const raw = monarchCells[column - 1] ?? null;
        const monarch = raw === null ? null : raw.replace(new RegExp(`\\.${KOJO_LANGUAGE_ID}$`), '');
        const structure = paint.tier;
        if (monarch === null) cells.monarchBlank += 1;
        else if (monarch === structure) cells.same += 1;
        else if (monarch.startsWith(`${structure}.`)) cells.family += 1;
        else cells.otherTier += 1;
        if (monarch !== null && (monarch === structure || monarch.startsWith(`${structure}.`))) continue;
        const logical = logicalByRow.get(lineNo);
        const kind = logical === undefined ? '<无逻辑行>' : classifyLine(logical).kind;
        kindSeen.add(kind);
        const expected = expectationByKind.get(kind);
        const kindNode = (KIND_TO_NODE as Readonly<Record<string, string>>)[kind];
        const evidence = kindNode !== undefined && kindNode === paint.node ? '自证' : '独立';
        const hitMonarch = matches(monarch, expected);
        const hitStructure = matches(structure, expected);
        const verdict: Verdict =
          expected === undefined ? '说不清' : hitStructure && !hitMonarch ? '结构层更对' : hitMonarch && !hitStructure ? '词法层更对' : '说不清';
        fileDiffs += 1;
        diffCells.push({
          fixture: rel,
          line: lineNo,
          column,
          kind,
          monarch,
          structure,
          expected,
          paintedNode: paint.node,
          evidence,
          verdict,
          strictMonarch: monarch !== null && monarch === expected,
          strictStructure: structure === expected,
          monarchIsAuthorTier: monarch !== null && TIERABLE_TOKENS.has(monarch),
          shape: maskShape(lineText),
        });
      }
    }
    perFileCells.push({ rel, total: fileTotal, diffs: fileDiffs });
  }
}, 600_000);

/**
 * 「说不清」桶的预算（**只降不升的棘轮**；两把"谁更对"的桶只报数不钉值）。
 *
 * 取数：2026-10-20，既有 19 份语料 / 与既有 A/B 同一条分母（97,143 内容格、412 差异格）实测 **189 格**，
 * 构成只有一族：`text` 行的台词串内插值（`sugar.interp` 135 + `sugar.interp.delimiter` 54）。
 * 成因不是"没测准"，是**真表没格**——`text_line` 挂 `@none`、`interpolation` 挂 `@string.special`，
 * 两支在 `types.ts` 都是表外 ⇒ 这一行的行档无从谈起，两侧各说各的。
 * 预算就取实测 189（贴线放）：以后哪一批让"说不清"多一格，当场红。
 *
 * **TSIT4-C 取证 + TSIT5 落地（2026-10-20）**：预算仍取实测 **189**（一格没少，判据一条没改）。
 * 构成只有一族：`text` 行的台词串内插值（`sugar.interp` 135 + `sugar.interp.delimiter` 54）。
 * TSIT4-C 当时卡的是"语法层拿不出行内节点"，那条**已经解决**：`string` 拆成
 * 「行首 `「` + 正文段/`interpolation` + `speech_close`」，28 份语料实测行内节点 **27 枚**、
 * 与真源 `scanInterpolations` 的列区间**逐段相同**（见 `packages/kojo-syntax-tree/tests/speech-interpolation-inline.test.ts`）。
 * 这一格降不下去的两条真原因现在都在**宿主与真表**那一侧，实测过、不是推理：
 * - ① **期望档位串不到**：这一族的真源 kind 是 `text`，而 `text_line` 在 `.scm` 里挂 `@none`（表外）
 *   ⇒ 三张真表对 `text` 给不出 E，按本文件的口径这类格子永远归"说不清"，与结构层涂什么无关；
 * - ② **内层落不上屏**：`encodeStructureTokens` 与本文件/A-B 的涂色表都是"同行重叠留先到的"，
 *   父 `string` 的捕获先落位 ⇒ 内层跨度整段被当重叠丢掉。假想登记（`@string.special`→`sugar.interp`）
 *   实测：现行重叠口径下只有那 2 枚行首整行形变 52 格，台词跨度内**一格没变**；要变必须让内层先落位
 *   （可覆盖 207 格 / 丢掉 27 枚内层跨度）。
 * ⇒ 归位剩下的活：宿主的重叠优先级 + 真表对 `text` 的归属，都不在本文件、也不在语法层。
 * 预算就取实测 189（贴线放）：以后哪一批让"说不清"多一格，当场红。
 *
 * ⚠ 分母口径：本文件的语料 = "既有 19 份"，`packages/kojo-syntax-tree/tests` 整棵子树不吃。
 * 若红先看第一行打印的夹具清单——清单变了（新增语料 / 有人把夹具挪进 `fixtures/`）就要重算取数，
 * 与既有 A/B 一样按"分母变大是允许方向、但必须重算并报新数"处置，不许默默抬预算。
 */
const UNRESOLVED_BUDGET = 189;

const BUCKETS: readonly Verdict[] = ['结构层更对', '词法层更对', '说不清'];

function bucketKey(c: DiffCell): string {
  return `${c.kind} | ${c.monarch ?? '<无色>'} ⇄ ${c.structure}`;
}

function topKeys(rows: readonly DiffCell[], limit: number): Array<[string, number, DiffCell]> {
  const counts = new Map<string, DiffCell[]>();
  for (const row of rows) {
    const list = counts.get(bucketKey(row)) ?? [];
    list.push(row);
    counts.set(bucketKey(row), list);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, list]) => [key, list.length, list[0]!]);
}

describe('结构层 ↔ 词法层逐格差异归因（三桶 + 说不清棘轮）', () => {
  it('语料在位、子进程供事实、期望档位串得起来', () => {
    console.log(`\n===== TSIT4-B 归因前置（语料 / 子进程 / 期望档位来源）=====`);
    console.log(`夹具文件数（既有语料） : ${fixtures.length}`);
    for (const file of fixtures) {
      const size = readFileSync(file, 'utf8').length;
      console.log(`  ${String(size).padStart(8)} B  ${relOf(file)}`);
    }
    console.log(`显式排掉的 ${excludedFixtures.length} 份（${relOf(syntaxTestsDir)} 子树 = 语法包自己的测试样本面，含并行批 TSIT4-A 正在新增、尚未进 git 的 coverage-fixtures）:`);
    for (const file of excludedFixtures) console.log(`  排掉 ${String(readFileSync(file, 'utf8').length).padStart(6)} B  ${relOf(file)}`);
    console.log('（注意）既有 A/B 只排掉该子树里的 `tests/fixtures`，coverage-fixtures 会进它的分母 ⇒ 那份文件的 97,143 / 412 两组数随并行批落地而抬，本文件的对账口径以"既有 19 份"为准。');
    console.log(`子进程崩溃（拿不到 JSON）: ${childCrashes}`);
    expect(childCrashes, '子进程没吐出 JSON ⇒ 归因的分母不可信').toBe(0);
    expect(fixtures.length).toBeGreaterThanOrEqual(19);
    console.log(`影子几何 vs 生产几何不一致的文件数: ${geometryDrift}`);
    expect(geometryDrift, 'provenance 影子几何漂了 ⇒ 涂色格↔节点的对应不可信').toBe(0);
    console.log(`highlights.scm 读表：${declared.map.size} 个节点有捕获声明，一行挂多捕获而被跳过的行数 = ${declared.skippedLines}`);
    console.log(`实测 (节点,捕获) 对里不被派生表覆盖的条数: ${observedOutsideDeclared}`);
    expect(observedOutsideDeclared, 'Query 实测到的捕获不在读表结果里 ⇒ 读表器漏了形态，期望档位不可信').toBe(0);
    console.log(`真表串出来的期望档位（kind → 档）: ${expectationByKind.size} 个 kind 有档，${expectationGapReasons.size} 个没有`);
    console.log(`  有档的: ${[...expectationByKind].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}→${v}`).join(', ') || '—'}`);
    const gapByReason = new Map<GapReason, string[]>();
    for (const [kind, reason] of expectationGapReasons) {
      const list = gapByReason.get(reason) ?? [];
      list.push(kind);
      gapByReason.set(reason, list);
    }
    console.log(`  没档的 ${expectationGapReasons.size} 个 kind（这些 kind 上的差异格一律落"说不清"），按成因归并:`);
    for (const [reason, kinds] of [...gapByReason].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    ${String(kinds.length).padStart(3)} 个 · ${reason}`);
      console.log(`        ${kinds.sort().join(', ')}`);
    }
    const gapCellCounts = new Map<string, number>();
    for (const c of diffCells) if (!expectationByKind.has(c.kind)) gapCellCounts.set(c.kind, (gapCellCounts.get(c.kind) ?? 0) + 1);
    console.log(`  真表缺口落到格子上（有差异格又没期望档位的 kind ⇒ 缩小"说不清"只能从这里补真表）: ${[...gapCellCounts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n} 格[${expectationGapReasons.get(k) ?? '?'}｜${expectationGapDetails.get(k) ?? ''}]`).join(' / ') || '—'}`);
    // 节点级覆盖那一格要真的在链上（漏接 = 归因会把 heart_text 判成 keyword 档，白报一堆"结构层更对"）
    expect(tierForCapture('keyword', 'heart_text'), 'heart_text 的节点级覆盖没进归因链').toBe(KOJO_STRUCTURE_NODE_TIERS.keyword!.heart_text);
    expect(expectationByKind.get('heartText')).toBe('sugar.speech');
  });

  it('差异格逐条归因：分桶读数 + 三桶样例（总数仍由既有 A/B 文件管）', () => {
    const diffTotal = cells.otherTier + cells.monarchBlank;
    console.log(`\n===== TSIT4-B 逐格差异归因（同语料、同档位名）=====`);
    console.log(`扫描行总数            : ${totalLines}`);
    console.log(`词法层列区间还原失败  : ${rebuildFailed} 行`);
    console.log(`分母（结构层涂色的内容格）: ${cells.total}`);
    console.log(`  同格同名 ${cells.same} / 同族子档 ${cells.family} / 异档 ${cells.otherTier} / 词法层未着色 ${cells.monarchBlank}`);
    console.log(`  剔出的分隔格 ${cells.spaceSkipped}`);
    console.log(`待归因差异格（异档 + 词法层未着色）: ${diffTotal}（本文件不收进任何比率地板，只分桶）`);
    expect(diffCells.length, '归因吃到的差异格数必须等于本次复算的（异档 + 词法层未着色）').toBe(diffTotal);

    const buckets = BUCKETS.map((verdict) => ({
      verdict,
      rows: diffCells.filter((c) => c.verdict === verdict),
    }));
    for (const b of buckets) {
      const self = b.rows.filter((c) => c.evidence === '自证').length;
      const strict = b.rows.filter((c) => (b.verdict === '结构层更对' ? c.strictStructure : c.strictMonarch)).length;
      const authorTierHits = b.rows.filter((c) => c.monarchIsAuthorTier).length;
      console.log(`\n── ${b.verdict}：${b.rows.length} 格（自证 ${self} / 独立 ${b.rows.length - self}；严格同名 ${strict}）`);
      console.log(`   词法层那一格是作者档位表里登记过的档: ${authorTierHits} 格；其余 ${b.rows.length - authorTierHits} 格词法层给的是基线 token（identifier/number/operator/number.hex）或未着色`);
      const keys = topKeys(b.rows, 8);
      for (const [key, n, sample] of keys) {
        console.log(`   ${String(n).padStart(4)} × ${key}`);
        console.log(`        期望档=${sample.expected ?? '<真表无>'}  涂色节点=${sample.paintedNode}  证据=${sample.evidence}`);
        console.log(`        样例 ${sample.fixture}:${sample.line} 第${sample.column}列｜${sample.shape}`);
      }
      const shownKeys = keys.reduce((s, k) => s + k[1], 0);
      const allKeys = topKeys(b.rows, 10_000).length;
      if (b.rows.length > shownKeys) console.log(`   （另有 ${b.rows.length - shownKeys} 格分散在 ${allKeys - keys.length} 个键上；全键表紧接在下面打印）`);
      const files = new Map<string, number>();
      for (const row of b.rows) files.set(row.fixture, (files.get(row.fixture) ?? 0) + 1);
      console.log(`   集中在文件: ${[...files].sort((a, b2) => b2[1] - a[1]).slice(0, 3).map(([f, n]) => `${n} 格/${f}`).join(' | ') || '—'}`);
    }

    // 全键表（人只能看这个来复核，别只给 top）
    console.log(`\n── 全部键（kind | 词法 ⇄ 结构）：${topKeys(diffCells, 10_000).length} 个`);
    for (const [key, n] of topKeys(diffCells, 10_000)) {
      const verdicts = new Set(diffCells.filter((c) => bucketKey(c) === key).map((c) => c.verdict));
      console.log(`   ${String(n).padStart(4)} × ${key}  ⇒ ${[...verdicts].join('/')}`);
    }

    console.log('\n── 每文件差异格（最多 19 行，只列有差异的）');
    for (const f of perFileCells.filter((x) => x.diffs > 0).sort((a, b) => b.diffs - a.diffs)) {
      console.log(`   ${String(f.diffs).padStart(4)} / ${String(f.total).padStart(6)}  ${f.rel}`);
    }

    console.log('\n── 结构层可疑形（只报不修；判据＝涂色节点既不是本行 kind 的那一支、也不是字面量/容器类节点）');
    const lineNodes = new Set<string>(Object.values(KIND_TO_NODE as Readonly<Record<string, string>>));
    const strays = diffCells.filter((c) => {
      const own = (KIND_TO_NODE as Readonly<Record<string, string>>)[c.kind];
      return own !== undefined && c.paintedNode !== own && lineNodes.has(c.paintedNode);
    });
    const errorNodes = diffCells.filter((c) => c.paintedNode === 'ERROR' || c.paintedNode === 'MISSING');
    const lexicalNodes = diffCells.filter((c) => NON_LINE_NODES.has(c.paintedNode));
    console.log(`   差异格 ${diffCells.length} 格｜由字面量/容器节点涂色（string / interpolation / comment_inline 一类，"比行档更细"的正常面）: ${lexicalNodes.length} 格`);
    console.log(`   由**别的行节点**涂色（色从隔壁行或别族糊过来 ⇒ 这才算"结构层明显更错"的形）: ${strays.length} 格`);
    for (const c of strays.slice(0, 8)) {
      console.log(`     ${c.fixture}:${c.line} 第${c.column}列 kind=${c.kind} 涂色节点=${c.paintedNode} 词法=${c.monarch ?? '<无色>'} 结构=${c.structure} 期望=${c.expected ?? '<真表无>'}｜${c.shape}`);
    }
    console.log(`   由 ERROR / MISSING 节点涂色: ${errorNodes.length} 格${errorNodes.length > 0 ? '（真缺陷：残缺节点不该拿到语义档）' : ''}`);
    for (const c of errorNodes.slice(0, 8)) {
      console.log(`     ${c.fixture}:${c.line} 第${c.column}列 kind=${c.kind} 涂色节点=${c.paintedNode} 词法=${c.monarch ?? '<无色>'} 结构=${c.structure}｜${c.shape}`);
    }

    console.log(`\n── 人话汇总`);
    const nodeMix = (rows: readonly DiffCell[]): string => {
      const m = new Map<string, number>();
      for (const row of rows) m.set(row.paintedNode, (m.get(row.paintedNode) ?? 0) + 1);
      return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / ') || '—';
    };
    for (const verdict of BUCKETS) {
      const rows = diffCells.filter((c) => c.verdict === verdict);
      if (rows.length === 0) {
        console.log(`   ${verdict}：0 格`);
        continue;
      }
      const [key, n] = topKeys(rows, 1)[0]!;
      const self = rows.filter((c) => c.evidence === '自证').length;
      console.log(`   ${verdict}：${rows.length} 格，其中 ${n} 格（${((n / rows.length) * 100).toFixed(0)}%）是同一形「${key}」；涂色节点 ${nodeMix(rows)}；本行捕获自证 ${self} 格 / 独立证据 ${rows.length - self} 格`);
    }
    const overwritten = diffCells.filter((c) => c.monarchIsAuthorTier).length;
    const independent = diffCells.filter((c) => c.verdict === '结构层更对' && c.evidence === '独立').length;
    console.log(`   一句话：这批差异读成"结构层判错"没有证据，读成"结构层判对"同样没有证据——期望档位只能由三张真表串出来，`);
    console.log(`           串得到的 ${expectationByKind.size} 个 kind 全靠结构层自己那一支捕获 ⇒ "结构层更对" ${buckets[0]!.rows.length} 格里独立证据只 ${independent} 格。`);
    console.log(`           开默认的真实代价 = ${overwritten} 格"作者档位表里登记过的档"被整行一档覆盖；其中"说不清" ${buckets[2]!.rows.length} 格全在台词内插值（真表对这一族没有归属）。`);
    console.log(`           TSIT5 实测更新：台词串已不是原子记号——「string」跨度内部现在捕到 ${capturesInsideString} 枚子节点（行内插值），`);
    console.log(`           但这 ${buckets[2]!.rows.length} 格仍归"说不清"，两条原因都不在语法：真表对 kind=text 串不出期望档位（@none 表外），`);
    console.log(`           而宿主的重叠口径是"同行留先到的"（父 string 先落位 ⇒ 内层跨度被丢）。逐条实测数见下面那条取证用例。`);
    console.log(`   合计 ${diffCells.length} 格 = 本次复算的差异格 ${diffTotal} 格；既有 A/B 的 99.58% / 97,143 格由那份文件继续管，这里不重复钉。`);

    // 唯一钉值：说不清只降不升（两把"谁更对"的桶只报数）
    const unresolved = buckets[2]!.rows.length;
    expect(unresolved, `说不清 ${unresolved} 格 > 预算 ${UNRESOLVED_BUDGET} ⇒ 差异解释面在退化`).toBeLessThanOrEqual(UNRESOLVED_BUDGET);
  });

  it('取证：台词行内插值已经有可捕落点——剩下的卡在宿主两处，不在语法', () => {
    const unresolvedRows = diffCells.filter((c) => c.verdict === '说不清');
    const byPaintedNode = new Map<string, number>();
    for (const c of unresolvedRows) byPaintedNode.set(c.paintedNode, (byPaintedNode.get(c.paintedNode) ?? 0) + 1);
    const inInterpFamily = unresolvedRows.filter(
      (c) => c.kind === 'text' && (c.monarch === 'sugar.interp' || c.monarch === 'sugar.interp.delimiter'),
    );
    const inlineNodes = interpolationCells - interpolationCellsLineInitial;
    console.log(`\n===== TSIT4-C / TSIT5 归位取证（"落点在不在"与"登记了能不能翻格"是两件事）=====`);
    console.log(`说不清格总数            : ${unresolvedRows.length}`);
    console.log(`  其中「kind=text 且词法档 ∈ {sugar.interp, sugar.interp.delimiter}」: ${inInterpFamily.length}`);
    console.log(`  按涂色节点分布        : ${[...byPaintedNode].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / ') || '—'}`);
    console.log('（TSIT5 已落地）台词串 `string` 跨度内部捕到的其它节点: ' + `${capturesInsideString} 枚（上一波取数 0）`);
    console.log(`语料里的 ` + '`interpolation`' + ` 捕获        : ${interpolationCells} 枚 = 行首整行形 ${interpolationCellsLineInitial} + 行内 ${inlineNodes}`);
    console.log('结论口径（改到实测为止，判据一条没动）：落点**已经存在**，但"说不清"这一格降不下去，原因有两条、都不在语法层——');
    console.log('  ① 期望档位串不到：这一族的真源 kind 是 `text`，而 `text_line` 挂的是 `@none`（表外）⇒ ' +
      '归因尺对 kind=text 没有 E，按口径只能落"说不清"，与结构层涂什么无关（要动的是真表那三张，不是这把尺）。');
    console.log('  ② 内层落不上屏：生产 `encodeStructureTokens` 与 A/B 的涂色表都是**同行重叠留先到的**，' +
      '而父 `string` 的捕获先落位 ⇒ 内层 `interpolation` 整段被当重叠丢掉。');
    console.log(`     实测（tmp 探针，27 份语料 / 假想把 @string.special 登记成 sugar.interp）：`);
    console.log('       现行重叠口径下变成 sugar.interp 的格子 = 52（全是那 2 枚行首整行形，台词内 0 格）；');
    console.log('       改成"内层优先"可覆盖的格子 = 259（其中台词跨度内 207 格），内层跨度被丢 27 枚。');
    // ① 说不清桶的形状仍是"台词行内的插值"这一族（换了形就红，逼下一批重新取证）
    expect(inInterpFamily.length, `说不清桶里混进了非「text × 插值档」的形（${unresolvedRows.length} 格）⇒ 归因结论过期，须重新取证`).toBe(unresolvedRows.length);
    // ② TSIT5 的事实：台词串内部**有**可捕获的子节点了。这条断言是上一波留的**跳线**——
    //    它红过一次就意味着落点出现；现在按实测反过来钉"只降不升"，退化回原子记号当场红。
    expect(capturesInsideString, '台词串内部捕不到子节点 ⇒ TSIT5 的行内形状退化了（归因尺要的落点又没了）').toBeGreaterThanOrEqual(27);
    // ③ 行内形与行首形分账：行首整行 `{…}` 仍是 2 枚（写形没被顺手改掉），多出来的全是行内。
    expect(interpolationCellsLineInitial, '行首整行形不再是 2 枚 ⇒ `interpolation` 的行级形状漂了').toBe(2);
    expect(inlineNodes, `行内 interpolation ${inlineNodes} 枚 < 棘轮 27 枚`).toBeGreaterThanOrEqual(27);
    // ④ 登记了也不会自动翻格——这条把"还剩什么活"写死成事实：说不清一格没少（口径没改，实测如此）
    expect(unresolvedRows.length, '说不清桶若真的往下走，必须先说清是哪一条口径动了（不许顺手改判定）').toBe(189);
  });

  it('归因没长出第二道总数闸：本文件不判一致率，只报参照', () => {
    const agree = cells.same + cells.family;
    const rate = cells.total === 0 ? 0 : (agree / cells.total) * 100;
    console.log(`\n===== 参照读数（**不判、不钉**；地板在 kojo-ts-vs-monarch-ab.test.ts）=====`);
    console.log(`本次复算逐格一致率    : ${rate.toFixed(2)}%（分母 ${cells.total}）`);
    console.log(`出现过的 kind         : ${kindSeen.size} 种（有期望档位的 ${[...kindSeen].filter((k) => expectationByKind.has(k)).length} 种）`);
    expect(cells.total, '结构层一个格子都没涂 ⇒ 归因没有可比面').toBeGreaterThan(0);
  });
});
