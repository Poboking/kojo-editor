/**
 * 结构解析协议 v3（LAU-1）——宿主 ↔ worker 的**唯一**契约。
 *
 * 出处：`docs/ARCH-language-unification.md` §4.1（逐字落地，改形状先改那份文档再改这里）。
 * 落点由用户 2026-10-27 裁定：`@kojo/kojo-core`（不镜像 plugin-api）。
 *
 * ## 为什么这份契约住在 core
 *
 * 它与游戏事实无关（零游戏名词），只描述"主线程问什么、worker 答什么"：一条请求一条回复、
 * 面（facet）合并成一条消息、失败原因是**闭集**且只报事实（代价由宿主决定，D2）。
 * 两套旧协议（v1 `types.ts` 的 5 类消息 / kojo2 的 4 类查询）都在 LAU-1 的迁移表里
 * 逐条映射到本文件（见 §4.1 的映射表）。
 *
 * ## 三条铁律
 *
 * 1. **只有一份**：宿主与两个 worker 都从这里取类型，不许第二套字段名；
 * 2. **形状一变就抬号**：`open` 那一步比对 `STRUCTURE_PROTOCOL_VERSION`，不符即回
 *    `protocol-mismatch`（不拿旧形状硬解）；抬号必须双跑一批（旧 client 留在
 *    `monaco/tree-sitter/client-v2.ts`，宿主收到 `protocol-mismatch` 降级到它）；
 * 3. **内容二选一**：`text`（整篇）或 `edit`（基线 + 差集），两个都给判 `invalid-input`
 *    ——不给"哪个算数"留猜的余地。
 */

/** 协议版本：形状一变就抬号；`open` 那一步比对，不符即拒（不拿旧形状硬解） */
export const STRUCTURE_PROTOCOL_VERSION = 3;

/** 一条回复最多带回多少捕获（超了截断 + `truncated`，不静默丢） */
export const STRUCTURE_MAX_CAPTURES = 50_000;

export type StructureFacet = 'semantic' | 'folds' | 'indent' | 'syntax';

/** 失败原因：**闭集**。worker 只报发生了什么，代价由宿主决定（D2） */
export type StructureFailureReason =
  | 'unavailable'        // 本进程建不出 worker
  | 'disposed'           // 客户端已释放
  | 'protocol-mismatch'  // open 那一步版本不符
  | 'invalid-input'      // 请求形状不合法
  | 'wasm-load-failed'   // runtime / grammar wasm 装不上
  | 'parse-failed'
  | 'query-failed'       // 查询编译或执行失败
  | 'crashed'            // 线程未捕获异常
  | 'timeout';           // 仅主线程产生

/**
 * 一个点（行 / UTF-16 列 / UTF-16 偏移），三件套必须同时给。
 *
 * 与 `packages/app/src/monaco/tree-sitter/types.ts` 的 `KojoStructurePoint` 逐字同形
 * （那边是别名）——`edit` 的形态要两侧都能说，故形状落在这里、由宿主做别名。
 */
export interface StructurePoint {
  readonly row: number;
  readonly column: number;
  readonly offset: number;
}

/**
 * 一条保守编辑（`text` 之外的另一半内容）。
 *
 * 与 `packages/app/src/monaco/tree-sitter/edit.ts::StructureEdit` 逐字同形：主线程用
 * `commonEdit()` 求最小编辑、`applyEdit()` 自检对得上才发差集，对不上自动退回整篇；
 * worker 用同一条编辑缝自己的文本副本 ⇒ 两侧文本恒等，不必每击键回传全文。
 */
export interface StructureEdit {
  readonly start: StructurePoint;
  readonly oldEnd: StructurePoint;
  readonly newEnd: StructurePoint;
  readonly newText: string;
}

/* ------------------------------ → worker ------------------------------ */

export interface StructureOpenRequest {
  readonly id: number;
  readonly kind: 'open';
  readonly protocol: number;
  /** 语言 id 原样带过去，只用于 worker 侧的日志与自证，worker 不据此分支 */
  readonly languageId: string;
  readonly runtimeWasmUrl: string;
  readonly grammarWasmUrl: string;
}

/**
 * 内容**二选一**（v1.1 改口，见下面"为什么保留差集"）：
 * - `{ text }`：整篇（开文件、换轨、worker 说 `baseTreeId` 不认识时的兜底）；
 * - `{ edit }`：基线 + 差集，基线文本由 worker 自己留着（主线程不再重发）。
 * 两者都给 ⇒ `invalid-input`（不猜哪个算数）；`edit` 的形态沿用既有 `StructureEdit`（`tree-sitter/edit.ts`）。
 */
export type StructureContent =
  | { readonly text: string }
  | { readonly edit: StructureEdit };

/**
 * 绝对区间（`@原生` 注入用，§4.6）：索引与行列**都要给**，直接对齐 web-tree-sitter 的 `Range`
 * ——只给行列会让 worker 再做一次全文扫描。坐标换算归 BOARD 的 **POS-UTIL** 那条口径。
 */
export interface StructureRange {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
}

/**
 * 设计稿写的是 `interface StructureParseRequest extends StructureContent`——**TypeScript 不让
 * 接口继承联合类型**（TS2312），故这里落成等价的交叉类型（字段一字不差，判别式仍在 `text` / `edit`）。
 * 这是与 §4.1 字面形状的唯一一处语法级偏离，语义为零差异。
 */
export type StructureParseRequest = StructureContent & {
  readonly id: number;
  readonly kind: 'parse';
  /** 文档身份（跨文档隔离；换轨后旧回复据此丢弃） */
  readonly doc: number;
  /** 内容版本（同文档内判陈旧） */
  readonly version: number;
  /** 增量基准：上一次回复交出的树；缺省 / 不认识 ⇒ 整篇重解 */
  readonly baseTreeId?: string;
  /** 只要这几面（缺省 = 全部）。大文件门控用，不改变"一条请求一条回复" */
  readonly want?: readonly StructureFacet[];
  /** `@原生` 注入用（§4.6 / LAU-6）：缺省 = 全文档 */
  readonly includedRanges?: readonly StructureRange[];
};

export type StructureRequest = StructureOpenRequest | StructureParseRequest;

/* ------------------------------ → 主线程 ------------------------------ */

export interface StructureReadyReply {
  readonly ok: true;
  readonly id: number;
  readonly kind: 'ready';
  readonly protocol: number;
  /** 引导期读数：`Parser.init` + `Language.load` + 查询编译 */
  readonly loadMs: number;
}

/**
 * 捕获的**扁平投影**（D4）：`spans` 每 6 个数字一条
 * `[startRow, startCol, endRow, endCol, nameIndex, nodeIndex]`，行 / 列 0 基。
 * `names` / `nodes` 是字典（去重后），`nameIndex` / `nodeIndex` 指向它们。
 */
export interface StructureCaptureTable {
  readonly names: readonly string[];
  readonly nodes: readonly string[];
  readonly spans: readonly number[];
}

export interface StructureFoldTable {
  /** 每 2 个数字一条 `[startRow, endRow]`（0 基，`endRow > startRow` 才算折叠） */
  readonly spans: readonly number[];
}

export interface StructureIndentRules {
  readonly increasePatterns: readonly string[];
  readonly decreasePatterns: readonly string[];
  readonly enterPatterns: readonly string[];
}

/** 结构残缺**事实**（无文案、无诊断码：说人话是表现层的事） */
export interface StructureSyntaxFault {
  readonly row: number;
  readonly endRow: number;
  readonly column: number;
  readonly endColumn: number;
  readonly kind: StructureSyntaxKind;
  readonly faultRow: number;
  readonly blockHeadText?: string;
  readonly blockHeadRow?: number;
  readonly expectedToken?: string;
}

/**
 * 结构残缺的类别闭集（v1 `KojoStructureSyntaxKind` 的同一串字面量；宿主侧诊断码 =
 * `kojo.` + 这一串，拼法在 `syntax-decorations.ts`）。
 */
export type StructureSyntaxKind = 'unclosed-block' | 'unterminated-string' | 'unterminated-interp' | 'unexpected-token';

export interface StructureParseReply {
  readonly ok: true;
  readonly id: number;
  readonly kind: 'parse';
  readonly doc: number;
  readonly version: number;
  readonly treeId: string;
  readonly incremental: boolean;
  /** 只带 `want` 里点名的面（缺省 = 全带）；缺的键 = 这一面这次没算 */
  readonly facets: {
    readonly semantic?: StructureCaptureTable;
    readonly folds?: StructureFoldTable;
    readonly indent?: StructureIndentRules;
    readonly syntax?: { readonly faults: readonly StructureSyntaxFault[]; readonly truncated: boolean };
  };
  readonly metrics: { readonly parseMs: number; readonly queryMs: number; readonly textLength: number };
}

export interface StructureFailureReply {
  readonly ok: false;
  readonly id: number;
  readonly kind?: 'open' | 'parse';
  readonly reason: StructureFailureReason;
  readonly message: string;
  /** 查询失败但树已解出：交回主线程，下一版还能增量 */
  readonly treeId?: string;
}

export type StructureReply = StructureReadyReply | StructureParseReply | StructureFailureReply;

/* ------------------------------ 两档预算 ------------------------------ */

/** 稳态：一条 `parse` 最多等多久 */
export const STRUCTURE_TIMEOUT_MS = 4_000;
/** 引导期（worker 还没回过任何一条）：线程 + 两枚 wasm + 文法装载都在这个窗口里 */
export const STRUCTURE_BOOTSTRAP_TIMEOUT_MS = 8_000;
/** 连续几次失败才判死一面（判死 = 这一面不再等，但换文档重计） */
export const STRUCTURE_DEAD_AFTER_FAILURES = 3;

/**
 * 失败原因的**运行期闭集**（协议表测试逐枚对拍；新增原因必须同时改上面的联合类型与这张表）。
 */
export const STRUCTURE_FAILURE_REASONS: readonly StructureFailureReason[] = [
  'unavailable',
  'disposed',
  'protocol-mismatch',
  'invalid-input',
  'wasm-load-failed',
  'parse-failed',
  'query-failed',
  'crashed',
  'timeout',
];

/** 面的**运行期闭集**（`want` 的合法取值；顺序即默认 `want` 的顺序） */
export const STRUCTURE_FACETS: readonly StructureFacet[] = ['semantic', 'folds', 'indent', 'syntax'];
