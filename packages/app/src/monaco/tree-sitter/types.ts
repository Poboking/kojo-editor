/**
 * 主线程 ↔ 结构解析 worker 的**消息协议**（单一真源；两侧都只从这里取类型）。
 *
 * ## 为什么协议要单独成文件并且"钉版"
 *
 * worker 与宿主是两条独立的编译产物：宿主改了消息形状而 worker 没跟上，症状是
 * "结构着色悄悄没了"——正是本仓最恨的那类静默。故此文件同时是三件事的落点：
 * ① 形状（`KojoStructureRequest` / `KojoStructureReply`）；② 版本号
 * （`KOJO_STRUCTURE_PROTOCOL`，`init` 带上、worker 不符即回 `error` 并停用）；
 * ③ **不可信输入的运行时闸**（`isStructureReply`：主线程绝不 `as` 一个 worker 回来的
 * 东西就用作数据）。形状变更 ⇒ 本文件与 `kojo-ts.worker.ts` 同一批改，A/B 测试
 * （`tests/tree-sitter-protocol.test.ts`）钉住协议表与档位名表。
 *
 * ## 坐标口径（错一格就整片歪，故写死在这里）
 *
 * - `row` = 0 基行号（tree-sitter 原生）；`column` = **UTF-16 码元**列号，0 基
 *   （与 Monaco `Position.column` 差一格，转换在 `semantic.ts` 一处完成）；
 * - `offset` = **UTF-16 码元**偏移（`model.getOffsetAt()` 同口径；web-tree-sitter 的
 *   `Edit.startIndex` 在 JS 绑定里就是 JS 字符串下标，两侧同源才不会把树编辑歪）；
 * - 行内区间取 `[startColumn, endColumn)`，`endColumn` 是**排他**的列号（不是 Monaco 列）。
 */

/** 协议版本：形状一变就抬号，worker 认不出就直接停用（而不是拿旧形状硬解） */
export const KOJO_STRUCTURE_PROTOCOL = 2;

/**
 * 跨文档隔离号：主线程给每份被跟踪的文档发一枚**全局单调自增**的序号，`parse` / `change`
 * 请求带上，worker 在三类内容回复里**原样回显**。为什么必须有：切文档瞬间旧文档的解析
 * 回复还在路上，而 `version` 是每文档各自从 1 起的——只靠版本号判过期，旧文档的 tokens
 * 会冒充新文档的结果被缓存上屏（真实踩过）。对不上号 ⇒ 主线程整条丢弃。
 */
export type KojoStructureDocSeq = number;

/** 一个点（行 / UTF-16 列 / UTF-16 偏移），三件套必须同时给：tree-sitter 的 Edit 两个轴都要 */
export interface KojoStructurePoint {
  readonly row: number;
  readonly column: number;
  readonly offset: number;
}

/** 一枚结构 token：CST 上一个命名节点覆盖的区间 + 该给它哪一档颜色 */
export interface KojoStructureToken {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
  /** 档位名：**必须**是 `kojo-language.ts` 的 `KOJO_TOKEN_TIERS` 里出现过的 token 名，
   *  这样语义色与词法色同源，A/B 比的是"判据"而不是"另一套配色" */
  readonly tier: string;
}

/** 一枚折叠区间（0 基行号；`kind` / `placeholder` 与 Monaco 的 FoldingRange 同义） */
export interface KojoStructureFold {
  readonly startRow: number;
  readonly endRow: number;
  readonly kind?: string;
  readonly placeholder?: string;
}

/**
 * 缩进规则：**正则源码字符串**数组（宿主侧 `new RegExp()` 前逐条 try/catch）。
 * 三条腿各自对应 Monaco 语言配置的一个属性，全部**叠加**在既有 `sugarEnterRulePatterns()`
 * 之上，一条都不替换（`providers.ts` 的合并点）。空数组 = 结构层这次没有要补的 ⇒ 宿主
 * 连 `setLanguageConfiguration` 都不发（关掉与没接是同一份行为）。
 */
export interface KojoStructureIndentRules {
  readonly increasePatterns: readonly string[];
  readonly decreasePatterns: readonly string[];
  readonly enterPatterns: readonly string[];
}

/** 出错时该停用的面：`all` = 整档回落到词法层；其余 = 只让这一面回落 */
export type KojoStructureCapability = 'semantic' | 'folds' | 'indent' | 'all';

/** 报错的阶段（作者面文案由 `fallback.ts` 按阶段翻成人话） */
export type KojoStructureErrorStage = 'wasm' | 'parse' | 'query' | 'worker';

/* ------------------------------- → worker ------------------------------- */

export type KojoStructureRequest =
  /** 装配 worker：两枚 wasm 的 URL 由宿主注入（Vite `?url` 解析结果，worker 里不许硬编码路径） */
  | { type: 'init'; protocol: number; wasmUrl: string; runtimeWasmUrl: string }
  /** 整篇重解（首份文档 / 切换文档 / 增量失败后的重新对齐） */
  | { type: 'parse'; doc: KojoStructureDocSeq; version: number; text: string }
  /**
   * 增量重解：worker 自己留着上一版文本，按这一条编辑缝合后再解。
   * 主线程把一次 content change 里可能有多段的编辑**并成一条**保守区间
   * （`commonEdit()`），`newText` 就是新区间里的新内容；两侧对同一个字符串做同一步缝合 ⇒
   * 文本恒等，无需回传全文。
   */
  | { type: 'change'; doc: KojoStructureDocSeq; version: number; start: KojoStructurePoint; oldEnd: KojoStructurePoint; newEnd: KojoStructurePoint; newText: string };

/* ------------------------------- → main ------------------------------- */

export type KojoStructureReply =
  | { type: 'ready'; version: number }
  | { type: 'semantic'; doc: KojoStructureDocSeq; version: number; tokens: readonly KojoStructureToken[] }
  | { type: 'folds'; doc: KojoStructureDocSeq; version: number; folds: readonly KojoStructureFold[] }
  | { type: 'indent'; doc: KojoStructureDocSeq; version: number; rules: KojoStructureIndentRules }
  | { type: 'error'; version: number; stage: KojoStructureErrorStage; capability: KojoStructureCapability; message: string };

/* --------------------------- 捕获名 → 档位名 --------------------------- */

/**
 * `highlights.scm` 的捕获名 → 词法档位名（`KOJO_TOKEN_TIERS` 的 `tokens`）。
 *
 * 为什么这张表住宿主而不是语法包：档位=**屏幕上要分出几层**，那是宿主的表现层决定
 * （`kojo-language.ts` 的头注已经写明取色口径）；语法包只负责说"这段是什么结构"。
 * 语法包给的捕获名不在表里 ⇒ worker 回一条 `error`（stage `query` / capability `semantic`），
 * 这一段不着色并且**说出去**，绝不静默丢色。
 *
 * 三个映射都对着既有档位，不是新配色：
 * - `@comment` → `comment`：词法层本来就是 Monaco 基线 token（主题基色在，无需另配）；
 * - `@keyword` → `keyword.erb`：「引擎指令」档（一整条还没中文化的骨架）；
 * - `@string`  → `sugar.speech`：「台词」档（作者写的正文）。
 */
export const KOJO_STRUCTURE_CAPTURE_TIERS: Readonly<Record<string, string>> = {
  comment: 'comment',
  keyword: 'keyword.erb',
  string: 'sugar.speech',
};

/** Monaco 基线 token 名（不必进 `KOJO_TOKEN_TIERS`，主题基线里已有色） */
export const KOJO_STRUCTURE_BASELINE_TOKENS: readonly string[] = ['comment'];

/** 捕获名 → 档位名；表里没有 = `null`（该捕获不着色，并走一次性告警） */
export function tierForCapture(capture: string): string | null {
  return KOJO_STRUCTURE_CAPTURE_TIERS[capture] ?? null;
}

/** 语义 token legend 的类型表（档位名去重后按稳定顺序；下标即编码里的 typeIndex） */
export function structureLegendTypes(): string[] {
  const seen = new Set<string>();
  for (const tier of Object.values(KOJO_STRUCTURE_CAPTURE_TIERS)) seen.add(tier);
  for (const token of KOJO_STRUCTURE_BASELINE_TOKENS) seen.add(token);
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 一文档最多回传多少段（超过就整档停用并说一声）。
 * 真实语料最大单文件 52,601 行 ⇒ 十万级 token 属于"结构层跑飞了"，不是正常文档。
 */
export const KOJO_STRUCTURE_MAX_TOKENS = 50_000;

/* ----------------------------- 运行时形状闸 ----------------------------- */

function isPoint(value: unknown): value is KojoStructurePoint {
  const p = value as KojoStructurePoint | null;
  return !!p && Number.isFinite(p.row) && Number.isFinite(p.column) && Number.isFinite(p.offset);
}

function isToken(value: unknown): value is KojoStructureToken {
  const t = value as KojoStructureToken | null;
  return (
    !!t &&
    Number.isFinite(t.startRow) &&
    Number.isFinite(t.startCol) &&
    Number.isFinite(t.endRow) &&
    Number.isFinite(t.endCol) &&
    typeof t.tier === 'string'
  );
}

function isFold(value: unknown): value is KojoStructureFold {
  const f = value as KojoStructureFold | null;
  return !!f && Number.isFinite(f.startRow) && Number.isFinite(f.endRow);
}

function isRules(value: unknown): value is KojoStructureIndentRules {
  const r = value as KojoStructureIndentRules | null;
  return (
    !!r &&
    Array.isArray(r.increasePatterns) &&
    Array.isArray(r.decreasePatterns) &&
    Array.isArray(r.enterPatterns)
  );
}

const STAGES: readonly string[] = ['wasm', 'parse', 'query', 'worker'];
const CAPABILITIES: readonly string[] = ['semantic', 'folds', 'indent', 'all'];

/**
 * worker 回传来路不明的东西时**整条丢掉**并计数（`client.ts` 把它报出去）。
 * 判据只在形状上，不解释内容——内容解释全在 `semantic.ts` / `providers.ts`。
 */
export function isStructureReply(value: unknown): value is KojoStructureReply {
  const m = value as KojoStructureReply | null;
  if (!m || typeof m.type !== 'string' || !Number.isFinite(m.version)) return false;
  switch (m.type) {
    case 'ready':
      return true;
    case 'semantic':
      return Number.isFinite(m.doc) && Array.isArray(m.tokens) && m.tokens.every(isToken);
    case 'folds':
      return Number.isFinite(m.doc) && Array.isArray(m.folds) && m.folds.every(isFold);
    case 'indent':
      return Number.isFinite(m.doc) && isRules(m.rules);
    case 'error':
      return typeof m.message === 'string' && STAGES.includes(m.stage) && CAPABILITIES.includes(m.capability);
    default:
      return false;
  }
}
