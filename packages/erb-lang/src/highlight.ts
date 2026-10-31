import { classifyControlFlow, ERB_CONTROL_STATEMENTS } from '@kojo/erb-vocab/control-flow';

/**
 * ERB **同符号高亮**的判据（`@kojo/erb-lang/highlight`，LAU-4 第一步）。
 *
 * ## 这一层回答的问题
 *
 * 光标落在哪个**同文件符号**上？这个符号在本文件的哪些地方出现？每处是
 * **声明（write）**、**引用（read）**，还是**不参与解析的同名提及（text）**？
 *
 * ERB 有三种可证明的符号，判据全部落在**字形**上（不读项目索引、不读盘、不猜）：
 *
 * 1. **控制流关键字**（`IF` / `ELSE` / `ENDIF` 一族）：只认**行首**那枚词；
 *    高亮 = 它所属那一块的开块（write）+ 本块全部分支词（text）+ 收束词（read）。
 *    块配对按**角色栈**做（开块入栈、收束出栈、分支挂栈顶）——所以是"最近的开块收束"
 *    这一条通用规则：错配文件里它可能给出一块并不存在的区间，但**绝不会**把光标之外的
 *    东西吃掉一半（区间全部来自关键词行本身的字形）。
 * 2. **函数名**：`@NAME` 定义行（write）+ `CALL` 直系族名字槽（read）+ 代码面其余
 *    同名记号（text）。`CALL` 直系族由语句名**形态**给出（行首词以 `CALL` 收尾：
 *    `CALL` / `TRYCALL` / `TRYCCALL`），`CALLFORM` / `TRYCALLLIST` 一族按形态自然排除
 *    ——参数位不是名字（与 `ui/reference-utils.ts::isCallShapedMention` 同一条"判窄"纪律）。
 * 3. **`$` 标签**：`$NAME` 定义行（write）+ `JUMP` / `GOTO` 直系族的目标槽（read）+
 *    代码面其余同名记号（text）。跳转目标允许带 `$` / `*` 前缀（引擎两种写法都认），
 *    高亮区间只覆盖名字本身。
 *
 * ## 什么一律不算（错标比不标危险）
 *
 * - **字符串内容**与**行内 / 整行注释**：`"IF"` / `; CALL FOO` 不是引用；
 * - **`[SKIPSTART] … [SKIPEND]` 死区**：引擎不编译这些行，里面既不开块也不产引用；
 *   区标记行本身也不是符号（`[]`）；
 * - **没有符号的位置**（空白 / 数字 / 标点 / 未声明的裸词 / `SIF` 这类单行语句）
 *   ⇒ `[]`：宁可不亮，也不猜"这个词大概是哪个符号"。
 *
 * ## 分层纪律（LAU-4：与 kojo2 同一条槽、同一份契约）
 *
 * - 本包是**纯判据**：源码 + 1 基行列进、出现处出，零 IO / 零 Monaco / 零 React / 零 DOM；
 * - 档位值域（`text` / `read` / `write`）与契约 `EditorDocumentHighlightKind` **同名同值域**：
 *   供方（插件 `@kojo/plugin-erb-lang`）原样搬运，翻 `DocumentHighlightKind` 的是宿主；
 * - 角色词表**零抄本**：从 `@kojo/erb-vocab/control-flow` 的配对表（`ERB_CONTROL_STATEMENTS`
 *   + `classifyControlFlow`，引擎 `FunctionIdentifier.cs` 的单一真源）现派生，一个词形
 *   都不在本包复写。这也是本包**唯一**的外部依赖——依赖方向是"语言面库读引擎配对表"，
 *   与宿主读同一张表是同一条路（回车派生 2026-10-31 起住本包 `./enter`）（配对表住在**非插件库包**里，
 *   插件 `@kojo/plugin-erb-parser`、宿主与语言面库**三方并列只读**，谁也不引谁）。
 *
 * 结构事实（行分类 / 控制行栈 / 函数与标签行）由 {@link erbStructureOf} 一次性建好，
 * 高亮与扩选（`@kojo/erb-lang/selection-range`）**共用这一份**——两处各扫一遍必然漂移。
 */

/* ============================== 角色词表（配对表派生，零抄本） ============================== */

/** 角色分桶（大写归一的词集合；`leaf` 只用来"别把 SIF 当块"） */
interface ErbRoleSets {
  readonly open: ReadonlySet<string>;
  readonly branch: ReadonlySet<string>;
  readonly close: ReadonlySet<string>;
  readonly leaf: ReadonlySet<string>;
}

let roleSets: ErbRoleSets | null = null;

/**
 * 角色集合（进程内建一次）：配对表是常量，档位由 `classifyControlFlow` 说。
 * 缓存的是**同一份派生结果**，判据仍只有那一条。
 */
function erbRoleSets(): ErbRoleSets {
  if (roleSets !== null) return roleSets;
  const open: string[] = [];
  const branch: string[] = [];
  const close: string[] = [];
  const leaf: string[] = [];
  for (const word of ERB_CONTROL_STATEMENTS) {
    switch (classifyControlFlow(word)?.role) {
      case 'open':
        open.push(word);
        break;
      case 'branch':
        branch.push(word);
        break;
      case 'close':
        close.push(word);
        break;
      case 'leaf':
        leaf.push(word);
        break;
      default:
        break; // 配对表加了一档而这里没接：`tests/highlight.test.ts` 的逐词用例当场拦下
    }
  }
  roleSets = {
    open: new Set(open.map((word) => word.toUpperCase())),
    branch: new Set(branch.map((word) => word.toUpperCase())),
    close: new Set(close.map((word) => word.toUpperCase())),
    leaf: new Set(leaf.map((word) => word.toUpperCase())),
  };
  return roleSets;
}

/** 控制词角色（`leaf` 与表外词都回 `null`：单行语句没有配对块） */
function roleOfWord(word: string): 'open' | 'branch' | 'close' | null {
  if (word.length === 0) return null;
  const sets = erbRoleSets();
  if (sets.open.has(word)) return 'open';
  if (sets.branch.has(word)) return 'branch';
  if (sets.close.has(word)) return 'close';
  return null;
}

/* ============================== 记号字符集 ============================== */

/**
 * ERB 记号字符：Unicode 字母 / 数字 / 下划线。
 *
 * 与语义层 `MODEL_TOKEN_CLASS`（契约层单源）/ 宿主 `erb-rename.ts` 的 `IDENT_RE` 同一字符集
 * ——真语料 21% 的函数名含 CJK，ASCII 集会静默漏两成。本包不 import 契约包（纯判据），
 * 字面量与既有的两个宿主落点逐字相同，`tests/highlight.test.ts` 用 CJK / 全角用例钉住行为。
 */
const NAME_CHAR = /[\p{L}\p{N}_]/u;

/** 名字起始字符：字母 / 下划线（数字不能起首——`$123` 是行号不是标签名） */
const NAME_START = /[\p{L}_]/u;

/** 是否记号字符（`undefined` 位置恒假：行外不是词） */
export function isErbNameChar(ch: string | undefined): boolean {
  return ch !== undefined && NAME_CHAR.test(ch);
}

/**
 * 光标列 → 所在词的 0 基半开区间 `[start, end)`（**纯函数**）。
 *
 * 光标贴着词（词尾后一格、或词首上一格）都算在词上，与宿主 `erb-rename.ts::wordAtColumn`
 * 的判据逐字相同；两侧都不是标识字符 ⇒ `null`。越界列夹取到行尾。
 */
export function erbWordAt(line: string, col0: number): { start: number; end: number } | null {
  if (!Number.isFinite(col0) || col0 < 0) return null;
  const at = Math.min(Math.trunc(col0), line.length);
  const anchor = isErbNameChar(line[at - 1]) ? at - 1 : isErbNameChar(line[at]) ? at : -1;
  if (anchor < 0) return null;
  let start = anchor;
  while (start > 0 && isErbNameChar(line[start - 1])) start--;
  let end = anchor + 1;
  while (end < line.length && isErbNameChar(line[end])) end++;
  return { start, end };
}

/* ============================== 公共形状 ============================== */

/** 1 基区间，`endColumn` 排他（与 Monaco `IRange` 同数值口径） */
export interface ErbRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/**
 * 出现处的语义档位：
 * - `write` = 声明（`@NAME` 定义名 / `$NAME` 标签定义 / 开块关键字）；
 * - `read` = 引用（`CALL` 名字槽 / 跳转目标 / 收束关键字）；
 * - `text` = 代码面里不参与解析的同名提及（输出行散文 / 分支关键字——编辑器可自行弱化）。
 *
 * 值域与契约 `EditorDocumentHighlightKind` **逐字相同**（供方原样搬运）；翻 Monaco 的
 * `DocumentHighlightKind` 是宿主翻译层的事。
 */
export type ErbHighlightKind = 'text' | 'read' | 'write';

/** 一条出现处（1 基半开区间） */
export interface ErbDocumentHighlight {
  readonly range: ErbRange;
  readonly kind: ErbHighlightKind;
}

/** 位点（1 基行列，与 Monaco `Position` 同口径） */
export interface ErbPosition {
  readonly line: number;
  readonly column: number;
}

/* ============================== 结构事实 ============================== */

/** 行分类：只有 `code` / `definition` / `label` 三档能承载符号 */
export type ErbLineKind =
  | 'blank'
  | 'comment'
  | 'dead'
  | 'marker'
  | 'definition'
  | 'label'
  | 'directive'
  | 'code';

/** 一行的事实（`view` / `lead` 只在 `code` 行有意义） */
export interface ErbLine {
  /** 1 基行号 */
  readonly line: number;
  /** 行原文（未 trim；列对齐的基准） */
  readonly raw: string;
  readonly kind: ErbLineKind;
  /** 代码视野（串内容与行尾注释等长刷白；列坐标不变）；非 `code` 行为空串 */
  readonly view: string;
  /** 行首 `[A-Za-z_]+` 一段的大写形态（没有则空串） */
  readonly lead: string;
  /** 行首词前的缩进（0 基列偏移；没有行首词 = `raw.length - raw.trimStart().length`） */
  readonly leadStart: number;
}

/** 一处名字记号（0 基半开区间 + 源里原样大小写） */
export interface ErbNameSpan {
  /** 1 基行号 */
  readonly line: number;
  /** 0 基起列 */
  readonly start: number;
  /** 0 基排他端列 */
  readonly end: number;
  /** 源里原样写法（大小写不归一；匹配时现算大写） */
  readonly name: string;
}

/** 一枚控制流关键字（行首那一段） */
export interface ErbControlLine {
  /** 1 基行号 */
  readonly line: number;
  /** 大写词形（`ENDIF` 一族） */
  readonly word: string;
  readonly role: 'open' | 'branch' | 'close';
  /** 0 基起列 */
  readonly start: number;
  /** 0 基排他端列 */
  readonly end: number;
}

/** 一个控制流块（收束行缺席 ⇒ `close = null`，此时不产块） */
export interface ErbBlock {
  readonly open: ErbControlLine;
  /** 本块的分支词（行序） */
  readonly branches: readonly ErbControlLine[];
  readonly close: ErbControlLine | null;
}

/** 一份 ERB 文本的结构事实（高亮与扩选共用同一份） */
export interface ErbStructure {
  readonly lines: readonly ErbLine[];
  /** 行号 → 控制行（含没有块的孤儿关键字） */
  readonly controlByLine: ReadonlyMap<number, ErbControlLine>;
  /** 控制行行号 → 它所属的块（孤儿 / 未闭合的开块不在表里） */
  readonly blockByControlLine: ReadonlyMap<number, ErbBlock>;
  /** 全部配对成功的块（按开块行升序） */
  readonly blocks: readonly ErbBlock[];
  /** `@NAME` 定义（行序） */
  readonly functions: readonly ErbNameSpan[];
  /** `$NAME` 定义（行序） */
  readonly labels: readonly ErbNameSpan[];
  /** `CALL` 直系族名字槽（行序） */
  readonly calls: readonly ErbNameSpan[];
  /** `JUMP` / `GOTO` 直系族目标槽（行序） */
  readonly jumps: readonly ErbNameSpan[];
}

/** 死区标记的**严格等值**判据（与 `erb-parser/scanner.ts` 逐字同源；不放开大小写） */
const SKIP_START = '[SKIPSTART]';
const SKIP_END = '[SKIPEND]';

/**
 * 行首**代码前缀** `;!;` / `;#;`（Emuera 有效代码，不是注释；2026-10-25 P2-1）。
 *
 * 为什么这里再写一遍字形判据、而不是 import `plugin-api` 的 `erbCodePrefixLength`：
 * 本包是纯判据库（不引契约包），字面量与契约 `ERB_CODE_PREFIXES` 同值由宿主的
 * `packages/plugins/erb-parser/tests/code-prefix.test.ts` 与本包的
 * `tests/highlight.test.ts` 双向对拍——改一处不改另一处当场红。
 */
const CODE_PREFIXES: readonly string[] = [';!;', ';#;'];

/** 行首代码前缀宽度（0 = 没有前缀）；与 `plugin-api` 的 `erbCodePrefixLength` 同值 */
function codePrefixLength(trimmed: string): number {
  for (const prefix of CODE_PREFIXES) {
    if (trimmed.startsWith(prefix)) return prefix.length;
  }
  return 0;
}

/** 水平空白集（空格 / TAB / 全角空格——与 `scanUndefinedCallTargets` 同一集） */
const BLANK_RE = /[ \t\u3000]/;

/** 行首词一段（未 trim 的行上不匹配：缩进由调用方先算好） */
const LEAD_WORD_RE = /^[A-Za-z_]+/;

/** 源文切行（CRLF / CR / LF 都认；末尾换行留下一个空行，与 Monaco model 同口径） */
function splitLines(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

/**
 * 一行的"代码视野"：字符串内容与引号外的 `;` 注释尾巴**等长刷白**（列坐标不变）。
 *
 * 与 `erb-parser/references.ts::codeViewOf` 同一规则（那边未导出；宿主侧另一份在
 * `erb-dim-navigation.ts`，两处逐字符同形）。未闭合引号按"到行尾都是字符串"处理——
 * 那种文本引擎本来就编译不过，刷白是安全方向。
 */
export function erbCodeViewOf(line: string): string {
  if (line.indexOf('"') === -1 && line.indexOf(';') === -1) return line;
  let out = '';
  let seg = 0;
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (inString) {
      if (code === 34 /* " */) {
        out += ' '.repeat(i - seg + 1);
        seg = i + 1;
        inString = false;
      }
      continue;
    }
    if (code === 34 /* " */) {
      out += line.slice(seg, i) + ' ';
      seg = i + 1;
      inString = true;
    } else if (code === 59 /* ; */) {
      return out + line.slice(seg, i) + ' '.repeat(line.length - i);
    }
  }
  return inString ? out + ' '.repeat(line.length - seg) : out + line.slice(seg);
}

/** 从 `from` 起跳过水平空白后的下标（没有可跳过的就原样返回） */
function skipBlank(raw: string, from: number): number {
  let i = from;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (!BLANK_RE.test(ch)) break;
    i++;
  }
  return i;
}

/** 一个 0 基偏移处的名字记号（`view` 已把串 / 注释刷白 ⇒ 那里永远不会出记号） */
function nameSpanFrom(view: string, start: number): { start: number; end: number } | null {
  if (!isErbNameChar(view[start])) return null;
  let end = start + 1;
  while (end < view.length && isErbNameChar(view[end])) end++;
  return { start, end };
}

/**
 * `@` 行的定义名（0 基区间，相对行首；`null` = 这一行不是函数定义）。
 *
 * 名字 = `@` 之后的最大记号段，且**首字符必须是名字起始字符**：
 * 语料里跨行 CALL 的续行 `@"给…"` 也能切出一段"名字"，但它以 `"` 起首 ⇒ 自然被拒
 * （与 `erb-parser/structure.ts::isFunctionBoundary` 同一条排除理由）。
 */
function definitionName(raw: string, indent: number): { start: number; end: number; name: string } | null {
  const afterAt = indent + 1;
  if (raw[afterAt] === undefined || !isErbNameChar(raw[afterAt])) return null;
  if (!NAME_START.test(raw[afterAt]!)) return null;
  let end = afterAt + 1;
  while (end < raw.length && isErbNameChar(raw[end])) end++;
  return { start: afterAt, end, name: raw.slice(afterAt, end) };
}

/** `$` 行的标签名（0 基区间；首字符必须是名字起始字符——纯数字是行号不是标签） */
function labelName(raw: string, indent: number): { start: number; end: number; name: string } | null {
  const afterDollar = indent + 1;
  if (raw[afterDollar] === undefined || !isErbNameChar(raw[afterDollar])) return null;
  if (!NAME_START.test(raw[afterDollar]!)) return null;
  let end = afterDollar + 1;
  while (end < raw.length && isErbNameChar(raw[end])) end++;
  return { start: afterDollar, end, name: raw.slice(afterDollar, end) };
}

/**
 * 建立结构事实（**纯函数**；一次线性扫描，不做二次解析）。
 *
 * 死区按 `[SKIPSTART]` / `[SKIPEND]` 的**整行等值**判据切分（`kind = 'dead'`）；
 * 块栈在**函数边界**（`@NAME` 定义行）清空——跨函数配对是错的（与结构体检
 * `checkControlFlowStructure` 的 `flushOpen` 同一纪律），未闭合的开块因此不产块。
 */
function computeStructure(source: string): ErbStructure {
  const rawLines = splitLines(source);
  const rows: ErbLine[] = [];
  const functions: ErbNameSpan[] = [];
  const labels: ErbNameSpan[] = [];
  let inDeadZone = false;

  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index] ?? '';
    const outer = raw.trim();
    /**
     * 代码前缀（`;!;` / `;#;`）之后是真代码，不是注释（判据单源 `plugin-api` 的
     * 本文件的 `codePrefixLength`）。这里剥掉前缀再分类，`indent` 跟着把前缀宽度算进列坐标。
     */
    const prefixLen = codePrefixLength(outer);
    const trimmed = prefixLen === 0 ? outer : outer.slice(prefixLen);
    const indent = raw.length - raw.trimStart().length + prefixLen;
    const line = index + 1;

    if (inDeadZone) {
      if (trimmed === SKIP_END) {
        inDeadZone = false;
        rows.push({ line, raw, kind: 'marker', view: '', lead: '', leadStart: indent });
        continue;
      }
      rows.push({ line, raw, kind: 'dead', view: '', lead: '', leadStart: indent });
      continue;
    }
    if (trimmed === SKIP_START) {
      inDeadZone = true;
      rows.push({ line, raw, kind: 'marker', view: '', lead: '', leadStart: indent });
      continue;
    }
    if (trimmed.length === 0) {
      rows.push({ line, raw, kind: 'blank', view: '', lead: '', leadStart: indent });
      continue;
    }
    if (trimmed.startsWith(';')) {
      rows.push({ line, raw, kind: 'comment', view: '', lead: '', leadStart: indent });
      continue;
    }
    if (trimmed.startsWith('#')) {
      rows.push({ line, raw, kind: 'directive', view: '', lead: '', leadStart: indent });
      continue;
    }
    if (trimmed.startsWith('$')) {
      const label = labelName(raw, indent);
      if (label !== null) labels.push({ line, start: label.start, end: label.end, name: label.name });
      rows.push({ line, raw, kind: label === null ? 'code' : 'label', view: label === null ? erbCodeViewOf(raw) : '', lead: '', leadStart: indent });
      continue;
    }
    if (trimmed.startsWith('@')) {
      const definition = definitionName(raw, indent);
      if (definition !== null) {
        functions.push({ line, start: definition.start, end: definition.end, name: definition.name });
        rows.push({ line, raw, kind: 'definition', view: '', lead: '', leadStart: indent });
        continue;
      }
      // `@"…"` 续行 / 引号起的行：不是函数头，按普通代码行处理
    }

    const lead = LEAD_WORD_RE.exec(trimmed)?.[0].toUpperCase() ?? '';
    rows.push({ line, raw, kind: 'code', view: erbCodeViewOf(raw), lead, leadStart: indent });
  }

  /* ---- 控制行 + 块（角色栈：开块入栈、分支挂栈顶、收束出栈） ---- */
  const controlByLine = new Map<number, ErbControlLine>();
  const blockByControlLine = new Map<number, ErbBlock>();
  const blocks: ErbBlock[] = [];
  const stack: Array<{ open: ErbControlLine; branches: ErbControlLine[] }> = [];
  const calls: ErbNameSpan[] = [];
  const jumps: ErbNameSpan[] = [];

  for (const row of rows) {
    if (row.kind === 'definition') {
      // 函数边界：上一函数里没闭合的开块到此为止（不跨函数配对）
      stack.length = 0;
      continue;
    }
    if (row.kind !== 'code') continue;

    const role = roleOfWord(row.lead);
    if (role !== null) {
      const control: ErbControlLine = {
        line: row.line,
        word: row.lead,
        role,
        start: row.leadStart,
        end: row.leadStart + row.lead.length,
      };
      controlByLine.set(row.line, control);
      if (role === 'open') {
        stack.push({ open: control, branches: [] });
      } else if (role === 'branch') {
        const top = stack[stack.length - 1];
        if (top !== undefined) top.branches.push(control);
      } else {
        const top = stack.pop();
        if (top !== undefined) {
          const block: ErbBlock = { open: top.open, branches: top.branches, close: control };
          blocks.push(block);
          blockByControlLine.set(top.open.line, block);
          blockByControlLine.set(control.line, block);
          for (const branch of top.branches) blockByControlLine.set(branch.line, block);
        }
      }
      // 不 continue：`TRYCCALL` 既是 try 开块、又把函数名放在名字槽里（引擎同一语句两种身份），
      // 两条判据都要走一遍；`IF` / `ELSE` 一类词不以 CALL 收尾，下面的名字槽检查自然不命中。
    }

    /* ---- 名字槽：`CALL` / `JUMP` / `GOTO` 直系族（行首词形态判据，见头注） ---- */
    const keywordEnd = row.leadStart + row.lead.length;
    if (row.lead.endsWith('CALL')) {
      const at = skipBlank(row.raw, keywordEnd);
      const span = nameSpanFrom(row.view, at);
      // 名字槽必须是"像名字的裸标识符"（`CALL 123` / FORM 拼接一类不给槽）
      if (span !== null && NAME_START.test(row.raw[span.start]!)) {
        calls.push({ line: row.line, start: span.start, end: span.end, name: row.raw.slice(span.start, span.end) });
      }
    } else if (row.lead.endsWith('JUMP') || row.lead.endsWith('GOTO')) {
      let at = skipBlank(row.raw, keywordEnd);
      // 跳转目标可带 `$` / `*` 前缀（引擎两种写法都认）：区间只覆盖名字本身
      if (row.raw[at] === '$' || row.raw[at] === '*') at++;
      const span = nameSpanFrom(row.view, at);
      // 纯数字目标是**行号**不是标签名（引擎的两种跳转目标语义不同，不混为一谈）
      if (span !== null && NAME_START.test(row.raw[span.start]!)) {
        jumps.push({ line: row.line, start: span.start, end: span.end, name: row.raw.slice(span.start, span.end) });
      }
    }
  }

  blocks.sort((a, b) => a.open.line - b.open.line);

  return { lines: rows, controlByLine, blockByControlLine, blocks, functions, labels, calls, jumps };
}

/**
 * 最近一份源文的结构事实（LRU-1）。`computeStructure` 是 O(行数) 单趟（真语料 19,033 行
 * 实测 30.7ms），而两个消费方（同符号高亮、扩选）**每次光标移动各问一次**且答案逐字相同。
 * 命中判据是源文本身：`model.getValue()` 内容未变时交回同一引用，`===` 走 O(1) 快路；
 * 内容一变整份换掉（不做增量、不认版本号）。**返回值只读**（两个消费方都只读）。
 * 超 4MB 不入缓存（169k 行那份 5.7MB 不占内存）；只留一份，编辑一次就换。
 */
const STRUCTURE_CACHE_MAX_CHARS = 4 * 1024 * 1024;
let cachedStructureSource: string | null = null;
let cachedStructure: ErbStructure | null = null;

export function erbStructureOf(source: string): ErbStructure {
  if (cachedStructure !== null && cachedStructureSource === source) return cachedStructure;
  const built = computeStructure(source);
  if (source.length <= STRUCTURE_CACHE_MAX_CHARS) {
    cachedStructureSource = source;
    cachedStructure = built;
  } else {
    // 超大源文：连上一份一起丢掉，别让缓存持有两份大对象
    cachedStructureSource = null;
    cachedStructure = null;
  }
  return built;
}

/* ============================== 小工具 ============================== */

function isUsablePosition(position: ErbPosition | null | undefined): boolean {
  if (position === null || position === undefined) return false;
  return (
    Number.isFinite(position.line) &&
    Number.isFinite(position.column) &&
    position.line >= 1 &&
    position.column >= 1
  );
}

/** 大写归一（ERB 关键字与函数名都大小写不敏感；全角小写也随 `toUpperCase` 归一） */
function upperOf(text: string): string {
  return text.toUpperCase();
}

/** 一处 0 基记号 → 1 基区间 */
function spanRange(line: number, start: number, end: number): ErbRange {
  return { startLine: line, startColumn: start + 1, endLine: line, endColumn: end + 1 };
}

/** 该位置是不是落在被刷白的串 / 注释里（刷白处视图是空格、原文不是） */
function isMasked(row: ErbLine, col0: number): boolean {
  const ch = row.view[col0];
  if (ch !== ' ') return false;
  return !BLANK_RE.test(row.raw[col0] ?? ' ');
}

/** 代码行里的全部名字记号（按 `view` 切：串 / 注释位置不会有记号） */
function nameSpansOfRow(row: ErbLine): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < row.view.length) {
    if (!isErbNameChar(row.view[i])) {
      i++;
      continue;
    }
    const start = i;
    i++;
    while (i < row.view.length && isErbNameChar(row.view[i])) i++;
    out.push({ start, end: i });
  }
  return out;
}

/** 档位排序（同一行同一起点只可能是同一处；此序只为确定性） */
const KIND_ORDER: Readonly<Record<ErbHighlightKind, number>> = Object.freeze({
  write: 0,
  read: 1,
  text: 2,
});

/** 角色 → 档位（开块 = 写、分支 = 文、收束 = 读） */
const ROLE_KIND: Readonly<Record<'open' | 'branch' | 'close', ErbHighlightKind>> = Object.freeze({
  open: 'write',
  branch: 'text',
  close: 'read',
});

/* ============================== 符号识别 ============================== */

/** 光标处识别出的符号（只在本文件命名空间内） */
interface ErbHighlightSymbol {
  readonly kind: 'function' | 'label';
  /** 归一化大写名 */
  readonly name: string;
}

/** 同一行里起点落在 `start` 的记号槽（`CALL` / 跳转 / 声明） */
function spanAt(spans: readonly ErbNameSpan[], line: number, start: number): ErbNameSpan | undefined {
  return spans.find((span) => span.line === line && span.start === start);
}

/**
 * 光标处的符号（**只看本文件**）。
 *
 * 顺序：`@` / `$` 行（光标停在 `@` / `$` 与名字之间也算这一枚）→ 调用槽 / 跳转槽 →
 * 名字本身就是本文件里某枚声明 → 都不是 ⇒ `null`（不猜）。
 */
function symbolAt(structure: ErbStructure, row: ErbLine, col0: number): ErbHighlightSymbol | null {
  if (row.kind === 'definition' || row.kind === 'label') {
    const span =
      row.kind === 'definition'
        ? structure.functions.find((candidate) => candidate.line === row.line)
        : structure.labels.find((candidate) => candidate.line === row.line);
    if (span === undefined || col0 > span.end) return null;
    return { kind: row.kind === 'definition' ? 'function' : 'label', name: upperOf(span.name) };
  }
  if (isMasked(row, col0)) return null;
  const word = erbWordAt(row.raw, col0);
  if (word === null) return null;
  const name = upperOf(row.raw.slice(word.start, word.end));

  const call = spanAt(structure.calls, row.line, word.start);
  if (call !== undefined) return { kind: 'function', name };

  const jump = spanAt(structure.jumps, row.line, word.start);
  if (jump !== undefined) return { kind: 'label', name };

  if (structure.functions.some((span) => upperOf(span.name) === name)) return { kind: 'function', name };
  if (structure.labels.some((span) => upperOf(span.name) === name)) return { kind: 'label', name };
  return null;
}

/* ============================== 出现处收集 ============================== */

/** 控制关键字高亮：本块的开块（write）+ 分支（text）+ 收束（read） */
function keywordHighlights(structure: ErbStructure, line: number): ErbDocumentHighlight[] {
  const control = structure.controlByLine.get(line);
  if (control === undefined) return [];
  const block = structure.blockByControlLine.get(line);
  const out: ErbDocumentHighlight[] = [];
  if (block === undefined) {
    // 孤儿闭合 / 未闭合的开块：只给光标所在的那一枚（配对缺席就不猜别的）
    out.push({ range: spanRange(control.line, control.start, control.end), kind: ROLE_KIND[control.role] });
    return out;
  }
  out.push({ range: spanRange(block.open.line, block.open.start, block.open.end), kind: 'write' });
  for (const branch of block.branches) {
    out.push({ range: spanRange(branch.line, branch.start, branch.end), kind: 'text' });
  }
  if (block.close !== null) {
    out.push({ range: spanRange(block.close.line, block.close.start, block.close.end), kind: 'read' });
  }
  return sortHighlights(out);
}

/** 出现处按（行、列、档位）排序 + 同位同档去重 */
function sortHighlights(hits: ErbDocumentHighlight[]): ErbDocumentHighlight[] {
  const seen = new Set<string>();
  const out: ErbDocumentHighlight[] = [];
  for (const hit of hits) {
    const key = `${hit.range.startLine}:${hit.range.startColumn}:${hit.range.endColumn}:${hit.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  out.sort(
    (a, b) =>
      a.range.startLine - b.range.startLine ||
      a.range.startColumn - b.range.startColumn ||
      a.range.endColumn - b.range.endColumn ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );
  return out;
}

/** 一枚符号在本文件的全部出现处 */
function symbolHighlights(structure: ErbStructure, symbol: ErbHighlightSymbol): ErbDocumentHighlight[] {
  const want = symbol.name;
  const decls = symbol.kind === 'function' ? structure.functions : structure.labels;
  const reads = symbol.kind === 'function' ? structure.calls : structure.jumps;
  const out: ErbDocumentHighlight[] = [];

  const declLines = new Set<number>();
  for (const span of decls) {
    if (upperOf(span.name) !== want) continue;
    declLines.add(span.line);
    out.push({ range: spanRange(span.line, span.start, span.end), kind: 'write' });
  }

  const readKeys = new Set<string>();
  for (const span of reads) {
    if (upperOf(span.name) !== want) continue;
    readKeys.add(`${span.line}:${span.start}`);
    out.push({ range: spanRange(span.line, span.start, span.end), kind: 'read' });
  }

  // 代码面其余同名记号 = 不参与解析的提及（输出行散文 / 未加 CALL 的同名词）⇒ text
  for (const row of structure.lines) {
    if (row.kind !== 'code') continue;
    if (declLines.has(row.line)) continue; // 声明行的形参表是局部名，不是提及
    for (const span of nameSpansOfRow(row)) {
      if (span.start === row.leadStart) continue; // 行首语句关键字不是引用
      if (readKeys.has(`${row.line}:${span.start}`)) continue; // 已按 read 收过
      if (upperOf(row.raw.slice(span.start, span.end)) !== want) continue;
      out.push({ range: spanRange(row.line, span.start, span.end), kind: 'text' });
    }
  }
  return sortHighlights(out);
}

/* ============================== 纯逻辑入口 ============================== */

/**
 * 同符号高亮（**纯函数**）：源码 + 1 基行列 → 本文件的出现处。
 *
 * 空文件 / 坏输入 / 越界位点 / 光标下没有可证明的符号 ⇒ `[]`（不抛、不猜）。
 * 出现处的 `range` 是 1 基半开区间（与 Monaco `IRange` 同数值口径）。
 */
export function erbDocumentHighlights(source: string, position: ErbPosition): ErbDocumentHighlight[] {
  if (typeof source !== 'string' || source.length === 0) return [];
  if (!isUsablePosition(position)) return [];
  let structure: ErbStructure;
  try {
    structure = erbStructureOf(source);
  } catch {
    return [];
  }
  const row = structure.lines[position.line - 1];
  if (row === undefined) return [];
  if (position.column > row.raw.length + 1) return [];
  if (row.kind === 'blank' || row.kind === 'comment' || row.kind === 'dead' || row.kind === 'marker') return [];
  if (row.kind === 'directive') return [];

  const col0 = Math.min(Math.max(position.column - 1, 0), row.raw.length);

  // ① 控制流关键字（只认行首那枚词）
  if (row.kind === 'code') {
    const word = erbWordAt(row.raw, col0);
    if (word !== null && word.start === row.leadStart && roleOfWord(row.lead) !== null) {
      return keywordHighlights(structure, row.line);
    }
  }

  // ② 函数名 / `$` 标签
  const symbol = symbolAt(structure, row, col0);
  if (symbol === null) return [];
  return symbolHighlights(structure, symbol);
}
