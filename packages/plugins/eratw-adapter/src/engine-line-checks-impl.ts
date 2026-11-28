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
 * (c) **error · ARRAYCOPY 双名实参四判**：装载相位 `ArgumentParser.cs:2451-2496`
 *     （`ArgumentBuilder.warn`，isBackComp:false）与运行时 `Process.cs:1711-1768`
 *     同构；eratw `StatementExecutor.kt execArrayCopyFlat` 同形。判据顺序与引擎一致：
 *     非数组（`ArraycopyArgIsNotArray`，引擎标量 dim:0）→ 角色变量
 *     （`ArraycopyArgIsCharaVar`，引擎名表 section=角色变量 或 `#DIM CHARADATA`）→
 *     维度（`DifferentArraycopyArgsDim`，声明尺寸个数 = 维度，`UserDefinedVariableData.cs:437`）→
 *     类型（`DifferentArraycopyArgsType`，int vs str）。**两实参都是引号字面名才判**：
 *     裸名可能是 str 变量值（动态）、名字带逗号/表达式 → fail-open；名字真值 =
 *     `ERB_ENGINE_NAMES` ∪ 全局用户 `#DIM`/`#DIMS`（函数体内的是局部，同名互不相干
 *     → 收集器不可见 ⇒ fail-open）；名字同时在两处（遮蔽关系判不了）也 fail-open。
 *
 * 可见行复用 `variable-bounds-impl::visibleLines`（SKIP 块、`;` 注释、`@FUNC` 行、
 * 双引号字符串内容全部豁免，与 erb-parser 同尺）。
 *
 * 语料活闸：`engine-line-checks.corpus.test.ts`——eraTW 4.981 全量 4,371 文件三类相位
 * 全零（探针先证）；全角空格键**有意不判**：40,783 处全在 PRINT 输出文本（引擎只在
 * 表达式相位报），token 级相位才能零误报，归档表留账。
 */
import type { ConventionCheckContext, ConventionIssue } from '@kojo/plugin-api';
import { erbCodeBodyOf, formatEngineErrorText } from '@kojo/plugin-api';
import { ERB_ENGINE_PROFILES } from '../../../plugin-api/src/erb-engine-profiles';
import { ERB_ENGINE_NAMES } from '../../../plugin-api/src/erb';
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
  const texts = new Map<string, string>();
  for (const filePath of ctx.index.files.keys()) {
    try {
      texts.set(filePath, await ctx.readFile(filePath));
    } catch {
      continue; // 读不到的文件不是稿子的错，不产诊断
    }
  }
  const userVars = collectUserVars(ctx, texts);
  const push = (
    filePath: string,
    line: number,
    message: string,
    tag: string,
    severity: 'info' | 'error' = 'error',
  ) => {
    issues.push({
      ruleId: ENGINE_LINE_CHECKS_RULE_ID,
      severity,
      message,
      filePath,
      line,
      key: `${ENGINE_LINE_CHECKS_RULE_ID}|${filePath}|${line}|${tag}`,
    });
  };
  // (e) 声明面：全局重名（后到者）与数字开头名——引擎在声明相位就拒载（warnLevel 2 ⇒ CodeEE）
  for (const d of userVars.dups) {
    push(
      d.filePath,
      d.line,
      formatEngineErrorText('VarNameAlreadyUsed', [d.name]) +
        '——同名全局 #DIM/#DIMS 只许声明一处，后到者会被引擎拒载；请改掉其中一处。',
      `dupdim|${d.name}`,
    );
  }
  for (const d of userVars.digitStarts) {
    push(
      d.filePath,
      d.line,
      formatEngineErrorText('VarStartedHalfDigit', [d.name]) +
        '——全局变量名不能以半角数字开头（引擎声明相位拒载）。',
      `halfdigit|${d.name}`,
    );
  }
  for (const [filePath, text] of texts) {
    const lines = visibleLines(text);
    for (let i = 0; i < lines.length; i++) {
      const { line, code, rawCode } = lines[i]!;

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

      // (f) 0 维变量带下标（error）——VariableParser.cs:177-179 求值前就抛 CodeEE；
      // 函数体 #DIM 遮蔽同名 0 维的形态不建模（localNames 集合里 fail-open）
      if (ZERO_DIM_SUBSCRIPT_RE && code.length > 0) {
        for (const [idx, m] of [...code.matchAll(ZERO_DIM_SUBSCRIPT_RE)].entries()) {
          const name = m[1]!.toUpperCase();
          if (userVars.localNames.has(name)) continue;
          push(
            filePath,
            line,
            formatEngineErrorText('ZeroDVarHasArg', [name]) +
              '——它是引擎标量（不带下标），写成 NAME:0 会在解析期直接拒载；直接用 NAME 即可。',
            `zerod|${name}|${idx}`,
          );
        }
      }

      // (d) ARRAYCOPY 双名实参四判（error）——两实参都是引号字面名才判
      const arr = /^ARRAYCOPY\s+(.+)$/i.exec(rawCode);
      if (arr) {
        const names = parseArraycopyNames(arr[1]!);
        if (names) {
          const s1 = judgeArg(resolveVar(names[0], userVars.byName));
          const s2 = judgeArg(resolveVar(names[1], userVars.byName));
          const sides: readonly (readonly [string, string, ArgStatus])[] = [
            ['1', names[0], s1],
            ['2', names[1], s2],
          ];
          for (const [pos, name, s] of sides) {
            if (s?.kind === 'notArray') {
              push(
                filePath,
                line,
                formatEngineErrorText('ArraycopyArgIsNotArray', [pos, name]) +
                  '——ARRAYCOPY 的两个实参必须是数组变量（引号里写字面名）；引擎标量（GAMEBASE 系 / RESULTF / SAVEDATA_TEXT 等）与普通标量变量不能整组拷。',
                `arraycopy|na${pos}`,
              );
            } else if (s?.kind === 'chara') {
              push(
                filePath,
                line,
                formatEngineErrorText('ArraycopyArgIsCharaVar', [pos, name]) +
                  '——引擎不支持拷贝角色变量；要按角色搬数据请写成逐角色循环赋值。',
                `arraycopy|cv${pos}`,
              );
            }
          }
          if (s1?.kind === 'array' && s2?.kind === 'array') {
            if (s1.dim !== undefined && s2.dim !== undefined && s1.dim !== s2.dim) {
              push(
                filePath,
                line,
                formatEngineErrorText('DifferentArraycopyArgsDim') +
                  `——两边分别是 ${s1.dim} 维与 ${s2.dim} 维；1 维对 1 维、2 维对 2 维才能整组拷。`,
                'arraycopy|dim',
              );
            } else if (
              (s1.type === 'int' && s2.type === 'str') ||
              (s1.type === 'str' && s2.type === 'int')
            ) {
              push(
                filePath,
                line,
                formatEngineErrorText('DifferentArraycopyArgsType') +
                  '——整数数组只能拷给整数数组、字符串数组只能拷给字符串数组（#DIM 对 #DIM，#DIMS 对 #DIMS）。',
                'arraycopy|type',
              );
            }
          }
        }
      }
    }
  }
  return issues;
}

// ---------- (d) ARRAYCOPY 判据的数据面与解析 ----------

/** 引擎名真值：dim/kind 缺席 = spec 未钉死（fail-open）；`section:"角色变量"` = IsCharacterData */
interface VarInfo {
  readonly dim?: number;
  readonly kind?: string;
  readonly chara: boolean;
}

const ENGINE_VAR_INFOS: ReadonlyMap<string, VarInfo> = new Map(
  ERB_ENGINE_NAMES.map((e) => [e.name, { dim: e.dim, kind: e.kind, chara: e.section === '角色变量' }]),
);

/** 引擎 0 维名（GAMEBASE 系 / RESULTF / SAVEDATA_TEXT）的下标用法：`NAME:` 或 `NAME[数字]` */
const ZERO_DIM_SUBSCRIPT_RE: RegExp | null = (() => {
  const names = ERB_ENGINE_NAMES.filter((e) => e.dim === 0).map((e) => e.name);
  return names.length > 0 ? new RegExp(`(?<![\\w])(${names.join('|')})\\s*(?::|\\[\\s*\\d)`, 'g') : null;
})();

/** 全局用户 `#DIM`/`#DIMS` 声明的形状（函数体内的是局部，不收） */
interface UserVarInfo {
  readonly name: string;
  readonly dim: number;
  readonly kind: 'int' | 'str';
  readonly chara: boolean;
}

/**
 * 用户声明尺寸个数 = 维度（`UserDefinedVariableData.cs:437` `Dimension = list.Count`；
 * :434 无尺寸 ⇒ 补 1；:361-363 初始值路径也是 1 维）。表达式尺寸只验形状不猜值；
 * 形状判不了的声明整个 fail-open。CHARADATA 的维度不收（角色变量先报 chara 键，
 * 轮不到 dim 判，且 P1-4 已实证 isChara ⇒ 角色维在前）。
 */
function parseDimDecl(ln: string): UserVarInfo | null {
  const m = /^(#DIMS|#DIM)\b((?:\s+(?:CHARADATA|GLOBAL|SAVEDATA|STATIC|DYNAMIC|CONST|REF)\b)*)\s+([^\s,=]+)\s*(.*)$/i.exec(ln);
  if (!m) return null;
  const name = m[3]!;
  if (!/^[A-Za-z_0-9ａ-ｚＡ-Ｚぁ-んァ-ヶー一-鿿]+$/.test(name)) return null;
  const rest = m[4] ?? '';
  let dim = 1;
  if (rest.startsWith(',')) {
    const sizes = splitTopArgs(rest.slice(1).split('=')[0] ?? '');
    if (sizes.length === 0 || !sizes.every((p) => /^[^:%"'!]+$/.test(p))) return null;
    if (sizes.length > 3) return null; // C# :446-448 四维以上拒载，引擎根本不会声明出来
    dim = sizes.length;
  } else if (rest !== '' && !rest.startsWith('=')) {
    return null; // 名字后面跟着无法识别的东西 ⇒ 引擎多半也拒载，不猜
  }
  return {
    name: name.toUpperCase(),
    dim,
    kind: m[1]!.toUpperCase() === '#DIMS' ? 'str' : 'int',
    chara: /\bCHARADATA\b/i.test(m[2] ?? ''),
  };
}

function collectUserVars(
  ctx: ConventionCheckContext,
  texts: ReadonlyMap<string, string>,
): {
  byName: ReadonlyMap<string, UserVarInfo>;
  /** 全局重名的后到者（eratw `Symbols.kt LabelTable.scanLabels` seenDims 命中后到者；锚 IdentifierDictionary.cs:258-300 CheckUserVarName） */
  dups: readonly { name: string; filePath: string; line: number }[];
  /** 名字以半角数字开头（IdentifierDictionary.cs:354-359 `char.IsDigit(varName[0])`） */
  digitStarts: readonly { name: string; filePath: string; line: number }[];
  /** 函数体内声明的局部名：可能遮蔽引擎 0 维名，遮蔽关系判不了 ⇒ 0 维带下标对它们 fail-open */
  localNames: ReadonlySet<string>;
} {
  const byName = new Map<string, UserVarInfo>();
  const dups: { name: string; filePath: string; line: number }[] = [];
  const digitStarts: { name: string; filePath: string; line: number }[] = [];
  const localNames = new Set<string>();
  for (const [filePath, text] of texts) {
    if (!/\.(erb|erh)$/i.test(filePath)) continue;
    const fns = ctx.index.files.get(filePath)?.functions ?? [];
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    // 与 visibleLines 同一条 SKIP 尺：[SKIPSTART]…[SKIPEND] 块是死代码，声明不参与
    // 重名/数字开头判定（语料实证：COLOR_CLAC.ERB 整文件函数在 SKIP 块内、
    // TEMP_CHARA_LIST_BY_DT.ERB 的 DISP_MEMO 重名对也在 SKIP 块内）
    let inSkip = false;
    for (let i = 0; i < lines.length; i++) {
      const body = erbCodeBodyOf(lines[i]!.trim());
      if (inSkip) {
        if (body === '[SKIPEND]') inSkip = false;
        continue;
      }
      if (body === '[SKIPSTART]') {
        inSkip = true;
        continue;
      }
      const ln = body.replace(/\s*;.*$/, '').trim();
      if (!/^#DIMS?\b/i.test(ln)) continue;
      const lineNo = i + 1;
      const inFn = fns.some((fn) => lineNo >= fn.startLine && lineNo <= fn.endLine);
      const info = parseDimDecl(ln);
      if (!info) continue;
      if (inFn) {
        // 函数体内的 #DIM 是调用栈局部：同名互不相干（跨函数不可共判）
        localNames.add(info.name);
        continue;
      }
      if (/^[0-9]/.test(info.name)) digitStarts.push({ name: info.name, filePath, line: lineNo });
      if (byName.has(info.name)) dups.push({ name: info.name, filePath, line: lineNo });
      else byName.set(info.name, info);
    }
  }
  return { byName, dups, digitStarts, localNames };
}

function resolveVar(name: string, user: ReadonlyMap<string, UserVarInfo>): VarInfo | null {
  const key = name.toUpperCase();
  const u = user.get(key);
  const e = ENGINE_VAR_INFOS.get(key);
  if (u && e) return null; // 用户与引擎同名：遮蔽关系判不了 ⇒ fail-open
  if (u) return { dim: u.chara ? undefined : u.dim, kind: u.kind, chara: u.chara };
  return e ?? null;
}

type ArgStatus =
  | { kind: 'notArray' }
  | { kind: 'chara' }
  | { kind: 'array'; dim?: number; type?: string }
  | null;

/** 引擎判序：非数组（dim:0）→ 角色变量 → 数组（dim/kind 未钉死则 fail-open） */
function judgeArg(v: VarInfo | null): ArgStatus {
  if (!v) return null;
  if (v.chara) return { kind: 'chara' };
  if (v.dim === 0) return { kind: 'notArray' };
  if (v.dim === undefined) return null;
  return { kind: 'array', dim: v.dim, type: v.kind };
}

/** 只认「两个引号字面名」实参：裸名可能是 str 变量值（动态），引号残缺/表达式一律 fail-open */
function parseArraycopyNames(args: string): readonly [string, string] | null {
  const m = /^\s*"([^"]*)"\s*,\s*"([^"]*)"\s*$/.exec(args);
  return m ? [m[1]!, m[2]!] : null;
}
