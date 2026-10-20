/**
 * 「续」标记判据 · 真实语料反例闸（KOJO_SMOKE_PROJECT / KOJO_CORPUS_DIR 守门，语料不在位整组跳过）。
 *
 * ## 为什么存在（MULTI-CORPUS-SEMANTIC 2026-10-20 实测）
 *
 * 规范 §3.3 把 `续` 定为**行尾标记**（"必须写在引号/句号之外"），§8 的 lint 项叫
 * 「`续` 标记写在引号内 → 报错」。但转译器实际用的尺子是
 * `lexer.ts::detectContInsideQuotes` 的 `[「][^」]*续[^」]*[」]`——**引号里任一处出现
 * `续` 字就报 error**，于是把中文日常词（`继续` / `连续` / `手续`）一概判成"标记写错"。
 *
 * 解析侧自己的尺子不是这样：`lexer.ts::stripCont` 只认 `(?:^|\s)续\s*$`
 * ——**前有空白 / 行首**才算标记。两条尺子对同一行给了相反结论，这就是本闸。
 *
 * 三盘实测（2026-10-20，只读）：
 * - 汉化语料（`eratw-画蛇添足版4.980` / `eratw魔王改版`）：口上域 `PRINTFORM*` 行里
 *   引号内含 `续` 的 **2,882 / 3,020 行**，其中 `续` 位于引号内**末字**（可能是真标记形，
 *   本闸不算）只有 35 / 36 行 ⇒ 其余全部是**词内字**；
 * - 日文原版（`eratw原生官方版4.842`）：926 行同形（社区汉化台词）；
 * - `eraAkumaMaid`：0 行（日文语料，无 `续` 字）。
 *
 * 代价不是一条波浪线：`compileToFile` / `compileToBytes` 遇到 error 诊断**拒绝编译**，
 * 所以作者在 `.kojo` 里写一句「请继续吧。」就存不下去；`sugar.lift` 也会把含这类台词的
 * 区间判成 `transpile-error` 丢弃（魔王改版 60 个文件里实测 127 处）。
 *
 * ## 本闸的判据
 *
 * 只取**词汇义不可能当标记**的样本：`续` 在引号内但**不是末字**（如「请继续吧。」）。
 * 这类行按解析器 `stripCont` 的尺子完全合法 ⇒ 转译不得报 `cont-inside-quotes`。
 *
 * **修复已落地（2026-10-20，同一批）**：`detectContInsideQuotes` 换成与 `stripCont` 同一把尺
 * ——只认空白后、引号内行尾的标记形；汉化三盘由此转绿。第二个 `describe` 是**防塌闸**：
 * 真标记写进引号（`「…… 续」`）必须仍然报错，不许为了让上面那条转绿就把规则删掉。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SugarTranspileResult } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

/** 口上域（与 `slot-cn.corpus.test.ts` 同一目录口径） */
const KOJO_DIR = SMOKE ? join(SMOKE, 'ERB', '口上・メッセージ関連', '個人口上') : '';

/** 扫面上限：够取到样本即可（本闸是判据闸，不是覆盖率闸） */
const MAX_FILES = 80;
const MAX_SAMPLES = 8;

interface QuoteContSample {
  /** 源文件（绝对路径） */
  readonly file: string;
  /** 1 基行号 */
  readonly line: number;
  /** 文本体（`PRINTFORM*` 之后的原文） */
  readonly body: string;
}

/** 递归收 `.erb`（排序后取前 MAX_FILES 棵——样本顺序稳定，读数可复算） */
function erbFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.erb$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * 收集「引号内含 `续`、但 `续` 不是引号内末字」的台词行。
 * 末字那种（`「我继续」`）可能是作者真想把标记写进引号，判据上仍有争议 ⇒ 不取。
 */
function collectQuoteContSamples(): QuoteContSample[] {
  // 语料根指到没有 `個人口上` 的盘（如 eraAkumaMaid 的 `ERB/EVENT_K`）⇒ 无样本、整组跳过，
  // 不许在收集期抛 ENOENT（那会让 vitest 判成"文件收集失败"而不是"跳过"）。
  if (!SMOKE || !existsSync(KOJO_DIR)) return [];
  const samples: QuoteContSample[] = [];
  const files = erbFiles(KOJO_DIR).slice(0, MAX_FILES);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (samples.length >= MAX_SAMPLES) return samples;
      const m = /^\s*PRINTFORM\w*\s+(.*)$/i.exec(lines[i]!);
      if (!m) continue;
      const quoted = /[「｢]([^」｣]*)[」｣]/.exec(m[1]!);
      if (!quoted) continue;
      const content = quoted[1]!;
      const at = content.indexOf('续');
      if (at < 0 || at === content.length - 1) continue;
      samples.push({ file, line: i + 1, body: m[1]!.trim() });
    }
  }
  return samples;
}

const SAMPLES = collectQuoteContSamples();

/** 生产口径的转译器（与 `index.ts` 同一装配：真字典替身 + adapter 真分野模板） */
const sugar = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

/** 一条文本行 → 最小 `.kojo`（只留一个时机块，行号 = 3 便于读诊断） */
function kojoWithTextLine(body: string): string {
  return ['角色: 1', '时机 指令 310：', `    ${body}`, ''].join('\n');
}

const contDiagnostics = (tr: SugarTranspileResult): string[] =>
  tr.diagnostics.filter((d) => d.code === 'cont-inside-quotes').map((d) => `L${d.loc?.line}: ${d.message}`);

describe.skipIf(!SMOKE || SAMPLES.length === 0)(
  '「续」判据 · 真实语料：引号内的词内字不得被当成行尾标记',
  () => {
    it('词内 `续`（引号内非末字）→ 不得报 cont-inside-quotes', () => {
      expect(SAMPLES.length, '没取到样本 ⇒ 本闸无证明力（语料布局变了？）').toBeGreaterThan(0);
      const hits: string[] = [];
      for (const sample of SAMPLES) {
        const tr = sugar.transpile(kojoWithTextLine(sample.body), { fileName: 'cont-probe.kojo' });
        const found = contDiagnostics(tr);
        if (found.length > 0) {
          hits.push(`${sample.file}:${sample.line} ${sample.body} → ${found.join(' ; ')}`);
        }
      }
      expect(
        hits,
        '这些行里的 `续` 是中文词的一部分（`继续`/`连续`），解析器 stripCont 只认空白后的行尾 `续`；' +
          'lint 却按"引号内出现即报错"判 ⇒ 两把尺子。error 诊断会让 compileToFile 拒绝编译',
      ).toEqual([]);
    }, 60_000);
  },
);

describe('「续」标记规则仍在（防塌闸：不许以删除规则的办法让上面的用例转绿）', () => {
  it('真标记写进引号（`「…… 续」`）→ 仍必须是 error', () => {
    const tr = sugar.transpile(kojoWithTextLine('「…… 续」'), { fileName: 'cont-true.kojo' });
    expect(contDiagnostics(tr).length).toBeGreaterThan(0);
  });

  it('正确写法（标记在引号外、空白分隔）→ 不得报错', () => {
    const tr = sugar.transpile(kojoWithTextLine('「……」 续'), { fileName: 'cont-ok.kojo' });
    expect(contDiagnostics(tr)).toEqual([]);
  });
});
