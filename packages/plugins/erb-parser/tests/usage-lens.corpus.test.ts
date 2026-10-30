/**
 * 行上内联注解 · 真实语料自证（B8；`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 守门，不在位跳过）。
 *
 * 钉死**上限判据的证据面**（宿主三道降级为什么这么定，读数以本文件为准，走的是真注册）：
 * 1. 噪音两条：孤儿率（为何不说「没人调用」）、大数尾巴（为何把 1000 以上改报 `1000+`）；
 * 2. 产出：行数门槛内每篇实际出几条、有没有顶到条数上限、几篇超密度；
 * 3. 代价：门槛内最坏一次 provide（parseText + 全篇计数）多少毫秒，以及门槛外那份巨型文件的
 *    parse 单价（`stickyScroll` / 面包屑同一条降级理由，在此复测）。
 *
 * 断言一律用**区间**（语料会换版本），读数逐条 `console.log`。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  EditorCodeLens,
  EditorLanguageServiceContribution,
  ErbParserService,
  ErbReference,
  Logger,
} from '@kojo/plugin-api';
import { createKernel } from '../../../kernel/src/kernel';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { MemoryStorageBackend } from '../../../kernel/tests/helpers/memory-storage';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { USAGE_LENS_BIG_COUNT } from '../src/symbols';

/**
 * 宿主三道降级的**当前取值**（真源：`app/src/ui/editor-options.ts` 的 `LARGE_FILE_LINES`、
 * `app/src/monaco/kojo-code-lens.ts` 的 `CODE_LENS_MAX_*`）。插件测试不许反向 import 宿主，
 * 故此处照抄；宿主侧改动由 `packages/app/tests/kojo-code-lens.test.ts` 钉住取值。
 */
const LARGE_FILE_LINES = 5000;
const MAX_LENSES = 200;
const MAX_DENSITY = 5;

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const pct = (sorted: readonly number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

/** 读数里只留文件名（语料绝对路径会随机器与目录名变） */
const base = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** 一个名字的非定义引用**处**数（与 usageLenses 同口径：按 文件+行 去重） */
function siteCountOf(list: readonly ErbReference[]): number {
  const sites = new Set<string>();
  for (const r of list) {
    if (r.kind === 'definition') continue;
    sites.add(`${r.filePath}\u0000${r.line}`);
  }
  return sites.size;
}

describe.skipIf(!SMOKE)('行上内联注解 · 真实语料自证', () => {
  it('孤儿率 / 大数尾巴 / 每篇产出 / provide 代价', async () => {
    const kernel = await createKernel({
      platform: new NodeBridge(mkdtempSync(join(tmpdir(), 'kojo-b8-'))),
      plugins: [createErbParserPlugin()],
      storageBackend: new MemoryStorageBackend(),
      logger: silent,
    });
    await kernel.start();
    try {
      const parser = kernel.services.get<ErbParserService>('erb.parser');
      const index = await parser.buildIndex([join(SMOKE!, 'ERB')]);
      const lens = kernel.slots
        .query('ui.editor.languageService')
        .find((c: EditorLanguageServiceContribution) => c.id === 'erb-usage-lens');
      if (!lens) throw new Error('erb-usage-lens 未注册');
      // 判别式各管各的：definition 请求不许被本贡献应答
      expect(lens.provide({ kind: 'definition', path: '/t/a.ERB', text: '@A\n', line: 1, column: 1, project: null })).toBeUndefined();
      const io = new FileIOServiceImpl(new NodeBridge(SMOKE!));

      /* ---------- 1. 噪音两条 ---------- */
      const unique: Array<[name: string, sites: number]> = [];
      let defs = 0;
      let dupDefs = 0;
      for (const [name, list] of index.references!.bySymbol) {
        const d = index.byName.countOf(name);
        if (d === 0) continue;
        defs += d;
        if (d > 1) {
          dupDefs += d;
          continue;
        }
        unique.push([name, siteCountOf(list)]);
      }
      const counts = unique.map(([, c]) => c).sort((a, b) => a - b);
      const annotCounts = counts.filter((c) => c > 0); // 分位数按**可标注**那批算（孤儿不参与）
      const orphan = counts.length - annotCounts.length;
      const annotatable = counts.length - orphan;
      const bucket = unique.filter(([, c]) => c > USAGE_LENS_BIG_COUNT);
      const worst = [...unique].sort((a, b) => b[1] - a[1])[0]!;
      console.log(
        `[b8] 规模：文件 ${index.files.size} / 定义 ${defs} / 名 ${index.byName.size}；` +
          `重名定义 ${dupDefs} 处（占定义 ${((dupDefs / defs) * 100).toFixed(2)}% ⇒ 本批让开不计数）`,
      );
      console.log(
        `[b8] 唯一定义 ${unique.length}：孤儿（证明不了有人用）${orphan} = ${((orphan / unique.length) * 100).toFixed(1)}%` +
          ` ⇒「没人调用」会在每两个函数里点一个，本批不说这句话`,
      );
      console.log(
        `[b8] 可标注 ${annotatable}：处数 P50=${pct(annotCounts, 50)} P90=${pct(annotCounts, 90)} P99=${pct(annotCounts, 99)} ` +
          `P99.9=${pct(annotCounts, 99.9)} P99.99=${pct(annotCounts, 99.99)} max=${annotCounts[annotCounts.length - 1]}（${worst[0]}）；` +
          `超过 ${USAGE_LENS_BIG_COUNT} 改报 1000+ 的 ${bucket.length} 名（占可标注 ${((bucket.length / annotatable) * 100).toFixed(3)}%）`,
      );
      expect(orphan / unique.length, '孤儿率必须在「满屏标记」量级，这才是不说「没人调用」的证据').toBeGreaterThan(0.5);
      expect(dupDefs / defs, '重名定义占比必须极低，让开它换「每条注解可核对」').toBeLessThan(0.01);
      expect(pct(annotCounts, 99), 'P99 的名字必须拿到精确数（界线之上只该是引擎级工具函数）').toBeLessThan(USAGE_LENS_BIG_COUNT);
      expect(bucket.length).toBeLessThan(100);
      expect(worst[1], '最坏一名必须确实是万级，否则这条降噪判据没有取证对象').toBeGreaterThan(10_000);

      /* ---------- 2. 每篇实际产出（走真注册） ---------- */
      const perFile: number[] = [];
      let totalLenses = 0;
      let overCap = 0;
      let overDensity = 0;
      let badLine = 0;
      let badLabel = 0;
      let worstMs = 0;
      let worstMsFile = { path: '', lines: 0, lenses: 0 };
      let bucketFiles = 0;
      let worstDensity = { density: 0, path: '', lines: 0, lenses: 0 };
      let deliveredDensity = { density: 0, path: '', lines: 0, lenses: 0 };
      let densest = { path: '', lines: 0, lenses: 0, ms: 0 };
      const perFileDefs: number[] = [];
      const overDensityFiles: string[] = [];
      // 预热一次（不计入读数）：`parseErbText` 的**首笔**调用含 JIT 编译，实测 58–61ms，
      // 与文件体量无关（热态复跑 0.87–12.76ms）；下面 assert 的"一次 provide 的稳态单价"
      // 若把这一次算进去，读到的是启动成本而不是每篇成本——与巨型文件那节"单价取热态（首笔含 JIT）"同口径。
      const warm = [...index.files].find(([, f]) => f.lineCount < LARGE_FILE_LINES);
      if (warm) {
        const warmText = await io.readText(warm[0]);
        lens.provide({ kind: 'codeLens', path: warm[0], text: warmText.text, project: null, lineCount: warm[1].lineCount });
      }
      for (const [path, file] of index.files) {
        if (file.lineCount >= LARGE_FILE_LINES) continue; // 宿主第一档：这篇整篇不办
        const tf = await io.readText(path);
        const t0 = performance.now();
        const res = lens.provide({ kind: 'codeLens', path, text: tf.text, project: null, lineCount: file.lineCount });
        const ms = performance.now() - t0;
        if (!res || res.kind !== 'codeLens') throw new Error(`门槛内文件未得答复：${path}`);
        const lenses = res.lenses as EditorCodeLens[];
        for (const l of lenses) {
          if (l.line < 1 || l.line > file.lineCount) badLine++;
          if (!/^被 (\d+|\d+\+) 处用到$/.test(l.label)) badLabel++;
        }
        perFile.push(lenses.length);
        totalLenses += lenses.length;
        perFileDefs.push(file.functions.length);
        if (lenses.length > MAX_LENSES) overCap++;
        if (lenses.length > Math.floor(file.lineCount / MAX_DENSITY)) {
          overDensity++;
          overDensityFiles.push(`${base(path)} ${file.lineCount}行/${lenses.length}条`);
        }
        if (ms > worstMs) {
          worstMs = ms;
          worstMsFile = { path, lines: file.lineCount, lenses: lenses.length };
        }
        const density = file.lineCount > 0 ? lenses.length / file.lineCount : 0;
        if (density > worstDensity.density) {
          worstDensity = { density, path, lines: file.lineCount, lenses: lenses.length };
        }
        // 作者**开着**时看到的最坏情形：只算两道预算都过得了的那些篇
        if (lenses.length <= MAX_LENSES && lenses.length <= Math.floor(file.lineCount / MAX_DENSITY)) {
          if (density > deliveredDensity.density) {
            deliveredDensity = { density, path, lines: file.lineCount, lenses: lenses.length };
          }
        }
        if (lenses.some((l) => l.label === `被 ${USAGE_LENS_BIG_COUNT}+ 处用到`)) bucketFiles++;
        if (lenses.length > densest.lenses) densest = { path, lines: file.lineCount, lenses: lenses.length, ms };
      }
      perFile.sort((a, b) => a - b);
      console.log(
        `[b8] 产出：门槛内 ${perFile.length} 篇（出注解的 ${perFile.filter((n) => n > 0).length} 篇）共 ${totalLenses} 条；` +
          `每篇 P50=${pct(perFile, 50)} P90=${pct(perFile, 90)} P99=${pct(perFile, 99)} max=${perFile[perFile.length - 1]}`,
      );
      perFileDefs.sort((a, b) => a - b);
      console.log(
        `[b8] 门槛内每篇定义数：P50=${pct(perFileDefs, 50)} P90=${pct(perFileDefs, 90)} P99=${pct(perFileDefs, 99)} ` +
          `max=${perFileDefs[perFileDefs.length - 1]}（这是"一开就插多少行"的上界来源）`,
      );
      console.log(
        `[b8] 降级命中：顶到 ${MAX_LENSES} 条上限 ${overCap} 篇；超 1/${MAX_DENSITY} 密度 ${overDensity} 篇（只有这些整篇不给）：` +
          `${overDensityFiles.join('、') || '无'}；最坏密度 ${(worstDensity.density * 100).toFixed(1)}% 的行（` +
          `${worstDensity.lines} 行出 ${worstDensity.lenses} 条：${base(worstDensity.path)}）`,
      );
      console.log(
        `[b8] 开着时的最坏观感：过得了预算的 ${perFile.length - overDensity} 篇里最密的一份 = ` +
          `${(deliveredDensity.density * 100).toFixed(1)}% 的行插注解（${deliveredDensity.lines} 行出 ` +
          `${deliveredDensity.lenses} 条：${base(deliveredDensity.path)}）`,
      );
      console.log(
        `[b8] 1000+ 这一档真的出在产物里：${bucketFiles} 篇文件带过这条标签（全库 ${bucket.length} 个引擎级名字）`,
      );
      const worstHot = await io.readText(worstMsFile.path);
      const w0 = performance.now();
      lens.provide({
        kind: 'codeLens',
        path: worstMsFile.path,
        text: worstHot.text,
        project: null,
        lineCount: worstMsFile.lines,
      });
      const worstHotMs = performance.now() - w0;
      console.log(
        `[b8] provide 单价：门槛内最坏 ${worstMs.toFixed(2)}ms（${worstMsFile.lines} 行 / ${worstMsFile.lenses} 条：` +
          `${base(worstMsFile.path)}），复跑同一篇热态 ${worstHotMs.toFixed(2)}ms；产出最多那篇 ${densest.lines} 行 / ` +
          `${densest.lenses} 条 / ${densest.ms.toFixed(2)}ms（${base(densest.path)}）`,
      );
      expect(badLine, '注解行号必须都在文件内（越界只会被宿主丢弃）').toBe(0);
      expect(badLabel, '标签形状只许两种：精确数与 1000+').toBe(0);
      expect(overCap, `真实语料不许顶到 ${MAX_LENSES} 条上限（上限是护栏，不是裁剪）`).toBe(0);
      expect(overDensity, '密度档只该拦掉极少数文件（顶到上限的那档才是主力，见上一行读数）').toBeLessThan(20);
      expect(
        deliveredDensity.density,
        `过了预算的篇，插行比例不许超过 1/${MAX_DENSITY}（密度档的存在意义）`,
      ).toBeLessThanOrEqual(1 / MAX_DENSITY + 0.001);
      expect(bucketFiles, '大数那档既已定口径，真语料上必须真的出得来（不是纸面判据）').toBeGreaterThan(0);
      expect(worstMs, '门槛内一次 provide 必须停在个位数毫秒').toBeLessThan(50);

      /* ---------- 3. 门槛外那份巨型文件：为什么这篇不办 ---------- */
      const giant = [...index.files.entries()].sort((a, b) => b[1].lineCount - a[1].lineCount)[0]!;
      const gtf = await io.readText(giant[0]);
      const g0 = performance.now();
      parser.parseText(gtf.text, giant[0]);
      const giantParseMs = performance.now() - g0;
      // 单价取热态（首笔含 JIT）：这一笔在开关打开后**每次停笔**都要重付一遍
      const g1 = performance.now();
      parser.parseText(gtf.text, giant[0]);
      const giantParseHotMs = performance.now() - g1;
      // 反事实单价：**若不设体量档**，这篇每次停笔都要付多少（读盘不算，模型里已有全文）
      const g2 = performance.now();
      const gRes = lens.provide({
        kind: 'codeLens',
        path: giant[0],
        text: gtf.text,
        project: null,
        lineCount: giant[1].lineCount,
      });
      const giantProvideMs = performance.now() - g2;
      const giantLenses = gRes && gRes.kind === 'codeLens' ? gRes.lenses.length : -1;
      expect(giant[1].lineCount, '本档的取证对象必须是超阈值巨型文件').toBeGreaterThanOrEqual(LARGE_FILE_LINES);
      console.log(
        `[b8] 巨型文件 ${giant[1].lineCount} 行 / ${giant[1].functions.length} 定义：单次 parseText 冷 ${giantParseMs.toFixed(1)}ms` +
          ` / 热 ${giantParseHotMs.toFixed(1)}ms；不设体量档则一次 provide ${giantProvideMs.toFixed(1)}ms 出 ${giantLenses} 条` +
          ` ⇒ 每次停笔都付这一笔不值（与 stickyScroll / 面包屑同一条降级）`,
      );
      expect(giantParseMs).toBeGreaterThan(5);
      expect(giantLenses, '体量档拦掉的是一篇「真能出注解」的文件，否则这道闸没有代价').toBeGreaterThan(0);
    } finally {
      await kernel.stop();
    }
  }, 600_000);
});
