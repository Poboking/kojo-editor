/**
 * TRY 系**配对表**在体检与折叠两个读者上的对齐闸（ERBDIAG-B / D03，2026-11-06）。
 *
 * 立文件的理由：配对表唯一真源在 `@kojo/erb-vocab/control-flow`，但它有两个**独立**读者
 * （结构体检 `structure.ts`、折叠 `folding.ts`）——表补一词时若只验其中一个，另一个的
 * 容错分支（`CATCH` 归属 / `funclist` 例外）就会静默漂移，表现是"波浪线不报了但折叠塌了"。
 * 所以这里逐枚词把两个读者都过一遍，判据全部取自引擎注册行为，不取自"看起来像块"。
 *
 * 引擎真源（Emuera `Runtime/Script/Statements/FunctionIdentifier.cs`，行号会漂、以内容为准）：
 * - `funcMatch[X] = "CATCH"` 一共 **8** 枚 ⇒ TRYCGOTO / TRYCJUMP / TRYCCALL（±FORM）
 *   + TRYCJUMPSTR + TRYCCALLSTR；
 * - `funcMatch[X] = "ENDFUNC"` 一共 **3** 枚 ⇒ TRYCALLLIST / TRYGOTOLIST / TRYJUMPLIST；
 * - `funcMatch[CATCH] = "ENDCATCH"`；
 * - `funcMatch` 里查不到的 TRY* 全是**单行语句**（注册行第三枚实参 `isTry` 置 `IS_TRY`，
 *   第四枚 `isTryCatch` 才置 `IS_TRYC`；`CALLS_Instruction` / `GOTO_Instruction` /
 *   `CALL_Instruction` 三族同形状）⇒ TRYCALL / TRYCALLFORM / TRYGOTO / TRYGOTOFORM /
 *   TRYJUMP / TRYJUMPFORM / TRYCALLSTR / TRYJUMPSTR **不开块**。
 *
 * 触发这一批的真实误报（基线语料，合法代码被连环误报两条）：
 * `ERB/SHOP関連/TEST.ERB:13-17` = `TRYCCALLSTR RESULTS` / `PRINTW …` / `CATCH` /
 * `PRINTW …` / `ENDCATCH` ⇒ 旧表只认 6 枚 TRYC，`TRYCCALLSTR` 没开块，于是 `CATCH` 变孤儿
 * （:15）+ `ENDCATCH` 变孤儿（:17）。**一次漏词 = 两条假缺陷。**
 */
import { describe, expect, it } from 'vitest';
import { classifyControlFlow } from '@kojo/erb-vocab/control-flow';
import { checkControlFlowStructure } from '../src/structure';
import { controlFlowFoldingRanges } from '../src/folding';
import { scanControlFlow } from '../src/scanner';

/** 引擎 `funcMatch → "CATCH"` 的全部 8 枚（逐条抄自注册行为，不是正则推出来的） */
const CATCH_OPENERS = [
  'TRYCGOTO',
  'TRYCJUMP',
  'TRYCCALL',
  'TRYCGOTOFORM',
  'TRYCJUMPFORM',
  'TRYCCALLFORM',
  'TRYCJUMPSTR',
  'TRYCCALLSTR',
] as const;

/** 引擎 `funcMatch → "ENDFUNC"` 的全部 3 枚 */
const FUNCLIST_OPENERS = ['TRYCALLLIST', 'TRYGOTOLIST', 'TRYJUMPLIST'] as const;

/** 注册了但**不在** `funcMatch` 里的 TRY* ⇒ 单行语句，不开块 */
const SINGLE_LINE_TRYS = [
  'TRYCALL',
  'TRYCALLFORM',
  'TRYGOTO',
  'TRYGOTOFORM',
  'TRYJUMP',
  'TRYJUMPFORM',
  'TRYCALLSTR',
  'TRYJUMPSTR',
] as const;

/** 8 枚逐条的合法块体（`CATCH` 分支 + `ENDCATCH` 闭合，形状与 TEST.ERB:13-17 一致） */
function has(ranges: readonly { startLine: number; endLine: number }[], a: number, b: number): boolean {
  return ranges.some((r) => r.startLine === a && r.endLine === b);
}

function tryBlock(opener: string): string {
  return [`${opener} RESULTS`, '\tPRINTW 函数正常调用结束', 'CATCH', '\tPRINTW 函数调用失败', 'ENDCATCH', 'RETURN'].join('\n');
}

describe('配对表 · funcMatch→CATCH 的 8 枚全部开块（体检零报 + 折叠给区间）', () => {
  for (const opener of CATCH_OPENERS) {
    it(`${opener}…CATCH…ENDCATCH：零报告`, () => {
      expect(checkControlFlowStructure(tryBlock(opener)), opener).toEqual([]);
    });

    it(`${opener}：开块/分支/闭合三档都被表认出来（扫描器拿到语句、不是静默丢弃）`, () => {
      const kinds = scanControlFlow(tryBlock(opener)).map((s) => s.kind);
      expect(kinds, opener).toEqual([opener, 'CATCH', 'ENDCATCH']);
      expect(classifyControlFlow(opener), opener).toEqual({ role: 'open', pair: 'try' });
    });

    it(`${opener}：折叠给出整块区间（第二读者同表）`, () => {
      const ranges = controlFlowFoldingRanges(scanControlFlow(tryBlock(opener)));
      // 整块 1..5 + 两个分支段 1..2 / 3..4（表补对之前这里一块都没有）
      expect(has(ranges, 1, 5), `${opener} 整块 1..5`).toBe(true);
      expect(has(ranges, 3, 4), `${opener} CATCH 段 3..4`).toBe(true);
      expect(has(ranges, 1, 2), `${opener} 块头段 1..2`).toBe(true);
    });

    // 反证（回退即红的那一类）：删掉 ENDCATCH ⇒ 必报未闭合；补回 ⇒ 零报
    it(`${opener}：删 ENDCATCH ⇒ 必报未闭合，补回 ⇒ 零报`, () => {
      const broken = tryBlock(opener)
        .split('\n')
        .filter((l) => l !== 'ENDCATCH')
        .join('\n');
      const after = checkControlFlowStructure(broken);
      expect(after.map((i) => [i.kind, i.statement]), opener).toEqual([['unclosed-open', opener]]);
      expect(after[0]!.message, opener).toContain('ENDCATCH');
      expect(checkControlFlowStructure(tryBlock(opener)), opener).toEqual([]);
    });

    // 反证第二向：删掉开块那一行 ⇒ CATCH / ENDCATCH 双双变孤儿（旧表只有 6 枚时的全语料形态）
    it(`${opener}：删开块行 ⇒ CATCH 与 ENDCATCH 各报一条孤儿`, () => {
      const broken = tryBlock(opener)
        .split('\n')
        .filter((l) => !l.startsWith(opener))
        .join('\n');
      expect(checkControlFlowStructure(broken).map((i) => i.kind)).toEqual(['orphan-branch', 'orphan-close']);
    });
  }
});

describe('配对表 · funcMatch→ENDFUNC 的 3 枚（CATCH 归 funclist 层的例外照旧）', () => {
  for (const opener of FUNCLIST_OPENERS) {
    const block = [opener, 'CALL A', 'CATCH', 'CALL B', 'ENDFUNC'].join('\n');

    it(`${opener}…CATCH…ENDFUNC：零报告`, () => {
      expect(checkControlFlowStructure(block), opener).toEqual([]);
    });

    it(`${opener}：删 ENDFUNC ⇒ 报未闭合，补回 ⇒ 零报`, () => {
      const broken = block
        .split('\n')
        .filter((l) => l !== 'ENDFUNC')
        .join('\n');
      expect(checkControlFlowStructure(broken).map((i) => [i.kind, i.statement]), opener).toEqual([
        ['unclosed-open', opener],
      ]);
      expect(checkControlFlowStructure(block), opener).toEqual([]);
    });

    it(`${opener}：折叠吃 CATCH 例外（folding.ts 的第二读者同口径）`, () => {
      const ranges = controlFlowFoldingRanges(scanControlFlow(block));
      expect(has(ranges, 1, 5), `${opener} 整块 1..5`).toBe(true);
      expect(has(ranges, 3, 4), `${opener} CATCH 段 3..4`).toBe(true);
    });
  }
});

describe('配对表 · 单行 TRY 系不开块（表不许宽到把注册行为以外的词当块）', () => {
  for (const word of SINGLE_LINE_TRYS) {
    it(`${word}：不在配对表里 ⇒ 单行语句`, () => {
      expect(classifyControlFlow(word), word).toBeNull();
    });

    it(`${word} 后面没有 CATCH/ENDCATCH ⇒ 零报告（不留幻影深度）`, () => {
      expect(checkControlFlowStructure(`${word} RESULTS\nPRINTW ok\n`), word).toEqual([]);
    });

    it(`${word} + CATCH + ENDCATCH ⇒ 报孤儿（**不许**因为前缀是 TRY 就默认开块）`, () => {
      expect(checkControlFlowStructure(`${word} RESULTS\nCATCH\nPRINTW fail\nENDCATCH\n`).map((i) => i.kind), word).toEqual(
        ['orphan-branch', 'orphan-close'],
      );
    });
  }
});

describe('真实误报形状（基线语料 ERB/SHOP関連/TEST.ERB:13-17 原样）', () => {
  const snippet = ['INPUTS', 'RESULT = 0', 'TRYCCALLSTR RESULTS', '\tPRINTW 函数正常调用结束', 'CATCH', '\tPRINTW 函数调用失败', 'ENDCATCH', 'RETURN RESULT'].join('\n');

  it('零报告（补词前这里报 2 条：CATCH 不在块里 + ENDCATCH 找不到开块）', () => {
    expect(checkControlFlowStructure(snippet)).toEqual([]);
  });

  it('折叠把 TRYCCALLSTR 块当一整段（1..8 起算于本片段首行）', () => {
    const ranges = controlFlowFoldingRanges(scanControlFlow(snippet));
    expect(ranges).toEqual([
      { startLine: 3, endLine: 4 },
      { startLine: 5, endLine: 6 },
      { startLine: 3, endLine: 7 },
    ]);
  });
});
