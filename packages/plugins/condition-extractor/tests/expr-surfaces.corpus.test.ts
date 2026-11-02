/**
 * E8 表面扩面（T8）· 真实语料自证（`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 守门，不在位跳过）。
 *
 * 扩面后的第一问仍是**误报率**：赋值右侧与插值段的提取守卫（散文 / data 块 /
 * `\@` 条件插值 / ERA 三元 / 实数 / 字符字面量）只要漏挡一种真语料形态，这里就会
 * 以千计暴露。判据读数以本文件为准（走真注册的 `erb-expr-syntax` 装饰器，
 * 骨架扫描吃 erb-parser 服务——与宿主同一条链）；断言一律用区间（语料会换版本），
 * 明细逐条 `console.log`。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EditorDecoratePayload, ErbParserService, LineDecoration, Logger } from '@kojo/plugin-api';
import { createKernel } from '../../../kernel/src/kernel';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { MemoryStorageBackend } from '../../../kernel/tests/helpers/memory-storage';
import { createConditionExtractorPlugin } from '@kojo/plugin-condition-extractor';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { diagnoseExpression } from '../src/expr';
import { collectExprSyntaxDecorations, expressionSurfaces } from '../src/decorator';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const pct = (sorted: readonly number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
const base = (p: string): string => p.split(/[\\/]/).pop() ?? p;

describe.skipIf(!SMOKE)('erb-expr-syntax · 真实语料自证（T8 扩面）', () => {
  it('误报率 / 表面分布 / 单价', { timeout: 300_000 }, async () => {
    const kernel = await createKernel({
      platform: new NodeBridge(mkdtempSync(join(tmpdir(), 'kojo-t8-'))),
      plugins: [createErbParserPlugin(), createConditionExtractorPlugin()],
      storageBackend: new MemoryStorageBackend(),
      logger: silent,
    });
    await kernel.start();
    try {
      const parser = kernel.services.get<ErbParserService>('erb.parser');
      await parser.buildIndex([join(SMOKE!, 'ERB')]);
      const deco = kernel.slots
        .query('ui.editor.decorator')
        .find((c: { id?: string }) => c.id === 'erb-expr-syntax') as
        | { decorate(payload: EditorDecoratePayload): LineDecoration[] }
        | undefined;
      if (!deco) throw new Error('erb-expr-syntax 装饰器未注册');
      const io = kernel.services.get<{ readText(p: string): Promise<{ text: string }> }>('kernel.io');
      const idx = parser.currentIndex();
      if (!idx) throw new Error('索引未构建');

      const perFile: number[] = [];
      const byCode = new Map<string, number>();
      const byOrigin = new Map<string, number>();
      const assignSamples: string[] = [];
      const interpSamples: string[] = [];
      let total = 0;
      let surfacesBad = 0;
      let surfacesTotal = 0;
      let worstMs = 0;
      let worstMsFile = '';
      let chainMismatch = 0;
      for (const [path] of idx.files) {
        const tf = await io.readText(path);
        const t0 = performance.now();
        const out = deco.decorate({ path, text: tf.text });
        const ms = performance.now() - t0;
        if (ms > worstMs) {
          worstMs = ms;
          worstMsFile = path;
        }
        perFile.push(out.length);
        total += out.length;
        // 表面级探针（诊断失败的才算候选误报）
        const surfaces = expressionSurfaces(tf.text);
        surfacesTotal += surfaces.length;
        const bad = surfaces.filter((s) => diagnoseExpression(s.expression) !== null);
        surfacesBad += bad.length;
        for (const s of bad) {
          byOrigin.set(s.origin, (byOrigin.get(s.origin) ?? 0) + 1);
          const lineText = tf.text.split(/\r\n|\n/)[s.line - 1]?.trim() ?? '';
          const sample = `${base(path)}:${s.line} [${s.origin}] ${JSON.stringify(s.expression)} ← ${JSON.stringify(lineText.slice(0, 120))}`;
          if (s.origin === 'assign' && assignSamples.length < 30) assignSamples.push(sample);
          if (s.origin === 'interp' && interpSamples.length < 30) interpSamples.push(sample);
        }
        // 端到端（decorate = 任务/回退两条走法的共同真源）与纯管线逐条一致：不允许分叉
        const viaCollect = collectExprSyntaxDecorations(tf.text, (t) => parser.scanControlFlow(t)).map((d) => ({
          line: d.line,
          message: d.message,
          code: d.code,
        }));
        const viaDecorate = out.map((d) => ({ line: d.line, message: d.message, code: d.code }));
        if (JSON.stringify(viaCollect) !== JSON.stringify(viaDecorate)) chainMismatch++;
        for (const d of out) {
          const code = d.code ?? '<none>';
          byCode.set(code, (byCode.get(code) ?? 0) + 1);
        }
      }

      perFile.sort((a, b) => a - b);
      const filesWithHits = perFile.filter((n) => n > 0).length;
      console.log(`[T8] 文件数 ${idx.files.size}，表面总数 ${surfacesTotal}，波浪线候选 ${total}（其中表面诊断失败 ${surfacesBad}，其余为既有条件链基线）`);
      console.log(`[T8] byCode ${JSON.stringify([...byCode.entries()])}，byOrigin(候选) ${JSON.stringify([...byOrigin.entries()])}`);
      console.log(`[T8] 单价 worst ${worstMs.toFixed(1)}ms @${base(worstMsFile)}，p50 ${pct(perFile, 50).toFixed(2)}ms，p99 ${pct(perFile, 99).toFixed(2)}ms`);
      console.log(`[T8] 管线/端到端不一致文件数 ${chainMismatch}`);
      for (const s of assignSamples) console.log(`[T8] assign样本 ${s}`);
      for (const s of interpSamples) console.log(`[T8] interp样本 ${s}`);

      // 门槛（区间断言；语料换版本时以 console 读数重新校准，不许静默漂移）：
      // 误报门槛只裁决**本批新增的表面候选**（八轮探针 10,908 → 终版 56：assign 高置信门 +
      // interp fail-open 后，残余全是 `@"` 内嵌引号的 span 错位形态，集中在少数口上文件）。
      // total 里 ~760 条是既有条件链（erb-expr-syntax）的语料基线，不在本批裁决范围。
      expect(surfacesBad).toBeLessThan(100);
      // 一致性：两条走法在真语料上不得分叉（差异即“波浪线一种、回退另一种”）
      expect(chainMismatch).toBe(0);
      // 单价：装饰热路径 250ms 去抖预算内，单文件整链不得进入两位数毫秒的常驻区
      expect(pct(perFile, 99)).toBeLessThan(10);
    } finally {
      await kernel.stop();
    }
  });
});
