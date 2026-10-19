import type { EnclosingMode, ErbFile, ErbFunction, ErbFunctionRef, ErbIndex } from '@kojo/plugin-api';
import { MODEL_TOKEN_CLASS, enclosingAt, enclosingChainAt } from '@kojo/plugin-api';
import { parseErbText, parseLabelDefinition } from './scanner';
import { functionNameTokenAt } from './references';

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
