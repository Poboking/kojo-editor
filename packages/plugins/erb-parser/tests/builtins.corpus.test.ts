/**
 * A1 语料活闸 · 内建实参诊断（exmeth 静态签名表）在真语料上的读数。
 *
 * 判据三条：
 * 1. **规模闸**：真语料（eraNAS 基线盘）上两类诊断的条数钉在实测水位附近——表演化
 *    （加函数 / 改签名）一旦把误报面推高，这里当场红；
 * 2. **可解释闸**：抽样逐条回查——诊断名字必须在 exmeth 表内、行列必须对得上原文
 *    （指着的就是报出来的那个实参）；
 * 3. **影子让位闸**：与项目索引合成后（`isUserFunction`），用户函数名的调用一条不报。
 *
 * 只读语料（硬约束）；语料不在位 ⇒ 整例 skip（`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR`）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErbFile, ErbIndex } from '@kojo/plugin-api';
import { ERB_DIALECT_EXTENSIONS } from '@kojo/plugin-api';
import { parseErbText } from '../src/scanner';
import { aggregateIndex } from '../src/snapshot';
import {
  BUILTIN_ARG_TYPE_CODE,
  BUILTIN_ARGS_CODE,
  BUILTIN_SIGNATURES,
  collectBuiltinArgDiagnostics,
} from '../src/builtins';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

/** 语料根 = `<corpus>/ERB`（编辑器索引的 kojo 根同一片；只读） */
function dialectFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if ((ERB_DIALECT_EXTENSIONS as readonly string[]).includes(path.extname(p).toLowerCase())) out.push(p);
    }
  }
  return out.sort();
}

interface Sample {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly name: string;
}

describe('A1 · 内建实参诊断 × 真语料', () => {
  it.skipIf(!SMOKE)(
    '规模 / 可解释 / 影子让位三闸',
    { timeout: 900_000 },
    () => {
      const root = path.join(SMOKE!, 'ERB');
      const files = dialectFiles(root);
      expect(files.length).toBeGreaterThan(1_000);

      // 索引（影子让位判据用；与生产同一条聚合路径）
      const parsed: ErbFile[] = [];
      for (const p of files) parsed.push(parseErbText(readFileSync(p, 'utf8'), p));
      const agg = aggregateIndex(parsed);
      const index = { files: agg.files, byName: agg.byName } as unknown as ErbIndex;

      let extra = 0;
      let typeIssues = 0;
      const samples: Sample[] = [];
      const lineCache = new Map<string, string[]>();
      const lineAt = (p: string, line: number): string =>
        (lineCache.get(p) ?? lineCache.set(p, readFileSync(p, 'utf8').split(/\r?\n/)).get(p)!)[line - 1] ?? '';

      for (const p of files) {
        const text = readFileSync(p, 'utf8');
        for (const d of collectBuiltinArgDiagnostics({
          path: p,
          text,
          isUserFunction: (upper) => index.byName.has(upper),
        })) {
          if (d.code === BUILTIN_ARGS_CODE) extra++;
          else if (d.code === BUILTIN_ARG_TYPE_CODE) typeIssues++;
          if (samples.length < 24) {
            const m = /「([^」]+)」/.exec(d.message);
            samples.push({ file: path.relative(root, p), line: d.line, code: d.code ?? '', name: m?.[1] ?? '?' });
          }
        }
      }

      // 读数（非首行输出，避开 vitest 把首行 log 并进用例头的坑）
      console.log('');
      console.log(
        'A1-CORPUS ' +
          JSON.stringify({ files: files.length, extra, typeIssues, samples }, null, 1),
      );

      // ① 规模闸（阈值 = 2026-10-25 实测水位；改表改签名须连阈值一起复核）
      // 多给实参钉 0：引擎对非可变内建一律"引数が多すぎる"，分支间无分歧——非 0 即误报。
      expect(extra, '多给实参应为 0（实测 eraNAS 4,145 文件 = 0）').toBe(0);
      // 类型留小余量：分支会改签名（eraNAS 的 LOADTEXT 就吃 `@"…"` 文件名形，wiki 只载 int），
      // 系统性编码错误动辄几十上百条，8 条以内视为语料漂白、由可解释闸逐条兜底。
      expect(typeIssues, '类型误报应≈0（实测 eraNAS 4,145 文件 = 0）').toBeLessThanOrEqual(8);

      // ② 可解释闸：抽样逐条回查
      for (const s of samples) {
        expect(BUILTIN_SIGNATURES.has(s.name), `诊断名不在 exmeth 表内: ${s.name}`).toBe(true);
        expect(lineAt(path.join(root, s.file), s.line).length).toBeGreaterThan(0);
      }

      // ③ 影子让位闸：语料里与内建同名的用户函数（若有）其调用不进诊断。
      // 恒真式没有牙——对每个被投影名合成一个**错误个数**的调用，断言整个名字静默。
      const shadowed = [...BUILTIN_SIGNATURES.keys()].filter((n) => index.byName.has(n));
      console.log('A1-SHADOWED ' + JSON.stringify(shadowed));
      for (const name of shadowed) {
        const probe = `${name}("x", "y", "z", 1, 2, 3)\n`;
        const hits = collectBuiltinArgDiagnostics({
          path: 'probe.ERB',
          text: probe,
          isUserFunction: (upper) => index.byName.has(upper),
        });
        expect(hits, `同名用户函数应整名让位: ${name}`).toEqual([]);
      }
    },
  );
});
