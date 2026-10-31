/**
 * ERB **声明面**体检（2026-10-25 ERB 语法缺口批 P1-3 / P1-4）。
 *
 * 与 `structure.ts`（控制流配对）同一形态：**纯文本入、纯数据出**，由编辑器在去抖后
 * 对本文件调一次（`checkStructure` 服务），不读盘、不碰索引。放在这一层的理由正是
 * 审计的原话——"改一行就崩游戏的那类错，提前到打字时"。
 *
 * ## 两类判据
 *
 * 1. **`#DIM` 族硬规则**（`dim-invalid`，error）——违反的后果是 Emuera **加载期直接
 *    拒绝整个文件**：
 *    · 名字撞引擎保留名（指令 / 内建式中函数，见下）；
 *    · 维数最多 3 维；
 *    · `CONST` 必须有初值，且不能与 `GLOBAL`/`SAVEDATA`/`REF`/`DYNAMIC` 并用；
 *    · `REF` 的元素数必须写 0（多格空槽 `,,` 与 `, 0, 0` 都是合法写法）；
 *    · 初值个数不得多于元素数。
 *    出处：Era Wiki `Emuera/UserVars`、`Emuera/ERH`；名字撞车一条另对引擎源码
 *    （见 `reservedNameViolation`）。
 * 2. **`#FUNCTION` 收尾形态**（`return-form`，warning）——式中函数必须用 `RETURNF`
 *    收尾；裸 `RETURN` 在式中函数里**带不出返回值**（调用方静默拿到 0）。
 *    出处：Era Wiki `Emuera/exfunc` §#FUNCTION。
 *
 * ## 精度纪律（错标比不标危险）
 * 声明行在真语料里写法极其多样（`#DIMS SORT_TARGET, LIST_MAX_SORT` 的"元素数"是常量名、
 * `#DIMS 賭け = "丁","半"` 的初值是字符串表、`{`…`}` 行连接把初值摊到多行）。因此
 * **只在拿得准的形态上下判断**：元素数不是十进制字面量 ⇒ 不判"初值超量"；初值摊在
 * 行连接块里 ⇒ 个数未知，相关两条都不判；名字解析不出 ⇒ 整行跳过。
 *
 * 真语料实测（eraNAS 4,780 文件 / 35,870 行 `#DIM` 族 / 7,092 个式中函数）：
 * **0 条误报**（唯一 3 处裸 `RETURN` 全在 `[SKIPSTART]` 停用区内，本模块不编译那段）。
 *
 * ## 名字撞引擎保留名（2026-10-25 批 A3 · P1-4 第六条）
 *
 * 曾因"本仓没有指令全集真源"而搁置；现补上 `instructions.ts`（301 条，出处可复现），
 * 与既有 `builtins.ts`（170 个式中函数名）并在一条规则里判。语料口径：**8 个盘 /
 * 18,149 文件 / 143,167 行 `#DIM` 族，0 命中**——这条规则在真代码上是静音的，
 * 只在作者真撞上时说话。
 */

import { splitEolLines } from '@kojo/plugin-api/eol';
import type { ErbStructureIssue } from '@kojo/plugin-api';
import { builtinSignatureOf } from './builtins';
import { isInstructionName } from './instructions';
import { erbCodeBodyOf } from './scanner';
import { parseFunctionDefinition } from './scanner';

/**
 * 本模块自身的**安全上限**（防病态文件把内存吃满）。
 *
 * 展示上限是 `structure.ts` 的 `MAX_STRUCTURE_ISSUES`（50），由 `checkStructure` 在
 * 合并后统一截断；这里只兜"直接调本函数"的路径。两个数故意分开：一个是给作者看的
 * 列表长度，一个是内存护栏，混成一个会让"谁在截断"变得说不清。
 */
const DECLARATION_ISSUE_CAP = 200;

/** `#DIM` 族头（与 scanner 的 `DIM_RE` 同族；本模块与它同包，直接同口径） */
const DIM_HEAD = /^#(DIMSTR|DIMCHAR|DIMF|DIMS|DIM|DEFINE)\s+(.+)$/i;
/** 声明前置修饰词（与 scanner 的 `DIM_MODIFIERS` 同集） */
const DIM_MODIFIER = /^(CONST|SAVEDATA|GLOBAL|REF|NOINIT|CHARA|LOCAL|STATIC|DYNAMIC|OUT|CHARADATA)\b\s*/i;

/** 不能与 `CONST` 并用的修饰词（Emuera 加载期报错） */
const CONST_INCOMPATIBLE = new Set(['GLOBAL', 'SAVEDATA', 'REF', 'DYNAMIC']);

/** 一条 `#DIM` 族声明切出来的结构 */
export interface DimLine {
  /** 头指令名（大写：`DIM` / `DIMS` / `DEFINE` …）——措辞要分"变量名"与"宏名" */
  directive: string;
  modifiers: string[];
  name: string;
  /** `NAME:a:b:c` 的维度段（不含名字本身） */
  dims: string[];
  /** `, 元素数` 原文（缺席 = undefined） */
  elements?: string;
  /** `= 初值, 初值…`（缺席 = undefined；`null` = 有 `=` 但值在行连接块里，个数未知） */
  inits?: string[] | null;
}

/** 引号 / 括号外切顶层逗号（初值表用；`"a,b"` 不切） */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth > 0) depth--;
    } else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** 引号外截断行内注释 */
function sliceComment(s: string): string {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (!inStr && c === ';') return s.slice(0, i);
  }
  return s;
}

/** 顶层 `=` 的位置（引号 / 括号外；`==` 不算） */
function indexOfTopLevelEq(s: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth > 0) depth--;
    } else if (c === '=' && depth === 0) {
      if (s[i + 1] === '=') {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** `= ` 之后 → 初值表；空 / 行尾 `{` ⇒ null（值摊在行连接块里，个数未知） */
function parseInits(body: string): string[] | null {
  const text = body.trim();
  if (text.length === 0 || text.endsWith('{')) return null;
  return splitTopLevel(text)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * 切一行 `#DIM` 族声明。解析不出名字 ⇒ null（不猜）。
 * 形态：`#DIM[S|F|STR|CHAR] [修饰词…] 名字[:维1[:维2[:维3]]] [, 元素数] [= 初值, …]`
 */
export function parseDimLine(rawLine: string): DimLine | null {
  const head = DIM_HEAD.exec(rawLine.trim());
  if (!head) return null;
  let rest = sliceComment(head[2]!).trim();
  if (rest.length === 0) return null;

  const modifiers: string[] = [];
  for (let guard = 0; guard < 8; guard++) {
    const m = DIM_MODIFIER.exec(rest);
    if (!m) break;
    modifiers.push(m[1]!.toUpperCase());
    rest = rest.slice(m[0].length);
  }

  const nameMatch = /^([^\s,:=\[]+)/.exec(rest);
  if (!nameMatch) return null;
  const name = nameMatch[1]!;
  rest = rest.slice(name.length);

  const dims: string[] = [];
  while (rest.startsWith(':')) {
    rest = rest.slice(1);
    const seg = /^[^:,=\s]*/.exec(rest)![0];
    dims.push(seg);
    rest = rest.slice(seg.length);
  }

  let elements: string | undefined;
  let inits: string[] | null | undefined;
  const tail = rest.trim();
  if (tail.length > 0) {
    if (tail.startsWith(',')) {
      const body = tail.slice(1);
      const eq = indexOfTopLevelEq(body);
      elements = (eq < 0 ? body : body.slice(0, eq)).trim();
      if (eq >= 0) inits = parseInits(body.slice(eq + 1));
    } else if (tail.startsWith('=')) {
      inits = parseInits(tail.slice(1));
    } else {
      // `#DEFINE NAME 3` 的裸值形（也容忍 `#DIM NAME 3`）
      elements = tail;
    }
  }
  return {
    directive: head[1]!.toUpperCase(),
    modifiers,
    name,
    dims,
    ...(elements === undefined ? {} : { elements }),
    ...(inits === undefined ? {} : { inits }),
  };
}

/**
 * 名字撞引擎保留名（指令 / 内建式中函数）⇒ 一条违规描述，否则 null。
 *
 * 判据出处（Emuera `IdentifierDictionary`）：`nameDic` 里 `SystemInstrument`
 * （指令，来自 `FunctionIdentifier.GetInstructionNameDic()`）与 `SystemMethod`
 * （内建式中函数）**都是致命档**——`CheckUserPrivateVarName` / `CheckUserVarName` /
 * `CheckUserMacroName` 三处一律 `warnLevel = 2` 后 `return/break`，随后
 * `LogicalLineParser` 的 `#DIM` 分支因 `AddPrivateVariable` 失败 `return false`，
 * **整个文件加载失败**。注释原话：「代入文が使えなくなるために命令名との衝突は致命的。」
 *
 * 两张词表各管自己的出处：指令见 `instructions.ts`（`FunctionCode` 枚举，301 条），
 * 式中函数见 `builtins.ts`（exmeth，170 条）。这里只做并集判断，不重抄任何名字。
 */
function reservedNameViolation(dim: DimLine): string | null {
  const what = dim.directive === 'DEFINE' ? '宏名' : '变量名';
  if (isInstructionName(dim.name)) {
    return `「${dim.name}」是引擎内建指令名——拿它当${what}会让 Emuera 加载失败（整个文件被拒绝）。`;
  }
  if (builtinSignatureOf(dim.name) !== null) {
    return `「${dim.name}」是引擎内建式中函数名——拿它当${what}会让 Emuera 加载失败（整个文件被拒绝）。`;
  }
  return null;
}

/**
 * 一条声明行的硬规则检查（导出供单测直接打点）。
 * @returns 违规描述列表（空 = 通过）
 */
export function dimLineViolations(dim: DimLine): string[] {
  const out: string[] = [];
  const mods = new Set(dim.modifiers);

  const reserved = reservedNameViolation(dim);
  if (reserved !== null) out.push(reserved);

  if (dim.dims.length > 3) {
    out.push(`「${dim.name}」声明了 ${dim.dims.length} 维——Emuera 最多 3 维，超出的部分会让整个文件加载失败。`);
  }

  if (mods.has('CONST')) {
    const conflict = [...mods].filter((m) => CONST_INCOMPATIBLE.has(m));
    if (conflict.length > 0) {
      out.push(`「${dim.name}」的 CONST 不能与 ${conflict.join(' / ')} 并用（Emuera 加载期报错）。`);
    }
    // `inits === null` = 有 `=` 但值摊在行连接块里 ⇒ 算"有初值"（不猜个数，也不报缺失）
    const hasInit = dim.inits === null || (dim.inits?.length ?? 0) > 0;
    if (!hasInit) {
      out.push(`「${dim.name}」标了 CONST 却没有初值——CONST 必须给出初值。`);
    }
  }

  if (mods.has('REF') && dim.elements !== undefined) {
    // 元素槽可以多格、也可以空着：`#DIM REF 集合,,` 与 `#DIM REF カラーマトリクス, 0, 0`
    // 都是真语料里的合法写法（引用变量不分配元素）。判据 = 每一格要么空、要么就是 0。
    const bad = dim.elements
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '' && s !== '0');
    if (bad.length > 0) {
      out.push(`「${dim.name}」是 REF 变量，元素数必须写 0（现在是 ${dim.elements}）——引用变量不分配元素。`);
    }
  }

  if (dim.inits && dim.inits.length > 0 && dim.elements !== undefined && /^\d+$/.test(dim.elements)) {
    const size = Number(dim.elements);
    if (dim.inits.length > size) {
      out.push(`「${dim.name}」元素数 ${size}，却给了 ${dim.inits.length} 个初值——初值多于元素数会让文件加载失败。`);
    }
  }
  return out;
}

/** `#FUNCTION` / `#FUNCTIONS` 指令行（含 `;` 行内注释形态） */
const FUNCTION_MARKER = /^#FUNCTIONS?(?![A-Za-z0-9_])(\s|$)/i;

/**
 * 声明面体检主入口（纯函数：同一份文本必得同一份结果）。
 *
 * 一遍扫描同时办两件事：`#DIM` 族逐行判规则；`@` 函数头之间跟踪 `#FUNCTION` 标记，
 * 对式中函数查裸 `RETURN`。停用区（`[SKIPSTART]`…`[SKIPEND]`）里的行**一律不看**——
 * 那段引擎不编译，报了就是假缺陷。
 */
export function checkDeclarationIssues(text: string): ErbStructureIssue[] {
  const issues: ErbStructureIssue[] = [];
  const lines = splitEolLines(text);

  /** 当前函数（`@` 头）；`isExpr` 由 `#FUNCTION` 标记点亮 */
  let cur: { name: string; isExpr: boolean } | null = null;
  /** 写在 `@` 行**之前**的 `#FUNCTION`（扫描器同样宽容这种写法） */
  let pendingMarker = false;
  let inSkipBlock = false;

  const push = (issue: ErbStructureIssue): void => {
    if (issues.length < DECLARATION_ISSUE_CAP) issues.push(issue);
  };

  for (let i = 0; i < lines.length; i++) {
    // 代码前缀（`;!;` / `;#;`）之后是真代码：`;!;#DIM X` 是一条真声明（判据单源 `code-prefix.ts`）
    const trimmed = erbCodeBodyOf((lines[i] ?? '').trim());
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (trimmed.length === 0 || trimmed.startsWith(';')) continue;

    if (trimmed.startsWith('@')) {
      const def = parseFunctionDefinition(trimmed);
      // 续行 `@"…"` 不是函数头（判据与 structure.ts 的 isFunctionBoundary 同源：名字必须像标识符）
      cur = def && /^[A-Za-z_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uFF21-\uFF3A\uFF41-\uFF5A]/.test(def.name)
        ? { name: def.name, isExpr: pendingMarker }
        : cur;
      pendingMarker = false;
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (FUNCTION_MARKER.test(sliceComment(trimmed))) {
        if (cur) cur.isExpr = true;
        else pendingMarker = true;
        continue;
      }
      const dim = parseDimLine(trimmed);
      if (dim) {
        for (const message of dimLineViolations(dim)) {
          push({
            kind: 'dim-invalid',
            severity: 'error',
            line: i + 1,
            statement: dim.name,
            message,
          });
        }
      }
      continue;
    }

    if (cur?.isExpr && /^RETURN(?![A-Za-z0-9_])/i.test(trimmed)) {
      push({
        kind: 'return-form',
        severity: 'warning',
        line: i + 1,
        statement: 'RETURN',
        message: `「${cur.name}」是 #FUNCTION 式中函数，收尾要用 RETURNF 而不是 RETURN——裸 RETURN 不会把值交回调用方。`,
      });
    }
  }
  return issues;
}
