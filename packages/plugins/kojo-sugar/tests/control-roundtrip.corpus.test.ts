/**
 * **round-trip 对拍**（本批验收本体）：真语料的 ERB 行 → 中文显示形 → 当 `.kojo` 源转译 → 产物。
 *
 * 链路是产品链路，不是测试自造的近似：
 *
 * ```
 * 语料一行 ERB
 *   → renderControlLine(...)   显示层（`native-display/passes.ts`，预览上屏走的就是这条）
 *   → 拼成 `.kojo` 源          写侧（lexer classifyLine → parser 配对 → codegen 发射）
 *   → 产物那一行必须与**原始 ERB 行**逐字节相等
 * ```
 *
 * **比较口径**：语句本体逐字节相等；行首缩进不比——缩进由糖的块层级决定（产物一律 TAB），
 * 比缩进只会把「语句本体对不对」这件事糊掉。三族各取**一整块**（开块 + 体 + 收束），
 * 所以对拍的是配对后的每一行，不是孤立一行——循环族尤其如此：`循环结束` 一条写法要能
 * 落回语料那一枚闭合词（`NEXT` / `WEND` / `REND` / `LOOP`），只有整块转译才验得出来。
 *
 * **循环族按模态取样**（2026-10-17）：盘上真分布 `FOR 3159 / WHILE 248 / REPEAT 89 /
 * DO 210`（`.ERB` 行首记号实测），旧口径「取满 2 块就收」只会从最靠前的文件取到 `FOR`——
 * 「一条 `循环结束` 对四枚闭合词」这条判据名存实亡（实测把下限从 ≥1 收到 ≥2 立刻红：
 * `闭合词只有 NEXT`）。现每种开块模态（`FOR…NEXT` / `WHILE…WEND` / `REPEAT…REND` /
 * `DO…LOOP <式>`）各取至少一块，闭合词集合钉死为四枚。`DO` 族的收束**只收盘上真形
 * `LOOP <表达式>`**（裸 `LOOP` 盘上 0 处；`LOOP 1` 215 处），且表达式必须可恒等——
 * 纪律与 `forIsIdentity` 同一条（不收进样本 ≠ 放宽断言）。写侧 `循环结束 当 <条件>`
 * 由另一条线实现中：`DO` 那条用例在它落地前**预期红**，这是本批缺口的证据，
 * 不许为变绿而注掉取样或放宽逐字节判据。
 *
 * 另两条硬口径：显示层**必须**认得出这一行（返 `null` = 读了但读不懂，不算样本）；
 * 转译**必须**零 error（有 error 的产物不许写盘，等于这条路走不通）。
 * 语料盘整体只读，本文件一个字节都不写它。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { localizeNativeLine } from '../src/native-display/passes';
import { ENGINE_GLOBAL_IDENTIFIERS } from '../src/engine-globals';
import { stubDict, stubFaceTable } from './support';

const SMOKE_DIR = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

/** 跳转 / 数据表两族的下限口径（实测能取到，维持「各至少 2 块」） */
const MIN_PER_FAMILY = 2;
/** 循环族的下限口径：**每种开块模态**各至少 1 块（见文件头：取满即收 = 只验了 FOR 四分之一族） */
const MIN_PER_LOOP_MODE = 1;

/** 一行 ERB → 语句本体（去行首缩进与行尾空白；语料里 TAB / 空格混用，本体才是判据） */
const text = (line: string): string => line.replace(/^[ \t\u3000]+/, '').replace(/\s+$/, '');

const indentOf = (line: string): string => /^[ \t\u3000]*/.exec(line)![0];

/* =========================== 语料取样（只读） =========================== */

interface BlockSample {
  /** 出处（文件名 + 起始行号，失败回执里指得回去） */
  readonly where: string;
  /** 语料里的原始行（含原缩进） */
  readonly lines: readonly string[];
}

/** 循环族的四种开块模态（引擎记号名）；产物闭合词 = `LOOP_CLOSE[模态]` */
type LoopHead = 'FOR' | 'WHILE' | 'REPEAT' | 'DO';
const LOOP_HEADS: readonly LoopHead[] = ['FOR', 'WHILE', 'REPEAT', 'DO'];

interface Corpus {
  /** **按模态**取的真语料整块：`FOR…NEXT` / `WHILE…WEND` / `REPEAT…REND` / `DO…LOOP <式>` */
  readonly loops: Record<LoopHead, BlockSample[]>;
  /** `$标签` 行 + `GOTO 标签名` 行（同文件成对取） */
  readonly jumps: BlockSample[];
  /** `PRINTDATA…` / 条目行 / `ENDDATA`（整块，纯条目） */
  readonly tables: BlockSample[];
}

function erbFiles(root: string, cap: number): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= cap) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (/\.(ERB|ERH)$/i.test(name)) out.push(p);
      if (out.length >= cap) return;
    }
  };
  walk(root);
  return out.sort();
}

/** 行首记号（`FOR` / `NEXT` / `DATAFORM` …；`$标签` 记为 `$`） */
function token(line: string): string {
  const t = text(line);
  if (t.startsWith('$')) return '$';
  return /^[A-Za-z_]+/.exec(t)?.[0] ?? '';
}

const LOOP_CLOSE: Readonly<Record<LoopHead, string>> = { FOR: 'NEXT', WHILE: 'WEND', REPEAT: 'REND', DO: 'LOOP' };

/**
 * `FOR` 逗号形的界限必须都能被表达式降糖**恒等**带走（数字 / 引擎全局白名单名）。
 *
 * 白名单外的裸大写名（`CNT_CHARA` 一类）在本盘是**同文件 `#DIM` 项目全局**
 * （`ERB/ANOTHER_TALK.ERB:78`），按 `engine-globals.ts` 入库判据③明令不收 ⇒ 写侧无解、
 * 不属本族可写形态，取样即排除（不收进样本 ≠ 放宽断言）。
 */
const ENGINE_GLOBAL_SET: ReadonlySet<string> = new Set(ENGINE_GLOBAL_IDENTIFIERS);
function identityOperand(operand: string): boolean {
  return /^-?\d+$/.test(operand) || ENGINE_GLOBAL_SET.has(operand);
}
function forIsIdentity(line: string): boolean {
  const t = text(line);
  // 逗号形写法必须与产物**同一间距口径**（`, ` 单空格）——`FOR LOCAL,1,X` 这类紧凑形
  // 语料合法但产物规范化后不逐字节相等，逐字节判据下不收进样本（≠ 放宽断言）
  if (!/^FOR [^,]+(?:, [^,]+){2,3}$/.test(t)) return false;
  const m = /^FOR\s+[^,]+,\s*(.+)$/.exec(t);
  if (!m) return false;
  return m[1]!.split(',').every((o) => identityOperand(o.trim()));
}

/** `WHILE <左> <比较> <右>`（同样只收可恒等的简单形，且间距与产物口径一致） */
function whileIsIdentity(line: string): boolean {
  const m = /^WHILE ([A-Za-z_][A-Za-z0-9_:]*) (<|>|<=|>=|==|!=) (-?\d+|[A-Za-z_][A-Za-z0-9_]*)$/.exec(text(line));
  if (!m) return false;
  return identityOperand(m[1]!) && identityOperand(m[3]!);
}

/**
 * `REPEAT <圈数>`：圈数必须能被表达式降糖**恒等**带走（数字 / `engine-globals.ts` 白名单名）。
 *
 * 盘上真形是 `REPEAT <数字>`（`REPEAT 5` 23 处 / `REPEAT 100` 10 处），裸 `REPEAT` 0 处；
 * `REPEAT LOCAL:3` / `REPEAT VARSIZE(…)` 这类白名单外形不收进样本 ≠ 放宽断言（口径同 `forIsIdentity`）。
 */
function repeatIsIdentity(line: string): boolean {
  const t = text(line);
  if (t === 'REPEAT') return true;
  const m = /^REPEAT (\S+)$/.exec(t);
  return m !== null && identityOperand(m[1]!);
}

/**
 * `DO` 族的收束：盘上真形只有 `LOOP <表达式>`（裸 `LOOP` 0 处），所以样本必须收带式的形。
 *
 * 可恒等判据与 `whileIsIdentity` 同一条纪律：界限/条件只收**数字**、`engine-globals.ts`
 * 白名单裸名、或 `<标识符> <比较记号> <数字>` 且**间距与产物口径一致**（`LOOP ` 单空格）——
 * `LOOP 1`（盘上 215 处）与 `LOOP <白名单名> <比较> <数字>` 恒等可带走；
 * `LOOP LOCAL < 80`（`LOCAL` 按白名单判据③明令不收）、`LOOP !出口`、`LOOP INRANGE(…)`
 * 一类不收进样本 ≠ 放宽断言。为取到样本去扩白名单或放宽逐字节比较是禁止项。
 */
function loopCloseIsIdentity(line: string): boolean {
  const t = text(line);
  const bare = /^LOOP (\S+)$/.exec(t);
  if (bare !== null && identityOperand(bare[1]!)) return true;
  const cmp = /^LOOP ([A-Za-z_][A-Za-z0-9_:]*) (<|>|<=|>=|==|!=) (-?\d+)$/.exec(t);
  return cmp !== null && identityOperand(cmp[1]!);
}

/**
 * 从**同一份**语料里取一块指定模态的完整循环（开块行 + 一条注释体 + 配对闭合行）。
 *
 * 体刻意用注释占位而不是语料的真实正文：正文行归**其它**能力线（台词 / 赋值 / 调用），
 * 把它们混进本对拍就等于让一条线的回归冒名顶替另一条线。配对则按缩进**真数**嵌套。
 *
 * 头/收束的「可恒等」过滤器按模态套用上面各自的判据——判据外不收进样本 ≠ 放宽断言。
 */
function takeLoop(lines: readonly string[], file: string, head: LoopHead): BlockSample | null {
  const closeWord = LOOP_CLOSE[head];
  const headOk = (l: string): boolean => {
    switch (head) {
      case 'FOR':
        return forIsIdentity(l);
      case 'WHILE':
        return whileIsIdentity(l);
      case 'REPEAT':
        return repeatIsIdentity(l);
      case 'DO':
        return text(l) === 'DO'; // 盘上 `DO` 一律裸形；带体的 `DO …` 形态不认识 ⇒ 不猜
    }
  };
  const closeOk = (l: string): boolean => head !== 'DO' || loopCloseIsIdentity(l);
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i]!;
    if (token(h) !== head || !headOk(h)) continue;
    const want = indentOf(h);
    let depth = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (indentOf(l) !== want) continue;
      const t = token(l);
      if (t === head) depth++;
      else if (t === closeWord && depth === 0) {
        // 配对到的收束不在可恒等判据内（如 `LOOP !出口`）：这一块不收，继续找下一个块头
        if (!closeOk(l)) break;
        return { where: `${head}@${file}:${i + 1}-${j + 1}`, lines: [h, '; 对拍占位（正文归其它能力线）', l] };
      } else if (t === closeWord) depth--;
      else if (/^(IF|SELECTCASE|PRINTDATA|DATALIST|DO|REPEAT|WHILE|FOR|CATCH|TRY)/.test(t)) depth++;
    }
  }
  return null;
}

/** 同一文件里成对取 `$标签` + `GOTO 该名`（语料实测跳转目标**不带** `$`） */
function takeJump(lines: readonly string[], file: string): BlockSample | null {
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i]!;
    if (token(label) !== '$') continue;
    const name = text(label).slice(1).trim();
    if (name.length === 0 || /\s/.test(name)) continue;
    const go = lines.findIndex((l) => text(l) === `GOTO ${name}`);
    if (go < 0) continue;
    return { where: `${file}:${i + 1}+${go + 1}`, lines: [label, `; 对拍占位`, lines[go]!] };
  }
  return null;
}

/** 取一块**纯条目**的数据表（块头 + 全部条目行 + `ENDDATA`；含 `DATALIST` 分组的块不要） */
function takeTable(lines: readonly string[], file: string): BlockSample | null {
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]!;
    if (!/^PRINTDATA[A-Z]*$/.test(text(head))) continue;
    const want = indentOf(head);
    const entries: string[] = [];
    let close = '';
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      const t = text(l);
      if (t.length === 0 || t.startsWith(';')) continue;
      if (indentOf(l) !== want) continue;
      if (/^(DATAFORM|DATA)\s+\S/.test(t)) {
        if (/;/.test(t.replace(/^[A-Z]+\s+/, ''))) break; // 正文带 `;`：显示层会把它当注释剥，不比
        entries.push(l);
        continue;
      }
      if (t === 'ENDDATA') {
        close = l;
        break;
      }
      entries.length = 0;
      break;
    }
    if (close.length > 0 && entries.length > 0) {
      return { where: `${file}:${i + 1}`, lines: [head, ...entries, close] };
    }
  }
  return null;
}

function collectCorpus(root: string): Corpus {
  const loops = {} as Record<LoopHead, BlockSample[]>;
  for (const head of LOOP_HEADS) loops[head] = [];
  const corpus: Corpus = { loops, jumps: [], tables: [] };
  const done = (): boolean =>
    LOOP_HEADS.every((head) => loops[head].length >= MIN_PER_LOOP_MODE) &&
    corpus.jumps.length >= MIN_PER_FAMILY &&
    corpus.tables.length >= MIN_PER_FAMILY;
  for (const path of erbFiles(root, 4000)) {
    if (done()) break;
    let src: string;
    try {
      src = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    } catch {
      continue;
    }
    const lines = src.split('\n');
    const rel = path.slice(root.length + 1);
    for (const head of LOOP_HEADS) {
      if (loops[head].length < MIN_PER_LOOP_MODE) {
        const loop = takeLoop(lines, rel, head);
        if (loop) loops[head].push(loop);
      }
    }
    if (corpus.jumps.length < MIN_PER_FAMILY) {
      const jump = takeJump(lines, rel);
      if (jump) corpus.jumps.push(jump);
    }
    if (corpus.tables.length < MIN_PER_FAMILY) {
      const table = takeTable(lines, rel);
      if (table) corpus.tables.push(table);
    }
  }
  return corpus;
}

/* ======================= 对拍（显示形 → .kojo → 产物） ======================= */

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

/** 一行的中文显示形（认不出 ⇒ 直接判红：这条样本根本没被显示层接管） */
function shown(line: string, where: string): string {
  const body = text(line);
  if (body.startsWith(';')) return body; // 注释行不归显示层，两侧同串
  const out = localizeNativeLine({ content: body, indent: 0 });
  expect(out, `${where}：显示层认不出「${body}」`).not.toBeNull();
  expect(out, where).not.toBe(body);
  return out!;
}

/** 收束行的显示形前缀（dedent 判据）；`循环结束 当 <条件>`（盘上真形 `LOOP <表达式>` 的显示形）不以 `结束` 结尾，只能按块收束词前缀认 */
const CLOSE_ROW_RE = /^(循环结束|数据表结束|出错处理结束)/;

/** 块头 / 收束行 / 其它行的缩进（`.kojo` 源侧一律 TAB，收束行与块头同缩进） */
function layout(rows: readonly string[]): string[] {
  let depth = 0;
  return rows.map((r) => {
    if (CLOSE_ROW_RE.test(r)) depth = Math.max(0, depth - 1);
    const out = '\t'.repeat(1 + depth) + r;
    if (r.endsWith('：') && !CLOSE_ROW_RE.test(r)) depth += 1;
    return out;
  });
}

/** 一个样本 → `.kojo` 源（显示形逐行拼回） */
function toSource(sample: BlockSample): string {
  return `角色: 12\n时机 绝顶：\n${layout(sample.lines.map((l) => shown(l, sample.where))).join('\n')}\n`;
}

/** 产物正文行（去缩进；语句本体就是判据） */
function productLines(erb: string): string[] {
  return erb
    .split('\n')
    .map((l) => l.replace(/^\t+/, ''))
    .filter((l) => l.length > 0);
}

function assertRoundTrip(sample: BlockSample): void {
  const src = toSource(sample);
  const result = svc().transpile(src);
  const errors = result.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}@${d.loc?.line}: ${d.message}`);
  expect(errors, `${sample.where}\n源：\n${src}`).toEqual([]);
  const got = productLines(result.erb);
  for (const original of sample.lines) {
    expect(got, `${sample.where}：产物里没有原始行「${text(original)}」\n产物=${JSON.stringify(got)}`).toContain(text(original));
  }
}

/* ============================================================================ */

/** 每模态反证要换掉的显示形词（词形与 `keywords.ts` 同源）：换错词后产物必须报错，否则对拍断言在比空话 */
const BREAK_WORD: Readonly<Record<LoopHead, readonly [word: string, junk: string]>> = {
  FOR: ['从', '自'], // `循环 计数 <变量> 从 <起> 到 <止>：`
  WHILE: ['当', '弼'], // `循环 当 <条件>：`
  REPEAT: ['次', '遍'], // `循环 <表达式> 次：`（义项 = 按参数指定的次数循环；量词换掉即整块不认）
  DO: ['当', '弼'], // `循环结束 当 <条件>`（盘上真形 `LOOP <表达式>`；写侧在落，本条用例当前预期红）
};

describe.skipIf(!SMOKE_DIR)('round-trip 对拍 · 真语料 ⇄ 中文显示形 ⇄ 写侧产物', () => {
  const corpus = collectCorpus(SMOKE_DIR!);

  it(`取样非空：循环族四模态各至少 ${MIN_PER_LOOP_MODE} 块、跳转 / 数据表各至少 ${MIN_PER_FAMILY} 块`, () => {
    for (const head of LOOP_HEADS) {
      const n = corpus.loops[head].length;
      expect(n, `循环模态 ${head}（${head} … ${LOOP_CLOSE[head]}）只取到 ${n} 块（语料不在位或可恒等判据过窄）`).toBeGreaterThanOrEqual(
        MIN_PER_LOOP_MODE,
      );
    }
    expect(corpus.jumps.length, `跳转只取到 ${corpus.jumps.length} 块（语料不在位或判据过窄）`).toBeGreaterThanOrEqual(MIN_PER_FAMILY);
    expect(corpus.tables.length, `数据表只取到 ${corpus.tables.length} 块（语料不在位或判据过窄）`).toBeGreaterThanOrEqual(MIN_PER_FAMILY);
  });

  for (const head of LOOP_HEADS) {
    it(`循环族 · ${head} → ${LOOP_CLOSE[head]}：整块逐字节回得来 + 反证（换掉显示形词必须报错）`, () => {
      for (const sample of corpus.loops[head]) assertRoundTrip(sample);
      const sample = corpus.loops[head][0]!;
      // 自证（一）：产物里出现的开词与闭合词和原始行**同一串**
      const erb = svc().transpile(toSource(sample)).erb;
      expect(erb, `${sample.where}：产物里没有开块行`).toContain(text(sample.lines[0]!));
      expect(erb, `${sample.where}：产物里没有闭合行`).toContain(text(sample.lines[sample.lines.length - 1]!));
      // 自证（二）：把显示形里的一个词换掉，产物就不再等于原始行（说明断言真的在比那一串）
      const [word, junk] = BREAK_WORD[head];
      const broken = toSource(sample).replace(word, junk);
      expect(
        svc().transpile(broken).diagnostics.some((d) => d.severity === 'error'),
        `${sample.where}：把「${word}」换成「${junk}」后竟无 error——对拍断言可能在比空话`,
      ).toBe(true);
    });
  }

  it('闭合词集合：取样集齐 `NEXT / WEND / REND / LOOP` 四枚（"一条 `循环结束` 对四枚闭合词"钉死在四）', () => {
    const closes = new Set(LOOP_HEADS.flatMap((head) => corpus.loops[head]).map((s) => token(s.lines[s.lines.length - 1]!)));
    expect([...closes].sort().join('/'), `取样闭合词=${[...closes].sort().join('/')}`).toBe('LOOP/NEXT/REND/WEND');
  });

  it('跳转族：`$标签` 定义行与 `GOTO 名` 行逐字节回得来', () => {
    for (const sample of corpus.jumps) assertRoundTrip(sample);
  });

  it('数据表族：`PRINTDATA[…]` + 条目正文 + `ENDDATA` 逐字节回得来（正文不降糖）', () => {
    for (const sample of corpus.tables) assertRoundTrip(sample);
  });
});
