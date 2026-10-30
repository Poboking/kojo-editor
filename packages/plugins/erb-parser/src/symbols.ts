import type {
  EditorRenameEdit,
  EditorRenameRelated,
  EditorRenameResult,
  EditorRenameTarget,
  EditorRenameTargetResult,
  EditorSymbolLocation,
  EnclosingMode,
  ErbFile,
  ErbFunction,
  ErbFunctionRef,
  ErbIndex,
  ErbReference,
} from '@kojo/plugin-api';
import { MODEL_TOKEN_CLASS, enclosingAt, enclosingChainAt, erbCodeBodyOf, symbolTokenAt } from '@kojo/plugin-api';
import { parseDimDeclaration, parseErbText, parseLabelDefinition } from './scanner';
import { codeViewOf, functionNameTokenAt, referencesOf } from './references';

/**
 * 位置 → 符号（B0，2026-10-15 语言服务批）。
 *
 * 全仓此前**没有任何**"位置 → 符号"的方法——definition / hover / highlight 三条线
 * 都得先回答"光标处是哪个函数"。本模块把这件事做成**纯函数**：索引进、符号出，
 * 不读盘、不碰工程状态，因此可被单测钉死，也可同时跑在 Node 与 WebView。
 *
 * 两条口径都刻意**复用 `ErbIndex` 既有结构**（不新造第二张表——第二张表就是漂移源）：
 * - 包围反查走 `files[path].functions` 的 `startLine/endLine`（`endLine` 由 scanner
 *   收紧成"下一个定义前一行"，故区间**互不重叠**）；判据本身**不在这里写**
 *   （W7 NAV-SCOPE：单源 `plugin-api/semantic-locate.ts` 的 `enclosingAt`）；
 * - 引用反查走 `byName`（"未定义函数"的判据 = `byName` 缺失，不另立标准）。
 */

/**
 * 包围该行的函数定义（1 基行号）。找不到 → `undefined`。
 *
 * **归属判据不在本文件**：区间包含与平局折法单源于 `@kojo/plugin-api` 的
 * `enclosingAt`（W7 NAV-SCOPE 批：同一行此前有四份判据四个答案，见该文件头注）。
 * 本模块只做**索引通道**的接线——按路径取文件、将 `mode` 原样传下去。
 *
 * 边界（逐条有测试）：
 * - `line` 非有限数 / 小于 1 → `undefined`（**不夹取**：把过期行号静默夹到附近，
 *   会把"位置失效"伪装成"命中旁边那个函数"，比不给答案更危险）；
 * - 行号超过文件行数 / 文件不在索引里 / 空文件（无 `@`）→ `undefined`；
 * - 一行落在两个区间上（理论上不发生——区间互不重叠）时取 `startLine` **较大**者
 *   （最近的 enclosing 定义，即 `innermost` 模式），保留为防御性口径。
 *
 * `mode` 是**显式模式参数**而不是第二份实现：大纲/跳状态/调用层级要最内层（缺省），
 * "这一行属于哪个外层块"那类消费者传 `outermost`。
 */
export function functionAt(
  index: ErbIndex,
  path: string,
  line: number,
  mode: EnclosingMode = 'innermost',
): ErbFunction | undefined {
  if (!Number.isFinite(line)) return undefined;
  const n = Math.trunc(line);
  if (n < 1) return undefined;
  const file = index?.files?.get(path);
  if (!file) return undefined;
  return functionInFile(file, n, mode);
}

/**
 * 单个解析结果内包围该行的函数（`functionAt` 的**唯一**内核，2026-10-16 语言服务批
 * 起同时服务标签导航——`definitionTargetsAt` 的输入是**缓冲区文本**（脏缓冲也要给
 * 正确答案），包围判定对"索引里的那份"与"刚 parse 出来的这份"必须是同一条逻辑）。
 */
export function functionInFile(
  file: ErbFile,
  line: number,
  mode: EnclosingMode = 'innermost',
): ErbFunction | undefined {
  return enclosingAt(file?.functions ?? [], line, mode);
}

/**
 * 归属**链**（外→内）：一次解析结果里包住该行的全部函数定义。
 * 面包屑与吸顶那类"要完整链"的消费者从这里取，别再去扫 `file.functions`
 * （扫一遍就是第五份判据）。
 */
export function functionChainInFile(file: ErbFile, line: number): ErbFunction[] {
  return enclosingChainAt(file?.functions ?? [], line);
}

/** 跳转系语句：行首关键字后的**第一个记号**是标签目标（`*CALLFORM` 与变量世界不在此列） */
const JUMP_FAMILY: ReadonlySet<string> = new Set(['JUMP', 'GOTO', 'TRYJUMP', 'TRYGOTO']);

/**
 * 行首跳转系关键字的结束偏移（0 基；非跳转行 = -1）。
 * 缩进口径与 `scanFileRefs` 的 `keywordEnd` 同一条（行首空白 + 关键字长度）。
 */
function jumpKeywordEndOf(lineText: string): number {
  const indent = lineText.length - lineText.trimStart().length;
  const lead = /^[A-Za-z_]+/.exec(lineText.slice(indent));
  if (!lead || !JUMP_FAMILY.has(lead[0]!.toUpperCase())) return -1;
  return indent + lead[0]!.length;
}

/** 标签记号字符集（与反向索引同一枚 Unicode 集：真实标签名允许 CJK） */
const LABEL_TOKEN_RUN = new RegExp(`^${MODEL_TOKEN_CLASS}+`, 'u');
const LABEL_NAME_FULL = new RegExp(`^${MODEL_TOKEN_CLASS}+$`, 'u');
/** 纯数字名字不认：`GOTO 123` 在引擎里与行号目标有歧义，不替作者裁决 */
const LABEL_NAME_DIGITS = /^\p{N}+$/u;

/** 行内一段裸标识符（0 基半开区间） */
interface LineToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * 跳转系语句的**裸标签目标**（行内 0 基区间）：关键字之后只许空白，目标必须是整段标识符。
 * 动态形态（`(X)` / `{X}` / `%X%` / `"X"`）与成员访问（`FLAG:X`）一律 `null`——不猜。
 */
function jumpSlotOf(lineText: string): LineToken | null {
  const keywordEnd = jumpKeywordEndOf(lineText);
  if (keywordEnd < 0) return null;
  let i = keywordEnd;
  while (i < lineText.length) {
    const ch = lineText[i]!;
    if (ch !== ' ' && ch !== '\t' && ch !== '\u3000') break;
    i++;
  }
  const run = LABEL_TOKEN_RUN.exec(lineText.slice(i));
  if (!run) return null;
  const end = i + run[0].length;
  const after = lineText[end];
  if (after === ':' || after === '：') return null;
  return { text: lineText.slice(i, end), start: i, end };
}

/** 光标是否落在跳转槽的目标记号上（含词尾后一格） */
function jumpSlotAt(lineText: string, column: number): LineToken | null {
  if (!Number.isFinite(column)) return null;
  const slot = jumpSlotOf(lineText);
  if (!slot) return null;
  const col0 = Math.trunc(column) - 1;
  return col0 >= slot.start && col0 <= slot.end ? slot : null;
}

/**
 * 光标是否落在 `$` 定义行的标签名上（含词尾后一格；名字形状不设限——判"这里不是函数名"
 * 不该依赖名字能不能作跳转目标）。
 */
function labelDefinitionAt(lineText: string, column: number): LineToken | null {
  if (!Number.isFinite(column)) return null;
  const indent = lineText.length - lineText.trimStart().length;
  const trimmed = lineText.trimStart();
  if (!trimmed.startsWith('$')) return null;
  const name = parseLabelDefinition(trimmed);
  if (name === undefined) return null;
  // parseLabelDefinition 允许 `$ NAME`：名字起点 = `$` 之后第一个非空白列（与其 trim 口径一致）
  let start = indent + 1;
  while (start < lineText.length && /\s/.test(lineText[start]!)) start++;
  const end = start + name.length;
  if (lineText.slice(start, end) !== name) return null;
  const col0 = Math.trunc(column) - 1;
  return col0 >= start && col0 <= end ? { text: name, start, end } : null;
}

/** 一处标签出现（定义或跳转目标）；行列 1 基、`endColumn` 不含端点（与 Monaco Range 同口径） */
export interface ErbLabelOccurrence {
  /** 原文（大小写随各处写法） */
  readonly name: string;
  readonly normalizedName: string;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
  /** `definition` = `$` 定义行；`jump` = JUMP/GOTO 系的目标槽 */
  readonly kind: 'definition' | 'jump';
}

/** 标签入口的两种形态 */
export type ErbLabelEntry = 'definition' | 'jump';

/**
 * 光标是否落在**标签入口**上（不要求标签真的存在）：
 * - `definition`：`$` 定义行的名字上（名字形状不设限）；
 * - `jump`：跳转系关键字之后的整个目标一侧（含 `(X)` / `FLAG:X` 这类动态目标）。
 *
 * 改名与转到定义都用它挡住"跳转目标被当成函数名"——`GOTO (ALPHA)` 里的 ALPHA
 * 是表达式不是函数引用，哪怕 ALPHA 恰好是函数名（跳转目标不猜，宁可不改）。
 */
export function labelEntryAt(lineText: string, column: number): ErbLabelEntry | null {
  if (labelDefinitionAt(lineText, column) !== null) return 'definition';
  if (jumpSlotAt(lineText, column) !== null) return 'jump';
  const keywordEnd = jumpKeywordEndOf(lineText);
  if (keywordEnd < 0 || !Number.isFinite(column)) return null;
  return Math.trunc(column) - 1 >= keywordEnd ? 'jump' : null;
}

/**
 * 光标处标签的**函数局部作用域读数**：同名定义与跳转目标的全部出现。
 *
 * 入口只有两个（都能证明"这个记号是标签"）：
 * - `$` 定义行上的名字；
 * - JUMP/GOTO 系目标槽里的裸标识符，且**本函数内确有**同名标签。
 *
 * 跳转目标无同名标签（动态表达式 / 拼错 / 跨函数）⇒ `null`，调用方给空结果——标签是
 * 函数局部作用域，跨函数同名各归各的；`GOTO ALPHA` 与函数 `ALPHA` 毫无关系。
 * `siblingNames` 供改名查重（同函数内其它标签，大小写不敏感、去重、保留原形）。
 */
export interface ErbLabelScope {
  /** 命中的标签名（定义侧原形，无定义时来自跳转目标） */
  readonly name: string;
  readonly normalizedName: string;
  /** 所属函数定义行（1 基）——标签作用域的唯一边界 */
  readonly functionStartLine: number;
  readonly occurrences: readonly ErbLabelOccurrence[];
  /** 同函数内其它标签名（不含自己；改名不能撞上它们） */
  readonly siblingNames: readonly string[];
}

/**
 * 光标处标签 → 本函数内的全部出现（**纯函数**：缓冲区文本进、作用域出；脏缓冲也正确）。
 *
 * 数据面只有 `parseErbText` 的 `labels`（定义）+ 同一函数行区间内的跳转槽（目标），
 * `[SKIPSTART]…[SKIPEND]` 一律不计（引擎不编译）。位置不构成标签入口 / 本函数没有
 * 同名标签 ⇒ `null`，**不猜、不抛**。
 */
export function labelScopeAt(
  text: string,
  path: string,
  line: number,
  column: number,
): ErbLabelScope | null {
  if (!Number.isFinite(line) || !Number.isFinite(column)) return null;
  const n = Math.trunc(line);
  if (n < 1) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const lineText = lines[n - 1];
  if (lineText === undefined) return null;
  const entry = labelDefinitionAt(lineText, column) ?? jumpSlotAt(lineText, column);
  if (!entry) return null;
  // 形状不整的名字（含标点）与裸数字（引擎里与行号目标有歧义）无从证明跳转，也不该改：不认
  if (!LABEL_NAME_FULL.test(entry.text) || LABEL_NAME_DIGITS.test(entry.text)) return null;
  const upper = entry.text.toUpperCase();
  const file = parseErbText(text, path);
  const fn = functionInFile(file, n);
  if (!fn) return null;
  const sameFunction = (file.labels ?? []).filter((label) => label.functionStartLine === fn.startLine);
  const own = sameFunction.find((label) => label.name.toUpperCase() === upper);
  if (!own) return null;

  const occurrences: ErbLabelOccurrence[] = [];
  const seen = new Set<string>();
  const push = (kind: ErbLabelOccurrence['kind'], atLine: number, token: LineToken): void => {
    const key = `${atLine}\u0000${token.start}`;
    if (seen.has(key)) return;
    seen.add(key);
    occurrences.push({
      name: token.text,
      normalizedName: upper,
      filePath: path,
      line: atLine,
      column: token.start + 1,
      endColumn: token.end + 1,
      kind,
    });
  };

  // 定义：同函数内同名（重复声明各算一条）
  for (const label of sameFunction) {
    if (label.name.toUpperCase() !== upper) continue;
    const raw = lines[label.line - 1];
    if (raw === undefined) continue;
    const indent = raw.length - raw.trimStart().length;
    const at = raw.indexOf(label.name, indent + 1);
    if (at < 0) continue;
    push('definition', label.line, { text: label.name, start: at, end: at + label.name.length });
  }

  // 跳转目标：本函数行区间内的可见行（跳过区 / 注释 / 指令行 / 定义行一概不进）
  let inSkipBlock = false;
  const lastLine = Math.min(fn.endLine, lines.length);
  for (let i = fn.startLine; i <= lastLine; i++) {
    const raw = lines[i - 1]!;
    const trimmed = raw.trim();
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (trimmed.length === 0) continue;
    const first = trimmed[0]!;
    if (first === ';' || first === '#' || first === '$' || first === '@') continue;
    const slot = jumpSlotOf(raw);
    if (!slot || slot.text.toUpperCase() !== upper) continue;
    push('jump', i, slot);
  }

  occurrences.sort((a, b) => a.line - b.line || a.column - b.column);

  const siblingNames: string[] = [];
  const seenSiblings = new Set<string>();
  for (const label of sameFunction) {
    const sibling = label.name.toUpperCase();
    if (sibling === upper || seenSiblings.has(sibling)) continue;
    seenSiblings.add(sibling);
    siblingNames.push(label.name);
  }
  return {
    name: own.name,
    normalizedName: upper,
    functionStartLine: fn.startLine,
    occurrences,
    siblingNames,
  };
}

/**
 * 光标下的函数**引用** → 定义位置列表（转到定义的数据面）。
 *
 * 三条腿（2026-10-19 W-2 起）：
 * - **标签定义腿**：光标在 `$` 定义行名字上 → 本函数内同名标签（重复定义全给）；
 * - **标签跳转腿**：记号在 JUMP/GOTO 系语句的名字槽里（裸标识符）→ 当前函数内的同名
 *   `$` 标签（函数局部作用域；找不到 = 空数组，不猜、也不落函数名——`GOTO ALPHA`
 *   是跳转不是调用）；
 * - **函数腿**（原有）：记号整串在项目索引 `byName` 里 → 它的**全部**定义（重名函数
 *   多处定义都给，由宿主/Monaco 呈现；此处不替作者裁决哪一个是"对的那个"）。
 *
 * **未收录 → 空数组**（"未定义函数"的判据就是 `byName` 缺失，不猜、不新造表）。
 * 因此本函数对"变量名 / 关键字 / 散文"一律不给答案：那些记号根本不在 `byName` 里。
 *
 * 取词尺 = `references.ts` 的 `functionNameTokenAt`（契约 `MODEL_TOKEN_CLASS` 那把 Unicode
 * 尺 + 成员冒号退让，**与 `erbReferenceLocationsAt` 是同一个函数**，不是"同一把尺子"的
 * 两种写法）。F12-TOKEN 2026-10-19 起不再用 ASCII 尺：真实语料 25,003 条含 CJK 的
 * `@` 定义名上，ASCII 尺在 50,006 个名字点位里只答得出 61 次（0.12%）——中文函数名的
 * F12 事实上是瞎的；中文散文那一侧的代价是 1,269,664 个散文点位里新增 1,384 次可跳
 * （0.11%），而每一次的落点都是"光标下那一整串恰好是某个函数的名字"。
 * 优先序仍由本函数的**一条链**裁决：标签腿 →（标签入口但作用域不成立 ⇒ 不给）→ 函数腿。
 *
 * 纯函数：只读入参索引，`text` 只用来切行与（仅标签入口命中时）parse 出标签表。
 */
export function definitionTargetsAt(
  index: ErbIndex,
  path: string,
  text: string,
  line: number,
  column: number,
): ErbFunctionRef[] {
  const lineText = lineTextOf(text, line);
  if (lineText === undefined) return [];
  const scope = labelScopeAt(text, path, line, column);
  if (scope) {
    return scope.occurrences
      .filter((occurrence) => occurrence.kind === 'definition')
      .map((occurrence) => ({
        name: occurrence.name,
        normalizedName: occurrence.normalizedName,
        filePath: path,
        startLine: occurrence.line,
        endLine: occurrence.line,
        // 标签出现点本来就带列（`labelScopeAt` 算的），此前在这里被丢掉 ⇒ 同一次 F12
        // 走函数腿有列、走标签腿没列。结束列 = column + 名字长度，与 `occurrence.endColumn`
        // 恒等（同一把尺子的两种写法），所以这里只带起点列。
        nameColumn: occurrence.column,
      }));
  }
  // 标签入口（定义名 / 跳转目标一侧）但作用域不成立 ⇒ 空数组：`$FOO` 不是函数引用，
  // 哪怕 FOO 恰好是函数名；`GOTO NOWHERE` / `GOTO (X)` 也不落函数名那把尺子
  if (labelEntryAt(lineText, column) !== null) return [];
  const token = functionNameTokenAt(lineText, column);
  if (!token) return [];
  return index.byName.get(token.text.toUpperCase()) ?? [];
}

/** 取 1 基行号的原文（越界 → undefined；不做补空格之类的"宽容"假数据） */
function lineTextOf(text: string, line: number): string | undefined {
  if (!Number.isFinite(line)) return undefined;
  const n = Math.trunc(line);
  if (n < 1) return undefined;
  const lines = text.split(/\r\n?|\n/);
  return lines[n - 1];
}

/* 本地名字（`#DIM` 声明名 / `$` 标签名）的落点判据 —— `erb-definition` 的本地两腿。
 * 2026-10-30 从 `@kojo/erb-lang/definition` 折回本插件：常驻包静态引库叶子会把整包拖进首屏。 */

/** `.kojo` 是派生文本（行号不属于原文 ⇒ 不答）；比 `isErbDialectPath` 多认 `.erd` */
const LOCAL_NAME_DIALECT_RE = /\.(?:erb|erh|erd)$/i;

export function isErbDefinitionPath(path: string): boolean {
  return LOCAL_NAME_DIALECT_RE.test(path);
}

/** 行首 `#DIM*`（名字与修饰词的切分以 `parseDimDeclaration` 为准） */
const DIM_HEAD_RE = /^#(?:DIMSTR|DIMCHAR|DIMS|DIM)\b/i;
const DIM_MODIFIERS = new Set(['CONST', 'SAVEDATA', 'GLOBAL', 'REF', 'NOINIT', 'CHARA']);

/** 一条 `#DIM*` 声明（`nameStart` = 行内 0 基列偏移） */
export interface ErbDimDeclaration {
  readonly directive: string;
  readonly name: string;
  readonly nameStart: number;
}

/** 名字字符：非空白、非运算符 / 分隔符（中文与全角字母都合法，绝不用 `\w`） */
export function isErbDimNameChar(ch: string | undefined): boolean {
  return ch !== undefined && !/[\s,;:()[\]{}=+\-*/<>%!&|'"`]/.test(ch);
}

/** 归一变行后切行（1 基行号 = 下标 + 1；与解析器同规则） */
const linesOf = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n');

/** 一行 `#DIM*`：名字与指令取 `parseDimDeclaration`，本函数只补名字起始列 */
export function dimDeclarationOf(line: string): ErbDimDeclaration | null {
  const trimmed = line.trim();
  const parsed = parseDimDeclaration(trimmed);
  const head = parsed === null ? null : DIM_HEAD_RE.exec(trimmed);
  if (!parsed || !head) return null;
  const indent = line.length - line.trimStart().length;
  let i = head[0].length;
  let nameStart = -1;
  while (i < trimmed.length) {
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i++;
    const start = i;
    while (i < trimmed.length && !/[\s,=[\]]/.test(trimmed[i]!)) i++;
    if (start === i) break;
    if (!DIM_MODIFIERS.has(trimmed.slice(start, i).toUpperCase())) {
      nameStart = start;
      break;
    }
  }
  if (nameStart < 0) return null;
  const name = parsed.name.replace(/\[[^\]]*\]$/, '');
  if (name.length === 0 || !trimmed.startsWith(name, nameStart)) return null;
  return { directive: parsed.directive, name, nameStart: indent + nameStart };
}

/** 本文件全部 `#DIM*`（跳过 `[SKIPSTART]…[SKIPEND]`，与解析器同口径） */
export function dimDeclarationsOf(text: string): { line: number; dim: ErbDimDeclaration }[] {
  const out: { line: number; dim: ErbDimDeclaration }[] = [];
  let inSkipBlock = false;
  const lines = linesOf(text);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    const dim = dimDeclarationOf(lines[i]!);
    if (dim) out.push({ line: i + 1, dim });
  }
  return out;
}

/** 光标处变量名 → 本文件同名声明的落点；注释 / 字符串不算变量位置，跨文件不猜 */
export function resolveErbDimDefinition(
  text: string,
  line: number,
  column: number,
  filePath: string | null,
): EditorSymbolLocation[] {
  if (!filePath || !isErbDefinitionPath(filePath)) return [];
  if (!Number.isFinite(line) || !Number.isFinite(column)) return [];
  const lineText = linesOf(text)[Math.trunc(line) - 1];
  if (lineText === undefined) return [];
  const token = symbolTokenAt(codeViewOf(lineText), column, isErbDimNameChar);
  if (!token) return [];
  const want = token.text.toUpperCase();
  const out: EditorSymbolLocation[] = [];
  for (const { line: atLine, dim } of dimDeclarationsOf(text)) {
    if (dim.name.toUpperCase() !== want) continue;
    out.push({
      filePath,
      line: atLine,
      column: dim.nameStart + 1,
      span: { columnStart: dim.nameStart + 1, columnEnd: dim.nameStart + 1 + dim.name.length },
    });
  }
  return out;
}

/** 落点投影只要标签出现的这五格（作用域其余字段与投影无关） */
type LabelSpanFacts = Pick<ErbLabelOccurrence, 'filePath' | 'line' | 'column' | 'endColumn' | 'kind'>;

/** 一处标签出现 → 落点（零宽那一格不给区间：硬拼 `{n,n}` 是给下游发假区间） */
function labelLocation(occurrence: LabelSpanFacts, kind: EditorSymbolLocation['kind']): EditorSymbolLocation {
  return {
    filePath: occurrence.filePath,
    line: occurrence.line,
    column: occurrence.column,
    ...(occurrence.endColumn > occurrence.column
      ? { span: { columnStart: occurrence.column, columnEnd: occurrence.endColumn } }
      : {}),
    kind,
  };
}

/** 作用域里的 `$` 定义 → 导航落点（F12 自跳；重复定义全部保留） */
export function labelDefinitionLocations(scope: { readonly occurrences: readonly LabelSpanFacts[] }): EditorSymbolLocation[] {
  return scope.occurrences
    .filter((occurrence) => occurrence.kind === 'definition')
    .map((occurrence) => labelLocation(occurrence, 'definition'));
}

/** 作用域里的全部出现 → 引用落点（Shift+F12）；跳转目标记 `mention`（`GOTO` 不是调用） */
export function labelReferenceLocations(scope: { readonly occurrences: readonly LabelSpanFacts[] }): EditorSymbolLocation[] {
  return scope.occurrences.map((occurrence) =>
    labelLocation(occurrence, occurrence.kind === 'definition' ? 'definition' : 'mention'),
  );
}

/** 路径判等形态（`\` → `/`，大小写折叠）：两条腿的 `filePath` 来源不同，裸比会留下两份同一落点 */
export function normalizePathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** 合并两批位置（`primary` 在前），按 `路径(归一) + 行 + 区间起点` 去重；同处先到者没区间、后到者补上 */
export function mergeSymbolLocations(
  primary: readonly EditorSymbolLocation[],
  secondary: readonly EditorSymbolLocation[],
): EditorSymbolLocation[] {
  const out: EditorSymbolLocation[] = [];
  const at = new Map<string, number>();
  for (const loc of [...primary, ...secondary]) {
    const start = loc.span?.columnStart ?? loc.column ?? 0;
    const key = `${normalizePathKey(loc.filePath)}\u0000${loc.line}\u0000${start}`;
    const seenAt = at.get(key);
    if (seenAt === undefined) {
      at.set(key, out.length);
      out.push(loc);
      continue;
    }
    const kept = out[seenAt]!;
    if (!kept.span && loc.span) out[seenAt] = { ...kept, span: loc.span };
    if (kept.column === undefined && loc.column !== undefined) out[seenAt] = { ...out[seenAt]!, column: loc.column };
  }
  return out;
}

/** 三腿优先序：`$` 标签 → `#DIM` 声明 → 槽腿；收成一条链，F12 与 Shift+F12 不会各写一份 */
export function mergeNavigationLegs(
  labels: readonly EditorSymbolLocation[],
  dims: readonly EditorSymbolLocation[],
  slot: readonly EditorSymbolLocation[],
): EditorSymbolLocation[] {
  return mergeSymbolLocations(labels, mergeSymbolLocations(dims, slot));
}

/* ============================== 改名判据（LAU-4 改名腿） ============================== */

/**
 * ERB 改名判据（函数名 / `$` 标签两条腿）——LAU-4 从宿主 `monaco/erb-rename.ts` 整块搬来；
 * 宿主从此只剩「model/位置 → 请求」「契约 → Monaco 形状」与**落盘通道**（写允许域 / 写前备份 /
 * 双通道送达：宿主事实，不是语言判据）。
 *
 * 三态：`undefined` = 本包不认这个文件 / 语言（弃权）；索引未建、反向索引缺席、别家证据
 * `unprovable` 非空 ⇒ **拒绝**（可见理由，漏一处就是同名分叉）；拒绝时 `edits` 必为空。
 * 其它语言证据由宿主当**数据**递进来（供方之间不能互问），"判据缺席 ⇒ 整次拒绝"在这里裁决。
 */

/** 标识字符集（Unicode 字母 / 数字 / 下划线，与反向索引同口径；真语料 21% 函数名含 CJK） */
const IDENT_RE = /[\p{L}\p{N}_]/u;

function isIdentPart(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_RE.test(ch);
}

/** 光标列（0 基）→ 所在词 `[start, end)`；贴着词尾后一格也算在词上（同 Monaco 行为） */
export function wordAtColumn(lineText: string, col0: number): { start: number; end: number } | null {
  if (!Number.isFinite(col0) || col0 < 0) return null;
  const at = Math.min(Math.trunc(col0), lineText.length);
  const anchor = isIdentPart(lineText[at - 1]) ? at - 1 : isIdentPart(lineText[at]) ? at : -1;
  if (anchor < 0) return null;
  let start = anchor;
  while (start > 0 && isIdentPart(lineText[start - 1])) start--;
  let end = anchor + 1;
  while (end < lineText.length && isIdentPart(lineText[end])) end++;
  return { start, end };
}

/** 名字判定的产物：命中（1 基区间 + 归一化名）或拒绝（给作者看的理由） */
export type RenameNameTarget =
  | { readonly kind: 'hit'; readonly startColumn: number; readonly endColumn: number; readonly normalizedName: string }
  | { readonly kind: 'reject'; readonly reason: string };

/** 光标处词 → 是否可重命名（`column` 1 基；`hasName` = 索引里有没有这个名字） */
export function resolveRenameName(
  lineText: string,
  column: number,
  hasName: (normalizedName: string) => boolean,
): RenameNameTarget {
  const col0 = Math.min(Math.max(0, column - 1), lineText.length);
  const word = wordAtColumn(lineText, col0);
  if (!word) return { kind: 'reject', reason: '光标处没有可重命名的名字' };
  const raw = lineText.slice(word.start, word.end);
  const normalizedName = raw.toUpperCase();
  if (!hasName(normalizedName)) {
    return {
      kind: 'reject',
      reason: `「${raw}」不在 ERB 函数索引内，不能重命名（$ 标签与 #DIM 局部名不在射程）`,
    };
  }
  return { kind: 'hit', startColumn: word.start + 1, endColumn: word.end + 1, normalizedName };
}

/* -------- `$` 标签改名判据（单文件、函数局部） -------- */

/** 标签名字符集 / 纯数字判据复用上面的 `LABEL_NAME_FULL`、`LABEL_NAME_DIGITS`（同源一处） */

/** 标签新名判定（`null` = 可用；字符串 = 给作者看的拒绝理由；只改大小写合法） */
export function labelRenameRejection(
  scope: Pick<ErbLabelScope, 'name' | 'normalizedName' | 'siblingNames'>,
  newName: string,
): string | null {
  if (!LABEL_NAME_FULL.test(newName)) return `标签名只能用字母、数字、下划线（「${newName}」含其它字符）`;
  if (LABEL_NAME_DIGITS.test(newName)) return `标签名不能是纯数字（「${newName}」会与行号跳转混淆）`;
  const upper = newName.toUpperCase();
  if (upper === scope.normalizedName) return null;
  const clash = scope.siblingNames.find((name) => name.toUpperCase() === upper);
  return clash === undefined ? null : `本函数里已有标签「${clash}」，不能改成「${newName}」（标签名不区分大小写）`;
}

/** 光标是否落在作用域中的某一处（含词尾后一格） */
function occurrenceAt(scope: ErbLabelScope, line: number, column: number): ErbLabelOccurrence | undefined {
  return scope.occurrences.find(
    (occurrence) => occurrence.line === line && column >= occurrence.column && column <= occurrence.endColumn,
  );
}

/**
 * `.kojo` 源里是否有同名标签的**可证明引用面**（只认行首写法：`标签 <名>` / `跳到 <名>` /
 * 原生直通 `$名` / `JUMP|GOTO|TRYJUMP|TRYGOTO <名>`）。命中 ⇔ 只改 `.erb` 会被下一次保存盖回去。
 */
export function kojoLabelMentions(text: string, normalizedName: string): boolean {
  const want = normalizedName.toUpperCase();
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const code = raw.replace(/;.*$/, '').trim();
    if (code.length === 0) continue;
    const sugar = /^(?:标签|跳到)\s+(\S+)/.exec(code);
    const rawLabel = sugar === null ? /^\$(\S+)/.exec(code) : null;
    const rawJump = sugar === null && rawLabel === null ? /^(?:JUMP|GOTO|TRYJUMP|TRYGOTO)\s+(\S+)/i.exec(code) : null;
    const name = (sugar ?? rawLabel ?? rawJump)?.[1]?.replace(/^[$*]/, '');
    if (name !== undefined && name.toUpperCase() === want) return true;
  }
  return false;
}

/* -------- 求值（`resolveRenameLocation` 那一步） -------- */

/** 求值三态：`hit` = 可改名；`reject` = 认这个位置但不改；`none` = 本包不答 */
export type ErbRenameResolution =
  | { readonly kind: 'hit'; readonly target: EditorRenameTarget }
  | { readonly kind: 'reject'; readonly reason: string }
  | { readonly kind: 'none' };

/**
 * 光标处 → 可改名的原词：`$` 标签腿优先（文件局部事实，索引未建也能改），其次函数名腿。
 * 标签入口但作用域不成立 ⇒ 拒绝，**绝不落函数名腿**（`GOTO ALPHA` 不是调用 ALPHA）。
 */
export function resolveErbRenameAt(
  index: ErbIndex | null,
  path: string,
  text: string,
  line: number,
  column: number,
): ErbRenameResolution {
  if (!Number.isFinite(line) || !Number.isFinite(column) || line < 1) return { kind: 'none' };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const lineText = lines[Math.trunc(line) - 1] ?? '';
  const scope = labelScopeAt(text, path, Math.trunc(line), Math.trunc(column));
  const labelHit = scope === null ? undefined : occurrenceAt(scope, Math.trunc(line), Math.trunc(column));
  if (scope !== null && labelHit !== undefined) {
    return {
      kind: 'hit',
      target: {
        line: labelHit.line,
        startColumn: labelHit.column,
        endColumn: labelHit.endColumn,
        text: lineText.slice(labelHit.column - 1, labelHit.endColumn - 1),
        scope: 'label',
      },
    };
  }
  const entry: ErbLabelEntry | null = labelEntryAt(lineText, Math.trunc(column));
  if (entry !== null) {
    return {
      kind: 'reject',
      reason:
        entry === 'jump'
          ? '跳转目标在当前函数里找不到同名 `$` 标签，不按函数名重命名（不猜）'
          : '这不是可重命名的 `$` 标签名（标签名只能是字母、数字、下划线）',
    };
  }
  if (index === null) return { kind: 'none' };
  const target = resolveRenameName(lineText, Math.trunc(column), (name) => index.byName.has(name));
  if (target.kind === 'reject') return { kind: 'reject', reason: target.reason };
  return {
    kind: 'hit',
    target: {
      line: Math.trunc(line),
      startColumn: target.startColumn,
      endColumn: target.endColumn,
      text: lineText.slice(target.startColumn - 1, target.endColumn - 1),
      scope: 'symbol',
    },
  };
}

/* -------- 编辑集（`provideRenameEdits` 那一步） -------- */

/** 一份文件的编辑组（宿主按 `resourcePath` 分组送达；组序 = 索引出现序） */
function editOf(
  reference: {
    readonly filePath: string;
    readonly line: number;
    readonly column: number;
    readonly endColumn: number;
    readonly kind?: ErbReference['kind'];
  },
  requestPath: string,
  newName: string,
): EditorRenameEdit {
  return {
    line: reference.line,
    startColumn: reference.column,
    endColumn: reference.endColumn,
    newText: newName,
    ...(reference.filePath === requestPath ? {} : { resourcePath: reference.filePath }),
    ...(reference.kind === undefined ? {} : { occurrenceKind: reference.kind }),
  };
}

/**
 * 别家供方证明过的位置 → 编辑（`endColumn` = `column + 名字长度`，与反向索引同一条派生纪律）。
 * **不标** `occurrenceKind`：那是"散文跳过"的入口，只对 ERB 词法面有意义——跨语言腿的点是真引用。
 */
function relatedEdits(
  locations: readonly EditorSymbolLocation[] | undefined,
  requestPath: string,
  normalizedName: string,
  newName: string,
): EditorRenameEdit[] {
  const out: EditorRenameEdit[] = [];
  for (const location of locations ?? []) {
    if (!Number.isFinite(location.line) || location.line < 1) continue;
    const column = location.column ?? location.span?.columnStart ?? 1;
    if (!Number.isFinite(column) || column < 1) continue;
    const endColumn = location.span?.columnEnd ?? column + normalizedName.length;
    out.push({
      line: location.line,
      startColumn: column,
      endColumn,
      newText: newName,
      ...(location.filePath === requestPath ? {} : { resourcePath: location.filePath }),
    });
  }
  return out;
}

/**
 * 一次改名的完整判据：成功 = 编辑集 + 原名；失败 = 空编辑 + 可读理由。顺序即语义：
 * 标签腿先走 → 别家证据 `unprovable` 非空整次拒绝 → 函数腿（索引 / 反向索引缺席、引用集空
 * 都拒绝）→ 编辑集 = 本语言引用全集 + 别家证据（同一份全或无）。
 */
export function planErbRename(
  index: ErbIndex | null,
  requestPath: string,
  text: string,
  line: number,
  column: number,
  newName: string,
  related?: EditorRenameRelated,
): EditorRenameResult {
  const reject = (rejectReason: string): EditorRenameResult => ({ kind: 'rename', edits: [], rejectReason });
  const resolution = resolveErbRenameAt(index, requestPath, text, line, column);
  if (resolution.kind === 'none') return reject('ERB 函数索引未建，暂不可重命名');
  if (resolution.kind === 'reject') return reject(resolution.reason);

  const target = resolution.target;
  const normalizedName = target.text.toUpperCase();

  if (target.scope === 'label') {
    // 看不见 `.kojo` 源（宿主枚举抛错）⇒ 无从证明有没有同名标签写法 ⇒ 整次拒绝
    const unprovable = related?.unprovable ?? [];
    if (unprovable.length > 0) {
      return reject(`无法检查 .kojo 源里的同名标签（${unprovable.join('、')}）——为免只改一半，整次重命名取消`);
    }
    const scope = labelScopeAt(text, requestPath, line, column);
    if (scope === null) return reject('当前位点的 `$` 标签作用域已变化，请重按 F2 重试');
    const rejection = labelRenameRejection(scope, newName);
    if (rejection !== null) return reject(rejection);
    let kojoHits = 0;
    for (const source of related?.sources ?? []) {
      if (kojoLabelMentions(source.text, scope.normalizedName)) kojoHits++;
    }
    if (kojoHits > 0) {
      return reject(
        `${kojoHits} 份 .kojo 源里也写着标签「${scope.name}」。保存 .kojo 时会按同名重新生成 .erb，` +
          '只改这一处会留下两份不一致的标签，故整次重命名取消。请先在 .kojo 源里改名。',
      );
    }
    return {
      kind: 'rename',
      edits: scope.occurrences.map((occurrence) => ({
        line: occurrence.line,
        startColumn: occurrence.column,
        endColumn: occurrence.endColumn,
        newText: newName,
      })),
      oldName: scope.name,
    };
  }

  const unprovable = related?.unprovable ?? [];
  if (unprovable.length > 0) {
    return reject(
      `${normalizedName} 的改名需要连带 .kojo 源，但 ${unprovable.length} 项 .kojo 侧判据缺席：` +
        unprovable.join('、') +
        '。无法证明这些记号是否指向本函数——' +
        '只改 .erb 会被下一次保存 .kojo 冲掉，故整次重命名取消（不静默改一半）。' +
        '请先在对应 .kojo 源内改名，或由宿主接入 ui.editor.languageService 的引用判读',
    );
  }
  if (index === null) return reject('ERB 函数索引未建，暂不可重命名');
  if (index.references === undefined) {
    return reject('反向引用索引缺席，无法全项目收集引用（不猜，不部分改）');
  }
  const refs = referencesOf(index, normalizedName);
  if (refs.length === 0) {
    return reject('反向引用索引缺席，无法全项目收集引用（不猜，不部分改）');
  }
  const edits: EditorRenameEdit[] = refs.map((ref) => editOf(ref, requestPath, newName));
  edits.push(...relatedEdits(related?.occurrences, requestPath, normalizedName, newName));
  return { kind: 'rename', edits, oldName: target.text };
}

/* -------- 槽供方（两枚成员） -------- */

/** `renameTarget` 供方：非方言 / 索引未建 ⇒ `undefined`（弃权）；拒绝理由原样交回 */
export function provideRenameTarget(
  index: ErbIndex | null,
  request: { readonly path: string; readonly text: string; readonly line: number; readonly column: number },
  isDialect: (path: string) => boolean,
): EditorRenameTargetResult | undefined {
  if (!isDialect(request.path)) return undefined;
  const resolution = resolveErbRenameAt(index, request.path, request.text, request.line, request.column);
  if (resolution.kind === 'none') return undefined;
  if (resolution.kind === 'reject') return { kind: 'renameTarget', rejectReason: resolution.reason };
  return { kind: 'renameTarget', target: resolution.target };
}

/** `rename` 供方：非方言 ⇒ `undefined`；编辑集或拒绝理由二选一（契约全或无） */
export function provideRename(
  index: ErbIndex | null,
  request: {
    readonly path: string;
    readonly text: string;
    readonly line: number;
    readonly column: number;
    readonly newName: string;
    readonly related?: EditorRenameRelated;
  },
  isDialect: (path: string) => boolean,
): EditorRenameResult | undefined {
  if (!isDialect(request.path)) return undefined;
  return planErbRename(index, request.path, request.text, request.line, request.column, request.newName, request.related);
}
