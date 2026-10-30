/**
 * Kojo 2.0 **转到定义**的判据：同文件声明即定义；同文件无果才看项目里的同名声明。
 *
 * 与悬停共用 `declarations.ts` 的同一份索引（不各扫一遍源码）：
 * - 声明处：F12 落在自己（`# 设 好感度` / `# 表 心情` / `@函 …` / `# 幕 …`）；
 * - 引用处：代码面里的同名声明 → 声明行的**名字段**（`! 池 / 模 / 函` 调用同样走这条）；
 * - 台词正文 / `@原生` 体内不跳（那是文本，不是引用）。
 *
 * 纯函数：源码 + 1 基行列进，声明落点出；零 IO、零 Monaco、零注册。
 *
 * ## 同文件优先，跨文件是**第二段**
 *
 * {@link kojo2DefinitionAt} 只回答"名字 → 本文档里的哪一行哪一列"；{@link kojo2DefinitionAcrossProject}
 * 在它**没有落点**时才去项目快照（`{path, text}[]`，宿主现取）里找**同名声明**，落点带 `filePath`。
 * 两段共用一个入口的两条理由：
 * - 「先本地、后项目」是语义而不是优化：本文档的声明永远比同名同姓的另一份更近；
 * - 「哪一格算引用位」只许有一把尺子：跨文件那一段不自己切词，直接问 `references` 的
 *   候选位（`kojo2ReferenceCandidatesOf`）——参数名 / 类型词 / 表体字面量因此天然不跳，
 *   而 `! 名` / `{名}` / `? 条件` 这些真引用位天然要跳。
 *
 * ## 跨文件的三条硬边界（都不静默）
 *
 * - 结果按 **路径 → 行号 → 列** 稳定排序，最多 {@link KOJO2_PROJECT_DEFINITION_MAX_RESULTS} 条；
 * - 扫描有界：文件数 / 总字节 / **单份字节** 三道上限（超单份即跳过），本文 `lineCount` 超过
 *   {@link KOJO2_PROJECT_DEFINITION_MAX_LINES} 时整段不做——判据里**不无界切分超大文本**；
 * - 任何一道上限被碰到 ⇒ `truncated = true`：这时"项目里没有别的声明"这半句不成立。
 *
 * ## 已知边界
 *
 * - **名字级匹配**（与 `references` 的跨文件口径相同）：模板 / 函数形参在**体内**的用法
 *   仍是一枚可证引用位，若与项目里的顶层声明重名就会被算成那条声明——本批不新造作用域
 *   分析（两套尺子必然漂移），如实记在这里；
 * - `# 幕` 标题不进跨文件面（幕不是文件命名空间里的符号，同标题两幕是两段戏）；
 * - 事件名（`# 机` / `@织`）不是表达式引用，本判据不给跨文件落点；
 * - 同名多家族（core 错误）**全给**而不是替作者挑一个：定义面要让冲突看得见。
 *
 * ## 谁消费
 *
 * - 插件 `@kojo/plugin-kojo-lang` 把落点翻成契约的 `EditorSymbolLocation`，经
 *   `ui.editor.languageService` 槽（`kind: 'definition'`）交给宿主；
 * - 宿主把它翻成 Monaco `LocationLink`（**翻译**，不是判据）。
 *
 * 展开视图（模板 / 池 / 随机的"调用处 ↦ 定义处"）不在这里：那是 `expand-view.ts` 的
 * 事，由消费方在拿到本函数的落点之后**追加**，两条腿不互相依赖。
 */
import { insideInterpolation } from './interpolation';
import {
  KOJO2_DECL_WORD_BY_KIND,
  kojo2DeclarationAt,
  kojo2DeclarationHeaderAt,
  kojo2DeclarationNamed,
  kojo2DocumentOf,
  kojo2IsCodeSurface,
  kojo2IsNativeRecord,
  kojo2IsTextSurface,
  kojo2TokenSpanAt,
  type Kojo2Declaration,
  type Kojo2Document,
  type Kojo2Query,
} from './declarations';
import { kojo2ReferenceCandidatesOf } from './references';

/** 定义落点（同文件；1 基，尾列半开）。 */
export interface Kojo2DefinitionTarget {
  readonly name: string;
  /** 声明种类文案（`变量` / `对照表` / `函` …；来自 core 词表） */
  readonly kind: string;
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
}

/** 声明事实 → 定义落点。 */
function targetOf(declaration: Kojo2Declaration): Kojo2DefinitionTarget {
  return {
    name: declaration.name,
    kind: KOJO2_DECL_WORD_BY_KIND[declaration.kind],
    line: declaration.line,
    column: declaration.nameStart,
    endColumn: declaration.nameEnd,
  };
}

/* ============================== 位置门（两段共用一份） ============================== */

/** 一格可判读的行面：语句行种类 + 行文 + 0 基列 + 是否在 `{}` 插值里 */
interface DefinitionSurface {
  readonly record: Kojo2Document['lines'][number];
  readonly text: string;
  readonly col0: number;
  readonly interpolated: boolean;
}

/**
 * 位置门（与悬停同一套）：`@原生` / 注释 / 旧写法整行退让；叙事正文只在 `{}` 插值里算代码面。
 * `undefined` = 这一格连"可判读的行面"都不是（越界 / 围栏体 / 注释）。
 */
function surfaceIn(document: Kojo2Document, query: Kojo2Query): DefinitionSurface | undefined {
  const record = document.lines[query.line - 1];
  if (record === undefined) return undefined;
  if (kojo2IsNativeRecord(record)) return undefined;
  if (record.kind === 'comment' || record.kind === 'legacy') return undefined;
  const text = document.physical[query.line - 1]?.text ?? '';
  const col0 = Math.min(Math.max(query.column - 1, 0), text.length);
  const interpolated = insideInterpolation(text, col0);
  if (kojo2IsTextSurface(record) && !interpolated) return undefined;
  return { record, text, col0, interpolated };
}

/** 这一格是不是**表达式位**（代码面，或叙事正文里的 `{}` 插值） */
function isExpressionSurface(surface: DefinitionSurface): boolean {
  return (
    kojo2IsCodeSurface(surface.record) ||
    (kojo2IsTextSurface(surface.record) && surface.interpolated)
  );
}

/** 同文件判据本体（文档索引由调用方建好后复用：跨文件那一段不再 lex+parse 本文） */
function definitionTargetIn(
  document: Kojo2Document,
  query: Kojo2Query,
): Kojo2DefinitionTarget | undefined {
  const surface = surfaceIn(document, query);
  if (surface === undefined) return undefined;

  const atDeclaration = kojo2DeclarationAt(document, query.line, surface.col0);
  if (atDeclaration !== undefined) return targetOf(atDeclaration);
  const headerDeclaration = kojo2DeclarationHeaderAt(document, query.line, surface.col0);
  if (headerDeclaration !== undefined) return targetOf(headerDeclaration);

  if (!isExpressionSurface(surface)) return undefined;
  const span = kojo2TokenSpanAt(surface.text, surface.col0);
  if (span === null) return undefined;
  const declaration = kojo2DeclarationNamed(document, span.text, query.line);
  return declaration === undefined ? undefined : targetOf(declaration);
}

/**
 * 光标处的定义落点（**纯函数**）。
 *
 * 位置门与悬停同一套：`@原生` / 注释 / 台词的正文不跳，`{…}` 插值内照常解析。
 * 返回 `undefined` = 此处没有可跳的同文件声明（Monaco 自己会提示"未找到定义"）。
 */
export function kojo2DefinitionAt(query: Kojo2Query): Kojo2DefinitionTarget | undefined {
  return definitionTargetIn(kojo2DocumentOf(query.source), query);
}

/* ============================== 跨文件：项目快照口 ============================== */

/** 跨文件定义落点：同文件落点 + 命中文件（同文件命中时 = 查询里的本文路径） */
export interface Kojo2ProjectDefinitionTarget extends Kojo2DefinitionTarget {
  readonly filePath: string;
}

/** 跨文件查询：位置 + 本文身份（`path` 缺省 = 空串，调用方换成本文身份；`lineCount` 是体量事实） */
export interface Kojo2ProjectDefinitionQuery extends Kojo2Query {
  readonly path?: string;
  /** 本文行数（与契约 `lineCount` 同口径；超过上限 ⇒ 不做项目级扫描） */
  readonly lineCount?: number;
}

/** 项目快照里的一份文档（与契约 `EditorProjectFile` 同形；不含本文） */
export interface Kojo2ProjectDefinitionFile {
  readonly path: string;
  readonly text: string;
}

/** 跨文件查询的预算（缺省见四枚 `KOJO2_PROJECT_DEFINITION_MAX_*` 常量） */
export interface Kojo2ProjectDefinitionOptions {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxResults?: number;
  readonly maxLines?: number;
}

/** 一次跨文件查询的结果（`truncated` 显式告诉调用方"项目侧没扫完"） */
export interface Kojo2ProjectDefinitionResult {
  readonly targets: readonly Kojo2ProjectDefinitionTarget[];
  readonly truncated: boolean;
}

/** 单次查询参与扫描的文件数上限（与宿主项目快照 400 份同口径） */
export const KOJO2_PROJECT_DEFINITION_MAX_FILES = 400;

/** 单次查询参与扫描的文本**总字节**上限（与宿主快照 8 MiB 同口径） */
export const KOJO2_PROJECT_DEFINITION_MAX_BYTES = 8 * 1024 * 1024;

/** 单份项目文件的字节上限：超过即跳过并置 `truncated`（不把超大文本整篇 lex/parse） */
export const KOJO2_PROJECT_DEFINITION_MAX_FILE_BYTES = 512 * 1024;

/** 本文行数上限：超过即不做项目级扫描（大文件档位与宿主其余降级同一取舍） */
export const KOJO2_PROJECT_DEFINITION_MAX_LINES = 50_000;

/** 一次查询最多交回的落点条数（多候选按 路径 → 行号 → 列 排序后取前 N 条） */
export const KOJO2_PROJECT_DEFINITION_MAX_RESULTS = 64;

const EMPTY_RESULT: Kojo2ProjectDefinitionResult = Object.freeze({
  targets: Object.freeze([]) as readonly Kojo2ProjectDefinitionTarget[],
  truncated: false,
});

/** 路径归一键（分隔符折叠 + 小写；与 `references` 的 `snapshotPathKey` 同一条口径） */
function projectPathKey(path: string): string {
  return path.replace(/[\\/]+/g, '/').toLowerCase();
}

/** 码元序比较（不用 `localeCompare`：结果不随运行环境漂） */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * UTF-8 字节数的**有界估计**：够判上限即停（超过 `limit` 后的返回值只保证"超了"）。
 *
 * 为什么不 `TextEncoder` / `Buffer`：本包零 DOM、零 node IO（`purity.test.ts` 钉着）。
 * 代理对按 4 字节、孤立代理项按 3 字节计——这是估计而非编码器，只服务预算判定。
 */
function utf8BytesAtMost(text: string, limit: number): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

/** 落点规范序：路径归一键 → 原文路径 → 行 → 列 → 名字 → 种类（并列也定序） */
function compareProjectTargets(
  a: Kojo2ProjectDefinitionTarget,
  b: Kojo2ProjectDefinitionTarget,
): number {
  return (
    compareText(projectPathKey(a.filePath), projectPathKey(b.filePath)) ||
    compareText(a.filePath, b.filePath) ||
    a.line - b.line ||
    a.column - b.column ||
    compareText(a.name, b.name) ||
    compareText(a.kind, b.kind)
  );
}

/**
 * 光标处的**项目符号名字**（跨文件那一段唯一允许的取名字口）。
 *
 * 不自己切词：问 `references` 的候选位（`kojo2ReferenceCandidatesOf`）——它已经定义过
 * "哪些位置是表达式 / 调用位"，参数名、类型词、表体字面量、注释、`@原生` 都不会在这里
 * 冒出一个名字。本文档索引注入进去，避免同一篇再 lex+parse 一次。
 */
function projectSymbolNameIn(document: Kojo2Document, query: Kojo2Query): string | undefined {
  const surface = surfaceIn(document, query);
  if (surface === undefined || !isExpressionSurface(surface)) return undefined;
  const col0 = surface.col0;
  for (const candidate of kojo2ReferenceCandidatesOf(query.source, { getIndex: () => document })) {
    const span = candidate.span;
    if (span.startLine !== query.line) continue;
    if (col0 < span.startColumn - 1 || col0 > span.endColumn - 1) continue;
    return candidate.name;
  }
  return undefined;
}

/** 预算闸：缺省 / 非有限 ⇒ 缺省值；负数夹到 0（"给了个坏预算"不许变成别的行为） */
function budgetOf(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

/**
 * 光标处的定义（**同文件优先，其次项目快照**；纯函数：零 IO、零 Monaco）。
 *
 * - 同文件有落点 ⇒ 立刻返回那一条（`filePath` = 本文路径），项目快照一分钱不花；
 * - 同文件没有 ⇒ 取光标处的**可证引用名**（见 {@link projectSymbolNameIn}），再到 `files`
 *   的声明索引里找同名声明（按路径 → 行号 → 列排序、去重、截到上限）；
 * - `files` 缺席 / 空 ⇒ 退化成同文件判据（与加这一格之前逐字相同）；
 * - 坐标非法（`NaN` / 行 < 1）/ 空源 ⇒ 空结果（**不抛**，与 `kojo2DefinitionAt` 同向）。
 */
export function kojo2DefinitionAcrossProject(
  query: Kojo2ProjectDefinitionQuery,
  files: readonly Kojo2ProjectDefinitionFile[] | undefined,
  options: Kojo2ProjectDefinitionOptions = {},
): Kojo2ProjectDefinitionResult {
  if (typeof query.source !== 'string' || query.source.length === 0) return EMPTY_RESULT;
  if (!Number.isFinite(query.line) || !Number.isFinite(query.column)) return EMPTY_RESULT;
  if (query.line < 1) return EMPTY_RESULT;
  const ownPath = typeof query.path === 'string' ? query.path : '';

  let document: Kojo2Document;
  try {
    document = kojo2DocumentOf(query.source);
  } catch {
    return EMPTY_RESULT;
  }

  // 同文件优先：本地有落点就不再付项目扫描的钱（语义与开销在这里是同一个决定）。
  const local = definitionTargetIn(document, query);
  if (local !== undefined) {
    return { targets: [{ ...local, filePath: ownPath }], truncated: false };
  }
  if (files === undefined || files.length === 0) return EMPTY_RESULT;

  const maxLines = budgetOf(options.maxLines, KOJO2_PROJECT_DEFINITION_MAX_LINES);
  if (
    query.lineCount !== undefined &&
    Number.isFinite(query.lineCount) &&
    query.lineCount > maxLines
  ) {
    // 大文件档位：本文已经够大，不再逐篇 lex/parse 项目文件；"没找到"这半句不成立。
    return { targets: [], truncated: true };
  }

  const name = projectSymbolNameIn(document, query);
  if (name === undefined) return EMPTY_RESULT; // 光标不在可证引用位：不去项目里猜名字

  const maxFiles = budgetOf(options.maxFiles, KOJO2_PROJECT_DEFINITION_MAX_FILES);
  const maxBytes = budgetOf(options.maxBytes, KOJO2_PROJECT_DEFINITION_MAX_BYTES);
  const maxFileBytes = budgetOf(options.maxFileBytes, KOJO2_PROJECT_DEFINITION_MAX_FILE_BYTES);
  const maxResults = budgetOf(options.maxResults, KOJO2_PROJECT_DEFINITION_MAX_RESULTS);
  const ownKey = ownPath.length > 0 ? projectPathKey(ownPath) : null;
  const seen = new Set<string>();
  const hits: Kojo2ProjectDefinitionTarget[] = [];
  let examined = 0;
  let scannedBytes = 0;
  let truncated = false;

  for (const file of files) {
    if (file === null || typeof file !== 'object') continue;
    if (typeof file.path !== 'string' || file.path.length === 0) continue;
    if (typeof file.text !== 'string') continue;
    const key = projectPathKey(file.path);
    if (ownKey !== null && key === ownKey) continue; // 本文由同文件判据负责
    if (examined >= maxFiles) {
      truncated = true;
      break;
    }
    examined += 1;
    const size = utf8BytesAtMost(file.text, maxFileBytes);
    if (size > maxFileBytes) {
      truncated = true; // 单份过大：跳过并把"没扫"说清楚
      continue;
    }
    if (scannedBytes + size > maxBytes) {
      truncated = true;
      break;
    }
    scannedBytes += size;
    // 便宜预筛：名字没出现过就不必 lex+parse 这一份（声明行里必然出现名字字面）。
    if (!file.text.includes(name)) continue;
    let declarationDocument: Kojo2Document;
    try {
      declarationDocument = kojo2DocumentOf(file.text);
    } catch {
      continue; // 这一份解析不出来：跳过它，不带坏整批
    }
    for (const declaration of declarationDocument.declarations) {
      if (declaration.name !== name) continue;
      if (declaration.kind === 'scene') continue; // 幕标题不是文件命名空间里的符号
      const target: Kojo2ProjectDefinitionTarget = { ...targetOf(declaration), filePath: file.path };
      const siteKey = `${key}\u0000${target.line}\u0000${target.column}`;
      if (seen.has(siteKey)) continue;
      seen.add(siteKey);
      hits.push(target);
    }
  }

  hits.sort(compareProjectTargets);
  if (hits.length > maxResults) truncated = true;
  return {
    targets: hits.length > maxResults ? hits.slice(0, maxResults) : hits,
    truncated,
  };
}
