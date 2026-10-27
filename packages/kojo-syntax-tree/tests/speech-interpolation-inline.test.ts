import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Node, Parser } from 'web-tree-sitter';
// 真源**行内**列区间——转译侧唯一一枚"这一段是插值"的判官。深 import 插件 src 走的是本仓既有
// 测试面（`packages/app/tests/kojo-ts-vs-monarch-ab.test.ts` 深 import `src/folding` 同一条路）；
// **grammar.js 与 src/ 生产码一律不吃插件**（铁律 2），这条 import 只住在测试里。
import { scanInterpolations } from '../../plugins/kojo-sugar/src/lexer';
import { createParser } from '../src/index';

/**
 * 台词行**内层插值**成节点的闸（TSIT5）。
 *
 * ## 这个文件钉的是哪件事实
 *
 * `classifyLine` 只有整行 kind、没有行内概念，而转译真源 `lexer.ts::scanInterpolations` **有行内列
 * 区间**。上一波（TSIT4-C）取证的硬事实：台词串在 CST 里是一枚原子记号
 * 「string = token(prec(5, /「[^\n]*[」\\\\]/))」，跨度内部可捕节点 **0 枚** ⇒ `highlights.scm`
 * 没有任何可写的落点，"结构层认不出台词里的插值"这一格差异**无法只靠宿主登记表解决**。
 * 本文件钉的就是这一包的正成果：**行内 `{…}` 现在是真节点，且列区间与真源逐段相同**。
 *
 * ## 形状（`grammar.js` 的 `string`）
 *
 * 「」＋（正文段 / `interpolation`）＊＋ `speech_close`。行内插值**复用既有节点名**
 * `interpolation`（`alias($._speech_interpolation, $.interpolation)`）⇒
 * `queries/highlights.scm` 里那条既有捕获「(interpolation) @string.special」零改动就捕到它：
 * 本波**没有新增捕获名**，也没有动任何既有捕获（同波 B 依赖其稳定性）。
 *
 * ## 为什么"逐段相同"要由真源判、而不是抄一张表
 *
 * 插值写形只有 ASCII 括号 `{`/`}`：它**不是词形**，`word-forms.json` 那张投影面只投影
 * `keywords.ts` / `statement-functions.ts` 的词，里面没有它；真源侧也没有可导出的常量
 * （`lexer.ts` 把 `{`/`}` 写死在 `scanInterpolations` 内部，而 lexer 是第一真源、本包只读）。
 * ⇒ 单源约束在这一格能成立的**唯一形态是行为对账**：同一行喂给真源扫描器与 CST，逐段比列区间。
 * 于是本文件不新增词表、不在 grammar 里硬编中文词，只做对账——真源哪天改了写形或区间口径，
 * 这里当场红（比"表抄对了"强：抄本对上的是字，对账对上的是行为）。
 *
 * ## 口径（三条，一条不含糊）
 *
 * - 语料与取数规则同 `cst-classifyline-parity.test.ts`：`packages` + `fixtures` 递归、跳
 *   `node_modules`、排除 `tests/fixtures/` 那批故意残缺样本；
 * - 真源列是"剥掉行首缩进后的 1 基列" ⇒ 折回文档绝对偏移：行首偏移 + 缩进长度 + (column − 1)；
 *   只对账**单个物理行**的台词行（以 `\` 折行的那种两侧坐标系不同，单列计数、不混进分母）；
 * - 只比落在某枚 `string` 跨度**之内**的真源段（台词外的插值不归本形状管，另行报数）。
 *
 * ## 第三条用例钉"跨度一格没动"
 *
 * 拆内层的唯一硬条件是行节点的起止不变（否则 A/B 的涂色格会跟着漂）。这里逐枚复算旧原子写形
 * 「/「[^\n]*[」\\\\]/」在本行的命中区间，与 CST 的 `string` 节点比对——**不等就红**。
 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/kojo-syntax-tree/tests
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const wasmPath = join(pkgRoot, 'tree-sitter-kojo.wasm');
const BROKEN_DIR = join(pkgRoot, 'tests', 'fixtures');

/** 与 `tools/parse-corpus.mjs` / 对照闸同一份发现规则。 */
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
for (const top of ['packages', 'fixtures']) collect(join(repoRoot, top), fixtures, BROKEN_DIR);
fixtures.sort();
const relOf = (file: string): string => file.slice(repoRoot.length + 1).replaceAll('\\', '/');

const isHSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\u3000' || ch === '\f';

/** 一枚真源插值段 / 一枚 CST 行内节点，都用**文档绝对码元偏移**表示（左闭右开）。 */
interface Seg {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/** 一行台词的两侧事实（CST 的 `string` 节点 + 它的行内节点 + 真源在同跨度内的段）。 */
interface SpeechLine {
  readonly rel: string;
  readonly row: number;
  readonly from: number;
  readonly to: number;
  readonly nodeText: string;
  readonly inner: readonly Seg[];
  readonly truth: readonly Seg[];
  /** 以 `\` 折行的台词：两侧列坐标系不同 ⇒ 不参与逐段对账 */
  readonly folded: boolean;
}

const lines: SpeechLine[] = [];
/** 文件原文缓存（最后一枚用例要逐枚复算旧原子写形，不重复读盘） */
const texts = new Map<string, string>();
/** `string` 的具名子节点里，除插值之外出现过的名字（应当只有收束记号） */
const otherNamedChildren = new Set<string>();
let truthOutsideSpeech = 0;
let fileCount = 0;

/** 真源行内段：逐物理行喂 `scanInterpolations`（口径与转译器调用处一致：剥行首缩进、剥行尾空白）。 */
function truthOfLine(lineText: string, lineStart: number): Seg[] {
  let indent = 0;
  while (isHSpace(lineText[indent])) indent++;
  const content = lineText.slice(indent).replace(/\s+$/, '');
  if (content.length === 0) return [];
  type Sink = Parameters<typeof scanInterpolations>[2];
  const sink = { report: (): void => {}, all: () => [] } as unknown as Sink;
  const base = lineStart + indent;
  return scanInterpolations(content, 1, sink).map((s) => ({
    from: base + s.loc.start.column - 1,
    to: base + s.loc.end.column - 1,
    text: content.slice(s.loc.start.column - 1, s.loc.end.column - 1),
  }));
}

/** 走树收集 `string` 节点与其行内 `interpolation` 子节点（容器表复刻 `src/index.ts`，避免循环依赖）。 */
function collectSpeechLines(root: Node, text: string, rel: string): SpeechLine[] {
  const CONTAINERS = new Set(['source_file', 'block', 'item_block', 'block_body', 'switch_body', 'choice_body', 'when_body']);
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const out: SpeechLine[] = [];
  const walk = (node: Node): void => {
    if (node.type === 'string') {
      const inner: Seg[] = [];
      for (const c of node.namedChildren) {
        if (c.type === 'interpolation') inner.push({ from: c.startIndex, to: c.endIndex, text: c.text });
        else otherNamedChildren.add(c.type);
      }
      const row = node.startPosition.row;
      const lineText = text.slice(lineStarts[row] ?? 0, lineStarts[row + 1] ?? text.length + 1).replace(/\n$/, '');
      const truthAll = truthOfLine(lineText, lineStarts[row] ?? 0);
      const truth = truthAll.filter((s) => s.from >= node.startIndex && s.to <= node.endIndex);
      truthOutsideSpeech += truthAll.length - truth.length;
      out.push({
        rel,
        row,
        from: node.startIndex,
        to: node.endIndex,
        nodeText: node.text,
        inner,
        truth,
        // 以 `\` 收尾＝折行续接：真源给的是"合并后逻辑行"的列，与物理列不同坐标系 ⇒ 不对账
        folded: node.text.endsWith('\\'),
      });
      return;
    }
    if (CONTAINERS.has(node.type)) for (const c of node.namedChildren) walk(c);
  };
  walk(root);
  return out;
}

describe('台词行内插值成可捕节点（TSIT5）', () => {
  beforeAll(async () => {
    const parser: Parser = await createParser(wasmPath);
    for (const file of fixtures) {
      const rel = relOf(file);
      const text = readFileSync(file, 'utf8');
      texts.set(rel, text);
      const tree = parser.parse(text);
      if (tree === null) throw new Error(`解析器没有产出树：${rel}`);
      lines.push(...collectSpeechLines(tree.rootNode, text, rel));
      tree.delete();
      fileCount += 1;
    }
  }, 240_000);

  it('语料在位（分母 = 同一批 28 份语料）', () => {
    console.log(`\n===== ⑤ 台词行内插值（TSIT5 正成果）=====`);
    console.log(`语料文件数            : ${fileCount}`);
    console.log(`台词行（string）枚数  : ${lines.length}`);
    expect(fileCount, '语料发现面漂了 ⇒ 下面的枚数读数不可比').toBeGreaterThanOrEqual(28);
    expect(lines.length).toBeGreaterThan(1000);
  });

  it('行内插值真的成节点：枚数只降不升（上一波实测 0 枚）', () => {
    const withInner = lines.filter((l) => l.inner.length > 0);
    const innerNodes = withInner.reduce((n, l) => n + l.inner.length, 0);
    console.log(`带行内节点的台词行    : ${withInner.length}`);
    console.log(`行内 interpolation 枚数: ${innerNodes}   ← 上一波取数 0（原子记号跨度内无可捕节点）`);
    console.log(`string 里除插值外的具名子节点: ${[...otherNamedChildren].join(', ') || '（无）'}`);
    const byFile = new Map<string, number>();
    for (const l of withInner) byFile.set(l.rel, (byFile.get(l.rel) ?? 0) + l.inner.length);
    for (const [rel, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)} 枚  ${rel}`);
    // 断言 1（本包的正面成果数，棘轮取 2026-10-20 实测 27 枚）
    expect(innerNodes, '台词行内节点为 0 ⇒ `string` 又退回原子记号，归因尺要的落点没了').toBeGreaterThan(0);
    expect(innerNodes, `行内节点 ${innerNodes} 枚 < 棘轮 27 枚 ⇒ 台词内层形状退化`).toBeGreaterThanOrEqual(27);
    // 断言 2：台词内部的具名子节点只有插值与收束记号（别把行级形状塞进台词里）
    for (const name of otherNamedChildren) {
      expect(name === 'speech_close', `台词行内出现预期外的具名子节点 ${name}`).toBe(true);
    }
  });

  it('列区间与真源逐段相同（写形靠行为对账钉住，不抄第二份表）', () => {
    const comparable = lines.filter((l) => !l.folded && (l.inner.length > 0 || l.truth.length > 0));
    let equal = 0;
    let onlyTruth = 0;
    let onlyCst = 0;
    const diffs: string[] = [];
    for (const l of comparable) {
      const n = Math.min(l.truth.length, l.inner.length);
      for (let i = 0; i < n; i++) {
        const t = l.truth[i]!;
        const c = l.inner[i]!;
        if (t.from === c.from && t.to === c.to) equal += 1;
        else diffs.push(`${l.rel}:${l.row + 1} 真源 ${t.from}..${t.to} ${JSON.stringify(t.text.slice(0, 30))} ⇄ CST ${c.from}..${c.to} ${JSON.stringify(c.text.slice(0, 30))}`);
      }
      onlyTruth += Math.max(0, l.truth.length - l.inner.length);
      onlyCst += Math.max(0, l.inner.length - l.truth.length);
    }
    console.log(`\n===== 真源对账（scanInterpolations ⇄ CST 行内节点）=====`);
    console.log(`参与对账的台词行      : ${comparable.length}（折行跳过 ${lines.filter((l) => l.folded).length} 行）`);
    console.log(`逐段列区间相等        : ${equal}`);
    console.log(`只在真源 / 只在 CST  : ${onlyTruth} / ${onlyCst}`);
    console.log(`台词跨度之外的真源段 : ${truthOutsideSpeech}（行首整行 {…} 与旁白里的插值，不归本形状管）`);
    for (const d of diffs.slice(0, 20)) console.log(`  !! ${d}`);
    expect(onlyTruth, '真源在台词跨度内认出的插值段没有对应节点 ⇒ 语法写形比真源窄').toBe(0);
    expect(onlyCst, 'CST 出了行内节点而真源不认 ⇒ 语法写形比真源宽（会涂真源不认为是插值的格子）').toBe(0);
    expect(diffs, '两侧都认但列区间不等 ⇒ 起止漂格，宿主按列上色就会错一格').toEqual([]);
  });

  it('台词节点的起止与旧原子记号逐格相同（涂色面一格没动）', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const l of lines) {
      const text = texts.get(l.rel) ?? '';
      // 旧写形：行首 `「`，同一物理行内以最后一枚 `」` 或 `\` 收尾
      let base = l.from;
      while (isHSpace(text[base])) base++;
      const old = /^「[^\n]*[」\\]/.exec(text.slice(base));
      checked += 1;
      if (old === null) {
        bad.push(`${l.rel}:${l.row + 1} 旧原子写形没命中而 CST 出了 string 节点｜${JSON.stringify(l.nodeText.slice(0, 40))}`);
        continue;
      }
      if (base + old[0].length !== l.to) {
        bad.push(`${l.rel}:${l.row + 1} 终点漂了：旧形 ${base + old[0].length} ⇄ CST ${l.to}｜${JSON.stringify(old[0].slice(0, 40))}`);
      }
    }
    console.log(`\n===== 跨度不变性（逐枚复算旧原子写形）=====`);
    console.log(`复算台词行            : ${checked}`);
    console.log(`与旧形不等            : ${bad.length}`);
    for (const b of bad.slice(0, 20)) console.log(`  !! ${b}`);
    expect(bad, '台词节点的起止与旧原子记号不同 ⇒ A/B 的涂色格会跟着漂（本波口径：一格都不许多不许少）').toEqual([]);
  });
});
