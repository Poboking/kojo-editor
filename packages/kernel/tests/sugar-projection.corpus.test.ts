/**
 * 糖投影（B 层）**真实语料量化验收** —— 常驻守门，不是一次性探针。
 *
 * ## 为什么必须常驻
 *
 * 升糖重做的验收口径（`docs/LIFT-REPOSITION-2026-10-12.md` §验收口径 4）明确写着：
 * **"必须有量化提升，不接受「跑通就行」"**。没有一件常驻的测量工具，就没有 before/after，
 * 也就无法证明"从 6.5% 到 90%"这句话在**当前代码**上仍然成立——改动一次逐行映射规则、
 * 混进一个过度保守的判据，覆盖率会悄悄掉回 6.5%，而单测全绿。
 *
 * 故本文件把 `docs/LIFT-REMEASURE-2026-10-12.md` 的临时探针**固化**为守门测试：
 * 既打印完整读数（人看），也断言下限（CI 看）。
 *
 * ## 它测的是真实实现，不是"设想中的规则"
 *
 * 全程走生产链路：内核 + `erb-parser`（结构扫描是地基）+ `eratw-adapter` +
 * `kojo-sugar` 的 `sugar.lift`.liftProject（**被测对象本身**），文件来自真实工程索引。
 *
 * 真实游戏数据不入库：`KOJO_SMOKE_PROJECT` 未设置时整组跳过（CI 安全）。
 * 小样本快跑：`PROBE_FILE_LIMIT=300`。
 */

import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErbParserService, SugarLiftService } from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKernel, type Kernel } from '../src/kernel';
import { NodeBridge } from './helpers/node-bridge';
import { MemoryStorageBackend } from './helpers/memory-storage';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createConditionExtractorPlugin } from '@kojo/plugin-condition-extractor';
import { createKojoSugarPlugin } from '@kojo/plugin-kojo-sugar';

const SMOKE_DIR = process.env.KOJO_SMOKE_PROJECT;
const LIMIT = Number(process.env.PROBE_FILE_LIMIT ?? 0);

/** 口上语料目录名（用于"口上文件 vs 系统脚本"分组读数） */
const KOJO_DIR_MARK = '口上';

/**
 * 两类"读者要读的行"的尺子（**两把都要**，各挡一类回归）：
 *
 * - `FORM_PRINT_RE`：四个有糖形态的 `PRINTFORM*W/L/DW/DL` 变体。这是 B 层落地时的
 *   原始主指标（§5.49 起沿用），口径窄——只含"糖能一比一写出来"的行。
 * - `OUTPUT_PRINT_RE`：**全部会被打印出文本的输出行**（含裸 `PRINTFORM` / `PRINTFORMD`
 *   拼句片段，与非 FORM 的 `PRINTL` / `PRINTW` / `PRINTDL` / `PRINTDW` / `PRINT` / `PRINTD`）。
 *   批 F 把这一族接进投影，若仍只用窄尺子，新能力在守门读数里**完全看不见**。
 *
 * 两者都**不含** `PRINTDATA` 系（块开词）与按钮/排版类变体（表外，刻意不投影）。
 */
const FORM_PRINT_RE = /^\s*(PRINTFORM(?:DW|DL|W|L))\b/;
const OUTPUT_PRINT_RE = /^\s*(PRINTFORM(?:DW|DL|W|L|D)?|PRINT(?:DW|DL|W|L|D)?)\b/;

interface Totals {
  files: number;
  filesWithSegments: number;
  totalLines: number;
  projected: number;
  passthrough: number;
  native: number;
  segments: number;
  maxSegments: number;
  /** 台词/旁白行总数（有糖形态的 `PRINTFORM*` 行） */
  speechLines: number;
  /** 其中**落在糖段内**（已显示为糖）的行数 */
  speechProjected: number;
  /** 输出行总数（批 F：含裸 FORM 与非 FORM 系——全部"会被打印出文本"的行） */
  outputLines: number;
  /** 其中已显示为糖的行数 */
  outputProjected: number;
}

const zero = (): Totals => ({
  files: 0,
  filesWithSegments: 0,
  totalLines: 0,
  projected: 0,
  passthrough: 0,
  native: 0,
  segments: 0,
  maxSegments: 0,
  speechLines: 0,
  speechProjected: 0,
  outputLines: 0,
  outputProjected: 0,
});

const pct = (a: number, b: number): string => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`);

function line(t: Totals, label: string): string {
  return (
    `  ${label}：文件 ${t.files}｜有可映射段 ${t.filesWithSegments}（${pct(t.filesWithSegments, t.files)}）` +
    `｜行覆盖 ${pct(t.projected, t.totalLines)}（${t.projected}/${t.totalLines}）` +
    `｜**台词行覆盖 ${pct(t.speechProjected, t.speechLines)}**（${t.speechProjected}/${t.speechLines}）` +
    `｜**输出行覆盖 ${pct(t.outputProjected, t.outputLines)}**（${t.outputProjected}/${t.outputLines}）` +
    `｜段 ${t.segments}（最多 ${t.maxSegments}/文件）`
  );
}

describe.skipIf(!SMOKE_DIR)('糖投影真实语料量化验收', () => {
  it(
    '真实工程全量：行覆盖率 + 分段不变量 + 分因读数',
    async () => {
      const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-proj-'));
      const kernel: Kernel = await createKernel({
        platform: new NodeBridge(appData),
        plugins: [
          createErbParserPlugin(),
          createEratwAdapterPlugin(),
          createConditionExtractorPlugin(),
          createKojoSugarPlugin(),
        ],
        storageBackend: new MemoryStorageBackend(),
      });
      await kernel.start();
      const project = await kernel.project.open(SMOKE_DIR!);
      const parser = kernel.services.get<ErbParserService>(WellKnownServices.ErbParser);
      const sugar = kernel.services.get<SugarLiftService>(WellKnownServices.SugarLift);
      const index = await parser.ensureIndex();

      // 只测原生 ERB（`.kojo` 本身是糖，不属于投影对象）
      const all = [...index.files.keys()].filter((p) => /\.erb$/i.test(p)).sort();
      const use = LIMIT > 0 ? all.slice(0, LIMIT) : all;

      const total = zero();
      const kojo = zero();
      const reasons = new Map<string, number>();
      /**
       * 未被投影的**行首 token** 统计（含样本）。
       *
       * 为什么按 token 而不是按成因枚举：成因告诉我们"归到哪一类"，token 告诉我们
       * "到底是什么代码"——后者才能回答"这十万行 `other` 值不值得再做一层糖"。
       * 本项目的老教训：先看真实样本，再定规则。
       */
      const nativeTokens = new Map<string, { count: number; sample: string }>();
      /**
       * 单文件段数分布（宿主性能判据）。
       *
       * 段数 = 宿主要插的 ViewZone 数：几千个 DOM 视图区是**性能悬崖**，
       * 而"段数"又直接由骨架行（`RETURN` / `LOCAL` / `CALL`）切断决定——
       * 这条分布是"要不要做懒渲染 / 骨架合并"的唯一依据。
       */
      const segBuckets = [0, 0, 0, 0, 0, 0, 0]; // <=50 / <=200 / <=500 / <=1000 / <=2000 / <=5000 / >5000
      const bucketOf = (n: number): number =>
        n <= 50 ? 0 : n <= 200 ? 1 : n <= 500 ? 2 : n <= 1000 ? 3 : n <= 2000 ? 4 : n <= 5000 ? 5 : 6;
      let unaccounted = 0;
      let overlap = 0;
      let unreadable = 0;

      for (const path of use) {
        let source: string;
        try {
          source = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        } catch {
          unreadable++;
          continue;
        }
        const r = sugar.liftProject({ source, filePath: path });
        const isKojo = path.includes(KOJO_DIR_MARK);

        // ---- 不变量 1：三类计数之和 = 总行数（没有行凭空消失）----
        const sum = r.stats.projectedLines + r.stats.passthroughLines + r.stats.nativeLines;
        if (sum !== r.stats.totalLines) unaccounted++;

        // ---- 不变量 2：段升序且互不重叠（宿主 ViewZone 的依据）----
        for (let i = 0; i < r.segments.length; i++) {
          const s = r.segments[i]!;
          const prev = r.segments[i - 1];
          if (s.fromLine > s.toLine || (prev && s.fromLine <= prev.toLine)) overlap++;
        }

        for (const [reason, count] of r.stats.nativeByReason.map((x) => [x.reason, x.count] as const)) {
          reasons.set(reason, (reasons.get(reason) ?? 0) + count);
        }

        // ---- 未投影行按行首 token 归堆（段内行 = 已投影）----
        const covered = new Set<number>();
        for (const s of r.segments) {
          for (let ln = s.fromLine; ln <= s.toLine; ln++) covered.add(ln);
        }
        const srcLines = source.split('\n');
        for (let ln = 1; ln <= srcLines.length; ln++) {
          if (covered.has(ln)) continue;
          const text = (srcLines[ln - 1] ?? '').trim();
          if (text.length === 0 || text.startsWith(';')) continue; // 注释与空行本来就是"透传"
          const m = /^([A-Za-z_$@#][A-Za-z0-9_$]*|[$@#]|\S+)/.exec(text);
          const token = m ? m[1]!.toUpperCase() : '?';
          const rec = nativeTokens.get(token) ?? { count: 0, sample: text.slice(0, 80) };
          rec.count++;
          nativeTokens.set(token, rec);
        }

        // ---- 读者要读的行有多少显示成了糖（两把尺子，见文件头注释）----
        let speech = 0;
        let speechCovered = 0;
        let output = 0;
        let outputCovered = 0;
        for (let ln = 1; ln <= srcLines.length; ln++) {
          const text = srcLines[ln - 1] ?? '';
          const isOutput = OUTPUT_PRINT_RE.test(text);
          if (!isOutput && !FORM_PRINT_RE.test(text)) continue;
          if (isOutput) {
            output++;
            if (covered.has(ln)) outputCovered++;
          }
          if (FORM_PRINT_RE.test(text)) {
            speech++;
            if (covered.has(ln)) speechCovered++;
          }
        }
        for (const t of [total, ...(isKojo ? [kojo] : [])]) {
          t.files++;
          if (r.segments.length > 0) t.filesWithSegments++;
          t.totalLines += r.stats.totalLines;
          t.projected += r.stats.projectedLines;
          t.passthrough += r.stats.passthroughLines;
          t.native += r.stats.nativeLines;
          t.segments += r.segments.length;
          t.maxSegments = Math.max(t.maxSegments, r.segments.length);
          t.speechLines += speech;
          t.speechProjected += speechCovered;
          t.outputLines += output;
          t.outputProjected += outputCovered;
        }
        segBuckets[bucketOf(r.segments.length)]!++;
      }

      // eslint-disable-next-line no-console
      console.log(
        [
          '',
          '========== 糖投影真实语料读数（B 层）==========',
          `样本：${use.length} 个 ERB（全工程 ${all.length}）｜读失败 ${unreadable}`,
          line(total, '全部 ERB'),
          line(kojo, '口上目录'),
          '  保留原代码的分因：',
          ...[...reasons.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `    ${k} = ${v}`),
          '  未投影行按行首 token（前 15）：',
          ...[...nativeTokens.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 15)
            .map(([tok, v]) => `    ${tok.padEnd(18)} ${String(v.count).padStart(7)}   ${v.sample}`),
          `  单文件段数分布：≤50 ${segBuckets[0]}｜≤200 ${segBuckets[1]}｜≤500 ${segBuckets[2]}` +
            `｜≤1000 ${segBuckets[3]}｜≤2000 ${segBuckets[4]}｜≤5000 ${segBuckets[5]}｜>5000 ${segBuckets[6]}`,
          `  不变量违例：计数不平 ${unaccounted}｜段重叠/逆序 ${overlap}`,
          '=============================================',
          '',
        ].join('\n'),
      );

      // ---- 硬不变量（与样本无关，任何输入都不许破）----
      expect(unaccounted).toBe(0);
      expect(overlap).toBe(0);
      expect(unreadable).toBe(0);

      // ---- 覆盖率守门（量化提升的可回归证据）----
      //
      // 三个指标各有分工，缺一个都会掩盖一类回归：
      // - **台词行覆盖**（主指标）：读者真正要读的那类行有多少显示成了糖。
      //   它是本功能的成败线——台词读不出来，其余都是白搭。
      // - **文件覆盖**：有多少文件"打开了能看到人话"（0 命中的文件 = 按了开关没反应）。
      // - **行覆盖**（辅指标）：整份文件的人话密度，用来发现"规则被过度收紧"。
      //
      // 口径说明：行覆盖的分母是**全部行**（含函数骨架、赋值、调用、注释、空行），
      // 因此它天然低于台词行覆盖——两者不可互相替代（`docs/LIFT-REMEASURE` §三 那种
      // "6.5% 行覆盖"与这里的台词行覆盖是两把尺子）。
      expect(total.speechProjected / Math.max(1, total.speechLines)).toBeGreaterThan(0.99);
      // 批 F/G 后的实测读数（全量 2,285 文件）：台词行 **99.2%**（990,914/999,114）、
      // 输出行 **99.2%**（1,060,647/1,069,516）、行覆盖 56.5%。
      // 下限取 0.99 的依据（两个"退化后落点"都算过）：
      // - 退回"非 FORM 系 / 裸 FORM 不投影"（批 F 前）→ 输出行 ≈ 86%，红；
      // - 退回"行内条件一律留原代码"（批 G 前）→ 台词行 98.6%，红。
      expect(total.outputProjected / Math.max(1, total.outputLines)).toBeGreaterThan(0.99);
      expect(total.filesWithSegments / Math.max(1, total.files)).toBeGreaterThan(0.9);
      expect(total.projected / Math.max(1, total.totalLines)).toBeGreaterThan(0.5);
      // 口上目录是主战场，台词行要求更严
      expect(kojo.speechProjected / Math.max(1, kojo.speechLines)).toBeGreaterThan(0.99);
      expect(kojo.outputProjected / Math.max(1, kojo.outputLines)).toBeGreaterThan(0.99);

      await kernel.stop();
    },
    180_000,
  );
});
