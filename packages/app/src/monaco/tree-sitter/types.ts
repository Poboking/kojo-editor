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

/**
 * 协议版本：形状一变就抬号，worker 认不出就直接停用（而不是拿旧形状硬解）。
 *
 * **2** 里同时装着这一批的**两桩形状变更**（两条线各自独立抬到 2，合并后就是同一个 v2 构建：
 * 两侧都在 `init` 那一步比对同一个号，谁也不许再往上抬——抬号等于把对面那半边的钉版全拆掉）：
 * - **doc 序（跨文档隔离）**：内容回复一律带 `doc`，对不上号 ⇒ 主线程整条丢弃（见下）；
 * - **`syntax` 回话（TSIT2-D）**：新增一条腿（CST 的 ERROR / MISSING 事实）。加一条腿仍是
 *   形状变更——旧宿主碰到新 worker 会把 `syntax` 判成违约消息并整档停用（宁可停用，
 *   不拿看不懂的东西硬解），所以按本文件的纪律抬号，让两侧在 `init` 那一步就把不符说出来。
 */
export const KOJO_STRUCTURE_PROTOCOL = 2;

/**
 * 跨文档隔离号：主线程给每份被跟踪的文档发一枚**全局单调自增**的序号，`parse` / `change`
 * 请求带上，worker 在**四类内容回复里（`semantic` / `folds` / `indent` / `syntax`）原样回显**。
 * 为什么必须有：切文档瞬间旧文档的解析
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

/**
 * 一枚折叠区间（0 基行号；`kind` / `placeholder` 与 Monaco 的 FoldingRange 同义）
 *
 * `endRow` 的口径（本批起，additive：形状与协议号都不动）：**含**块后面整行空白的尾随行，
 * 与真源 `kojoFoldingRanges` 的止行逐行对齐（判据在 `engine.ts::extendFoldOverTrailingBlanks`：
 * 只伸最外层块、不越过下一个带内容兄弟的起点行、最多到文件末行）。
 */
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

/**
 * CST 上的一处**结构残缺事实**（`syntax` 回话的元素；TSIT2-D）。
 *
 * 这里只有**事实**，没有文案、没有诊断码：worker 的依赖面只有 `web-tree-sitter`
 * （见 `engine.ts` 头注纪律 1，它连 `@kojo/plugin-api` 都不 import），而"说人话 + 上屏码"
 * 是表现层的取舍，住在宿主侧的 `syntax-decorations.ts`。两侧对不上时最坏是"这一面没文案"，
 * 不该是 worker 去 import 一张 UI 表。
 *
 * 行号一律 0 基（本文件头注的坐标口径）；`row` = **该给作者看的那一行**：
 * - `unclosed-block` ⇒ 块头那一行（要补收束词的是那一族，落点指块头才看得懂）；
 * - 其余 ⇒ 出错节点自己那一行。
 * 残缺点（MISSING 插入点 / ERROR 末行）另存 `faultRow`，供文案说"它还开着开到第几行"。
 */
export interface KojoStructureSyntaxFault {
  /** 装饰落点行（0 基，见上） */
  readonly row: number;
  /** 落点区间的末行（0 基，含）；单行残缺 = 与 `row` 同值 */
  readonly endRow: number;
  /** 落点起始列（0 基 UTF-16 码元） */
  readonly column: number;
  /** 落点结束列（0 基，**排他**） */
  readonly endColumn: number;
  /** 残缺类别（闭集；宿主按它挑文案与诊断码） */
  readonly kind: KojoStructureSyntaxKind;
  /** 残缺点所在行（0 基）：MISSING 的插入点 / ERROR 的末行 */
  readonly faultRow: number;
  /** 出错的块头文本（已去行首缩进、截断到首行；`unclosed-block` 才有） */
  readonly blockHeadText?: string;
  /** 块头行（0 基；与 `row` 同值时省略） */
  readonly blockHeadRow?: number;
  /** 语法层该有的那个收束记号**名**（如 `loop_end`；不是中文、不是上屏文案） */
  readonly expectedToken?: string;
}

/**
 * 残缺类别的闭集（宿主侧诊断码 = `kojo.` + 这一串，拼法在 `syntax-decorations.ts`，
 * 与 `erb-parser` 的 `erb.${kind}` 同一形态；对账闸见 `tests/diagnostic-copy.test.ts`）。
 */
export type KojoStructureSyntaxKind = 'unclosed-block' | 'unterminated-string' | 'unterminated-interp' | 'unexpected-token';

/** 类别闭集（运行期遍历用；新增一类必须同时补文案与码表，漏一条 ⇒ 测试红） */
export const KOJO_STRUCTURE_SYNTAX_KINDS: readonly KojoStructureSyntaxKind[] = [
  'unclosed-block',
  'unterminated-string',
  'unterminated-interp',
  'unexpected-token',
];

/**
 * 一文档最多回传多少处残缺（超出只留最前那些 + 由宿主说一声"还有更多"）。
 *
 * 真实残缺文件通常 1–3 处；上百处只可能是错误恢复跑飞，那时无脑全发等于把编辑器
 * 变成装饰刷（`deltaDecorations` 的开销与作者的阅读带宽都会先炸）。
 */
export const KOJO_STRUCTURE_MAX_SYNTAX_FAULTS = 64;

/**
 * 出错时该停用的面：`all` = 整档回落到词法层；其余 = 只让这一面回落
 * （`syntax` = 结构诊断这一面，回落 = 不画这一层波浪线，词法层与转译器波浪线照旧）
 */
export type KojoStructureCapability = 'semantic' | 'folds' | 'indent' | 'syntax' | 'all';

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
  | { type: 'syntax'; doc: KojoStructureDocSeq; version: number; faults: readonly KojoStructureSyntaxFault[]; truncated: boolean }
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
 * 三支映射都对着既有档位，不是新配色：
 * - `@comment` → `comment`：词法层本来就是 Monaco 基线 token（主题基色在，无需另配）；
 * - `@keyword` → `sugar.keyword`：「中文关键字」档。**这一格本批改过**——wave 1 把它映射成
 *   `keyword.erb`（引擎指令档 = "一整条还没中文化的骨架"），而查询里挂 `@keyword` 的五支节点
 *   （`color_head` 着色 / `heart_head` 心形 / `heart_text` 心形正文 / `message_check` 隐藏情景 /
 *   `blank_line_cmd` 空行）说的都是**已经中文化**的行，词法层在同一批格子上发
 *   `sugar.keyword` / `sugar.speech` / `sugar.cont` ⇒ 屏上是"外来色糊住中文骨架"，
 *   A/B 确有 ~620 格因此判异档（逐类命中分布与改后的读数见 A/B 测试头注）。
 *   引擎指令档留给真·没中文化的 `@keyword.directive`（全大写 ERB 直通行）——那支现在表外不着色，
 *   等语法/词表把它接上时再登记，不许借中文关键字档凑数。
 * - `@string`  → `sugar.speech`：「台词」档（作者写的正文）。
 */
export const KOJO_STRUCTURE_CAPTURE_TIERS: Readonly<Record<string, string>> = {
  comment: 'comment',
  keyword: 'sugar.keyword',
  string: 'sugar.speech',
};

/**
 * **捕获名 → 节点类型级**覆盖（先查这张表里"这一支捕获下的这个节点"，落空才回上面的捕获名表）。
 *
 * 存在的理由只有一个：`@keyword` 是一支"整行"捕获，而同一支里混着一条不含关键字的正文
 * `heart_text`（`心形 「还想做……舒服ー的事……HPH」 续`），按捕获名只能给一个档，量出来
 * 161 格里 `sugar.speech` 族占 109 格、`sugar.keyword` 族只占 29 格 ⇒ 那支的判据是"台词"不是"关键字"。
 * 这是**表现层的取舍**，语法包不该为它负责，所以留在宿主表里；并且**按捕获名分组**——
 * 否则将来别的查询把 `heart_text` 挂在别的捕获下（例如 `@string.special`）会被这一格悄悄串色。
 *
 * 语法升级（节点改名 / 拆分）时这张表自然失效：查不到就回落到捕获名表，不抛错、不静默丢色，
 * A/B 的读数会自己说出来。
 */
export const KOJO_STRUCTURE_NODE_TIERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  keyword: { heart_text: 'sugar.speech' },
};

/** Monaco 基线 token 名（不必进 `KOJO_TOKEN_TIERS`，主题基线里已有色） */
export const KOJO_STRUCTURE_BASELINE_TOKENS: readonly string[] = ['comment'];

/** 捕获名（+ 可选的节点类型）→ 档位名；表里没有 = `null`（该捕获不着色，并走一次性告警） */
export function tierForCapture(capture: string, nodeType?: string): string | null {
  if (nodeType !== undefined) {
    const byNode = KOJO_STRUCTURE_NODE_TIERS[capture]?.[nodeType];
    if (byNode !== undefined) return byNode;
  }
  return KOJO_STRUCTURE_CAPTURE_TIERS[capture] ?? null;
}

/** 语义 token legend 的类型表（档位名去重后按稳定顺序；下标即编码里的 typeIndex） */
export function structureLegendTypes(): string[] {
  const seen = new Set<string>();
  for (const tier of Object.values(KOJO_STRUCTURE_CAPTURE_TIERS)) seen.add(tier);
  for (const byNode of Object.values(KOJO_STRUCTURE_NODE_TIERS)) for (const tier of Object.values(byNode)) seen.add(tier);
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

/** 残缺事实的形状闸：坐标必须是有限数、类别必须在闭集里（表外的类别一律不认——不猜文案） */
function isSyntaxFault(value: unknown): value is KojoStructureSyntaxFault {
  const f = value as KojoStructureSyntaxFault | null;
  return (
    !!f &&
    Number.isFinite(f.row) &&
    Number.isFinite(f.endRow) &&
    Number.isFinite(f.column) &&
    Number.isFinite(f.endColumn) &&
    Number.isFinite(f.faultRow) &&
    KOJO_STRUCTURE_SYNTAX_KINDS.includes(f.kind) &&
    (f.blockHeadText === undefined || typeof f.blockHeadText === 'string') &&
    (f.expectedToken === undefined || typeof f.expectedToken === 'string')
  );
}

const STAGES: readonly string[] = ['wasm', 'parse', 'query', 'worker'];
const CAPABILITIES: readonly string[] = ['semantic', 'folds', 'indent', 'syntax', 'all'];

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
    case 'syntax':
      return Number.isFinite(m.doc) && Array.isArray(m.faults) && m.faults.every(isSyntaxFault) && typeof m.truncated === 'boolean';
    case 'error':
      return typeof m.message === 'string' && STAGES.includes(m.stage) && CAPABILITIES.includes(m.capability);
    default:
      return false;
  }
}
