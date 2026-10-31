/**
 * ERB-PAINT-21 · 真语料活闸（lead 2026-10-26）
 *
 * 上一批把内联三元 `\@条件?真#假\@` 做成"整形状一次匹配"，实测**真语料 78.7% 上色**、其余整枚弃涂
 * （段内撞 `%…%` / `{…}` 是最主的一条成因）。本批改成 `str` 态相位机后，判据不能只靠夹具——
 * 夹具里的行是我想出来的，真语料里的形状才是作者写出来的（`docs/PITFALLS.md` 的那条老教训）。
 *
 * 四条硬判据（全部走 **真 Monarch 编译**，与 `erb-highlight.test.ts` 同一基座）：
 * ① **零回退**：真语料每一枚闭合的串内插值（`%…%` / `{…}`）的边界字符，改前出 `string.escape`，
 *    改后必须照旧出 `string.escape`——相位机若把插值吞进段色，这里当场数出违例；
 * ② **涂 ⊆ 认**：每一枚涂出来的 `\@` 开记号列，语义真源 `scanTextTernaries` 必在同一列认得
 *    （反方向允许：真源认得的无 else 残形 / 深过四层的括号，本层取窄不涂）；
 * ③ **覆盖率水位**：`涂出的形状 / 真源认得的形状` ≥ 下面的 `FLOOR`。分母只算**活代码视野**的形
 *    （`erbCodeViewOf` 说 `comment` 的那几枚摘除——注释本就不该有三元着色，拿它进分母是拿"设计上
 *    不涂"充数）。上一批的同款分母实测 0.787（那一批还没摘注释），本批读数随跑随打；
 * ④ **行首 `@"` 不再整行无色**：root 的行首函数规则 `/^(\s*)(@)([^\s(;]+)/` 改前连 `"` 一起吃，
 *    `CALL …,` 折行的实参 `@"…"` 整行成 `entity.name.function`（取样面 22 行）。禁集补 `"` 后这批行
 *    与普通行同进分母，本判据钉住"它们真涂上了"，防后来者顺手把那条规则改回去。
 *
 * 语料不在盘（`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 都没给）⇒ 整组 **SKIP**，不假绿；
 * 走树与取样一律按路径升序 + 固定上限 ⇒ 同机两次读数逐字相同。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerErbLanguage } from '../src/monaco/erb-language';
import { erbCodeViewOf } from '@kojo/plugin-erb-parser';
import { scanTextTernaries } from '@kojo/plugin-condition-extractor';
import { compileMonarch, driveLine, stubMonaco, type CompiledLexer, type Emit } from './monarch-harness';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
/**
 * 成本闸：走树文件上限 / 处理行数上限（只处理含 `\@` 的行）。默认值把本闸留在秒级；
 * 交付收录要**全树**读数时用环境变量抬到全量（`KOJO_PAINT_FILES` / `KOJO_PAINT_LINES`），
 * 判据本身不变，只是取样面变大。
 */
const FILES_CAP = Number(process.env.KOJO_PAINT_FILES) || 1500;
const LINES_CAP = Number(process.env.KOJO_PAINT_LINES) || 4000;
/**
 * 覆盖率水位线。本批实树实测（eraTW 画蛇添足 4.980）＝**默认取样面**（`FILES_CAP=1500` /
 * `LINES_CAP=4000` ⇒ 活形状 1,353 枚）**0.902**；把两枚环境变量抬到全树（`KOJO_PAINT_FILES=4000`
 * / `KOJO_PAINT_LINES=200000` ⇒ 3,971 份 / 9,171 行 / 活形状 8,988 枚）＝ **0.937**。
 * 上一批同一把尺（未摘注释视野、行首 `@"` 那批整行无色也不在账上）＝ 0.787。
 * 水位取默认面实测下浮一档 = 0.88，**只许升不许降**——留的那一档是给"语料目录换了一版"的余量，
 * 不是给后来者放宽字符类的余量。
 */
const FLOOR = 0.88;

interface Boundary {
  readonly col: number;
  readonly ch: string;
  readonly file: string;
  readonly lineNo: number;
  readonly line: string;
}

/**
 * 行首直接压 `@"…"` 的行（`CALL 函数, @"…"…` 的实参折到行首）。改前 root 的**行首函数定义**规则
 * `/^(\s*)(@)([^\s(;]+)/` 连 `"` 一起当名字字符 ⇒ 整行吞成 `entity.name.function`、串层进不去，
 * 那行的插值与三元**一枚色都没有**。本批把 `"` 加进禁集（ERB 函数名不许含引号），这批行照普通行走；
 * ④ 钉住「行首 `@"` 的形状现在必涂」——覆盖率分母里它们从此不再被摘除。
 */
const FORM_HEAD_AT_LINE_START = /^\s*@[^\s]*"/;

/**
 * 没涂上的形状按成因归类（只为**解释水位**，不是判据）：成因名册与
 * `tools/erb-paint-coverage.mjs` 同源，区别是本函数跑在"相位机改造之后"的状态上。
 */
function dropCause(line: string, col: number): string {
  const open = col + 2;
  const q = line.indexOf('?', open);
  const close = q < 0 ? -1 : line.indexOf('\\@', q + 1);
  const body = close < 0 ? line.slice(open) : line.slice(open, close);
  if (/[";]/.test(body) || body.includes('\\')) return body.includes(';') ? 'semicolon' : 'quote-or-backslash';
  if (/%[^"%]*[?#][^"%]*%/.test(body)) return 'pct-holds-bound';
  if ((body.match(/[([{]/g) ?? []).length !== (body.match(/[)\]}]/g) ?? []).length) return 'unbalanced';
  if (/\([^()]*\(/.test(body) || /\[\[[^]]*\]/.test(body)) return 'paren-deep';
  return 'other';
}

interface Stats {
  files: number;
  linesWithAt: number;
  recognized: number;
  painted: number;
  /**
   * 分母里摘掉的"注释视野"形状数。注释整行是 `comment` 档（本来就不该有三元着色，编辑器也不会
   * 给），把它算进分母等于拿"设计上不涂"的形状拉低覆盖率——水位线要防的是**活代码掉色**，
   * 不是"没把死代码涂成彩色"。判据与 `tools/erb-paint-coverage.mjs` 的活语料口径同一把尺：
   * 都用 `erbCodeViewOf` 说 `comment` 来切。
   */
  commentSkipped: number;
  /** 没涂上的成因计数（解释水位线用，不判绿） */
  drops: Map<string, number>;
  /**
   * 行首直接压 `@"…"` 的那几行（`CALL …,` 实参折行；root 的行首函数规则改前把整行吞成
   * `entity.name.function`，串层进不去 ⇒ 无色）。本批禁集里加了 `"`，它们和别的行一样进分母，
   * 这里单列三格给交付收录用，并钉成④的判据：`blank` = **一枚串色都没有**的行数，改前=全部，
   * 改后必须 0（覆盖率那一格留给③，④只守"不再整行无色"这条硬事实）。
   */
  formHead: { lines: number; recognized: number; painted: number; blank: number; blankSamples: Boundary[] };
  /** 成因 = `other` 的样例（最多 5 条），这种落点说明相位机还有洞，必须人工看 */
  otherSamples: Boundary[];
  /** ① 违例：闭合插值的边界字符没出 `string.escape` */
  interpViolations: Boundary[];
  /** ② 违例：涂出的开记号列，真源不认 */
  paintViolations: Boundary[];
}

const { monaco, captured } = stubMonaco();
registerErbLanguage(monaco);

/** 走树（名升序，确定性）；只收 `.ERB/.ERM/.ERH` */
function erbFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(erb|erm|erh)$/i.test(entry.name) && statSync(p).isFile()) out.push(p);
      if (out.length >= FILES_CAP) return;
    }
  };
  walk(root);
  return out.slice(0, FILES_CAP);
}

/**
 * 发射序列 → 列坐标表：直接用基座（ERB-PAINT-21 同批）带出的 `start`。
 * 按累计长度或 `indexOf` 反推都不可靠——真实 lexer 与基座一样，**没规则命中的字符不发射任何
 * token**（`PRINTL "…"` 里那枚空格就没有），反推会在有跳字的行上整段漂移：实测在
 * `fromEN/QOL/QoL_DetailedInfo.ERB:361` 上造出一枚**假**违例（真源认 134/276，反推报 274/334）。
 */
function tokenAt(emitted: readonly Emit[]): (col: number) => string {
  const spans = emitted
    .filter((e) => typeof e.start === 'number')
    .map((e) => ({ from: e.start as number, to: (e.start as number) + e.text.length, token: e.token }));
  return (col: number): string => spans.find((s) => col >= s.from && col < s.to)?.token ?? '';
}

/**
 * 行内**闭合的串内插值边界**（分母）。口径 = `str` 态 ④⑤ 两条开层规则的口径：
 * `%…%` 只在串内配对（离开串即丢弃未配对的开记号）、`{…}` 同理给一层（不与三元段混算）。
 * 这是判据的分母定义，与 `erbInterpRegionAt`（补全面的"区内光标"判据）互不替代——
 * 两者的一致性由 `tests/erb-interp-single-source.test.ts` 兜，本闸只数边界字符的档位。
 */
function interpBoundaries(line: string): { col: number; ch: string }[] {
  const out: { col: number; ch: string }[] = [];
  let pctOpen = -1;
  let braceOpen = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const inString = erbCodeViewOf(line, i) === 'string';
    if (!inString) {
      pctOpen = -1;
      braceOpen = -1;
      continue;
    }
    if (ch === '%') {
      if (pctOpen < 0) pctOpen = i;
      else {
        out.push({ col: pctOpen, ch: '%' }, { col: i, ch: '%' });
        pctOpen = -1;
      }
    } else if (ch === '{' && braceOpen < 0) {
      braceOpen = i;
    } else if (ch === '}' && braceOpen >= 0) {
      out.push({ col: braceOpen, ch: '{' }, { col: i, ch: '}' });
      braceOpen = -1;
    }
  }
  return out;
}

/**
 * 涂出的 `\@` **开**记号列。列坐标直接取驱动器带出的 `start`（ERB-PAINT-21 同批给基座补的字段）——
 * 用 `indexOf` 反推在"有字符没规则命中、不发射 token"的行上会整段漂移，实测就在
 * `fromEN/QOL/QoL_DetailedInfo.ERB:361` 上造出一枚假违例（真源认 134/276，反推却说 274/334）。
 *
 * 一开一闭必然成对相邻 ⇒ 取序列的偶数位就是开记号（相位机只在一枚完整形状里发 `\@::escape`，
 * 未成形的 `\@` 走 ① 普通转义、不发 escape ⇒ 不会混进这个序列）。
 */
function paintedOpeners(emitted: readonly Emit[]): number[] {
  const hits = emitted
    .filter((e) => e.text === '\\@' && e.token.startsWith('string.escape'))
    .map((e) => e.start ?? -1);
  return hits.filter((_col, idx) => idx % 2 === 0);
}

describe.skipIf(!SMOKE)('ERB-PAINT-21 · 真语料：插值零回退 + 涂⊆认 + 覆盖率水位', () => {
  let lexer: CompiledLexer;
  let stats: Stats;

  beforeAll(async () => {
    const root = join(SMOKE!, 'ERB');
    expect(existsSync(root), `语料在项目根下没有 ERB/ 目录：${root}`).toBe(true);
    const def = captured.monarchs.get('kojo-erb');
    if (!def) throw new Error('monaco 桩没捕获到 kojo-erb 的 Monarch def');
    lexer = await compileMonarch('kojo-erb', def);

    stats = {
      files: 0,
      linesWithAt: 0,
      recognized: 0,
      painted: 0,
      formHead: { lines: 0, recognized: 0, painted: 0, blank: 0, blankSamples: [] },
      commentSkipped: 0,
      drops: new Map(),
      otherSamples: [],
      interpViolations: [],
      paintViolations: [],
    };
    for (const file of erbFiles(root)) {
      if (stats.linesWithAt >= LINES_CAP) break;
      stats.files++;
      const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const rel = file.slice(root.length + 1).replace(/\\/g, '/');
      let lineNo = 0;
      for (const line of text.split(/\r?\n/)) {
        lineNo++;
        if (!line.includes('\\@')) continue;
        if (stats.linesWithAt >= LINES_CAP) break;
        stats.linesWithAt++;
        const allHere = scanTextTernaries(line);
        const recognizedHere = allHere.filter((c) => erbCodeViewOf(line, c.column) !== 'comment');
        stats.commentSkipped += allHere.length - recognizedHere.length;
        stats.recognized += recognizedHere.length;
        const emitted = driveLine(lexer, line).emitted;
        const openers = paintedOpeners(emitted);
        stats.painted += openers.length;
        if (FORM_HEAD_AT_LINE_START.test(line)) {
          stats.formHead.lines++;
          stats.formHead.recognized += recognizedHere.length;
          stats.formHead.painted += openers.length;
          if (!emitted.some((e) => e.token.startsWith('string'))) {
            stats.formHead.blank++;
            if (stats.formHead.blankSamples.length < 3) {
              stats.formHead.blankSamples.push({ col: 0, ch: '@"', file: rel, lineNo, line });
            }
          }
        }
        const paintedSet = new Set(openers);
        for (const c of recognizedHere) {
          if (paintedSet.has(c.column)) continue;
          const cause = dropCause(line, c.column);
          stats.drops.set(cause, (stats.drops.get(cause) ?? 0) + 1);
          if (cause === 'other' && stats.otherSamples.length < 5) {
            stats.otherSamples.push({ col: c.column, ch: '\\@', file: rel, lineNo, line });
          }
        }
        const at = tokenAt(emitted);
        // ① 插值边界零回退
        for (const b of interpBoundaries(line)) {
          if (!at(b.col).startsWith('string.escape')) {
            stats.interpViolations.push({ ...b, file: rel, lineNo, line });
          }
        }
        // ② 涂 ⊆ 认
        const known = new Set(recognizedHere.map((c) => c.column));
        for (const col of openers) {
          if (!known.has(col)) stats.paintViolations.push({ col, ch: '\\@', file: rel, lineNo, line });
        }
      }
    }
    const rate = stats.painted / Math.max(1, stats.recognized);
    console.log(
      `[erb-ternary-paint] 文件 ${stats.files} / 含 \\@ 行 ${stats.linesWithAt} / 行首 @" 行 ${stats.formHead.lines}（认 ${stats.formHead.recognized} 涂 ${stats.formHead.painted} 整行无色 ${stats.formHead.blank}）` +
        ` / 注释视野摘除 ${stats.commentSkipped}` +
        ` / 真源认 ${stats.recognized} / 涂出 ${stats.painted} ⇒ 覆盖率 ${rate.toFixed(3)}（水位 ${FLOOR}）` +
        ` / 插值边界违例 ${stats.interpViolations.length} / 涂⊄认违例 ${stats.paintViolations.length}` +
        ` / 未涂成因 ${[...stats.drops.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ')}`,
    );
    for (const s of stats.otherSamples) {
      console.log(`[erb-ternary-paint] OTHER ${s.file}:${s.lineNo} 列 ${s.col} ${s.line.slice(0, 160)}`);
    }
  }, 240_000);

  it('① 闭合插值的边界字符照样出 string.escape（相位机没吞掉既有插值着色）', () => {
    const first = stats.interpViolations[0];
    expect(
      stats.interpViolations.length,
      first ? `首枚违例 ${first.file}:${first.lineNo} 列 ${first.col}「${first.ch}」实发行：${first.line.slice(0, 120)}` : '',
    ).toBe(0);
  });

  it('② 涂出的每一枚开记号，真源 scanTextTernaries 必在同一列认得（涂 ⊆ 认）', () => {
    const first = stats.paintViolations[0];
    expect(
      stats.paintViolations.length,
      first ? `首枚违例 ${first.file}:${first.lineNo} 列 ${first.col}：${first.line.slice(0, 120)}` : '',
    ).toBe(0);
  });

  it('③ 覆盖率不低于水位线（上一批同分母 = 0.787）', () => {
    const rate = stats.painted / Math.max(1, stats.recognized);
    expect(rate, `覆盖率跌到 ${rate.toFixed(3)}（水位 ${FLOOR}）；读数见上面的 [erb-ternary-paint] 行`).toBeGreaterThanOrEqual(FLOOR);
  });

  it('④ 行首直接压 `@"…"` 的那批行不再整行无色（root 函数规则禁集加了 `"`）', () => {
    expect(stats.formHead.lines, '取样面里一行"行首 @\" 的行"都没抓到 ⇒ 分母口径漂了，本判据失去意义').toBeGreaterThan(0);
    const first = stats.formHead.blankSamples[0];
    expect(
      stats.formHead.blank,
      first
        ? `${stats.formHead.blank} 行行首 @" 仍一枚串色都没有，首行 ${first.file}:${first.lineNo}：${first.line.slice(0, 140)}`
        : `${stats.formHead.blank} 行`,
    ).toBe(0);
  });
});
