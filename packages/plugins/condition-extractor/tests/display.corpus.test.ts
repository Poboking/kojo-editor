/**
 * 显示行扫描 · 真实语料读数闸（v0.3 口上调试统一批）。
 *
 * 守门：`KOJO_SMOKE_PROJECT`（语料解析见 `tools/corpus.mjs`；**测试只读 env，不写死路径**）。
 *
 * 台词推演的价值全押在"扫得全"上：漏掉一类 PRINT 行，作者就会看到"这段不会说话"，
 * 而游戏里明明说了。所以本闸不判"某一行对不对"，判**召回**——用一条与实现无关的
 * 朴素判据（行首 `PRINT…` / `SIF … PRINT…`，只排除停用区与数据块）当分母，量
 * `collectDisplayLines` 收了多少，并逐类打印差异来源。
 *
 * 三条不变量：
 * 1. 召回 ≥ 98%（差异只许来自停用区 / `PRINTDATA` 块体 / 非 PRINT 语句这类**已建模**的排除）；
 * 2. FORM 族行的插值识别率 ≥ 99%（含 `%` 或 `{` 的行没被切开，就是推演里少了一段值）；
 * 3. 集成面：`extractFunctionPredicates` 的 `displays` 必须落在函数区间内且按行升序。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseErbText, scanControlFlow } from '@kojo/plugin-erb-parser';
import { extractFunctionPredicates } from '../src/extract';
import { collectDisplayLines } from '../src/display';
import { decodeWithProbe } from '../../../kernel/src/encoding';

/** 递归收集 `.ERB`（不跟随符号链接），按路径码点序排序 */
function collectErbFiles(root: string): string[] {
  const stack = [root];
  const out: string[] = [];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && /\.erb$/i.test(ent.name)) out.push(p);
    }
  }
  out.sort();
  return out;
}

const PRINT_LINE_RE = /^PRINT[A-Z]*(?![A-Za-z0-9_])/;
const SIF_PRINT_LINE_RE = /^SIF\s/;
const DATA_OPEN_RE = /^(PRINTDATA[A-Z]*|DATALIST|STRDATA)$/;
const DATA_CLOSE_RE = /^(ENDDATA|ENDLIST)$/;

/**
 * 朴素分母（与 `display.ts` **不共享任何代码**，故意写得笨）：
 * 函数区间内"看起来会打印"的行——行首 PRINT 动词，或 `SIF` 行里出现 PRINT 动词。
 * 只排除两类已建模的东西：`[SKIPSTART]`…`[SKIPEND]` 与 `PRINTDATA` 块体。
 * 两枚动词判据都带 `(?![A-Za-z0-9_])` 边界：`SIF PRINT_COUNT == 0` 里的 `PRINT_COUNT` 是变量名，
 * 没有边界就会把它算进分母（下面不变量 ③ 记实拍）。
 */
function naivePrintLines(lines: readonly string[], start: number, end: number): { total: number; sif: number } {
  let total = 0;
  let sif = 0;
  let inSkip = false;
  let inData = false;
  for (let i = start; i <= end && i <= lines.length; i++) {
    const code = (lines[i - 1] ?? '').trim().replace(/^;!;/, '').trim();
    if (inSkip) {
      if (code === '[SKIPEND]') inSkip = false;
      continue;
    }
    if (code === '[SKIPSTART]') {
      inSkip = true;
      continue;
    }
    if (inData) {
      if (DATA_CLOSE_RE.test(code)) inData = false;
      continue;
    }
    if (DATA_OPEN_RE.test(code)) {
      inData = true;
      continue;
    }
    if (PRINT_LINE_RE.test(code)) total++;
    else if (SIF_PRINT_LINE_RE.test(code) && /\sPRINT[A-Z]*(?![A-Za-z0-9_])/.test(code)) {
      total++;
      sif++;
    }
  }
  return { total, sif };
}

describe.skipIf(!process.env.KOJO_SMOKE_PROJECT)('显示行扫描 · 真实语料读数闸', () => {
  it('全语料：召回率 / 插值识别率 / 守卫行占比（读数真实打印）', () => {
    const root = process.env.KOJO_SMOKE_PROJECT!;
    const files = collectErbFiles(root);
    expect(files.length).toBeGreaterThan(0);

    let functions = 0;
    let functionsWithDisplays = 0;
    let displayLines = 0;
    let naiveLines = 0;
    let naiveSifLines = 0;
    let sifGuarded = 0;
    let formLines = 0;
    let formLinesWithDelimiter = 0;
    let formLinesSliced = 0;
    let interpolations = 0;
    let ternaries = 0;
    const missing: string[] = [];

    for (const file of files) {
      const { text } = decodeWithProbe(readFileSync(file));
      const rel = relative(root, file).replaceAll('\\', '/');
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const { functions: fns } = parseErbText(text, rel);

      for (const fn of fns) {
        functions++;
        const body = collectDisplayLines(lines, fn.startLine + 1, fn.endLine);
        if (body.length > 0) functionsWithDisplays++;
        displayLines += body.length;
        const naive = naivePrintLines(lines, fn.startLine + 1, fn.endLine);
        naiveLines += naive.total;
        naiveSifLines += naive.sif;
        for (const d of body) if (d.sifGuarded) sifGuarded++;
        for (const d of body) {
          const isForm = d.verb.includes('FORM');
          if (!isForm) continue;
          formLines++;
          if (d.interpolations.length > 0) formLinesSliced++;
          if (/[%{]|\\@/.test(d.payload)) formLinesWithDelimiter++;
          for (const it of d.interpolations) {
            interpolations++;
            if (it.form === 'inlineTernary') ternaries++;
          }
        }
        if (missing.length < 8 && naive.total > body.length) {
          missing.push(`${rel}:${fn.startLine}-${fn.endLine} 朴素 ${naive.total} / 收到 ${body.length}`);
        }
      }
    }

    const recall = displayLines / Math.max(1, naiveLines);
    const sliceRate = formLinesSliced / Math.max(1, formLinesWithDelimiter);
    console.log(
      `[display-corpus] ${files.length} 份 .ERB / ${functions} 函数（含显示行 ${functionsWithDisplays}）｜ ` +
        `显示行 ${displayLines}（朴素分母 ${naiveLines} ⇒ 召回 ${(recall * 100).toFixed(2)}%）｜ ` +
        `SIF 同行守卫 ${sifGuarded}（朴素分母 ${naiveSifLines}）｜ FORM 行 ${formLines}（带定界符 ${formLinesWithDelimiter}，切出插值 ${formLinesSliced} ⇒ ` +
        `${(sliceRate * 100).toFixed(2)}%）｜ 插值 ${interpolations}（行内三元 ${ternaries}）`,
    );
    console.log(`[display-corpus] 召回差异样本（只打印，不判绝对值）：\n${missing.map((s) => `  ${s}`).join('\n') || '  （无）'}`);

    // ① 召回：差异只许来自已建模的排除（停用区 / 数据块 / 非 PRINT 语句）
    expect(recall).toBeGreaterThan(0.98);
    // ② FORM 行的插值识别：带 `%`/`{` 的行必须几乎全被切开
    expect(sliceRate).toBeGreaterThan(0.99);
    // ③ SIF 同行守卫必须真收到。这类行在语料里**极稀疏**，且稀疏程度随盘换代大幅摆动
    //    （改版盘抽取 42；基线盘 4.980 抽取 7——`SIF` 总行两万九千条里绝大多数是 `SIF cond CALL/
    //    RETURN`，真正同行带 PRINT 的就这几行）。钉绝对值（原 `>30`）会把"换了一块盘"报成回归，
    //    故改判两件与盘无关的事：一枚都不许整行丢掉 + 抽取侧不许少于**同盘**朴素分母。
    //    分母侧那枚 `(?![A-Za-z0-9_])` 边界不是装饰：基线盘 `QOL_IMAGE.ERB` 有行 `SIF PRINT_COUNT == 0`，
    //    `PRINT_COUNT` 是变量名，裸 `/ PRINT[A-Z]*/` 把它算成打印行 ⇒ 判据读成 7<8 假红；加边界后两盘
    //    抽取与分母逐枚相等（7/7、42/42）——这才是这条的真读数。
    expect(sifGuarded).toBeGreaterThan(0);
    expect(sifGuarded).toBeGreaterThanOrEqual(naiveSifLines);
  }, 600_000);

  it('集成面：extractFunctionPredicates 的 displays 落在函数区间内且按行升序', () => {
    const root = process.env.KOJO_SMOKE_PROJECT!;
    const files = collectErbFiles(root).slice(0, 40);
    let checked = 0;

    for (const file of files) {
      const { text } = decodeWithProbe(readFileSync(file));
      const rel = relative(root, file).replaceAll('\\', '/');
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const stmts = scanControlFlow(text);
      const { functions: fns } = parseErbText(text, rel);
      let cursor = 0;
      for (const fn of fns) {
        while (cursor < stmts.length && stmts[cursor]!.line < fn.startLine) cursor++;
        const slice = [];
        for (let j = cursor; j < stmts.length && stmts[j]!.line <= fn.endLine; j++) slice.push(stmts[j]!);
        const detail = extractFunctionPredicates(fn, slice, { lines, endLine: fn.endLine });
        const displays = detail.displays ?? [];
        let prev = fn.startLine;
        for (const d of displays) {
          expect(d.line, `${rel}:${d.line} 必须落在函数体区间内`).toBeGreaterThan(fn.startLine);
          expect(d.line).toBeLessThanOrEqual(fn.endLine);
          expect(d.line, `${rel} 显示行必须按行升序`).toBeGreaterThanOrEqual(prev);
          prev = d.line;
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    console.log(`[display-corpus] 集成面已核 ${checked} 个函数（displays 区间与序）`);
  }, 600_000);
});
