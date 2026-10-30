/**
 * PS-3 提速批 —— 快路径**逐字节等价**差分对拍。
 *
 * 本批把 `codeViewOf` 换成"无引号无分号原样返回 + 分段重建"、把行首
 * `/^[A-Za-z_]+/` 与记号遍历的 `RegExp.exec` 循环换成 `charCodeAt` 走位。
 * 判据不许动一根手指：这里把**旧实现原样封存**（正则版）作对照，
 * 对 `scanFileRefs` / `scanUndefinedCallTargets` 在**对抗性随机文本**上逐字节对拍——
 * 覆盖面：CJK / 全角字母数字 / 增平面字母（代理对）/ **落单代理项** / 落单引号 /
 * 引号内 `;`、`:`、名字 / `[SKIPSTART…]` / `#` `$` `@` 行 / CALL 族全表 /
 * 半全角冒号成员访问 / 大小写名录 / 制表与全角空白缩进。
 * 固定种子 LCG，可复跑。语料朴素对拍（第三种独立实现）与 `references.test.ts`
 * 边界用例是本文件之外的另外两把尺子。
 */
import { describe, expect, it } from 'vitest';
import { scanFileRefs as scanFileRefsRaw, scanUndefinedCallTargets, normalizedUpper } from '../src/references';
import { unflattenRefs } from './support';

/**
 * 本文件里的 `scanFileRefs` 一律是**四元组视图**：封存的旧实现（`scanFileRefsNoCache` /
 * `scanFileRefsOld`）产出的是「一条一枚四元组」，而生产侧自 MEM-7 起是扁平流水
 * （步长 `REF_STRIDE`）。不摊平就直接 `toEqual`，比的是"格 vs 四元组"——
 * 一个不报错、也不像错的假对拍。摊平只在本文件做，生产侧不长第二套形态。
 */
const scanFileRefs = (...args: Parameters<typeof scanFileRefsRaw>) => unflattenRefs(scanFileRefsRaw(...args));

/* ---------------- 旧实现（改前 references.ts 的正则版，逐行封存作对照） ---------------- */

const CALL_FAMILY = new Set(['CALL', 'TRYCALL', 'TRYCCALL', 'TRYCALLLIST', 'TRYCCALLLIST']);
const DEF_STOP = new Set(['(', ',', ' ', '\t', ';']);
const TOKEN_RE = new RegExp('[\\p{L}\\p{N}_]+', 'gu');
const isMemberColon = (c: string | undefined): boolean => c === ':' || c === '：';
const normalizeEol = (text: string): string => text.replace(/\r\n?/g, '\n');

function codeViewOfOld(line: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inStr) {
      if (c === '"') inStr = false;
      out += ' ';
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += ' ';
      continue;
    }
    if (c === ';') return out + ' '.repeat(line.length - i);
    out += c;
  }
  return out;
}

function* visibleCodeLinesOld(text: string) {
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
    if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#') || trimmed.startsWith('$')) continue;
    if (trimmed.startsWith('@')) {
      yield { line: i + 1, raw, codeView: () => '', isDefinition: true, isCallLine: false, keywordEnd: -1 };
      continue;
    }
    const lead = /^[A-Za-z_]+/.exec(trimmed);
    const isCallLine = lead !== null && CALL_FAMILY.has(lead[0]!.toUpperCase());
    const keywordEnd = isCallLine ? raw.length - raw.trimStart().length + lead[0]!.length : -1;
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

function scanFileRefsOld(text: string, hasName: (upper: string) => boolean) {
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
        if (hasName(upper)) out.push([upper, line, at + 2 + (slice.length - slice.trimStart().length), 0]);
      }
      continue;
    }
    let slotTaken = !isCallLine;
    const code = codeView();
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(code)) !== null) {
      const run = m[0]!;
      const inSlot = !slotTaken && m.index >= keywordEnd;
      if (inSlot) slotTaken = true;
      if (isMemberColon(code[m.index - 1]) || isMemberColon(code[m.index + run.length])) continue;
      const upper = normalizedUpper(run);
      if (!hasName(upper)) continue;
      out.push([upper, line, m.index + 1, inSlot ? 1 : 2]);
    }
  }
  return out;
}

function scanUndefinedCallTargetsOld(text: string, hasName: (upper: string) => boolean) {
  const out: Array<{ line: number; column: number; name: string }> = [];
  for (const { line, raw, isCallLine, keywordEnd, codeView } of visibleCodeLinesOld(text)) {
    if (!isCallLine) continue;
    const code = codeView();
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(code)) !== null) {
      if (m.index < keywordEnd) continue;
      if (!/^[\t 　]*$/.test(raw.slice(keywordEnd, m.index))) break;
      const run = m[0]!;
      if (isMemberColon(code[m.index - 1]) || isMemberColon(code[m.index + run.length])) break;
      if (!hasName(normalizedUpper(run))) out.push({ line, column: m.index + 1, name: run });
      break;
    }
  }
  return out;
}

/* ---------------- 对抗性随机文本发生器（固定种子） ---------------- */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x4294967296;
  };
}

const PIECES = [
  'CALL', 'TRYCALL', 'TRYCCALL', 'TRYCALLLIST', 'TRYCCALLLIST', 'call', 'TRYCallList',
  'SIF', 'PRINTFORML', 'PRINT', 'JUMP', 'GOTO', 'CALLFORM', 'IF', 'ENDIF',
  'ALPHA', 'alpha', 'ＢＥＴＡ', '無個性', '＿Ａ', '123', '_x9', 'A.B', 'A,B',
  'ALPHA:FLAG', 'FLAG:ALPHA', 'CFLAG:alpha', '：ALPHA', 'ALPHA：',
  '"', '"ALPHA in string"', '";COMMENT"', '; 尾注', ';ALPHA', '"落单', '"串尾;',
  '(', ')', '[', ']', '.', '@ALPHA', '@ alpha_x ', '@ＦＵＮ_１', '@A,B(C=1)',
  '#DIM ALPHA[3]', '#FUNCTION', '$ALPHA', '$ 标签', '[SKIPSTART]', '[SKIPEND]',
  '\t', ' ', '　', '\r', ',', ':', '：', '𝐀', '𝐚', '\uD800', '\uDC00', '😀', 'αβ',
  'M_KOJO_無個性_関数', 'x\uD800y', 'a😀b', '𝐀:FLAG', 'FLAG:𝐀', '',
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

const DICT = new Set(['ALPHA', 'ＢＥＴＡ', '無個性', '_Ａ', 'A.B', 'FLAG', 'CFLAG', 'Ｍ_ＫＯＪＯ_無個性_関数', 'ＦＵＮ_１', '𝐀']);
const hasName = (u: string): boolean => DICT.has(u);

describe('PS-3 快路径差分对拍（旧正则实现 vs charCodeAt 实现）', () => {
  it('scanFileRefs：600 份对抗性随机文本逐字节相同', () => {
    const r = rng(20261027);
    for (let i = 0; i < 600; i++) {
      const text = randomText(r);
      const got = JSON.stringify(scanFileRefs(text, hasName));
      const want = JSON.stringify(scanFileRefsOld(text, hasName));
      expect(got, `第 ${i} 轮对拍不符，文本：${JSON.stringify(text)}`).toBe(want);
    }
  });

  it('scanUndefinedCallTargets：同批文本逐字节相同（波浪线判据不漂移）', () => {
    const r = rng(20261027);
    for (let i = 0; i < 600; i++) {
      const text = randomText(r);
      const got = JSON.stringify(scanUndefinedCallTargets(text, hasName));
      const want = JSON.stringify(scanUndefinedCallTargetsOld(text, hasName));
      expect(got, `第 ${i} 轮对拍不符，文本：${JSON.stringify(text)}`).toBe(want);
    }
  });

  it('代理对与落单代理项的定点用例（增平面字母算记号、落单码元不算）', () => {
    // 𝐀（U+1D400，\p{L}）是名字：前后贴码点整体走位
    expect(scanFileRefs('CALL 𝐀\n', hasName)).toEqual([['𝐀', 1, 6, 1]]);
    // 落单高代理项不是记号：把记号切断（x <lone> y ⇒ 两个记号）
    expect(scanFileRefs('ALPHA\uD800ALPHA\n', hasName)).toEqual([
      ['ALPHA', 1, 1, 2],
      ['ALPHA', 1, 7, 2],
    ]);
    // 😀（\p{So}，非字母非数字）不算记号：成对占两个码元，第二个记号从列 8 起
    expect(scanFileRefs('ALPHA😀ALPHA\n', hasName)).toEqual([
      ['ALPHA', 1, 1, 2],
      ['ALPHA', 1, 8, 2],
    ]);
  });
});
