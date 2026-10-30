/**
 * W7-G 字符分类缓存 —— **新旧路径逐条等价**差分对拍（2026-10-20 着色腿归因批）。
 *
 * 背景：5,000 行合成 ERB 的单次 `scanFileRefs` 读数 median 31.6 ms，逐段归因
 * 25.7 ms 花在 `IDENT_ONE.test`（`\p{L}`/`\p{N}` 的 `/u` 正则）对每个非 ASCII 码元
 * 各跑一次——正文里 CJK 字符有 13.7 万个。分类只取决于码点本身，所以本批在
 * `references.ts` 里按码元（BMP，含落单代理项）与码点（代理对）各缓存一次，并在
 * `forEachToken` 里顺带记下"这段记号含不含 `[a-zａ-ｚ]`"，让无小写的记号跳过
 * `toUpperCase` 那一遍全文扫描。**判据一个都没换**：命中的 `2 / 1 / 0` 仍是
 * `IDENT_ONE` 现算的值，`normalizedUpper` 仍是唯一的归一真源。
 *
 * 本文件把**改前的实现原样封存**（`scanFileRefsNoCache` / `scanUndefinedCallTargetsNoCache`，
 * 即 PS-3 的 charCodeAt 走位版，逐行拷贝），在以下输入上与现实现**逐条**对拍：
 * - 600 份对抗性随机文本（固定种子，与 `refs-fastpath-equiv.test.ts` 的种子不同）；
 * - 5,000 行合成 ERB + 110,194 条名录（与 `semantic-tokens.perf.test.ts` 同一体量）；
 * - 同一文本不同名录（缓存只许记字符分类，不许记名字命中）；
 * - 多文本交替（跨文本复用缓存不串味）；
 * - 代理对 / 落单代理项**两种到达顺序**（各自起全新模块实例，冷缓存顺序也被覆盖）。
 *
 * 与正则原版（`refs-fastpath-equiv.test.ts` 的 `*Old`）的关系：那条对拍证明
 * "charCodeAt 版 == 正则版"，本条证明"缓存版 == charCodeAt 版"，两段合起来即
 * "缓存版 == 正则版"（传递），且 `references.test.ts` / 语料朴素对拍仍在原位。
 */

import { describe, expect, it, vi } from 'vitest';
import { MODEL_TOKEN_CLASS } from '@kojo/plugin-api';
import { normalizedUpper, scanFileRefs as scanFileRefsRaw, scanUndefinedCallTargets } from '../src/references';
import { unflattenRefs } from './support';

/**
 * 本文件里的 `scanFileRefs` 一律是**四元组视图**：封存的旧实现（`scanFileRefsNoCache` /
 * `scanFileRefsOld`）产出的是「一条一枚四元组」，而生产侧自 MEM-7 起是扁平流水
 * （步长 `REF_STRIDE`）。不摊平就直接 `toEqual`，比的是"格 vs 四元组"——
 * 一个不报错、也不像错的假对拍。摊平只在本文件做，生产侧不长第二套形态。
 */
const scanFileRefs = (...args: Parameters<typeof scanFileRefsRaw>) => unflattenRefs(scanFileRefsRaw(...args));

/* ============================== 改前实现（逐行封存，只作对照） ============================== */

const CALL_FAMILY = new Set(['CALL', 'TRYCALL', 'TRYCCALL', 'TRYCALLLIST', 'TRYCCALLLIST']);
const DEF_STOP = new Set(['(', ',', ' ', '\t', ';']);
const IDENT_ONE = new RegExp(MODEL_TOKEN_CLASS, 'u');
const KIND_DEFINITION = 0;

const normalizeEol = (text: string): string => text.replace(/\r\n?/g, '\n');

function codeViewOfOld(line: string): string {
  if (line.indexOf('"') === -1 && line.indexOf(';') === -1) return line;
  let out = '';
  let seg = 0;
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (inStr) {
      if (c === 34) {
        out += ' '.repeat(i - seg + 1);
        seg = i + 1;
        inStr = false;
      }
      continue;
    }
    if (c === 34) {
      out += line.slice(seg, i) + ' ';
      seg = i + 1;
      inStr = true;
    } else if (c === 59) {
      return out + line.slice(seg, i) + ' '.repeat(line.length - i);
    }
  }
  return inStr ? out + ' '.repeat(line.length - seg) : out + line.slice(seg);
}

function colonAdjacentOld(code: string, start: number, end: number): boolean {
  const before = start > 0 ? code.charCodeAt(start - 1) : -1;
  const after = end < code.length ? code.charCodeAt(end) : -1;
  return before === 0x3a || before === 0xff1a || after === 0x3a || after === 0xff1a;
}

function tokenCharLenOld(s: string, i: number, code: number): 0 | 1 | 2 {
  if (code < 0x80) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 ? 1 : 0;
  }
  if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
    const low = s.charCodeAt(i + 1);
    if (low >= 0xdc00 && low <= 0xdfff) return IDENT_ONE.test(s.slice(i, i + 2)) ? 2 : 0;
  }
  return IDENT_ONE.test(s[i]!) ? 1 : 0;
}

function forEachTokenOld(s: string, visit: (start: number, end: number) => boolean | void): void {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const len = tokenCharLenOld(s, i, s.charCodeAt(i));
    if (len === 0) {
      i++;
      continue;
    }
    const start = i;
    i += len;
    while (i < n) {
      const next = tokenCharLenOld(s, i, s.charCodeAt(i));
      if (next === 0) break;
      i += next;
    }
    if (visit(start, i) === false) return;
  }
}

interface VisibleCodeLineOld {
  readonly line: number;
  readonly raw: string;
  codeView(): string;
  readonly isDefinition: boolean;
  readonly isCallLine: boolean;
  readonly keywordEnd: number;
}

function* visibleCodeLinesOld(text: string): Generator<VisibleCodeLineOld> {
  const lines = normalizeEol(text).split('\n');
  let inSkipBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#') || trimmed.startsWith('$')) {
      continue;
    }
    if (trimmed.startsWith('@')) {
      yield { line: i + 1, raw, codeView: () => '', isDefinition: true, isCallLine: false, keywordEnd: -1 };
      continue;
    }
    let leadLen = 0;
    while (leadLen < trimmed.length) {
      const c = trimmed.charCodeAt(leadLen);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) leadLen++;
      else break;
    }
    const isCallLine = leadLen > 0 && CALL_FAMILY.has(trimmed.slice(0, leadLen).toUpperCase());
    const keywordEnd = isCallLine ? raw.length - raw.trimStart().length + leadLen : -1;
    let codeCache: string | undefined;
    yield {
      line: i + 1,
      raw,
      codeView: () => (codeCache ??= codeViewOfOld(raw)),
      isDefinition: false,
      isCallLine,
      keywordEnd,
    };
  }
}

function scanFileRefsNoCache(text: string, hasName: (normalizedName: string) => boolean) {
  const out: Array<readonly [string, number, number, 0 | 1 | 2]> = [];
  for (const { line, raw, isDefinition, isCallLine, keywordEnd, codeView } of visibleCodeLinesOld(text)) {
    if (isDefinition) {
      const at = raw.indexOf('@');
      let j = at + 1;
      while (j < raw.length && !DEF_STOP.has(raw[j]!)) j++;
      const slice = raw.slice(at + 1, j);
      const name = slice.trim();
      if (name.length > 0) {
        const upper = name.toUpperCase();
        if (hasName(upper)) out.push([upper, line, at + 2 + (slice.length - slice.trimStart().length), KIND_DEFINITION]);
      }
      continue;
    }
    let slotTaken = !isCallLine;
    const code = codeView();
    forEachTokenOld(code, (start, end) => {
      const inSlot = !slotTaken && start >= keywordEnd;
      if (inSlot) slotTaken = true;
      if (colonAdjacentOld(code, start, end)) return;
      const upper = normalizedUpper(code.slice(start, end));
      if (!hasName(upper)) return;
      out.push([upper, line, start + 1, (inSlot ? 1 : 2) as 0 | 1 | 2]);
    });
  }
  return out;
}

function scanUndefinedCallTargetsNoCache(text: string, hasName: (upper: string) => boolean) {
  const out: Array<{ line: number; column: number; name: string }> = [];
  for (const { line, raw, isCallLine, keywordEnd, codeView } of visibleCodeLinesOld(text)) {
    if (!isCallLine) continue;
    const code = codeView();
    forEachTokenOld(code, (start, end) => {
      if (start < keywordEnd) return;
      if (!/^[\t \u3000]*$/.test(raw.slice(keywordEnd, start))) return false;
      const run = code.slice(start, end);
      if (colonAdjacentOld(code, start, end)) return false;
      if (!hasName(normalizedUpper(run))) out.push({ line, column: start + 1, name: run });
      return false;
    });
  }
  return out;
}

/* ============================== 对抗性随机文本（固定种子，与 PS-3 种子不同） ============================== */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x4294967296;
  };
}

const PIECES = [
  'CALL', 'TRYCALL', 'TRYCCALL', 'TRYCALLLIST', 'TRYCCALLLIST', 'call', 'tryCall',
  'SIF', 'PRINTFORML', 'PRINT', 'JUMP', 'GOTO', 'CALLFORM', 'IF', 'ENDIF',
  'ALPHA', 'alpha', 'ＢＥＴＡ', 'ｂｅｔａ', '無個性', '＿Ａ', '123', '_x9', 'A.B', 'A,B',
  'ALPHA:FLAG', 'FLAG:ALPHA', 'CFLAG:alpha', '：ALPHA', 'ALPHA：',
  '"', '"ALPHA in string"', '";COMMENT"', '; 尾注', ';ALPHA', '"落单', '"串尾;',
  '(', ')', '[', ']', '.', '@ALPHA', '@ alpha_x ', '@ＦＵＮ_１', '@A,B(C=1)',
  '#DIM ALPHA[3]', '#FUNCTION', '$ALPHA', '$ 标签', '[SKIPSTART]', '[SKIPEND]',
  '\t', ' ', '　', '\r', ',', ':', '：', '𝐀', '𝐚', '\uD835', '\uDC00', '\uD800', '😀', 'αβ',
  'M_KOJO_無個性_関数', 'x\uD835y', 'a😀b', '𝐀:FLAG', 'FLAG:𝐀', 'ＣＦＬＡＧ', 'ｃｆｌａｇ', '',
] as const;

function randomText(r: () => number): string {
  const nLines = 1 + Math.floor(r() * 14);
  const lines: string[] = [];
  for (let i = 0; i < nLines; i++) {
    const nPieces = Math.floor(r() * 10);
    let s = '';
    for (let k = 0; k < nPieces; k++) s += PIECES[Math.floor(r() * PIECES.length)]!;
    lines.push(s);
  }
  return lines.join(r() < 0.3 ? '\r\n' : '\n');
}

const DICT = new Set([
  'ALPHA',
  'ＢＥＴＡ',
  '無個性',
  '_Ａ',
  'A.B',
  'FLAG',
  'CFLAG',
  'Ｍ_ＫＯＪＯ_無個性_関数',
  'ＦＵＮ_１',
  '𝐀',
  '😀',
]);
const hasName = (u: string): boolean => DICT.has(u);

/* ============================== 5,000 行合成 ERB（与 perf 读数同体量） ============================== */

const INDEX_NAMES = 110_194;
const GATE_LINES = 5_000;

function erbText(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    if (i % 405 === 4) lines.push(`@M_KOJO_K58_${String(i).padStart(6, '0')}(ARGS, ARG:1 = 3)`);
    else if (i % 373 === 7) lines.push(`\tCALL M_KOJO_K58_${String(i - 7).padStart(6, '0')}(1)`);
    else if (i % 31 === 0) lines.push(`; 注释行 ${i}：这一段是作者留下的说明，着色不该在这里付命中成本`);
    else if (i % 97 === 5) lines.push('#DIM FLAG_' + String(i));
    else lines.push(`\tPRINTFORMW 美鈴は「这是用来逼近真实体量的口上台词行 ${i}，长度足够、含 CJK 与半角标点。」`);
  }
  return lines.join('\n');
}

const BIG_NAMES = new Set<string>();
for (let i = 0; i < INDEX_NAMES; i++) BIG_NAMES.add(`M_KOJO_K58_${String(i).padStart(6, '0')}`);
const bigHasName = (u: string): boolean => BIG_NAMES.has(u);

/* ============================== 用例 ============================== */

describe('W7-G 字符分类缓存 · 新旧路径逐条等价', () => {
  it('scanFileRefs：600 份对抗性随机文本逐条相同（新路径冷/热各跑一遍）', () => {
    const r = rng(20261020);
    for (let i = 0; i < 600; i++) {
      const text = randomText(r);
      const want = scanFileRefsNoCache(text, hasName);
      const cold = scanFileRefs(text, hasName);
      const warm = scanFileRefs(text, hasName);
      expect(cold, `第 ${i} 轮（冷）对拍不符，文本：${JSON.stringify(text)}`).toEqual(want);
      expect(warm, `第 ${i} 轮（热）对拍不符，文本：${JSON.stringify(text)}`).toEqual(want);
    }
  });

  it('scanUndefinedCallTargets：同批文本逐条相同（波浪线判据不漂移）', () => {
    const r = rng(20261020);
    for (let i = 0; i < 600; i++) {
      const text = randomText(r);
      expect(scanUndefinedCallTargets(text, hasName), `第 ${i} 轮，文本：${JSON.stringify(text)}`).toEqual(
        scanUndefinedCallTargetsNoCache(text, hasName),
      );
    }
  });

  it('5,000 行合成 ERB（110,194 条名录）：整篇逐条相同，且新旧两路都真产出', () => {
    const text = erbText(GATE_LINES);
    const want = scanFileRefsNoCache(text, bigHasName);
    expect(want.length).toBeGreaterThan(0);
    // 新路径量两遍：第一遍可能是冷缓存（本文件前面的用例已填过一部分码元），第二遍必为热
    expect(scanFileRefs(text, bigHasName)).toEqual(want);
    expect(scanFileRefs(text, bigHasName)).toEqual(want);
  });

  it('缓存只记字符分类、不记名字命中：同一文本换名录，逐条一致', () => {
    const text = '@ALPHA(ARG)\nCALL ALPHA BETA\nPRINTFORMW ｂｅｔａ「alpha Beta」\n';
    const dictA = new Set(['ALPHA', 'BETA']);
    const dictB = new Set(['ＢＥＴＡ']);
    const hasA = (u: string): boolean => dictA.has(u);
    const hasB = (u: string): boolean => dictB.has(u);
    expect(scanFileRefs(text, hasA)).toEqual(scanFileRefsNoCache(text, hasA));
    expect(scanFileRefs(text, hasB)).toEqual(scanFileRefsNoCache(text, hasB));
    expect(scanFileRefs(text, hasA)).toEqual(scanFileRefsNoCache(text, hasA));
    expect(scanFileRefs(text, () => false)).toEqual(scanFileRefsNoCache(text, () => false));
  });

  it('多文本交替（CJK / 全角小写 / 增平面 / 落单代理项）：跨文本复用缓存不串味', () => {
    const texts = [
      'PRINTFORMW 美鈴は「これは日本語の台詞です」\nCALL 美鈴は\n',
      'call ｂｅｔａ\nPRINTFORML ＡＢＣ ａｂｃ\n',
      'CALL 𝐀\nPRINTFORMW 😀𝐀𝐚\nCALL \uD835\n',
    ];
    for (let round = 0; round < 3; round++) {
      for (const text of texts) {
        expect(scanFileRefs(text, hasName), `第 ${round} 轮，文本：${JSON.stringify(text)}`).toEqual(
          scanFileRefsNoCache(text, hasName),
        );
        expect(scanUndefinedCallTargets(text, hasName), `第 ${round} 轮（波浪线），文本：${JSON.stringify(text)}`).toEqual(
          scanUndefinedCallTargetsNoCache(text, hasName),
        );
      }
    }
  });

  it('落单代理项先入缓存不会污染后续代理对（两种到达顺序，各自全新模块实例）', async () => {
    const loneHigh = 'CALL \uD835\n';
    const pair = 'CALL \uD835\uDC00\n'; // 𝐀（U+1D400，字母）
    const dict = new Set(['𝐀']);
    const has = (u: string): boolean => dict.has(u);
    // 旧路径的基准（与模块实例无关）
    expect(scanFileRefsNoCache(loneHigh, has)).toEqual([]);
    expect(scanFileRefsNoCache(pair, has)).toEqual([['𝐀', 1, 6, 1]]);

    // 顺序 A：先落单高代理项（写进 BMP 缓存），再代理对
    vi.resetModules();
    const a = await import('../src/references');
    expect(unflattenRefs(a.scanFileRefs(loneHigh, has))).toEqual([]);
    expect(unflattenRefs(a.scanFileRefs(pair, has))).toEqual([['𝐀', 1, 6, 1]]);

    // 顺序 B：先代理对（写进增平面缓存），再落单高代理项
    vi.resetModules();
    const b = await import('../src/references');
    expect(unflattenRefs(b.scanFileRefs(pair, has))).toEqual([['𝐀', 1, 6, 1]]);
    expect(unflattenRefs(b.scanFileRefs(loneHigh, has))).toEqual([]);
  });

  it('全角/半角小写归一仍走同一个 normalizedUpper（含 CJK 名与成员访问退让）', () => {
    const text =
      'call ａｌｐｈａ\nSIF ｂｅｔａ > 1\nSIF Ｍ_ＫＯＪＯ_無個性_関数 > 1\nCFLAG:Ｍ_ＫＯＪＯ_無個性_関数\nPRINTFORMW ＺＥＲＯ\n';
    const dict = new Set(['ＡＬＰＨＡ', 'Ｍ_ＫＯＪＯ_無個性_関数']);
    const has = (u: string): boolean => dict.has(u);
    expect(scanFileRefs(text, has)).toEqual(scanFileRefsNoCache(text, has));
    // 第 4 行的同名记号紧邻冒号 ⇒ 变量世界，不算引用（`colonAdjacent` 退让仍成立）
    expect(scanFileRefs(text, has)).toEqual([
      ['ＡＬＰＨＡ', 1, 6, 1],
      ['Ｍ_ＫＯＪＯ_無個性_関数', 3, 5, 2],
    ]);
  });
});
