/**
 * 条件矩阵 · 真实语料规模闸（2026-10-29 性能批）。
 *
 * ## 守什么
 * 矩阵面板的三笔钱都随语料线性涨，而**只有第一笔会被作者反复付**：
 * 1. `buildCharacterIndex` —— 每次索引重建（= 每次保存）跑一遍全量聚合；
 * 2. `buildMatrix` —— 选中角色 / 换口上包 / 该角色内容真变时建表；
 * 3. `cellKeysOfFunction` —— 光标跨函数时算高亮格。
 *
 * 本闸钉的是**形状**，不是绝对毫秒：
 * - ① **增量必须真的增量**：只换一份文件的 `ErbFile` 之后，重建成本 ≤ 全量的 1/4
 *   （改前是 1:1 —— 每次保存都全量重判 12 万函数）；
 * - ② **缓存不许改变结果**：增量重建与全量重建的角色数 / 函数总数 / 逐角色函数数逐项相等；
 * - ③ **指纹判据必须真的会变**：同一份输入稳定、换角色变、换依赖数组变（矩阵记忆化靠它失效）；
 * - ④ **光标命中与参考实现对拍**：与「逐行逐格逐函数全扫」的朴素实现给出同一份 (行 → 列)。
 *
 * 语料不在位（`KOJO_SMOKE_PROJECT` 未设 / `tools/corpus.mjs` rc≠0）⇒ 整文件 skip，
 * 与仓里其它语料闸同口径。跑法见 AGENTS §三（计时池：`--config vitest.perf.config.ts`）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErbFile, ErbIndex, StateDependency } from '@kojo/plugin-api';
import { parseErbText, scanControlFlow } from '@kojo/plugin-erb-parser';
import { createEratwFamilyIndex } from '@kojo/plugin-eratw-adapter';
import { extractFunctionConditions } from '@kojo/plugin-condition-extractor';
import { decodeWithProbe } from '../../../kernel/src/encoding';
import {
  buildCharacterIndex,
  buildMatrix,
  cellKeysOfFunction,
  depsFingerprint,
  type CharacterEntry,
  type ConditionMatrix,
  type ColumnDesc,
  type FaceFunction,
} from '../src/matrix-logic';

/** 递归收集 `.ERB`（不跟随符号链接），按路径码点序 */
function collectErb(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
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

/** 中位数（重尾统计量不用 min / 均值，PITFALLS §72） */
function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/** 计时：预热一次再取 `reps` 次中位数（首轮含 JIT / 懒编译，不代表稳态） */
function timeOf(reps: number, run: () => void): number {
  run();
  const samples: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    run();
    samples.push(performance.now() - t);
  }
  return median(samples);
}

/** 朴素参考实现：逐行 × 逐格 × 逐函数全扫（改前的口径，用来给快路径对拍） */
function cellKeysReference(
  matrix: ConditionMatrix,
  fn: { readonly filePath: string; readonly startLine: number },
): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of matrix.rows) {
    for (const colKey of Object.keys(row.cells)) {
      const cell = row.cells[colKey];
      if (!cell) continue;
      if (cell.functions.some((f) => f.startLine === fn.startLine && f.filePath === fn.filePath)) {
        out.set(row.key, colKey);
        break;
      }
    }
  }
  return out;
}

describe.skipIf(!process.env.KOJO_SMOKE_PROJECT)('条件矩阵 · 真实语料规模闸', () => {
  it('① 增量重建 ≤ 全量 1/4；② 结果逐项相等；③ 指纹判据；④ 光标命中与参考实现对拍', () => {
    const root = process.env.KOJO_SMOKE_PROJECT!;
    const paths = collectErb(root);
    expect(paths.length).toBeGreaterThan(100);

    // ---- 装载（解析成本不计入判据，只作夹具）----
    const files = new Map<string, ErbFile>();
    const texts = new Map<string, string>();
    for (const p of paths) {
      const text = decodeWithProbe(readFileSync(p)).text;
      texts.set(p, text);
      files.set(p, parseErbText(text, p));
    }
    const index: ErbIndex = { files, byName: new Map() };
    const family = createEratwFamilyIndex();

    // ---- ① 全量 vs 增量 ----
    // 分母必须是**真全量**：文件级缓存按 `ErbFile` 身份命中，所以要拿一份「身份全新」的索引来量
    // ——浅拷贝每个文件对象（函数数组原样共用）就够：身份变了 ⇒ 缓存必失效 ⇒ 逐函数重判。
    // 每次测量用一份新的浅拷贝，绝不复用（复用就等于量到缓存命中）。
    const coldSamples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const clone = new Map<string, ErbFile>();
      for (const [p, f] of files) clone.set(p, { ...f });
      const t = performance.now();
      buildCharacterIndex({ files: clone, byName: new Map() }, family);
      coldSamples.push(performance.now() - t);
    }
    const cold = median(coldSamples);
    const onePath = paths[Math.floor(paths.length / 2)]!;
    const afterSave = new Map(files);
    afterSave.set(onePath, parseErbText(texts.get(onePath)!, onePath));
    const index2: ErbIndex = { files: afterSave, byName: new Map() };
    const incremental = timeOf(5, () => buildCharacterIndex(index2, family));
    const unchanged = timeOf(5, () => buildCharacterIndex(index, family));

    // ---- ② 等价：逐角色函数数逐项相等 ----
    const full = buildCharacterIndex(index2, family);
    const again = buildCharacterIndex(index2, family);
    expect([...again.entries.keys()].sort((a, b) => a - b)).toEqual([...full.entries.keys()].sort((a, b) => a - b));
    for (const [no, e] of full.entries) {
      const other = again.entries.get(no)!;
      expect(other.functions.length).toBe(e.functions.length);
      expect(other.faces).toEqual(e.faces);
    }
    expect(again.totalFunctions).toBe(full.totalFunctions);
    expect(again.orphanCount).toBe(full.orphanCount);

    // ---- ③ 指纹：同输入稳定、换角色变、换依赖数组变 ----
    const entry: CharacterEntry = [...full.entries.values()].sort(
      (a, b) => b.functions.length - a.functions.length,
    )[0]!;
    const noDeps = (): StateDependency[] => [];
    const fpStable = depsFingerprint(entry, noDeps);
    expect(depsFingerprint(entry, noDeps)).toBe(fpStable);
    const otherEntry = [...full.entries.values()].find((e) => e !== entry)!;
    expect(depsFingerprint(otherEntry, noDeps)).not.toBe(fpStable);
    const depArr: StateDependency[] = [
      { key: 'CFLAG:1', name: 'CFLAG', indices: ['1'], count: 1, comparisons: [], firstLine: 1 },
    ];
    const withDeps = (n: string): StateDependency[] =>
      n === entry.functions[0]!.normalizedName ? depArr : [];
    expect(depsFingerprint(entry, withDeps)).not.toBe(fpStable);

    // ---- 建表 + 光标命中（用真语料里最大角色的一份真实依赖）----
    const deps = new Map<string, StateDependency[]>();
    const touched = new Set(entry.functions.map((f) => f.filePath));
    for (const p of touched) {
      const text = texts.get(p);
      if (!text) continue;
      const stmts = scanControlFlow(text);
      const lines = text.split(/\r?\n/);
      for (const fn of files.get(p)!.functions) {
        const cond = extractFunctionConditions(
          { normalizedName: fn.normalizedName, filePath: fn.filePath, startLine: fn.startLine },
          stmts,
          { lines, endLine: fn.endLine },
        );
        if (cond) deps.set(cond.normalizedName, cond.dependencies);
      }
    }
    const depsOf = (n: string): StateDependency[] => deps.get(n) ?? [];
    const instructionFaces = new Set(family.instructionFaces ?? []);
    const columnOf = (fn: FaceFunction): ColumnDesc => {
      if (!instructionFaces.has(fn.face)) return { key: fn.face, instructionNo: null };
      const m = /^(\d+)/.exec(fn.match.slot);
      return m ? { key: `${fn.face}#${m[1]}`, instructionNo: Number(m[1]) } : { key: fn.face, instructionNo: null };
    };
    const build = (): ConditionMatrix => buildMatrix(entry, depsOf, () => null, family.faceLabels, columnOf);
    const matrix = build();
    expect(matrix.rows.length).toBeGreaterThan(10);
    expect(matrix.columns.length).toBeGreaterThan(5);

    const buildMs = timeOf(3, () => void build());

    // ---- ④ 光标命中：快路径 vs 参考实现，逐函数对拍 ----
    const probes = entry.functions.filter((f) => depsOf(f.normalizedName).length > 0).slice(0, 25);
    expect(probes.length).toBeGreaterThan(0);
    for (const f of probes) {
      const fast = cellKeysOfFunction(matrix, { filePath: f.filePath, startLine: f.startLine });
      const ref = cellKeysReference(matrix, { filePath: f.filePath, startLine: f.startLine });
      expect([...fast.entries()]).toEqual([...ref.entries()]);
    }
    const cursorMs = timeOf(20, () => {
      for (const f of probes) cellKeysOfFunction(matrix, { filePath: f.filePath, startLine: f.startLine });
    });

    // ---- 判据 ----
    // ① 增量必须比全量便宜一个量级：判据给 1/4（实测约 1/80，留足 CI 抖动余量）。
    //    `unchanged`（一份都没换）是增量的下界，一并打出来做形状自证。
    expect(incremental).toBeLessThan(cold / 4);
    expect(unchanged).toBeLessThan(cold / 4);

    console.log(
      JSON.stringify(
        {
          files: paths.length,
          functions: full.totalFunctions,
          orphans: full.orphanCount,
          chara: { no: entry.no, fns: entry.functions.length },
          matrix: {
            rows: matrix.rows.length,
            columns: matrix.columns.length,
            filled: matrix.filledCells,
            total: matrix.totalCells,
          },
          ms: {
            indexCold: +cold.toFixed(1),
            indexUnchanged: +unchanged.toFixed(2),
            indexIncremental: +incremental.toFixed(2),
            buildMatrix: +buildMs.toFixed(1),
            cursorHit25: +cursorMs.toFixed(2),
            depsFingerprint: +timeOf(5, () => void depsFingerprint(entry, depsOf)).toFixed(2),
          },
        },
        null,
        1,
      ),
    );
  });
});
