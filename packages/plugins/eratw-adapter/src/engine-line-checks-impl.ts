/**
 * 引擎词法/字面实参相位检查（P2-7）——实现层（动态 import 装载，不进 PS-10 开机图）。
 *
 * 一条规则 `erb.engine-line-checks`（壳在 `conventions.ts`）出两类 issue，文案全部
 * 引擎原话（`formatEngineErrorText`），只在原话后追加定位/口径说明：
 *
 * (a) **info · 赋值位 `==`**：eratw `stmt/LineParser.kt parseAssignmentLine` 的
 *     `Use2EqualToAssign`（level 0 提示后照常按 `=` 执行；spec `LogicalLineParser.cs:548-554`）。
 *     判据 = 可见行行首 `标识符(下标)? ==`，标识符不在指令词表。指令词表取
 *     `plugin-api/src/erb-engine-profiles` 的 **snake 无条件指令面**——P1-6 锁档判据
 *     已钉死它与 `erb-parser::ERB_INSTRUCTION_NAMES` 恒等，单一真源不抄第二份。
 *     上一可见行以 `,` / `(` 收尾 ⇒ 该行是上一条语句的括号续行（PRINTL 多行实参），
 *     fail-open 豁免：真语料仅有的 2 处命中全是这类续行（`M_KOJO_K98_UPDATE.ERB:96/113`）。
 * (b) **error · 字面实参越界**：
 *     - `SETCOLOR`/`SETBGCOLOR`：spec 三处互证——装载期 `SP_COLOR_ArgumentBuilder`
 *       （ArgumentBuilder.cs:2040-2067）：**恰 1 实参 ⇒ `SpColorArgument(rgb)` 整值形态
 *       （按位取 RGB，全不查范围）**；恰 3 实参 ⇒ 逐分量 <0 / >255 抛错（执行端
 *       `Process.ScriptProc.cs:408-431` 同构）；2 实参 ⇒ 引擎另给装载警告
 *       （InvalidSetcolorArgCount，非本批键）；4+ 实参 C# 丢第 4 个而 eratw flat 化当整值
 *       ⇒ 两引擎分歧不判。⇒ **静态只判恰好 3 参形态的字面量**（含 0x 十六进制），
 *       表达式不猜。语料 23,651 处 `SETCOLOR 0xXXXXXX` 单值形态实证了这条口径的必要性。
 *     - `ASSERT`：`Process.cs:1790-1795`，实参求值 == 0 抛错（eratw 无 debug 守卫，
 *       正式跑也报）。静态只判唯一字面量实参 == 0。
 *
 * 可见行复用 `variable-bounds-impl::visibleLines`（SKIP 块、`;` 注释、`@FUNC` 行、
 * 双引号字符串内容全部豁免，与 erb-parser 同尺）。
 *
 * 语料活闸：`engine-line-checks.corpus.test.ts`——eraTW 4.981 全量 4,371 文件三类相位
 * 全零（探针先证）；全角空格键**有意不判**：40,783 处全在 PRINT 输出文本（引擎只在
 * 表达式相位报），token 级相位才能零误报，归档表留账。
 */
import type { ConventionCheckContext, ConventionIssue } from '@kojo/plugin-api';
import { formatEngineErrorText } from '@kojo/plugin-api';
import { ERB_ENGINE_PROFILES } from '../../../plugin-api/src/erb-engine-profiles';
import { visibleLines } from './variable-bounds-impl';

export const ENGINE_LINE_CHECKS_RULE_ID = 'erb.engine-line-checks';

/** snake 无条件指令面（= erb-parser `ERB_INSTRUCTION_NAMES`，恒等性由锁档判据钉死） */
const INSTRUCTION_WORDS: ReadonlySet<string> = (() => {
  const snake = ERB_ENGINE_PROFILES.find((p) => p.id === 'snake');
  if (!snake) throw new Error('引擎分档数据缺 snake 档——先跑 node tools/gen-erb-engine-profiles.mjs');
  return new Set(snake.commands.filter((n) => !(n in snake.conditionalCommands)));
})();

/** 顶层逗号切分（括号深度感知；双引号字符串已被 visibleLines 剥成 ""，无逗号逃逸） */
function splitTopArgs(code: string): readonly string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(code.slice(start, i));
      start = i + 1;
    }
  }
  out.push(code.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 数字字面量（十进制 / 0x 十六进制，Emuera 词法同款前缀）；其余表达式返回 null 不猜 */
function parseLiteral(token: string): number | null {
  if (/^-?\d+$/.test(token)) return Number(token);
  const m = /^-?0[xX]([0-9A-Fa-f]+)$/.exec(token);
  if (!m) return null;
  const v = parseInt(m[1]!, 16);
  return token.startsWith('-') ? -v : v;
}

export async function checkEngineLineChecks(ctx: ConventionCheckContext): Promise<ConventionIssue[]> {
  const issues: ConventionIssue[] = [];
  for (const filePath of ctx.index.files.keys()) {
    let text: string;
    try {
      text = await ctx.readFile(filePath);
    } catch {
      continue; // 读不到的文件不是稿子的错，不产诊断
    }
    const lines = visibleLines(text);
    for (let i = 0; i < lines.length; i++) {
      const { line, code } = lines[i]!;

      // (a) 赋值位 ==（info）
      const m = /^([A-Za-z_][A-Za-z_0-9]*(?::\d+)*)\s*==/.exec(code);
      if (m && !INSTRUCTION_WORDS.has(m[1]!.split(':')[0]!.toUpperCase())) {
        const prevTail = i > 0 ? lines[i - 1]!.code.trimEnd().at(-1) : undefined;
        if (prevTail !== ',' && prevTail !== '(') {
          issues.push({
            ruleId: ENGINE_LINE_CHECKS_RULE_ID,
            severity: 'info',
            message:
              formatEngineErrorText('Use2EqualToAssign') +
              '——引擎按 = 执行并只给提示；确要赋值请写 =，要比较请放进 IF/SIF 等条件位。',
            filePath,
            line,
            key: `${ENGINE_LINE_CHECKS_RULE_ID}|${filePath}|${line}|eqeq`,
          });
        }
      }

      // (b) SETCOLOR / SETBGCOLOR 字面分量（error）——只判恰好 3 参形态
      const sm = /^(SETCOLOR|SETBGCOLOR)\s+(.+)$/.exec(code);
      if (sm) {
        const args = splitTopArgs(sm[2]!);
        if (args.length === 3) {
          for (const arg of args) {
            const v = parseLiteral(arg);
            if (v === null) continue;
            if (v < 0 || v > 255) {
              issues.push({
                ruleId: ENGINE_LINE_CHECKS_RULE_ID,
                severity: 'error',
                message:
                  formatEngineErrorText(v < 0 ? 'SetcolorArgLessThan0' : 'SetcolorArgOver255') +
                  (v < 0
                    ? `——三值形态（恰好 3 个实参）每个分量必须在 0..255；单实参是整值形态（按位取 RGB），引擎不查范围。`
                    : `——原话如此（指超过 255）：三值形态（恰好 3 个实参）每分量 0..255；单实参是整值形态，引擎不查范围。`),
                filePath,
                line,
                key: `${ENGINE_LINE_CHECKS_RULE_ID}|${filePath}|${line}|color|${v}`,
              });
            }
          }
        }
      }

      // (c) ASSERT 字面量 0（error）
      const am = /^ASSERT\s+(.+)$/.exec(code);
      if (am) {
        const args = splitTopArgs(am[1]!);
        if (args.length === 1) {
          const v = parseLiteral(args[0]!);
          if (v === 0) {
            issues.push({
              ruleId: ENGINE_LINE_CHECKS_RULE_ID,
              severity: 'error',
              message:
                formatEngineErrorText('AssertArgIs0') +
                '——ASSERT 只在参数非 0 时通过，0 会在执行到这一行时抛错；调试断言请改用 DEBUGPRINT 系或移进 [SKIPSTART] 块。',
              filePath,
              line,
              key: `${ENGINE_LINE_CHECKS_RULE_ID}|${filePath}|${line}|assert`,
            });
          }
        }
      }
    }
  }
  return issues;
}
