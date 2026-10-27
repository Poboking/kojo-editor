/**
 * 协议 v4 的**运行期闸**与两张小解码器（主线程与两个 worker 共用；形状真源在
 * `@kojo/kojo-core` 的 `structure-protocol.ts`）。
 *
 * ## 为什么闸住在这里而不是 core
 *
 * core 是纯契约（零 IO、零 Monaco、可以被任何人 import），运行时闸是**本宿主**的纪律：
 * 主线程绝不 `as` 一条 worker 回来的东西就用作数据，worker 也绝不把形状不符的请求塞进引擎。
 * 两侧共用同一份闸，是因为它们判的是同一个协议——各写一份必然漂（v1 的 `isStructureReply`
 * 就是这么长出来的）。
 *
 * ## 为什么这个文件**只**从 core 取类型（一条值都不 import）
 *
 * 两个 worker 的依赖面只许 `./engine` + `./types` + 入口资源（见 `worker-bootstrap.ts` 头注）。
 * 从 `@kojo/kojo-core` 取一个值会把那个包的**桶**拖进 worker 图（`export *` 之下模块级
 * 初始化器不会被摇干净），worker 产物随之变胖。这里的闭集因此用**穷举表**表达：
 * 少写一枚原因 / 一个面，TypeScript 当场红（`Record<StructureFailureReason, true>`），
 * 与从 core 读数组是同一条钉法，只是漂不了。
 *
 * ## 三条判据
 *
 * 1. **形状**：`ok` / `kind` / `id` 必须是预期类型；`facets` 的每一面按各自形状查（扁平投影
 *    的 `spans` 必须是有限数数组、长度是 6 的整数倍——不是的话宁可整条丢掉，也不拿半截表着色）；
 * 2. **闭集**：`reason` 必须在闭集里（表外的原因 = 两侧版本对不上，不是"另一个失败"）；
 * 3. **内容二选一**：`text` 与 `edit` 同给 / 都没给 ⇒ 请求非法（由调用方判 `invalid-input`）。
 */
import type {
  STRUCTURE_PROTOCOL_VERSION as CORE_PROTOCOL_VERSION,
  StructureCaptureTable,
  StructureFacet,
  StructureFailureReason,
  StructureFoldTable,
  StructureParseReply,
  StructureParseRequest,
  StructureReply,
  StructureRequest,
} from '@kojo/kojo-core';

/**
 * core 认的协议号（**类型**，不是值）。
 *
 * worker 里钉字面量、用这个类型兜住：core 抬号而 worker 没跟上，`const PROTOCOL: StructureProtocolVersion = 3`
 * 当场编译不过。这是"不从 core 取值"（见文件头）与"版本只有一个真源"之间的那条缝。
 */
export type StructureProtocolVersion = typeof CORE_PROTOCOL_VERSION;

export type {
  StructureCaptureTable,
  StructureContent,
  StructureEdit,
  StructureFacet,
  StructureFailureReason,
  StructureFailureReply,
  StructureFoldTable,
  StructureIndentRules,
  StructureOpenRequest,
  StructureParseReply,
  StructureParseRequest,
  StructurePoint,
  StructureRange,
  StructureReadyReply,
  StructureReply,
  StructureRequest,
  StructureSyntaxFault,
  StructureSyntaxKind,
} from '@kojo/kojo-core';

/** 失败原因的穷举表（加一枚原因只改协议联合类型 ⇒ 这里不补齐就编译不过） */
const FAILURE_REASONS: Readonly<Record<StructureFailureReason, true>> = {
  unavailable: true,
  disposed: true,
  'protocol-mismatch': true,
  'invalid-input': true,
  'wasm-load-failed': true,
  'parse-failed': true,
  'query-failed': true,
  crashed: true,
  timeout: true,
};

/** 面的穷举表（同上：`StructureFacet` 加一面而这里不补 ⇒ 编译不过） */
const FACETS: Readonly<Record<StructureFacet, true>> = {
  semantic: true,
  folds: true,
  indent: true,
  syntax: true,
};

const REASON_SET = new Set<string>(Object.keys(FAILURE_REASONS));
const FACET_SET = new Set<string>(Object.keys(FACETS));

/** 面名是否合法（`want` 的每一项都过这一条；表外的面一律不认，不猜） */
export function isStructureFacet(value: unknown): value is StructureFacet {
  return typeof value === 'string' && FACET_SET.has(value);
}

/** 失败原因是否在闭集里（表外原因 = 两侧版本对不上，不是"另一个失败"） */
export function isStructureFailureReason(value: unknown): value is StructureFailureReason {
  return typeof value === 'string' && REASON_SET.has(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(isFiniteNumber);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 一条请求的 id 能不能回话（worker 收件闸：没有合法 id 的消息连错都回不了，只能丢） */
export function isStructureRequest(value: unknown): value is StructureRequest {
  if (value === null || typeof value !== 'object') return false;
  const request = value as Partial<StructureRequest>;
  if (!isFiniteNumber(request.id)) return false;
  if (request.kind === 'open') {
    const open = request as { protocol?: unknown; runtimeWasmUrl?: unknown; grammarWasmUrl?: unknown };
    if (!isFiniteNumber(open.protocol)) return false;
    return typeof open.runtimeWasmUrl === 'string' && typeof open.grammarWasmUrl === 'string';
  }
  if (request.kind !== 'parse') return false;
  return isStructureParseRequest(request);
}

/**
 * `parse` 请求的形状闸（**不含**内容二选一那条语义判据：同给 / 都没给要回
 * `invalid-input` 而不是静默丢掉——见 {@link contentProblem}）。
 */
export function isStructureParseRequest(value: unknown): value is StructureParseRequest {
  if (value === null || typeof value !== 'object') return false;
  const request = value as Partial<StructureParseRequest>;
  if (!isFiniteNumber(request.id) || request.kind !== 'parse') return false;
  if (!isFiniteNumber(request.doc) || !isFiniteNumber(request.version)) return false;
  if (request.baseTreeId !== undefined && typeof request.baseTreeId !== 'string') return false;
  if (request.want !== undefined && (!Array.isArray(request.want) || !request.want.every(isStructureFacet))) return false;
  if (request.includedRanges !== undefined) {
    // LAU-6：区间形状照 `StructureRange` 逐格查（索引与行列都要给，且都不许是 NaN/负数）；
    // 空数组 = "一个字节都不解"，语法上合法但语义上是调用方的错——由内容闸之外的调用方判。
    if (!Array.isArray(request.includedRanges) || !request.includedRanges.every(isStructureRange)) return false;
  }
  return true;
}

/** `StructureRange` 的逐格闸（§4.1：索引与行列都要给，UTF-16 码元口径） */
function isStructureRange(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const range = value as {
    startIndex?: unknown;
    endIndex?: unknown;
    startPosition?: { row?: unknown; column?: unknown };
    endPosition?: { row?: unknown; column?: unknown };
  };
  if (!isFiniteNumber(range.startIndex) || !isFiniteNumber(range.endIndex)) return false;
  if (range.startIndex < 0 || range.endIndex < range.startIndex) return false;
  const start = range.startPosition;
  const end = range.endPosition;
  if (start === null || typeof start !== 'object' || end === null || typeof end !== 'object') return false;
  if (!isFiniteNumber(start.row) || !isFiniteNumber(start.column)) return false;
  if (!isFiniteNumber(end.row) || !isFiniteNumber(end.column)) return false;
  return start.row >= 0 && start.column >= 0 && end.row >= 0 && end.column >= 0;
}

/**
 * 内容二选一的判据：返回 `null` = 合法，否则返回给作者 / 开发看的那句话。
 *
 * 两个都给判非法（不猜哪个算数）；两个都没给也判非法（没有内容可解）。
 */
export function contentProblem(value: unknown): string | null {
  const content = (value ?? {}) as { text?: unknown; edit?: unknown };
  const hasText = content.text !== undefined;
  const hasEdit = content.edit !== undefined;
  if (hasText && hasEdit) return 'parse 请求同时带了 text 与 edit ⇒ 内容二选一，不知道哪个算数';
  if (!hasText && !hasEdit) return 'parse 请求既没有 text 也没有 edit ⇒ 没有内容可解';
  if (hasText && typeof content.text !== 'string') return 'parse 请求的 text 不是字符串';
  if (hasEdit && !isStructureEdit(content.edit)) return 'parse 请求的 edit 不是一条合法编辑（start / oldEnd / newEnd / newText）';
  return null;
}

/** 一条编辑的形状（四个格子：三个点 + 新文本） */
export function isStructureEdit(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const edit = value as { start?: unknown; oldEnd?: unknown; newEnd?: unknown; newText?: unknown };
  return isPoint(edit.start) && isPoint(edit.oldEnd) && isPoint(edit.newEnd) && typeof edit.newText === 'string';
}

function isPoint(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const p = value as { row?: unknown; column?: unknown; offset?: unknown };
  return isFiniteNumber(p.row) && isFiniteNumber(p.column) && isFiniteNumber(p.offset);
}

/** 捕获表：`spans` 必须是 6 的整数倍，`nameIndex` / `nodeIndex` 必须落在字典内 */
export function isCaptureTable(value: unknown): value is StructureCaptureTable {
  if (value === null || typeof value !== 'object') return false;
  const table = value as Partial<StructureCaptureTable>;
  if (!isStringArray(table.names) || !isStringArray(table.nodes) || !isNumberArray(table.spans)) return false;
  if (table.spans.length % 6 !== 0) return false;
  for (let i = 4; i < table.spans.length; i += 6) {
    const nameIndex = table.spans[i]!;
    const nodeIndex = table.spans[i + 1]!;
    if (nameIndex < 0 || nameIndex >= table.names.length) return false;
    if (nodeIndex < 0 || nodeIndex >= table.nodes.length) return false;
  }
  return true;
}

/** 折叠表：`spans` 每 2 个数字一条 `[startRow, endRow]` */
export function isFoldTable(value: unknown): value is StructureFoldTable {
  if (value === null || typeof value !== 'object') return false;
  const table = value as Partial<StructureFoldTable>;
  return isNumberArray(table.spans) && table.spans.length % 2 === 0;
}

function isIndentRules(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const rules = value as { increasePatterns?: unknown; decreasePatterns?: unknown; enterPatterns?: unknown };
  return (
    isStringArray(rules.increasePatterns) && isStringArray(rules.decreasePatterns) && isStringArray(rules.enterPatterns)
  );
}

function isSyntaxFacet(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const facet = value as { faults?: unknown; truncated?: unknown };
  return Array.isArray(facet.faults) && typeof facet.truncated === 'boolean';
}

/**
 * worker 回传的**协议 v3** 回话（主线程唯一的收件闸）。
 *
 * 成功回话只认 `ready` / `parse` 两种 `kind`——表外的一律不认（不猜"是不是另一种 ready"）。
 */
export function isStructureReply(value: unknown): value is StructureReply {
  if (value === null || typeof value !== 'object') return false;
  const reply = value as Partial<StructureReply> & { facets?: unknown };
  if (!isFiniteNumber(reply.id)) return false;
  if (reply.ok === false) {
    const failure = reply as { reason?: unknown; message?: unknown };
    return isStructureFailureReason(failure.reason) && typeof failure.message === 'string';
  }
  if (reply.ok !== true) return false;
  if (reply.kind === 'ready') {
    // v4（LAU-5）：`docBase` 是这条通道的 doc 号段起点（单引擎 worker 回 0）
    const ready = reply as { protocol?: unknown; loadMs?: unknown; docBase?: unknown };
    return isFiniteNumber(ready.protocol) && isFiniteNumber(ready.loadMs) &&
      isFiniteNumber(ready.docBase) && (ready.docBase as number) >= 0;
  }
  if (reply.kind !== 'parse') return false;
  const parse = reply as Partial<StructureParseReply>;
  if (!isFiniteNumber(parse.doc) || !isFiniteNumber(parse.version)) return false;
  if (typeof parse.treeId !== 'string' || typeof parse.incremental !== 'boolean') return false;
  const facets = parse.facets;
  if (facets === null || typeof facets !== 'object') return false;
  const table = facets as Record<string, unknown>;
  if (table.semantic !== undefined && !isCaptureTable(table.semantic)) return false;
  if (table.folds !== undefined && !isFoldTable(table.folds)) return false;
  if (table.indent !== undefined && !isIndentRules(table.indent)) return false;
  if (table.syntax !== undefined && !isSyntaxFacet(table.syntax)) return false;
  const metrics = parse.metrics;
  if (metrics === null || typeof metrics !== 'object') return false;
  const m = metrics as { parseMs?: unknown; queryMs?: unknown; textLength?: unknown };
  return isFiniteNumber(m.parseMs) && isFiniteNumber(m.queryMs) && isFiniteNumber(m.textLength);
}

/**
 * 旧协议请求的**识别**：只用来把"对面还是旧形状"这件事说成 `protocol-mismatch`，
 * 而不是一声不响（旧宿主 + 新 worker 的静默曾被记成"结构层悄悄没了"）。
 *
 * 两套旧协议都收：v1 的 `init` / `parse` / `change`，kojo2 的 `captures` / `folds` / `indents`
 * （kojo2 的 `parse` 与 v1 同名）。
 */
export function looksLikeLegacyStructureRequest(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'init' ||
    type === 'parse' ||
    type === 'change' ||
    type === 'captures' ||
    type === 'folds' ||
    type === 'indents'
  );
}
