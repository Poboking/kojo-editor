import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { KOJO_LANGUAGE_ID, KOJO_TOKEN_TIERS, registerKojoLanguage } from '../src/monaco/kojo-language';
import { compileMonarch, driveLexer, stubMonaco, type Emit } from './monarch-harness';
import {
  KOJO_STRUCTURE_BASELINE_TOKENS,
  KOJO_STRUCTURE_CAPTURE_TIERS,
  KOJO_STRUCTURE_NODE_TIERS,
  tierForCapture,
} from '../src/monaco/tree-sitter/types';

/**
 * TSIT5：**表外捕获的覆盖面真账**（PITFALLS 141 欠的那三个数，逐支落格）。
 *
 * ## 这份文件回答什么问题
 *
 * `kojo-ts-vs-monarch-ab.test.ts` 的逐格一致率只统计**结构层涂了色的格子** ⇒ 比率再高也只证明
 * "重叠的那一面判得准"，从不证明覆盖面。PITFALLS 141 因此要求验收口径**并列给出**
 * 「涂色行数 / 有档捕获数 / 表外捕获数」三个数。本文件把这三个数**按捕获逐支**摊开：
 * 每一支 `highlights.scm` 的捕获在语料里占多少枚节点、多少格内容、词法层在同一批格子上
 * 实际发的是哪些档（分布，不是判据），并且点名这一支在宿主两张表里**有没有档**。
 *
 * ## 它**不**是什么
 *
 * - 不是第三套 kind→颜色映射：本文件只调生产函数 `tierForCapture`，**不写任何**捕获→档位的
 *   期望表（写了就等于给归因尺加第四张真表，读数立刻零意义——PITFALLS 141 的同族坑）；
 * - 不是第二道一致率闸：比率与 `TOKEN_AB_FLOOR` 仍由既有 A/B 管，本文件连 `99.4` 都不抄；
 * - 不判"谁更对"：三桶归因在 `kojo-ts-ab-attribution.test.ts`。
 *
 * ## 分母口径（刻意与既有 A/B **同一份夹具面**）
 *
 * 递归 `packages` + `fixtures`，只排掉 `packages/kojo-syntax-tree/tests/fixtures`（残缺样本）——
 * 即**不排除**语法包自己的 `tests/coverage-fixtures`，好让本文件的"有档捕获涂色格合计"与既有 A/B
 * 公布的分母逐格对账。词法层侧的削空白 / 空格格剔出 / 逐行拆段与 A/B 逐字同一条口径，
 * 只是每支**单独计**（solo）：一支的格子不与别支抢，故各支格数之和 > 联合涂色面（重叠处重复计），
 * 联合面另由 `registeredJointCells` 给出（那一条才走生产 `tierForCapture` 的先到先得）。
 *
 * ## 为什么 CST 经子进程拿
 *
 * PITFALLS 138：web-tree-sitter 0.27 + Node（Win）同进程解过一次大 `.kojo` ⇒ 退出必 Zone OOM
 * （屏上全过、`rc=3` 的假绿形）。⇒ 本文件（父进程）**零 wasm**，逐份文件复用既有子进程执行体
 * `helpers/tsit4b-attribution-child.ts`（它只供 `(捕获名, 节点名, 行列)` 四元组，不知道"档"这个字），
 * **只认 stdout 的 JSON、不看子进程退出码**。
 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/app/tests
const repoRoot = resolve(here, '..', '..', '..');
const syntaxPkg = join(repoRoot, 'packages', 'kojo-syntax-tree');
const highlightsPath = join(syntaxPkg, 'queries', 'highlights.scm');
/** 与既有 A/B 完全同一排除面：只排残缺样本目录 */
const brokenDir = join(syntaxPkg, 'tests', 'fixtures');
const childPath = join(here, 'helpers', 'tsit4b-attribution-child.ts');

function collect(dir: string, out: string[], exclude: string | null): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (exclude && (p === exclude || p.startsWith(`${exclude}/`) || p.startsWith(`${exclude}\\`))) continue;
    if (e.isDirectory()) collect(p, out, exclude);
    // LAU-3b-FLIP：封存层标准形 `.kojo1` 与盘上未改名的旧 `.kojo` 都在同一批夹具面里
    else if (e.name.endsWith('.kojo1') || e.name.endsWith('.kojo')) out.push(p);
  }
  return out;
}

const fixtures: string[] = [];
for (const top of ['packages', 'fixtures']) collect(join(repoRoot, top), fixtures, brokenDir);
fixtures.sort();
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

/* ==================== 子进程供事实（同归因批那枚执行体，零复制） ==================== */

interface CstCapture {
  readonly capture: string;
  readonly node: string;
  readonly sr: number;
  readonly sc: number;
  readonly er: number;
  readonly ec: number;
}
interface ChildReply {
  file?: string;
  fatal?: string;
  captureNames?: string[];
  nodeTypes?: string[];
  cells?: number[][];
}
function runChild(file: string): { captures: CstCapture[]; crashed: boolean } {
  const r = spawnSync(process.execPath, [childPath, join(syntaxPkg, 'tree-sitter-kojo.wasm'), highlightsPath, file], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const last = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  let reply: ChildReply | null = null;
  try {
    reply = JSON.parse(last) as ChildReply;
  } catch {
    reply = null;
  }
  if (reply === null || reply.fatal !== undefined || !Array.isArray(reply.cells)) {
    return { captures: [], crashed: true };
  }
  const captureNames = reply.captureNames ?? [];
  const nodeTypes = reply.nodeTypes ?? [];
  return {
    captures: reply.cells.map((row) => ({
      capture: captureNames[row[0]!] ?? '',
      node: nodeTypes[row[1]!] ?? '',
      sr: row[2]!,
      sc: row[3]!,
      er: row[4]!,
      ec: row[5]!,
    })),
    crashed: false,
  };
}

/* ==================== 词法层（A 侧，与 A/B 同一套执行机制） ==================== */

const { monaco, captured } = stubMonaco();
registerKojoLanguage(monaco as never);
const monarchDef = captured.monarchs.get('kojo-legacy');
if (!monarchDef) throw new Error('没捕获到 kojo1（kojo-legacy）的 Monarch def（装配面漂 = 本文件整个红）');

function emitCells(emits: readonly Emit[], lineText: string): (string | null)[] {
  const cells: (string | null)[] = new Array<string | null>(lineText.length).fill(null);
  let cursor = 0;
  for (const emit of emits) {
    if (emit.text.length === 0) continue;
    const at = lineText.indexOf(emit.text, cursor);
    if (at < 0) return cells;
    for (let i = at; i < at + emit.text.length; i++) cells[i] = emit.token;
    cursor = at + emit.text.length;
  }
  return cells;
}

/* ==================== 每支捕获的覆盖面账（只供事实） ==================== */

interface CaptureAccount {
  /** 节点枚数（同一支捕获下所有节点类型合计） */
  nodes: number;
  /** 内容格（已削行前空白、已剔空格类分隔格） */
  cells: number;
  /** 被这一支涂到的行（1 基行号去重） */
  lines: Set<number>;
  /** 词法层在同一批格子上的档位分布（剥掉 `.<语言 id>` 后缀（LAU-3 起是 `.kojo-legacy`）；`<未着色>` 单列） */
  lexical: Map<string, number>;
}

const accounts = new Map<string, CaptureAccount>();
/** 同一张账按 `(捕获, 节点类型)` 再摊一遍——节点级表要登记哪一格，只有这一层看得出来 */
const nodeAccounts = new Map<string, CaptureAccount>();
const blankAccount = (): CaptureAccount => ({ nodes: 0, cells: 0, lines: new Set<number>(), lexical: new Map() });
const bump = (account: CaptureAccount, key: string): void => {
  account.lexical.set(key, (account.lexical.get(key) ?? 0) + 1);
};

/** 生产两表里这一支有没有档：**捕获级**有档 ⇒ true；只有节点级有档也算"这支行得通"（另列表）。 */
const captureLevelTier = (capture: string): string | null => KOJO_STRUCTURE_CAPTURE_TIERS[capture] ?? null;
const nodeLevelCaptures = (capture: string): string[] => Object.keys(KOJO_STRUCTURE_NODE_TIERS[capture] ?? {});

/** 联合涂色面（走生产 `tierForCapture` + 同一条"先到先得"）——这一条才是 A/B 的分母本体。 */
let registeredJointCells = 0;
let registeredJointLines = 0;
/** 联合面上"词法层发同一档或同族子档"的格数（参照读数，本文件不拿它判地板） */
let registeredJointAgree = 0;
let lexicalPaintedCellsTotal = 0;
let childCrashes = 0;

beforeAll(async () => {
  const lexer = await compileMonarch('kojo-legacy', monarchDef);
  for (const file of fixtures) {
    const text = readFileSync(file, 'utf8');
    const starts = lineStarts(text);
    const lines = splitLines(text);
    const payload = runChild(file);
    if (payload.crashed) childCrashes += 1;
    /** 词法层逐行格子表（1 基行 → 0 基数组） */
    const lexicalRows = new Map<number, (string | null)[]>();
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]!;
      if (lineText.length === 0) continue;
      lexicalRows.set(i + 1, emitCells(driveLexer(lexer, lineText), lineText));
      for (const token of lexicalRows.get(i + 1)!) if (token !== null) lexicalPaintedCellsTotal += 1;
    }
    /** 联合涂色格（跨支先到先得，与 A/B 的 `painted` 同一条判据） */
    const joint = new Map<string, string>();
    for (const capture of payload.captures) {
      const tier = tierForCapture(capture.capture, capture.node);
      if (tier !== null) {
        let start = starts[capture.sr]! + capture.sc;
        const end = starts[capture.er]! + capture.ec;
        while (start < end && isSpace(text[start]!)) start++;
        if (end <= start) continue;
        const startLine = rowOf(starts, start) + 1;
        const endLine = rowOf(starts, end - 1) + 1;
        for (let line = startLine; line <= endLine; line++) {
          const lineText = lines[line - 1] ?? '';
          const from = line === startLine ? start - starts[line - 1]! : 0;
          const to = line === endLine ? end - 1 - starts[line - 1]! + 1 : lineText.length;
          for (let column = from + 1; column <= Math.min(to, lineText.length); column++) {
            if (isSpace(lineText[column - 1]!)) continue; // 与 A/B 同一条：分隔格不进分母
            joint.set(`${line}\u0000${column}`, tier);
          }
        }
      }
      /** solo：每支单独摊开（不与别支抢格） */
      const account = accounts.get(capture.capture) ?? blankAccount();
      accounts.set(capture.capture, account);
      const nodeKey = `${capture.capture}\u0000${capture.node}`;
      const byNode = nodeAccounts.get(nodeKey) ?? blankAccount();
      nodeAccounts.set(nodeKey, byNode);
      account.nodes += 1;
      byNode.nodes += 1;
      let start = starts[capture.sr]! + capture.sc;
      const end = starts[capture.er]! + capture.ec;
      while (start < end && isSpace(text[start]!)) start++;
      if (end <= start) continue;
      const startLine = rowOf(starts, start) + 1;
      const endLine = rowOf(starts, end - 1) + 1;
      for (let line = startLine; line <= endLine; line++) {
        const lineText = lines[line - 1] ?? '';
        const from = line === startLine ? start - starts[line - 1]! : 0;
        const to = line === endLine ? end - 1 - starts[line - 1]! + 1 : lineText.length;
        const row = lexicalRows.get(line) ?? [];
        for (let column = from + 1; column <= Math.min(to, lineText.length); column++) {
          if (isSpace(lineText[column - 1]!)) continue; // 分隔格不进任何账（同 A/B）
          account.cells += 1;
          account.lines.add(line);
          bump(account, (row[column - 1] ?? '<未着色>').replace(new RegExp(`\\.${KOJO_LANGUAGE_ID}$`), ''));
          byNode.cells += 1;
          byNode.lines.add(line);
          bump(byNode, (row[column - 1] ?? '<未着色>').replace(new RegExp(`\\.${KOJO_LANGUAGE_ID}$`), ''));
        }
      }
    }
    registeredJointCells += joint.size;
    registeredJointLines += new Set([...joint.keys()].map((k) => Number(k.split('\u0000')[0]))).size;
    for (const [key, tier] of joint) {
      const [lineNo, columnNo] = key.split('\u0000');
      const row = lexicalRows.get(Number(lineNo)) ?? [];
      const token = row[Number(columnNo) - 1] ?? null;
      if (token !== null && (token === tier || token.startsWith(`${tier}.`))) registeredJointAgree += 1;
    }  }
}, 600_000);

/** 档位名 → 是否"作者档位表里登记过的档"（终点校验，取现表，不新造） */
const AUTHOR_TIERS = new Set<string>(KOJO_TOKEN_TIERS.flatMap((t) => [...t.tokens]));
const BASELINE_TOKENS = new Set<string>([...KOJO_STRUCTURE_BASELINE_TOKENS]);

function describeLexical(account: CaptureAccount): string {
  return [...account.lexical]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([token, n]) => `${token} ${n}(${((n / account.cells) * 100).toFixed(0)}%)`)
    .join(' / ');
}

describe('表外捕获的覆盖面真账（逐支：节点 / 内容格 / 词法层实际发什么档）', () => {
  it('语料在位、子进程供事实、联合涂色面与既有 A/B 同一条分母', () => {
    console.log(`\n===== TSIT5 覆盖面前置（夹具 / 子进程 / 三数口径）=====`);
    console.log(`夹具文件数            : ${fixtures.length}`);
    console.log(`子进程崩溃            : ${childCrashes}`);
    expect(childCrashes, '子进程没吐出 JSON ⇒ 覆盖面账不可信').toBe(0);
    expect(fixtures.length).toBeGreaterThanOrEqual(19);
    console.log(`词法层涂色格合计（覆盖面参照）: ${lexicalPaintedCellsTotal}`);
    console.log(`结构层联合涂色格（生产两表实跑）: ${registeredJointCells}｜涂色行 ${registeredJointLines}`);
    console.log(`覆盖率（结构格 ÷ 词法格）: ${((registeredJointCells / lexicalPaintedCellsTotal) * 100).toFixed(2)}%`);
  });

  it('逐支账：有档 / 表外 × 节点枚数 × 内容格 × 词法层档位分布（PITFALLS 141 的三个数按支摊开）', () => {
    const rows = [...accounts.entries()].sort((a, b) => b[1].cells - a[1].cells);
    const withTier: string[] = [];
    const withoutTier: string[] = [];
    console.log(`\n===== TSIT5 逐支捕获账（${rows.length} 支，按内容格数降序）=====`);
    for (const [capture, account] of rows) {
      const captureTier = captureLevelTier(capture);
      const nodeTiers = nodeLevelCaptures(capture);
      const registered = captureTier !== null || nodeTiers.length > 0;
      (registered ? withTier : withoutTier).push(capture);
      const authorCells = [...account.lexical].reduce(
        (sum, [token, n]) => sum + (AUTHOR_TIERS.has(token) || BASELINE_TOKENS.has(token) ? n : 0),
        0,
      );
      console.log(
        `  ${registered ? '有档' : '表外'}  @${capture.padEnd(17)} 节点 ${String(account.nodes).padStart(6)}  内容格 ${String(account.cells).padStart(7)}  行 ${String(account.lines.size).padStart(5)}` +
          `｜词法层：${describeLexical(account) || '—'}`,
      );
      if (registered) {
        console.log(
          `        └ 宿主档=${captureTier ?? '（仅节点级）'}${nodeTiers.length > 0 ? ` 节点级=${nodeTiers.join(',')}` : ''}｜这一支里"词法层已发作者档/基线档"的格 ${authorCells}/${account.cells}（${((authorCells / account.cells) * 100).toFixed(0)}%），其余 ${account.cells - authorCells} 格词法层发的是表外名（identifier 一类）`,
        );
      }
    }
    console.log(`\n有档捕获 ${withTier.length} 支: ${withTier.join(', ') || '—'}`);
    console.log(`表外捕获 ${withoutTier.length} 支: ${withoutTier.join(', ') || '—'}`);
    console.log(`三数（PITFALLS 141 验收口径）：涂色行 ${registeredJointLines} · 有档捕获 ${withTier.length} · 表外捕获 ${withoutTier.length}`);
    expect(rows.length, '查询里一支捕获都没有 ⇒ 覆盖面账没东西可对').toBeGreaterThan(0);
  });

  it('节点级账（`KOJO_STRUCTURE_NODE_TIERS` 唯一的取数处）：一枚节点里的档族数 = 整行一档会抹掉几层', () => {
    console.log(`\n===== TSIT5 逐 (捕获 → 节点) 账（按内容格数降序；'档族数' = 词法层在这一跨度里发出的不同档名数）=====`);
    for (const [key, account] of [...nodeAccounts.entries()].sort((a, b) => b[1].cells - a[1].cells)) {
      const [capture, node] = key.split('\u0000');
      if (account.cells === 0) continue;
      const tier = tierForCapture(capture!, node!);
      const distinct = account.lexical.size;
      console.log(
        `  ${(tier === null ? '表外' : `档=${tier}`).padEnd(20)} @${capture!.padEnd(17)} ${node!.padEnd(20)} 节点 ${String(account.nodes).padStart(5)}  格 ${String(account.cells).padStart(6)}  档族数 ${String(distinct).padStart(2)}｜${describeLexical(account)}`,
      );
    }
    expect(nodeAccounts.size).toBeGreaterThan(0);
  });

  it('参照：联合面实测一致格（**不判不钉**，地板在 `kojo-ts-vs-monarch-ab.test.ts`）', () => {
    const rate = registeredJointCells === 0 ? 0 : (registeredJointAgree / registeredJointCells) * 100;
    console.log(
      `\n===== TSIT5 联合面参照（与既有 A/B 同一条分母）=====\n联合涂色格 ${registeredJointCells}｜同档或同族 ${registeredJointAgree}｜参照逐格一致率 ${rate.toFixed(2)}%（本文件不收进地板）`,
    );
    expect(registeredJointCells).toBeGreaterThan(0);
  });

  it('推算（不是判据）：登记后仍表外的每一 (捕获→节点) 若整支登记，代价落在哪几支、多少格', () => {
    let newCells = 0;
    let newAgree = 0;
    const rows: Array<{ capture: string; node: string; cells: number; agree: number; dominant: string }> = [];
    for (const [key, account] of nodeAccounts) {
      const [capture, node] = key.split('\u0000');
      if (tierForCapture(capture!, node!) !== null) continue; // 已登记的节点不在这一面
      if (account.cells === 0) continue;
      let dominant = '<未着色>';
      let dominantCells = 0;
      for (const [token, n] of account.lexical) {
        if (n > dominantCells) {
          dominant = token;
          dominantCells = n;
        }
      }
      let familyCells = 0;
      for (const [token, n] of account.lexical) {
        if (dominant !== '<未着色>' && (token === dominant || token.startsWith(`${dominant}.`))) familyCells += n;
      }
      rows.push({ capture: capture!, node: node!, cells: account.cells, agree: familyCells, dominant });
      newCells += account.cells;
      newAgree += familyCells;
    }
    rows.sort((a, b) => b.cells - a.cells);
    console.log(`\n===== TSIT5 登记后仍表外的那一面，若逐节点整支登记的推算（登记目标取"这一跨度里词法层发得最多的那一档"，共 ${rows.length} 个节点形，前 14 个）=====`);
    for (const row of rows.slice(0, 14)) {
      console.log(
        `  @${row.capture.padEnd(17)} ${row.node.padEnd(20)} 整支登记 ⇒ 新增格 ${String(row.cells).padStart(6)}，其中主导档 ${row.dominant.padEnd(20)} 只认领 ${String(row.agree).padStart(6)}（${((row.agree / row.cells) * 100).toFixed(0)}%）⇒ 失配 ${row.cells - row.agree} 格`,
      );
    }
    if (rows.length > 14) console.log(`  （其余 ${rows.length - 14} 个节点形合计 ${rows.slice(14).reduce((s, r) => s + r.cells, 0)} 格，账在下面这份输出里逐条可见）`);
    const projectedCells = registeredJointCells + newCells;
    const projectedRate = ((registeredJointAgree + newAgree) / projectedCells) * 100;
    console.log(
      `  合计：新增格 ${newCells}（当前联合面 ${registeredJointCells}）⇒ 分母 ${projectedCells}；按"整段 vs 逐词"这一把逐格同名尺推算，一致率 ${projectedRate.toFixed(2)}%（**推算**：solo 账与联合面有重叠，且主导档只是"最可能的登记目标"，不代表该登记）`,
    );
    console.log(
      `  ⇒ 这张表就是"覆盖面"与"逐格同名尺"互相顶死的证据：表外那一面要么按整行登记（比率照上面的推算走），要么由查询侧给出**子记号级捕获**后再逐格比；两者都不做，99.x% 只描述 ${((registeredJointCells / lexicalPaintedCellsTotal) * 100).toFixed(1)}% 的涂色面。`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });

  it('登记面闭合：表里每一支都得在查询里、每一支有档捕获都得真涂到格（不许死映射）', () => {
    const captureNames = [...accounts.keys()];
    for (const capture of Object.keys(KOJO_STRUCTURE_CAPTURE_TIERS)) {
      expect(captureNames, `宿主表登记了 @${capture}，但全语料的查询里捕不到它 ⇒ 死映射`).toContain(capture);
      const account = accounts.get(capture)!;
      expect(account.cells, `@${capture} 有档却涂不到一个格子 ⇒ 假登记`).toBeGreaterThan(0);
    }
    for (const [capture, byNode] of Object.entries(KOJO_STRUCTURE_NODE_TIERS)) {
      for (const nodeType of Object.keys(byNode)) {
        expect(tierForCapture(capture, nodeType), `节点级 ${capture}/${nodeType} 查不到档`).toBe(
          KOJO_STRUCTURE_NODE_TIERS[capture]![nodeType],
        );
      }
    }
    console.log(
      `登记面闭合：捕获级 ${Object.keys(KOJO_STRUCTURE_CAPTURE_TIERS).length} 支、节点级 ${Object.values(KOJO_STRUCTURE_NODE_TIERS).reduce((n, b) => n + Object.keys(b).length, 0)} 格，全部在语料里涂到了格`,
    );
  });

  it('覆盖面棘轮（**只许升不许降**）：表外那一面一旦登记就不许再被删回去', () => {
    const tieredCount = [...accounts.keys()].filter(
      (capture) => captureLevelTier(capture) !== null || nodeLevelCaptures(capture).length > 0,
    ).length;
    console.log(
      `\n===== TSIT5 覆盖面棘轮 =====\n有档捕获数 实测 ${tieredCount} / 地板 ${PAINTED_CAPTURES_FLOOR}｜联合涂色格 实测 ${registeredJointCells} / 地板 ${PAINTED_CELLS_FLOOR}`,
    );
    expect(tieredCount, '有档捕获数跌破棘轮 ⇒ 有人把登记好的覆盖面删回去了').toBeGreaterThanOrEqual(PAINTED_CAPTURES_FLOOR);
    expect(registeredJointCells, '联合涂色格跌破棘轮 ⇒ 结构层涂色面在缩水（覆盖面退化，不是判据变好）').toBeGreaterThanOrEqual(
      PAINTED_CELLS_FLOOR,
    );
  });
});

/**
 * 覆盖面棘轮（**只升不降**；PITFALLS 141 要的"覆盖面这块补成真账"就钉在这里）。
 *
 * 取数：2026-10-20 TSIT5 登记后实测（28 份夹具面、与既有 A/B 同一排除面，联合格与 A/B 分母
 * **逐格对上**：改前两边都是 100,462，登记后本文件与 A/B 同为 104,143–104,177 之间）。
 * - **有档捕获数 5**（`comment` / `string` / `keyword` 三支捕获级 + `keyword.control` /
 *   `keyword.directive` 两支只走节点级）：谁把登记表里的某一支删回表外，当场红；
 * - **联合涂色格地板 103,500**（实测 104,143，留 **643 格 ≈ 0.6%**）：这一面正被同波语法批从底下
 *   动——他们把台词里的 `{…}` 拆成 `interpolation` 子节点时，`string` 的跨度会缩、那几格当场掉出
 *   涂色面（本批两次取数之间已漂过 34 格），0.6% 之内当那条线的噪声；**超出就是有人把登记好的
 *   覆盖面删回去**、或把某支节点级登记改成不涂——那要当场红，不许静默缩水。
 * 地板刻意**不**碰逐格一致率（那条尺子在 `kojo-ts-vs-monarch-ab.test.ts`，本批实测 99.32%
 * 低于它的 99.4 地板 ⇒ 已按纪律报给组长定夺，本文件不替它改线）。
 */
const PAINTED_CAPTURES_FLOOR = 5;
const PAINTED_CELLS_FLOOR = 103_500;
