/**
 * Kojo 2.0 宿主侧**存储注册表**（K2-STORAGE-HOST）：`# 对照表 / # 池 / # 设 / # 设` 的项目级索引。
 *
 * ## 这一层为什么必须存在
 *
 * core 的 `project/storage`（槽位账本）与 `table`（表校验）都只吃**事实**、只吐**纯数据**：
 * 它们不知道文件 URI，也不该知道（core 零 IO）。宿主要做的东西恰恰相反——「按名字跳转」
 * 「这个文件里有什么」「补全该弹谁」「这条 error 点回哪一行」。把这些拼起来需要一份**跨文件**
 * 的索引，而索引一旦散落在面板 / 补全 / 诊断三处，三套缓存迟早对不上。所以注册表是**唯一**
 * 的装配点：一次 `lex + parse + planStorageSlots + validateTable`，产出一份不可变快照。
 *
 * ## 三条硬口径
 *
 * 1. **不静默覆盖**：同名重复声明不会被 Map 吃掉。`symbols` 保留每一条声明（按文件+位置定身份），
 *    `conflicts` 按名字分组暴露 `reasons`（重名 / 种类不同 / 类型不同 / 存储期不同）与
 *    `codes`（core 真报过的码）。`findDeclaration` 仍给一个**确定**的落点（稳定序第一枚），
 *    但同时带 `ambiguous: true` 与全部 `candidates`——宿主必须让作者看见歧义，不许假装唯一。
 * 2. **码原样**：诊断桥只做坐标与 URI 的搬运，`code` 逐字保留 core 的值（`core/storage/*` /
 *    `core/table/*` / `core/pool/*` / `core/decl/*` / `core/lex/*`）。**不发明码**：
 *    core 没报的冲突只出现在 `conflicts` 里，不会伪造一条诊断。
 * 3. **纯数据**：零 React、零 DOM、零 Monaco、零 IO。输入是 `{ uri, source }[]`，输出是
 *    readonly 对象图（运行时 `Object.freeze`，不只是 TS 的 `readonly` 装饰）。
 *
 * ## 坐标与不可变
 *
 * 行列一律 **1 基、UTF-16 码元**（与 core `KojoSpan` / Monaco 同口径），`endColumn` **不含**
 * （半开区间）。名字段命中的判据放宽一格：光标停在名字尾列也算命中（F12 的常见位置）。
 * 诊断落点会被夹进源文本现实（越界夹回、零宽扩一格）——这一步只影响**上屏**，不影响
 * `symbols` 里的真实 span。
 *
 * ## 与换盘 / 槽位账本的关系
 *
 * `# 设` 的槽位由 core 的 `planStorageSlots` 分配；本模块把 `存储期 + 声明键 → 槽` 挂回 symbol。
 * 声明键缺省是 `uri#行:列`（**无账本的近似**：改名不搬槽，搬行会搬槽）。真项目必须由宿主注入
 * `declarationKey`（编辑器账本的跨构建稳定键），并把 adapter 的槽位区段经 `storageClasses` 注入；
 * 缺省的宽松区段只配「没有 adapter 事实」的预览/测试。
 */
import {
  KOJO_STORAGE_WORDS,
  KOJO_TYPE_WORDS,
  collectIntegerConstants,
  lex,
  parse,
  planStorageSlots,
  splitSpaces,
  validateTable,
} from '@kojo/kojo-core';
import type {
  KojoConstDecl,
  KojoDiagnostic,
  KojoFile,
  KojoLexLine,
  KojoLiteral,
  KojoPhysicalLine,
  KojoSpan,
  KojoValueType,
  KojoVarStorage,
  SlotClassSpec,
  SlotRegistrySnapshot,
  StorageAllocationPlan,
  StorageDeclarationFact,
} from '@kojo/kojo-core';

/* ============================== 契约：种类与不可变形状 ============================== */

/** 本注册表管的四类声明（`# 模` / `@函` 不在存储面内，另有所属索引） */
export type Kojo2StorageKind = 'var' | 'const' | 'table' | 'pool';

/**
 * 可写性（`# 设` 的只读语义在**索引层**就钉住，不等 S5 校验）：
 *
 * - `mutable`：`# 设`，可赋值；
 * - `immutable`：`# 设`，编译期常量、任何赋值都是 `core/expr/assign-to-constant`；
 * - `read-only`：`# 对照表` / `# 池`，压根不是存储单元（引用点展开成隐藏槽），不可赋值。
 */
export type Kojo2StorageMutability = 'mutable' | 'immutable' | 'read-only';

/** 宿主坐标（1 基、UTF-16 码元；`endColumn` 半开） */
export interface Kojo2StorageRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** `# 设` 额外的存储事实（槽位来自 core 的 `planStorageSlots`） */
export interface Kojo2StorageVarFacts {
  readonly storage: KojoVarStorage;
  /** 数组长度**源文本**（`整数[上限]` → `上限`）；标量为 null */
  readonly arraySize: string | null;
  /** 交给 core 的声明键（跨构建稳定标识；缺省 `uri#行:列`） */
  readonly storageKey: string;
  /** 已分配槽位；规划失败（fail-closed）时为 null——**不猜** */
  readonly slot: number | null;
}

/** `# 对照表` 的静态事实（表行/兜底由 core 校验，这里只留计数） */
export interface Kojo2StorageTableFacts {
  readonly subject: string;
  readonly rows: number;
  readonly hasDefault: boolean;
}

/** `# 池` 的静态事实 */
export interface Kojo2StoragePoolFacts {
  readonly branches: number;
  readonly hasDefault: boolean;
}

/**
 * 一条声明符号。**每条声明一个**（同名重复声明各占一条，绝不合并）。
 *
 * `id` 由（uri, 行, 列）派生：同一份源里同位置的声明不可能有两个，重复解析结果稳定。
 */
export interface Kojo2StorageSymbol {
  readonly id: string;
  readonly name: string;
  readonly kind: Kojo2StorageKind;
  readonly uri: string;
  /** `int` / `string`；`# 池` 没有值类型（null），`# 对照表` 取首行值列的类型 */
  readonly valueType: KojoValueType | null;
  /** 声明初值（变量初值 / 常量值）；表/池与无初值变量为 null */
  readonly initialValue: KojoLiteral | null;
  readonly mutability: Kojo2StorageMutability;
  /** 整条声明（`# 对照表` / `# 池` 含块体）——「按位置跳声明」的兜底落点 */
  readonly span: Kojo2StorageRange;
  /** 名字段的精确区间（声明词之后的那个词）——转定义 / 引用高亮用 */
  readonly nameSpan: Kojo2StorageRange;
  /** 声明头行原文（含缩进；悬停「来源行」用） */
  readonly declarationText: string;
  readonly variable?: Kojo2StorageVarFacts;
  readonly table?: Kojo2StorageTableFacts;
  readonly pool?: Kojo2StoragePoolFacts;
}

/** 一条重名冲突的成因（同一枚冲突可同时命中多条） */
export type Kojo2StorageConflictReason =
  | 'duplicate-name'
  | 'kind-mismatch'
  | 'type-mismatch'
  | 'storage-mismatch';

/**
 * 一个同名声明组（≥2 条）。`reasons` 说得出**为什么**冲突，`codes` 只装 core 真报过的码
 * （空数组 = core 没覆盖到这个面，宿主仍应显示冲突，但不许伪造诊断码）。
 */
export interface Kojo2StorageConflict {
  readonly name: string;
  readonly symbols: readonly Kojo2StorageSymbol[];
  readonly reasons: readonly Kojo2StorageConflictReason[];
  readonly codes: readonly string[];
  readonly message: string;
}

/** 按名字反查的结果：总有一个确定落点，但歧义必须可见 */
export interface Kojo2StorageDeclaration {
  readonly name: string;
  /** 稳定序第一枚；名字未声明时为 null */
  readonly symbol: Kojo2StorageSymbol | null;
  readonly candidates: readonly Kojo2StorageSymbol[];
  /** 同名多于一条（宿主必须提示「选哪一处」，不许静默跳到第一处） */
  readonly ambiguous: boolean;
  readonly conflict: Kojo2StorageConflict | null;
}

/**
 * 一枚补全候选（**纯数据**：不 import Monaco 的 `CompletionItem`）。
 *
 * `sortText` 只由「种类秩 + 名字」决定：同一前缀下变量优先于表/池，名字内码元序稳定。
 */
export interface Kojo2StorageCompletionItem {
  readonly label: string;
  readonly kind: Kojo2StorageKind;
  /** 人类可读副标题（类型 / 存储期 / 槽位 / 表行数…） */
  readonly detail: string;
  readonly insertText: string;
  /** 首次声明所在文件（跨文件跳转 / 采信来源） */
  readonly uri: string;
  /** 同名多声明（补全仍只出一枚，但宿主可加警告标记） */
  readonly conflicted: boolean;
  readonly sortText: string;
}

/** 宿主诊断落点（1 基、`endColumn` 半开；越界已夹回、零宽已扩一格） */
export interface Kojo2StorageDiagnosticRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/**
 * 宿主诊断（问题面板 / 波浪线直接可用）：`{ severity, message, uri, range }` + `code`。
 *
 * `code` 是 core 的原始码（可点击回源、可按码做 quick fix）；本层**不改写、不加前缀**。
 */
export interface Kojo2HostDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly uri: string;
  readonly range: Kojo2StorageDiagnosticRange;
  readonly code: string;
}

/* ============================== 契约：输入与注册表 ============================== */

/** 一源文件（宿主从 model / 扫描结果给出；本模块不读盘） */
export interface Kojo2StorageDocument {
  readonly uri: string;
  readonly source: string;
}

/** 自定义声明键的入参（宿主账本据此算跨构建稳定标识） */
export interface Kojo2StorageKeyInput {
  readonly uri: string;
  readonly name: string;
  readonly storage: KojoVarStorage;
  readonly valueType: KojoValueType;
  /** 数组长度（数字；常量端点已静态求值）；标量 null */
  readonly arraySize: number | null;
  readonly line: number;
  readonly column: number;
}

export interface Kojo2StorageRegistryOptions {
  /** 全部参与索引的源（缺省 = 空工程）。同一 URI 重复出现直接抛错（身份必须唯一） */
  readonly documents?: readonly Kojo2StorageDocument[];
  /** adapter 的槽位区段（缺省用 {@link KOJO2_STORAGE_DEFAULT_CLASSES}，只配预览） */
  readonly storageClasses?: readonly SlotClassSpec[];
  /** 上一次已提交的槽位账本（给出后才做换盘 / 改型检测，fail-closed） */
  readonly previousSnapshot?: SlotRegistrySnapshot | null;
  /** adapter 的游戏指纹（缺省 {@link KOJO2_STORAGE_DEFAULT_FINGERPRINT}） */
  readonly gameFingerprint?: string;
  /** 项目级诊断（无单一声明落点）挂靠的虚拟 URI */
  readonly projectUri?: string;
  /** 声明键（缺省 `uri#行:列`；真项目注入编辑器账本键） */
  readonly declarationKey?: (input: Kojo2StorageKeyInput) => string;
  /**
   * 参与诊断桥的 core 码前缀（缺省 {@link KOJO2_STORAGE_DIAGNOSTIC_PREFIXES}）。
   * 空数组 = 不过滤（全量 core 诊断都桥）。叙事面的码不在缺省表里：那是诊断层的地盘。
   */
  readonly diagnosticPrefixes?: readonly string[];
}

export interface Kojo2StorageRegistry {
  /** 全部符号（按 uri → 行 → 列 稳定排序） */
  readonly symbols: readonly Kojo2StorageSymbol[];
  /** 全部同名冲突组（按名字码元序） */
  readonly conflicts: readonly Kojo2StorageConflict[];
  /** 已桥接的宿主诊断（按 uri → 行 → 列 → code 稳定排序） */
  readonly diagnostics: readonly Kojo2HostDiagnostic[];
  /** core 的槽位分配结果（原样：`ok` / `assignments` / `failures` / `stats` 都可查） */
  readonly storagePlan: StorageAllocationPlan;
  /** 被索引过的文件 URI（去重、排序） */
  readonly uris: readonly string[];
  /**
   * 某文件里的全部符号（按位置排序；没索引过的文件 → 稳定空表）。
   * `uri` 口径与输入逐字一致（不做路径归一化：宿主用同一字符串做键）。
   */
  getSymbolsForDocument(uri: string): readonly Kojo2StorageSymbol[];
  getSymbolsByKind(kind: Kojo2StorageKind): readonly Kojo2StorageSymbol[];
  /** 全部同名声明（稳定序；无声明 → 空表） */
  findDeclarations(name: string): readonly Kojo2StorageSymbol[];
  /** 按名字反查（歧义可见；名字未声明 → `symbol: null`） */
  findDeclaration(name: string): Kojo2StorageDeclaration;
  /**
   * 位置 → 声明。先命中**名字段**（含尾列），再退化到整条声明区间
   * （点在 `# 对照表` 的某一行数据上也能跳回声明）。未命中 → null。
   */
  findSymbolAt(uri: string, line: number, column: number): Kojo2StorageSymbol | null;
  /** 补全候选（前缀过滤按名字 `startsWith`；空前缀 = 全量） */
  getCompletionItems(prefix?: string): readonly Kojo2StorageCompletionItem[];
  getConflict(name: string): Kojo2StorageConflict | null;
  /** 某文件的宿主诊断（没索引过的文件 → 稳定空表） */
  diagnosticsForDocument(uri: string): readonly Kojo2HostDiagnostic[];
}

/* ============================== 缺省事实（宿主可覆盖） ============================== */

/** 无 adapter 事实时的游戏指纹（真项目必须注入 adapter 的指纹，否则换盘检测退化） */
export const KOJO2_STORAGE_DEFAULT_FINGERPRINT = 'kojo2-storage-registry@1';

/** 项目级诊断的虚拟 URI（无单一声明落点的失败挂在这里） */
export const KOJO2_STORAGE_DEFAULT_PROJECT_URI = 'kojo2:project';

/**
 * 诊断桥的缺省码前缀：**声明/存储/表/池** 四个面 + 词法（声明写坏时 AST 里没有节点，
 * 不桥词法就等于把坏声明的错误吃掉）。叙事面（`core/narrative/*` 等）不在此表。
 */
export const KOJO2_STORAGE_DIAGNOSTIC_PREFIXES: readonly string[] = Object.freeze([
  'core/lex/',
  'core/decl/',
  'core/storage/',
  'core/table/',
  'core/pool/',
]);

/**
 * 缺省槽位区段（**只配预览/测试**）：真实落点来自 adapter 的 `storageClasses`，
 * core 只要「编号闭区间 + 作用域」这两格事实。`场景` 按单元分账，`存档`/`会话` 全项目一份。
 */
export const KOJO2_STORAGE_DEFAULT_CLASSES: readonly SlotClassSpec[] = Object.freeze([
  Object.freeze({ storage: 'scene' as const, min: 0, max: 4095, scope: 'unit' as const }),
  Object.freeze({ storage: 'save' as const, min: 0, max: 4095, scope: 'project' as const }),
  Object.freeze({ storage: 'session' as const, min: 0, max: 4095, scope: 'project' as const }),
]);

/* ============================== 内部工具 ============================== */

/** 稳定空表（同一引用：消费方的 memo 不被每次新建的空数组打穿） */
const NO_SYMBOLS: readonly Kojo2StorageSymbol[] = Object.freeze([]);
const NO_DIAGNOSTICS: readonly Kojo2HostDiagnostic[] = Object.freeze([]);

const KIND_RANK: Readonly<Record<Kojo2StorageKind, number>> = Object.freeze({
  var: 0,
  const: 1,
  table: 2,
  pool: 3,
});

const KIND_TEXT: Readonly<Record<Kojo2StorageKind, string>> = Object.freeze({
  var: '变量',
  const: '常量',
  table: '对照表',
  pool: '池',
});

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(min, Math.trunc(value)), max);
}

function storageWordOf(storage: KojoVarStorage): string {
  const index = storage === 'scene' ? 0 : storage === 'save' ? 1 : 2;
  return KOJO_STORAGE_WORDS[index] ?? storage;
}

function typeWordOf(valueType: KojoValueType): string {
  return valueType === 'int' ? (KOJO_TYPE_WORDS[0] ?? 'int') : (KOJO_TYPE_WORDS[1] ?? 'string');
}

function rangeOf(span: KojoSpan): Kojo2StorageRange {
  return Object.freeze({
    startLine: span.start.line,
    startColumn: span.start.column,
    endLine: span.end.line,
    endColumn: span.end.column,
  });
}

/** 名字段候选（lexer 的声明行切片；只在同一行内用） */
interface NameToken {
  readonly offset: number;
  readonly text: string;
}

interface ParsedDocument {
  readonly uri: string;
  readonly source: string;
  readonly file: KojoFile;
  readonly lines: readonly KojoLexLine[];
  readonly physical: readonly KojoPhysicalLine[];
  /** 每行内容长度（已去 `\r`；1 基索引用 `line - 1`） */
  readonly lineLengths: readonly number[];
  /** 声明头行 → 名字段 token（`# 设 好感 …` → `好感` 及其绝对偏移） */
  readonly nameTokens: ReadonlyMap<number, NameToken>;
}

interface SourceIndex {
  readonly lineCount: number;
  lineMaxColumn(line: number): number;
}

function makeSourceIndex(source: string): SourceIndex {
  const parts = source.split('\n');
  const lengths = parts.map((part) => (part.endsWith('\r') ? part.length - 1 : part.length));
  return {
    lineCount: Math.max(1, lengths.length),
    lineMaxColumn(line: number) {
      return Math.max(1, (lengths[line - 1] ?? 0) + 1);
    },
  };
}

function parseDocument(document: Kojo2StorageDocument): ParsedDocument {
  const lexed = lex(document.source);
  const file = parse(lexed);
  const nameTokens = new Map<number, NameToken>();
  for (const line of lexed.lines) {
    if (line.kind !== 'decl' || !line.known) continue;
    const token = splitSpaces(line.rest, line.restOffset)[0];
    if (token !== undefined) nameTokens.set(line.number, { offset: token.offset, text: token.text });
  }
  return {
    uri: document.uri,
    source: document.source,
    file,
    lines: lexed.lines,
    physical: lexed.physical,
    lineLengths: lexed.physical.map((line) => line.text.length),
    nameTokens,
  };
}

/**
 * 名字段的精确 span。**优先 lexer**（它才知道声明词之后那个词的绝对偏移）；
 * 退化路径只在「AST 有声明但词法行对不上」时走（错误恢复态），按物理行找名字，
 * 且从声明词之后开始找（`# 设 量` 里的 `量` 不能被 `变量` 里的同名汉字骗到）。
 */
function nameSpanOf(doc: ParsedDocument, line: number, name: string): KojoSpan {
  const token = doc.nameTokens.get(line);
  if (token !== undefined && token.text === name) {
    const lineOffset = doc.lines[line - 1]?.lineOffset ?? 0;
    const column = token.offset - lineOffset + 1;
    return { start: { line, column }, end: { line, column: column + name.length } };
  }
  const text = doc.physical[line - 1]?.text ?? '';
  const firstSpace = text.search(/\s/u);
  const from = firstSpace < 0 ? 0 : firstSpace + 1;
  const index = text.indexOf(name, from);
  const column = (index < 0 ? from : index) + 1;
  return { start: { line, column }, end: { line, column: column + name.length } };
}

function declarationTextOf(doc: ParsedDocument, line: number): string {
  return doc.physical[line - 1]?.text ?? '';
}

function constantDeclsOf(file: KojoFile): readonly KojoConstDecl[] {
  const constants: KojoConstDecl[] = [];
  for (const decl of file.decls) if (decl.kind === 'const') constants.push(decl);
  return constants;
}

/** 数组长度端点：十进制整数直取，`# 设` 端点按同文件常量表静态求值；其余 → null（不猜） */
function resolveArraySize(
  text: string | null,
  constants: ReadonlyMap<string, number>,
): number | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (/^\d+$/u.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isSafeInteger(value) ? value : null;
  }
  const value = constants.get(trimmed);
  return value === undefined ? null : value;
}

/** 冻结一条诊断（含嵌套 range） */
function freezeDiagnostic(diagnostic: Kojo2HostDiagnostic): Kojo2HostDiagnostic {
  Object.freeze(diagnostic.range);
  return Object.freeze(diagnostic);
}

/* ============================== 诊断桥（纯函数，可单独消费） ============================== */

interface WidenableRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** 零宽（或逆序）落点扩一格：Monaco 不画零宽波浪线，问题面板也难点回 */
function widenZeroWidth(range: WidenableRange, index: SourceIndex): WidenableRange {
  if (range.startLine !== range.endLine || range.startColumn !== range.endColumn) return range;
  const maxColumn = index.lineMaxColumn(range.startLine);
  if (range.startColumn < maxColumn) {
    return { ...range, endColumn: range.startColumn + 1 };
  }
  if (range.startColumn > 1) {
    return { ...range, startColumn: range.startColumn - 1 };
  }
  return range;
}

/**
 * core span → 宿主 range：夹回源文本、保留跨行、同行零宽扩一格。
 *
 * **不做** 0/1 基换算（core 与 Monaco 已经同为 1 基 UTF-16）；只做「让落点合法且可点」。
 */
export function kojo2StorageDiagnosticRange(
  span: KojoSpan | null,
  source: string,
): Kojo2StorageDiagnosticRange {
  const index = makeSourceIndex(source);
  if (span === null) {
    return freezeRange(widenZeroWidth({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, index));
  }
  const startLine = clampInt(span.start.line, 1, index.lineCount);
  const endLine = clampInt(span.end.line, 1, index.lineCount);
  const startColumn = clampInt(span.start.column, 1, index.lineMaxColumn(startLine));
  const endColumn = clampInt(span.end.column, 1, index.lineMaxColumn(endLine));
  if (endLine < startLine || (endLine === startLine && endColumn < startColumn)) {
    return freezeRange(widenZeroWidth({ startLine, startColumn, endLine: startLine, endColumn: startColumn }, index));
  }
  return freezeRange(widenZeroWidth({ startLine, startColumn, endLine, endColumn }, index));
}

function freezeRange(range: WidenableRange): Kojo2StorageDiagnosticRange {
  return Object.freeze({
    startLine: range.startLine,
    startColumn: range.startColumn,
    endLine: range.endLine,
    endColumn: range.endColumn,
  });
}

/**
 * 桥一条 core 诊断：`{ severity, message, uri, range }` + **原样** `code`。
 *
 * 纯函数（同输入同输出）；`source` 只用于夹取/扩格，不参与语义。
 */
export function toKojo2HostDiagnostic(input: {
  readonly uri: string;
  readonly diagnostic: KojoDiagnostic;
  readonly source: string;
}): Kojo2HostDiagnostic {
  return freezeDiagnostic({
    severity: input.diagnostic.severity,
    message: input.diagnostic.message,
    uri: input.uri,
    code: input.diagnostic.code,
    range: kojo2StorageDiagnosticRange(input.diagnostic.span, input.source),
  });
}

/* ============================== 装配 ============================== */

interface SymbolDraft {
  readonly uri: string;
  readonly name: string;
  readonly kind: Kojo2StorageKind;
  readonly valueType: KojoValueType | null;
  readonly initialValue: KojoLiteral | null;
  readonly mutability: Kojo2StorageMutability;
  readonly span: KojoSpan;
  readonly nameSpan: KojoSpan;
  readonly declarationText: string;
  readonly variable:
    | {
        readonly storage: KojoVarStorage;
        readonly arraySizeText: string | null;
        readonly arraySize: number | null;
        readonly key: string;
      }
    | null;
  readonly table: Kojo2StorageTableFacts | null;
  readonly pool: Kojo2StoragePoolFacts | null;
}

interface DraftBase {
  readonly line: number;
  readonly nameSpan: KojoSpan;
  readonly declarationText: string;
}

function draftBaseOf(doc: ParsedDocument, decl: { readonly name: string; readonly span: KojoSpan }): DraftBase {
  const line = decl.span.start.line;
  return {
    line,
    nameSpan: nameSpanOf(doc, line, decl.name),
    declarationText: declarationTextOf(doc, line),
  };
}

function draftOf(
  doc: ParsedDocument,
  decl: KojoFile['decls'][number],
  constants: ReadonlyMap<string, number>,
  keyOf: (input: Kojo2StorageKeyInput) => string,
): SymbolDraft | null {
  switch (decl.kind) {
    case 'var': {
      const base = draftBaseOf(doc, decl);
      const arraySizeText = decl.arraySize?.text ?? null;
      const arraySize = resolveArraySize(arraySizeText, constants);
      return {
        uri: doc.uri,
        name: decl.name,
        kind: 'var',
        valueType: decl.valueType,
        initialValue: decl.init ?? null,
        mutability: 'mutable',
        span: decl.span,
        nameSpan: base.nameSpan,
        declarationText: base.declarationText,
        variable: {
          storage: decl.storage,
          arraySizeText,
          arraySize,
          key: keyOf({
            uri: doc.uri,
            name: decl.name,
            storage: decl.storage,
            valueType: decl.valueType,
            arraySize,
            line: base.line,
            column: base.nameSpan.start.column,
          }),
        },
        table: null,
        pool: null,
      };
    }
    case 'const': {
      const base = draftBaseOf(doc, decl);
      return {
        uri: doc.uri,
        name: decl.name,
        kind: 'const',
        valueType: decl.valueType,
        initialValue: decl.value,
        mutability: 'immutable',
        span: decl.span,
        nameSpan: base.nameSpan,
        declarationText: base.declarationText,
        variable: null,
        table: null,
        pool: null,
      };
    }
    case 'table': {
      const base = draftBaseOf(doc, decl);
      const firstRow = decl.rows[0];
      return {
        uri: doc.uri,
        name: decl.name,
        kind: 'table',
        valueType:
          firstRow === undefined ? null : typeof firstRow.value === 'number' ? 'int' : 'string',
        initialValue: null,
        mutability: 'read-only',
        span: decl.span,
        nameSpan: base.nameSpan,
        declarationText: base.declarationText,
        variable: null,
        table: {
          subject: decl.subject.text,
          rows: decl.rows.length,
          hasDefault: decl.rows.some((row) => row.from === null && row.to === null),
        },
        pool: null,
      };
    }
    case 'pool': {
      const base = draftBaseOf(doc, decl);
      return {
        uri: doc.uri,
        name: decl.name,
        kind: 'pool',
        valueType: null,
        initialValue: null,
        mutability: 'read-only',
        span: decl.span,
        nameSpan: base.nameSpan,
        declarationText: base.declarationText,
        variable: null,
        table: null,
        pool: {
          branches: decl.branches.length,
          hasDefault: decl.branches.some((branch) => branch.test === null),
        },
      };
    }
    default:
      return null;
  }
}

function compareDraft(a: SymbolDraft, b: SymbolDraft): number {
  return (
    compareText(a.uri, b.uri) ||
    a.span.start.line - b.span.start.line ||
    a.span.start.column - b.span.start.column
  );
}

function symbolOf(draft: SymbolDraft, slotByKey: ReadonlyMap<string, number>): Kojo2StorageSymbol {
  const variable: Kojo2StorageVarFacts | undefined =
    draft.variable === null
      ? undefined
      : Object.freeze({
          storage: draft.variable.storage,
          arraySize: draft.variable.arraySizeText,
          storageKey: draft.variable.key,
          slot: slotByKey.get(draft.variable.key) ?? null,
        });
  const table = draft.table === null ? undefined : Object.freeze({ ...draft.table });
  const pool = draft.pool === null ? undefined : Object.freeze({ ...draft.pool });
  return Object.freeze({
    id: `${draft.uri}#L${draft.span.start.line}C${draft.span.start.column}`,
    name: draft.name,
    kind: draft.kind,
    uri: draft.uri,
    valueType: draft.valueType,
    initialValue: draft.initialValue,
    mutability: draft.mutability,
    span: rangeOf(draft.span),
    nameSpan: rangeOf(draft.nameSpan),
    declarationText: draft.declarationText,
    ...(variable === undefined ? {} : { variable }),
    ...(table === undefined ? {} : { table }),
    ...(pool === undefined ? {} : { pool }),
  });
}

function detailOf(symbol: Kojo2StorageSymbol): string {
  switch (symbol.kind) {
    case 'var': {
      const variable = symbol.variable;
      if (variable === undefined) return `${typeWordOf(symbol.valueType ?? 'int')} · 变量`;
      const array = variable.arraySize === null ? '' : `[${variable.arraySize}]`;
      const slot = variable.slot === null ? '' : ` · 槽 ${variable.slot}`;
      return `${typeWordOf(symbol.valueType ?? 'int')}${array} · ${storageWordOf(variable.storage)}${slot}`;
    }
    case 'const':
      return `${typeWordOf(symbol.valueType ?? 'int')} · 常量 · 只读`;
    case 'table':
      return `表 · ${symbol.table?.rows ?? 0} 行`;
    case 'pool':
      return `池 · ${symbol.pool?.branches ?? 0} 分支`;
  }
}

function conflictOf(
  name: string,
  group: readonly Kojo2StorageSymbol[],
  codesByLocation: ReadonlyMap<string, readonly string[]>,
): Kojo2StorageConflict {
  const reasons: Kojo2StorageConflictReason[] = ['duplicate-name'];
  const kinds = new Set(group.map((symbol) => symbol.kind));
  if (kinds.size > 1) reasons.push('kind-mismatch');
  const types = new Set(group.map((symbol) => symbol.valueType).filter((value) => value !== null));
  if (types.size > 1) reasons.push('type-mismatch');
  const storages = new Set(
    group.map((symbol) => symbol.variable?.storage).filter((value) => value !== undefined),
  );
  if (storages.size > 1) reasons.push('storage-mismatch');

  const codes = new Set<string>();
  for (const symbol of group) {
    for (const code of codesByLocation.get(`${symbol.uri}\u0000${symbol.span.startLine}`) ?? []) {
      codes.add(code);
    }
  }

  const locations = group
    .map((symbol) => `${symbol.uri}:${symbol.span.startLine}:${symbol.span.startColumn}`)
    .join(' / ');
  const kindText = group.map((symbol) => KIND_TEXT[symbol.kind]).join('+');
  const message =
    `「${name}」在项目里被声明了 ${group.length} 次（${kindText}）：${locations}` +
    '——同名声明会互相遮蔽，宿主必须让作者选一处，不许静默覆盖。';

  return Object.freeze({
    name,
    symbols: Object.freeze([...group]),
    reasons: Object.freeze(reasons),
    codes: Object.freeze([...codes].sort(compareText)),
    message,
  });
}

/* ============================== 工厂 ============================== */

/**
 * 创建一个存储注册表（**一次装配、之后只读**）。
 *
 * 装配流程（全部纯 core 调用，零 IO）：
 * `lex → parse`（每文件）→ 声明事实 → `planStorageSlots`（槽位 + `core/storage/*`）
 * → `validateTable`（`core/table/*`）→ 桥诊断 → 冲突分组。
 *
 * 同一 URI 重复 / 空 URI / 非字符串源 / 自定义声明键返回空串 —— 一律抛 `TypeError`
 * （身份不唯一或事实不成立时**不装配**，别让脏索引污染跳转与补全）。
 */
export function createKojo2StorageRegistry(
  options: Kojo2StorageRegistryOptions = {},
): Kojo2StorageRegistry {
  const documents = options.documents ?? [];
  const projectUri = options.projectUri ?? KOJO2_STORAGE_DEFAULT_PROJECT_URI;
  const prefixes = options.diagnosticPrefixes ?? KOJO2_STORAGE_DIAGNOSTIC_PREFIXES;
  const classes = options.storageClasses ?? KOJO2_STORAGE_DEFAULT_CLASSES;
  const gameFingerprint = options.gameFingerprint ?? KOJO2_STORAGE_DEFAULT_FINGERPRINT;
  const keyOf =
    options.declarationKey ??
    ((input: Kojo2StorageKeyInput): string => `${input.uri}\u0000${input.line}:${input.column}`);

  const seen = new Set<string>();
  for (const document of documents) {
    if (typeof document.uri !== 'string' || document.uri.trim().length === 0) {
      throw new TypeError('Kojo 2.0 存储注册表：document.uri 不能为空（诊断与跳转都靠它做身份）');
    }
    if (typeof document.source !== 'string') {
      throw new TypeError(`Kojo 2.0 存储注册表：${document.uri} 的 source 必须是字符串`);
    }
    if (seen.has(document.uri)) {
      throw new TypeError(`Kojo 2.0 存储注册表：URI 重复（${document.uri}）——同一份源只许登记一次`);
    }
    seen.add(document.uri);
  }

  const parsed: ParsedDocument[] = documents.map(parseDocument);
  const drafts: SymbolDraft[] = [];
  const storageFacts: StorageDeclarationFact[] = [];
  /** 存储期声明的位置账（用于把 core 的项目级诊断挂回文件） */
  const factLocations: { readonly uri: string; readonly span: KojoSpan }[] = [];

  for (const doc of parsed) {
    const constants = collectIntegerConstants(constantDeclsOf(doc.file));
    for (const decl of doc.file.decls) {
      const draft = draftOf(doc, decl, constants, (input) => {
        const key = keyOf(input);
        if (typeof key !== 'string' || key.length === 0) {
          throw new TypeError(
            `Kojo 2.0 存储注册表：declarationKey 为「${input.uri}:${input.line}」返回了空键——声明键必须非空（否则槽位无法跨构建保住）`,
          );
        }
        return key;
      });
      if (draft === null) continue;
      drafts.push(draft);
      if (draft.variable !== null) {
        const fact: StorageDeclarationFact = {
          key: draft.variable.key,
          storage: draft.variable.storage,
          name: draft.name,
          valueType: draft.valueType ?? 'int',
          arraySize: draft.variable.arraySize,
          filePath: draft.uri,
          span: draft.span,
          ...(draft.variable.storage === 'scene' ? { unitId: draft.uri } : {}),
        };
        storageFacts.push(fact);
        factLocations.push({ uri: draft.uri, span: draft.span });
      }
    }
  }

  drafts.sort(compareDraft);
  const plan = planStorageSlots(
    { gameFingerprint, classes, declarations: storageFacts },
    options.previousSnapshot ?? null,
  );
  const slotByKey = new Map<string, number>();
  for (const assignment of plan.assignments) slotByKey.set(assignment.key, assignment.slot);

  const symbols = Object.freeze(drafts.map((draft) => symbolOf(draft, slotByKey)));

  /* ---------- 诊断：文件（词法+语法） → 表校验 → 槽位账本 ---------- */

  const accepted = (code: string): boolean => {
    if (prefixes.length === 0) return true;
    for (const prefix of prefixes) if (code.startsWith(prefix)) return true;
    return false;
  };

  const diagnostics: Kojo2HostDiagnostic[] = [];
  const dedicated = new Set<string>();
  const push = (diagnostic: Kojo2HostDiagnostic): void => {
    const key =
      `${diagnostic.uri}\u0000${diagnostic.code}` +
      `\u0000${diagnostic.range.startLine}:${diagnostic.range.startColumn}`;
    if (dedicated.has(key)) return; // 同一个 (文件, 码, 位置) 只报一次（parser 与表校验会撞）
    dedicated.add(key);
    diagnostics.push(diagnostic);
  };

  for (const doc of parsed) {
    for (const coreDiagnostic of doc.file.diagnostics) {
      if (!accepted(coreDiagnostic.code)) continue;
      push(toKojo2HostDiagnostic({ uri: doc.uri, diagnostic: coreDiagnostic, source: doc.source }));
    }
    // 表校验（parse 不做语义校验：重叠 / 类型 / 缺否 / 动态端点都在这）
    const constants = collectIntegerConstants(constantDeclsOf(doc.file));
    for (const decl of doc.file.decls) {
      if (decl.kind !== 'table') continue;
      const result = validateTable(decl, { integerConstants: constants });
      for (const coreDiagnostic of result.diagnostics) {
        if (!accepted(coreDiagnostic.code)) continue;
        push(toKojo2HostDiagnostic({ uri: doc.uri, diagnostic: coreDiagnostic, source: doc.source }));
      }
    }
  }

  for (const coreDiagnostic of plan.diagnostics) {
    if (!accepted(coreDiagnostic.code)) continue;
    const uri = resolveStorageDiagnosticUri(coreDiagnostic, factLocations, projectUri);
    const source = parsed.find((doc) => doc.uri === uri)?.source ?? '';
    push(toKojo2HostDiagnostic({ uri, diagnostic: coreDiagnostic, source }));
  }

  diagnostics.sort(
    (a, b) =>
      compareText(a.uri, b.uri) ||
      a.range.startLine - b.range.startLine ||
      a.range.startColumn - b.range.startColumn ||
      compareText(a.code, b.code) ||
      compareText(a.message, b.message),
  );
  const frozenDiagnostics = Object.freeze(diagnostics);

  /* ---------- 冲突（同名分组；不静默覆盖） ---------- */

  const codesByLocation = new Map<string, string[]>();
  for (const diagnostic of frozenDiagnostics) {
    if (!diagnostic.code.startsWith('core/decl/') && !diagnostic.code.startsWith('core/storage/')) {
      continue;
    }
    const key = `${diagnostic.uri}\u0000${diagnostic.range.startLine}`;
    const list = codesByLocation.get(key);
    if (list === undefined) codesByLocation.set(key, [diagnostic.code]);
    else if (!list.includes(diagnostic.code)) list.push(diagnostic.code);
  }

  const byName = new Map<string, Kojo2StorageSymbol[]>();
  for (const symbol of symbols) {
    const list = byName.get(symbol.name);
    if (list === undefined) byName.set(symbol.name, [symbol]);
    else list.push(symbol);
  }
  const conflicts: Kojo2StorageConflict[] = [];
  for (const name of [...byName.keys()].sort(compareText)) {
    const group = byName.get(name)!;
    if (group.length > 1) conflicts.push(conflictOf(name, group, codesByLocation));
  }
  const frozenConflicts: readonly Kojo2StorageConflict[] = Object.freeze(conflicts);
  const conflictByName = new Map<string, Kojo2StorageConflict>();
  for (const conflict of frozenConflicts) conflictByName.set(conflict.name, conflict);

  /* ---------- 索引（查询热路径只读表） ---------- */

  const byKind = new Map<Kojo2StorageKind, Kojo2StorageSymbol[]>([
    ['var', []],
    ['const', []],
    ['table', []],
    ['pool', []],
  ]);
  for (const symbol of symbols) byKind.get(symbol.kind)!.push(symbol);
  const frozenByKind = new Map<Kojo2StorageKind, readonly Kojo2StorageSymbol[]>();
  for (const [kind, list] of byKind) frozenByKind.set(kind, Object.freeze([...list]));

  const byDocument = new Map<string, Kojo2StorageSymbol[]>();
  for (const symbol of symbols) {
    const list = byDocument.get(symbol.uri);
    if (list === undefined) byDocument.set(symbol.uri, [symbol]);
    else list.push(symbol);
  }
  const frozenByDocument = new Map<string, readonly Kojo2StorageSymbol[]>();
  for (const [uri, list] of byDocument) frozenByDocument.set(uri, Object.freeze([...list]));

  const diagnosticsByDocument = new Map<string, Kojo2HostDiagnostic[]>();
  for (const diagnostic of frozenDiagnostics) {
    const list = diagnosticsByDocument.get(diagnostic.uri);
    if (list === undefined) diagnosticsByDocument.set(diagnostic.uri, [diagnostic]);
    else list.push(diagnostic);
  }
  const frozenDiagnosticsByDocument = new Map<string, readonly Kojo2HostDiagnostic[]>();
  for (const [uri, list] of diagnosticsByDocument) {
    frozenDiagnosticsByDocument.set(uri, Object.freeze([...list]));
  }

  /* ---------- 补全（名字去重；冲突名字带 `conflicted`） ---------- */

  const completionItems: Kojo2StorageCompletionItem[] = [];
  const completionSeen = new Set<string>();
  for (const symbol of symbols) {
    if (completionSeen.has(symbol.name)) continue;
    completionSeen.add(symbol.name);
    const conflict = conflictByName.get(symbol.name);
    const detail =
      conflict === undefined ? detailOf(symbol) : `${detailOf(symbol)} · ${conflict.symbols.length} 处声明`;
    completionItems.push(
      Object.freeze({
        label: symbol.name,
        kind: symbol.kind,
        detail,
        insertText: symbol.name,
        uri: symbol.uri,
        conflicted: conflict !== undefined,
        sortText: `${KIND_RANK[symbol.kind]}${symbol.name}`,
      }),
    );
  }
  completionItems.sort((a, b) => compareText(a.sortText, b.sortText));
  const frozenCompletions: readonly Kojo2StorageCompletionItem[] = Object.freeze(completionItems);

  const uris = Object.freeze(parsed.map((doc) => doc.uri).sort(compareText));

  // 注册表本体也冻结：宿主只能读；换一批文档 = 重新 create（旧快照不被就地改写）
  return Object.freeze({
    symbols,
    conflicts: frozenConflicts,
    diagnostics: frozenDiagnostics,
    storagePlan: plan,
    uris,

    getSymbolsForDocument(uri: string): readonly Kojo2StorageSymbol[] {
      return frozenByDocument.get(uri) ?? NO_SYMBOLS;
    },

    getSymbolsByKind(kind: Kojo2StorageKind): readonly Kojo2StorageSymbol[] {
      return frozenByKind.get(kind) ?? NO_SYMBOLS;
    },

    findDeclarations(name: string): readonly Kojo2StorageSymbol[] {
      const group = byName.get(name);
      return group === undefined ? NO_SYMBOLS : Object.freeze([...group]);
    },

    findDeclaration(name: string): Kojo2StorageDeclaration {
      const group = byName.get(name);
      if (group === undefined) {
        return Object.freeze({
          name,
          symbol: null,
          candidates: NO_SYMBOLS,
          ambiguous: false,
          conflict: null,
        });
      }
      const candidates = Object.freeze([...group]);
      return Object.freeze({
        name,
        symbol: candidates[0] ?? null,
        candidates,
        ambiguous: candidates.length > 1,
        conflict: conflictByName.get(name) ?? null,
      });
    },

    findSymbolAt(uri: string, line: number, column: number): Kojo2StorageSymbol | null {
      const inDocument = frozenByDocument.get(uri);
      if (inDocument === undefined) return null;
      for (const symbol of inDocument) {
        const nameSpan = symbol.nameSpan;
        if (nameSpan.startLine !== line) continue;
        // 名字尾列也算命中（光标停在词末是 F12 的常见位置）
        if (column >= nameSpan.startColumn && column <= nameSpan.endColumn) return symbol;
      }
      for (const symbol of inDocument) {
        const span = symbol.span;
        if (line < span.startLine || line > span.endLine) continue;
        if (line === span.startLine && column < span.startColumn) continue;
        if (line === span.endLine && column > span.endColumn) continue;
        return symbol;
      }
      return null;
    },

    getCompletionItems(prefix = ''): readonly Kojo2StorageCompletionItem[] {
      if (typeof prefix !== 'string') {
        throw new TypeError('Kojo 2.0 存储注册表：补全前缀必须是字符串');
      }
      if (prefix.length === 0) return frozenCompletions;
      return Object.freeze(frozenCompletions.filter((item) => item.label.startsWith(prefix)));
    },

    getConflict(name: string): Kojo2StorageConflict | null {
      return conflictByName.get(name) ?? null;
    },

    diagnosticsForDocument(uri: string): readonly Kojo2HostDiagnostic[] {
      return frozenDiagnosticsByDocument.get(uri) ?? NO_DIAGNOSTICS;
    },
  });
}

/**
 * core 的存储期诊断只带 span（无 filePath）：先按「声明起点行:列」找事实，
 * 多个事实撞同一坐标时用**消息里的路径**消歧（core 的 `formatLocation` 逐字带 `uri:行:列`），
 * 仍不唯一则取稳定序第一枚——诊断**绝不丢**，uri 只决定点回哪份文件。
 */
function resolveStorageDiagnosticUri(
  diagnostic: {
    readonly span: KojoSpan | null;
    readonly message: string;
  },
  locations: readonly { readonly uri: string; readonly span: KojoSpan }[],
  projectUri: string,
): string {
  const span = diagnostic.span;
  if (span === null) return projectUri;
  let best: string | null = null;
  let bestIndex = -1;
  for (const location of locations) {
    if (location.span.start.line !== span.start.line) continue;
    if (location.span.start.column !== span.start.column) continue;
    const index = diagnostic.message.indexOf(location.uri);
    if (best === null) {
      best = location.uri;
      bestIndex = index;
      continue;
    }
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
      best = location.uri;
      bestIndex = index;
    }
  }
  return best ?? projectUri;
}
