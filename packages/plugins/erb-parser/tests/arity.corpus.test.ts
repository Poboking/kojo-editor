/**
 * ERBDIAG-C 语料活闸 · 用户函数实参判据（D02 翻转后口径）。
 *
 * 引擎权威依据（`Process.CalledFunction.ConvertArg` + `ErbLoader` 的形参表装载，行号会漂）：
 * - **多给**：转换循环上界是 `fixedArgCount`，多余实参既不报错也不警告 ⇒ 一条不产；
 * - **少给**：缺的槽先取 `func.Def[i]`，而装载期对 **ARG / ARGS / ARGF 家族**形参
 *   无条件**合成**默认值（int→0 / float→0.0 / string→""），所以作者写 `@FUNC(ARG, ARG:1)`
 *   时**没有一个槽是必需的**；只有「名字不是 ARG 家族、又没写 `= 值`」的槽才可能吃到
 *   `CanNotOmitArgWithMessage`（`emuera.config:61` 明写 `ALLOW ARGUMENTS OMISSION FOR
 *   USER FUNCTIONS:NO`，即 `CompatiFuncArgOptional` = false，兜不住这一档）；
 * - **省略可选**：合法写法 ⇒ 一条不产。
 *
 * 判据四条（每条都带"回退即红"的牙）：
 * 1. **扫描形状闸**：语料里多给调用点仍 = 111（组长 2026-11-24 实测；掉了 = 扫描/目录被改坏）；
 * 2. **翻转闸**：多给 / 省略可选 / 「ARG 家族的少给」三类落点，规则层一条不产；
 * 3. **对拍闸**：本文件自带一份**独立**分类器（只用 `erbCallSitesOf` 给的 `given` + 形参表），
 *    它与 `arity.ts` 的 `arityOutcomeOf` 必须逐位同结论，且规则层产出 == `missing-required` 全集；
 * 4. **可解释闸**：`missing-required` 逐条带定义行原文，非 ARG 家族名 = 唯一的真错候选。
 *
 * 只读语料（硬约束）；语料不在位 ⇒ 整例 skip（`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR`）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErbFile, ErbIndex, ErbParam, LineDecoration } from '@kojo/plugin-api';
import { ERB_DIALECT_EXTENSIONS } from '@kojo/plugin-api';
import { parseErbText } from '../src/scanner';
import { aggregateIndex } from '../src/snapshot';
import {
  ARITY_MISMATCH_CODE,
  arityOutcomeOf,
  arityParamsOf,
  collectArityDiagnostics,
  erbCallSitesOf,
  type ArityOutcome,
} from '../src/arity';
import { normalizedUpper, splitErbLines, visibleCodeLineList } from '../src/references';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

/** 语料根 = `<corpus>/ERB`（与 `builtins.corpus.test.ts` 同一片；只读） */
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

/* ==================== 独立分类器（对拍的另一边：不复用 `arity.ts` 的任何算式） ==================== */

type Kind = ArityOutcome['kind'];

/** 可变下标形参 ⇒ 个数不可证（独立实现） */
function oracleVariableSlot(params: readonly ErbParam[]): boolean {
  for (const p of params) {
    const m = /^(?:ARG|ARGS)\s*[:：](.*)$/i.exec(p.name);
    if (m !== null && !/^\d+$/.test(m[1]!.trim())) return true;
  }
  return false;
}

/** 引擎装载期会合成默认值的名字家族：`ARG` / `ARGS` / `ARGF`（含任意下标形） */
const ARG_FAMILY_NAME = /^(?:ARG|ARGS|ARGF)\b/i;

/**
 * 引擎口径的"可省略"（独立实现；出处见 `arity.ts` 里 `omissibleSlot` 的注）：
 * 显式 `= 值` ∨ **裸名**（`ErbLoader` 的 `ArgHasNotSubscript` 硬门保证裸名必是 ARG 家族或私有变量，
 * 两者装载期都拿到合成默认值）∨ ARG 家族的下标形。
 */
const HAS_SUBSCRIPT_NAME = /[:：]/;
const oracleOmissible = (p: ErbParam): boolean =>
  p.hasDefault || !HAS_SUBSCRIPT_NAME.test(p.name) || ARG_FAMILY_NAME.test(p.name);

/** 老判据口径的"可省略"：只认显式 `= 值`（D02 之前生产在用的那一套） */
const oracleLegacyOmissible = (p: ErbParam): boolean => p.hasDefault;

function requiredUnder(params: readonly ErbParam[], omissible: (p: ErbParam) => boolean): number {
  let required = 0;
  for (let i = 0; i < params.length; i++) {
    if (!omissible(params[i]!)) required = i + 1;
  }
  return required;
}

function oracleKind(given: number, params: readonly ErbParam[]): Kind {
  if (oracleVariableSlot(params)) return 'unprovable';
  const total = params.length;
  const required = requiredUnder(params, oracleOmissible);
  if (given > total) return 'extra';
  if (given < required) return 'missing-required';
  if (given < total) return 'omitted-optional';
  return 'ok';
}

/** 诊断落点（区间口径：1 基、结束列不含端点、无实参落函数名） */
function rangeOf(site: { line: number; nameStart: number; nameEnd: number; argFirst: number; argLast: number }): string {
  return site.argFirst >= 0
    ? `${site.line}:${site.argFirst + 1}-${site.argLast + 1}`
    : `${site.line}:${site.nameStart + 1}-${site.nameEnd + 1}`;
}

interface MissSample {
  readonly file: string;
  readonly line: number;
  readonly call: string;
  readonly name: string;
  readonly given: number;
  readonly required: number;
  readonly offender: string;
  readonly defLine: number;
  readonly defText: string;
}

describe('ERBDIAG-C · 用户函数实参 × 真语料', () => {
  it.skipIf(!SMOKE)(
    '翻转 / 对拍 / 少给必需可解释四闸',
    { timeout: 900_000 },
    () => {
      const root = path.join(SMOKE!, 'ERB');
      const files = dialectFiles(root);
      expect(files.length).toBeGreaterThan(1_000);

      const parsed: ErbFile[] = [];
      for (const p of files) parsed.push(parseErbText(readFileSync(p, 'utf8'), p));
      const agg = aggregateIndex(parsed);
      const index = { files: agg.files, byName: agg.byName } as unknown as ErbIndex;
      const catalog = (upper: string) => arityParamsOf(index, upper);

      const lineCache = new Map<string, string[]>();
      const lineAt = (p: string, line: number): string =>
        (lineCache.get(p) ?? lineCache.set(p, readFileSync(p, 'utf8').split(/\r?\n/)).get(p)!)[line - 1] ?? '';

      const counts: Record<Kind, number> = {
        ok: 0,
        extra: 0,
        'missing-required': 0,
        'omitted-optional': 0,
        unprovable: 0,
      };
      /** 对拍按 kind 分桶的落点键（生产条数的交叉核对全靠它，不碰文案） */
      const keys: Record<Kind, Set<string>> = {
        ok: new Set(),
        extra: new Set(),
        'missing-required': new Set(),
        'omitted-optional': new Set(),
        unprovable: new Set(),
      };
      /** 老判据（只认显式 `=`）判出的"少给"总数：其中 ARG 家族那一坨就是 D02 摘掉的假阳 */
      let legacyStrictMissing = 0;
      /** `arity.ts` 的结论 vs 独立分类器的结论分歧（非 0 = 判据长出了第二份） */
      const disagreement: string[] = [];
      const production = new Map<string, LineDecoration>();
      let productionTotal = 0;
      let defaultTotal = 0;
      const misses: MissSample[] = [];
      const extraSamples: string[] = [];

      for (const p of files) {
        const text = readFileSync(p, 'utf8');
        const rel = path.relative(root, p);

        // 规则层（显式打开定罪开关）：这一趟量的是"判据本身"，接线默认开关另有一趟
        for (const d of collectArityDiagnostics({ path: p, text, catalog, diagnoseMissingRequired: true })) {
          productionTotal++;
          production.set(`${rel}|${d.line}:${d.startColumn}-${d.endColumn}`, d);
        }
        // 接线默认口径（开关关着）⇒ 语料上必须一条不上屏
        defaultTotal += collectArityDiagnostics({ path: p, text, catalog }).length;

        // 独立对拍路径：同一把扫描尺（`erbCallSitesOf`）+ 自己算的分类
        for (const line of visibleCodeLineList(splitErbLines(text))) {
          if (line.isDefinition) continue;
          if (!line.isCallLine && line.raw.indexOf('(') < 0) continue;
          for (const site of erbCallSitesOf(line, line.codeView())) {
            const params = catalog(normalizedUpper(site.name));
            if (!params) continue;
            const kind = oracleKind(site.given, params);
            counts[kind]++;
            keys[kind].add(`${rel}|${rangeOf(site)}`);
            const engineKind = arityOutcomeOf(site, params).kind;
            if (engineKind !== kind && disagreement.length < 12) {
              disagreement.push(`${rel}:${site.line} 「${site.name}」对拍=${kind} / arity.ts=${engineKind}`);
            }
            if (site.given < requiredUnder(params, oracleLegacyOmissible)) legacyStrictMissing++;
            if (kind === 'extra' && extraSamples.length < 8) {
              extraSamples.push(`${rel}:${site.line} 「${site.name}」形参 ${params.length} 个 / 实参 ${site.given} 个`);
            }
            if (kind !== 'missing-required') continue;
            const required = requiredUnder(params, oracleOmissible);
            const def = index.byName.defsOf(normalizedUpper(site.name))[0];
            misses.push({
              file: rel,
              line: site.line,
              call: line.raw.trim(),
              name: site.name,
              given: site.given,
              required,
              offender: params[required - 1]!.name,
              defLine: def?.startLine ?? 0,
              defText: def ? lineAt(def.filePath, def.startLine).trim() : '?',
            });
          }
        }
      }

      const producedIn = (kind: Kind): string[] =>
        [...keys[kind]].filter((k) => production.has(k)).slice(0, 20);
      const missingNotProduced = [...keys['missing-required']].filter((k) => !production.has(k)).slice(0, 20);

      console.log('');
      console.log(
        'D02-CORPUS ' +
          JSON.stringify(
            { files: files.length, counts, legacyStrictMissing, productionTotal, defaultTotal },
            null,
            1,
          ),
      );
      console.log('D02-EXTRA-SAMPLES ' + JSON.stringify(extraSamples, null, 1));
      console.log('D02-MISSING-REQUIRED-SAMPLES ' + JSON.stringify(misses.slice(0, 12), null, 1));
      console.log('D02-TOLERATED-PRODUCED ' + JSON.stringify(producedIn('extra').concat(producedIn('omitted-optional'), producedIn('unprovable')), null, 1));
      console.log('D02-DISAGREEMENT ' + JSON.stringify(disagreement, null, 1));
      console.log(
        'D02-MISSING-NOT-PRODUCED ' +
          JSON.stringify(missingNotProduced, null, 1) +
          ' / MISSING-KEYS ' +
          keys['missing-required'].size +
          ' / PRODUCTION-KEYS ' +
          production.size,
      );

      // ① 扫描形状闸：多给调用点在语料里仍然是 111 处（组长 2026-11-24 实测同数）
      expect(counts.extra, '语料里的多给调用点数（扫描/目录形状变了就该红）').toBe(111);

      // ② 翻转闸：引擎容忍的三档一条不产（多给 / 省略可选 / 个数不可证）
      expect(producedIn('extra'), '「多给」不得产出诊断（引擎 ConvertArg 只吃到 fixedArgCount）').toEqual([]);
      expect(producedIn('omitted-optional'), '「省略有默认值的形参」不是引擎错误 ⇒ 不产').toEqual([]);
      expect(producedIn('unprovable'), '可变下标形参 ⇒ 不猜 ⇒ 不产').toEqual([]);

      // ③ 假阳闸：老判据（只认显式 `=`）判出的"少给"绝大多数是引擎合成默认值那一坨；
      //    新判据产出的集合必须是它的真子集，且**每一条产出都能被对拍解释**。
      expect(
        legacyStrictMissing - counts['missing-required'],
        '引擎合成默认值的那些槽（ARG 家族 / 裸名私有变量）必须整条摘掉'
      ).toBe(44_606);
      const producedNotExplainable = [...production.keys()].filter((k) => !keys['missing-required'].has(k)).slice(0, 20);
      expect(producedNotExplainable, '规则层产出的每一条都必须是对拍判出的 missing-required').toEqual([]);

      // ④ 对拍闸：独立分类器与 `arity.ts` 逐位同结论；规则层产出 == `missing-required` 全集
      expect(disagreement, '判据只许有一份（对拍 vs arity.ts 分歧即红）').toEqual([]);
      expect(missingNotProduced, '对拍判出的少给必需，规则层必须逐位产出').toEqual([]);
      expect(productionTotal, '生产条数 == 对拍 missing-required 条数').toBe(counts['missing-required']);
      expect([...production.values()].every((d) => d.code === ARITY_MISMATCH_CODE)).toBe(true);

      // ⑤ 可解释闸：`missing-required` 的 offender 必须是"带下标 + 非 ARG 家族"那一族
      //    （裸名与家族名由引擎合成默认值 ⇒ 一旦混进来就是判据又漂回假阳）
      for (const m of misses.slice(0, 12)) {
        expect(oracleOmissible({ name: m.offender, hasDefault: false }), `offender 不可是引擎会补默认值的槽: ${m.file}:${m.line} ${m.offender}`).toBe(
          false,
        );
      }
      //    并如实记下这一族今天仍**不可定罪**：默认接线口径 0 条上屏（`defaultTotal`）
      expect(defaultTotal, '默认接线口径（定罪开关关着）必须一条不上屏').toBe(0);
    },
  );
});
