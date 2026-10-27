/**
 * 结构层**宿主侧的投影类型**与**旧协议（v2）的遗留形状**。
 *
 * ## 协议真源已搬到 `@kojo/kojo-core`
 *
 * LAU-1 起，宿主 ↔ worker 的消息协议是 `packages/kojo-core/src/structure-protocol.ts`
 * 的 **v4**（`STRUCTURE_PROTOCOL_VERSION = 4`，LAU-5 抬号：`ready.docBase`）：`open` / `parse` 两条请求、`ready` /
 * `parse` / 失败三条回话、面（facet）合并成一条消息、失败原因是闭集。运行期闸与两张
 * 小解码器在 `./protocol.ts`。
 *
 * 本文件剩下的两件事：
 * 1. **宿主侧投影**：`KojoStructureToken`（档位名 + 行列）/ `KojoStructureFold`（行区间）
 *    / 档位表 / legend —— 这些是"屏上要分几层"的表现层决定，不属于线上协议；
 * 2. **v2 遗留形状**（`KojoStructureRequest` / `KojoStructureReply` + `KOJO_STRUCTURE_PROTOCOL`
 *    + `isLegacyStructureReply`）：双跑窗口里旧 client（`./client-v2.ts`）要说旧形状，
 *    v3 client 收到 `protocol-mismatch` 就在那一刻降级到它。**LAU-1 收尾（双跑窗口关闭）
 *    时整块删除**，届时 `client-v2.ts` 一起删。
 *
 * 名字映射（v3 → 本文件）：
 * `StructurePoint` → `KojoStructurePoint`；`StructureIndentRules` → `KojoStructureIndentRules`；
 * `StructureSyntaxFault` → `KojoStructureSyntaxFault`；`StructureSyntaxKind` → `KojoStructureSyntaxKind`。
 * 四者都是**类型别名**，编译期兼容，不另起一套形状。
 *
 * ## 坐标口径（错一格就整片歪，故写死在这里）
 *
 * - `row` = 0 基行号（tree-sitter 原生）；`column` = **UTF-16 码元**列号，0 基
 *   （与 Monaco `Position.column` 差一格，转换在 `semantic.ts` 一处完成）；
 * - `offset` = **UTF-16 码元**偏移（`model.getOffsetAt()` 同口径；web-tree-sitter 的
 *   `Edit.startIndex` 在 JS 绑定里就是 JS 字符串下标，两侧同源才不会把树编辑歪）；
 * - 行内区间取 `[startColumn, endColumn)`，`endColumn` 是**排他**的列号（不是 Monaco 列）。
 */
import { ROLE, type SemanticRole } from '@kojo/kojo-sdk/semantic-roles';
import type {
  StructureCaptureTable,
  StructureIndentRules,
  StructurePoint,
  StructureSyntaxFault,
  StructureSyntaxKind,
} from '@kojo/kojo-core';

/**
 * 旧协议版本（v2）：`init` 那一步比对。
 *
 * **2** 里同时装着两桩形状变更（两条线各自独立抬到 2，合并后就是同一个 v2 构建）：
 * doc 序（跨文档隔离）+ `syntax` 回话（TSIT2-D）。**v3 的号在 kojo-core**，这里不再抬——
 * 双跑窗口里这个常量只是旧 client 与旧 worker 对暗号用的。
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
export type KojoStructurePoint = StructurePoint;

/** 一枚结构 token：CST 上一个命名节点覆盖的区间 + 该给它哪一档颜色 */
export interface KojoStructureToken {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
  /** 档位名：**必须**是 `kojo-language.ts` 的 `KOJO_TOKEN_TIERS` 里出现过的 token 名，
   *  这样语义色与词法色同源，A/B 比的是"判据"而不是"另一套配色" */
  readonly tier: string;
  /**
   * 这两格只在 **worker 内部**用（LAU-1）：v3 的 `facets.semantic` 是捕获的扁平投影
   * （`[行, 列, 行, 列, nameIndex, nodeIndex]` + 两张字典），引擎在把捕获折成 token 时
   * 顺手把名字与节点类型留在 token 上，回话那一层据此压表。宿主侧的正规路径**不看**它们
   * （宿主从表里自己按档位表翻，见 `client.ts`）；唯一例外是 `@原生` 注入层——它把子树的
   * 捕获名翻成宿主语言的档（LAU-6），见 `kojo2-semantic.ts::injectionTokenSpans`。
   */
  readonly capture?: string;
  readonly node?: string;
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
export type KojoStructureIndentRules = StructureIndentRules;

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
export type KojoStructureSyntaxFault = StructureSyntaxFault;

/**
 * 残缺类别的闭集（宿主侧诊断码 = `kojo.` + 这一串，拼法在 `syntax-decorations.ts`，
 * 与 `erb-parser` 的 `erb.${kind}` 同一形态；对账闸见 `tests/diagnostic-copy.test.ts`）。
 * 形状真源是 v3 协议的 `StructureSyntaxKind`（本处是别名）。
 */
export type KojoStructureSyntaxKind = StructureSyntaxKind;

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

/* --------------------------- 旧协议（v2，双跑窗口） --------------------------- */

/**
 * **旧**请求形状（v2）：只给 `./client-v2.ts` 用。
 *
 * v3 起请求有两种（`open` / `parse`，见 `@kojo/kojo-core`）；这三条只是双跑窗口里
 * "对面还是旧 worker"时宿主改说旧话所需的遗留形状，LAU-1 收尾时整块删。
 */
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

/**
 * **旧**回话形状（v2）：只给 `./client-v2.ts` 的收件闸用（形状与 v3 不同，故单列一套）。
 */
export type KojoStructureReply =
  /** `loadMs` 是 LAU-1 加的**引擎内读数**（v3 `ready` 要它；v2 线上不带） */
  | { type: 'ready'; version: number; loadMs?: number }
  /**
   * `table` 是 LAU-1 加的**引擎内投影**：v3 的 `facets.semantic` 就是这张扁平捕获表。
   * 引擎在折 token 的同时把捕获名 / 节点类型留成字典（`tokens` 仍给 v1 那一侧与测试用，
   * **不在线上协议里**）。两者同源、同一次遍历，不是两份判据。
   */
  | { type: 'semantic'; doc: KojoStructureDocSeq; version: number; tokens: readonly KojoStructureToken[]; table?: StructureCaptureTable }
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
 *   引擎指令档**不借给中文行**；原生那一族（`@keyword.directive`）另按下面的节点级表处理，
 *   `native_line` 至今仍未登记（理由见那张表的头注），不许拿中文关键字档凑数。`keyword.erb`
 *   那一档**仍然空着等它**——本批登记的 `raw_block_start` 取的是「整行原生直通」档 `keyword.raw`
 *   （那一档的 `why` 写的就是 `@函数` = 不透明整块），不是指令档。
 * - `@string`  → `sugar.speech`：「台词」档（作者写的正文）。
 *
 * ## TSIT5：表外那 12 支的**覆盖面真账**（PITFALLS 141 欠的三个数）
 *
 * 查询 15 支捕获，本节两张表加上面三支 = **有档 5 支**（`comment` / `string` / `keyword` /
 * `keyword.control`（仅节点级）/ `keyword.directive`（仅节点级）），**表外 10 支**。逐支结论与
 * 实测格数（28 份夹具、`tests/kojo-ts-capture-coverage.test.ts` 打印的 solo 账；取数 2026-10-20，
 * **同波语法批正在重编 wasm，下面这些格数会漂**，一切以探针当轮打印为准——漂的方向不是本批判据）：
 *
 * | 捕获 | 内容格 | 结论 | 一句理由 |
 * | --- | --- | --- | --- |
 * | `keyword.control` | 7,652 | **部分登记**（只登光杆形，见下表） | 收束/流转/裸头行的跨度里除了关键字与冒号没有别族内容；带条件/值/台词的头行反过来——一半以上的位置由**内容**占着 |
 * | `keyword.directive` | 53,889 | **只登 `raw_block_start`** | `native_line` 一枚节点混两形（全大写指令行 / `$标签`，35% `keyword.erb` + 21% `sugar.speech` + 16% `identifier`，12 个档族），一档必抹两档 ⇒ 等查询侧给子记号捕获再登记 |
 * | `none` | 3,647 | **不登记** | 哨兵：这两枚节点的意思就是"这些行不该被结构层涂色"；登记等于把旁白整行糊成一档（48% 是名字层） |
 * | `type`（时机头） | 2,502 | **不登记** | 时机名与参数占掉跨度 55%（`sugar.slot` 36% + `number` 19%），行身份要让位给内容 |
 * | `keyword.head` | 738 | **不登记** | 声明行 = 关键字 + **作者自定名/值**（slot 29–43%）；名字层正是这一行要让人看见的东西 |
 * | `operator` | 327 | **不登记** | `assign`/`mutator`/`settle` 的信息在目标名与右值（含行内插值）上，没有"整行一档"可给 |
 * | `function` | 63 | **不登记** | 函数/自定指令头携带名字（slot 30–58%），同上 |
 * | `function.call` | 38 | **不登记** | 调用行 = 关键字 + 被调名（slot 42% + `sugar.system-function` 21%），一档会抹掉调用位 |
 * | `property` | 32 | **不登记** | 开关条目 81% 是作者自定名；"这是一条条目"对作者没有信息量 |
 * | `label` | 18 | **不登记** | `标签 <名>` 89% 是名字（identifier），涂关键字等于抹名字 |
 * | `error` | 2 | **不登记** | 残缺属**诊断面**（`syntax` 腿 + 波浪线 + `kojo.*` 码），不许拿前景色表达错误 |
 * | `string.special` | 201 | **本批不动**（留给同波语法批） | 它正在让台词行内插值出节点（本批两次取数间 44 → 201 格）；实测这一支跨度 100% 落在 `sugar.interp` 一族（72% + 28% 深浅子档）⇒ 节点齐了以后的登记目标就是 `sugar.interp`，但**不许现在抢登记**去归零归因尺那 189 格"说不清" |
 *
 * 判据只有一条（**不看读数涨跌**，也不给"过半就行"的数尺）：**登记一档 = 承诺"这一跨度的作者面
 * 语义由这一档说完"**。跨度里若还有**别族在承担内容**（台词、名字层、参数、调用位、插值），涂一档
 * 就是把词法层已经分好的那几层抹平——那既不是"结构层更对"，也不是覆盖面，是**降维**。反过来说，
 * 表外那些格数是**覆盖面的真账缺口**，要补得先由查询侧给出**子记号级捕获**（`(if_head keyword: …)`
 * 那一类），不是由宿主猜一个档。逐支账由 `tests/kojo-ts-capture-coverage.test.ts` 每次复跑打印。
 */
export const KOJO_STRUCTURE_CAPTURE_TIERS: Readonly<Record<string, SemanticRole>> = {
  comment: ROLE.comment,
  keyword: ROLE.keyword,
  string: ROLE.speech,
};

/**
 * **捕获名 → 节点类型级**覆盖（先查这张表里"这一支捕获下的这个节点"，落空才回上面的捕获名表）。
 *
 * 存在的理由只有一个：同一支"整行"捕获里混着**跨度内容并不齐**的节点，按捕获名只能给一个档就必然
 * 有一半涂错。上面 TSIT5 那条判据（一档要说得完这一跨度）落不到捕获级时，**只许落到这张表里按节点
 * 登记**——这也是本批唯一的新增通道：捕获级表 `KOJO_STRUCTURE_CAPTURE_TIERS` 三支一毫米不动，
 * 新登记的每一格都是"跨度里除了行身份档没有别族承担内容"的节点。
 *
 * - `keyword / heart_text`：整行 `@keyword` 里唯一一条不含关键字的正文（`心形 「还想做……舒服ー的事……HPH」 续`），
 *   161 格里 `sugar.speech` 族占 109 格 ⇒ 这一支的判据是"台词"不是"关键字"。
 * - `keyword.control /（光杆收束·流转·裸头 12 枚节点）`：`循环结束` / `出错结束` / `数据表结束` /
 *   `出错处理` / `数据表` / `循环流转` / `返回` / `随机` / `组` / `分支` / `选项` / `菜单` 这些行**整行
 *   就是那个中文关键字**（28 份夹具实测：同族的词法格占这一跨度 67–100%，`loop_flow` / `catch_end` /
 *   `data_end` 三形 100%），剩下的只有 `sugar.colon` 那一格冒号边界与个别运算符格——与已经登记的
 *   `heart_head` / `color_head` 同一形态。带条件、带值、带台词的其余 19 枚节点形
 *   （`if_head` 5,466 格 / `case_head` 710 / `when_head` 424 / `choice_item` 150 …）**不在这里**，
 *   理由见上面那张账。
 * - `keyword.directive / raw_block_start`：`@函数名` 块起始行 = 不透明整块，词法层 3,239 格里 94% 发的
 *   正是「整行原生直通」档 `keyword.raw`（`kojo-language.ts` 那一档的 `why` 写的就是"`@函数` = 不透明整块"）；
 *   这是**外来族**，不是中文关键字档。同一支捕获下的 `native_line`（50,650 格）**不登记**：一枚节点两形混
 *   涂，`keyword.erb` 只认领 35%，台词引号与名字各占 21% / 16%，登记等于把 3/4 的格子糊成外来色。
 *
 * 语法升级（节点改名 / 拆分）时这张表自然失效：查不到就回落到捕获名表，不抛错、不静默丢色，
 * A/B 与覆盖面账会自己说出来。
 */
export const KOJO_STRUCTURE_NODE_TIERS: Readonly<Record<string, Readonly<Record<string, SemanticRole>>>> = {
  keyword: { heart_text: ROLE.speech },
  // TSIT5：光杆收束 / 流转 / 裸块头——整行就是那个中文关键字，跨度里没有别族承担内容
  'keyword.control': {
    loop_end: ROLE.keyword,
    loop_flow: ROLE.keyword,
    catch_head: ROLE.keyword,
    catch_end: ROLE.keyword,
    data_head: ROLE.keyword,
    data_end: ROLE.keyword,
    return_statement: ROLE.keyword,
    random_head: ROLE.keyword,
    group_head: ROLE.keyword,
    branch_head: ROLE.keyword,
    choice_head: ROLE.keyword,
    menu_head: ROLE.keyword,
  },
  // TSIT5：`@函数名` 块起始 = 不透明整块（`native_line` 依上面那条理由留在表外）
  'keyword.directive': { raw_block_start: ROLE.raw },
};

/** Monaco 基线 token 名（不必进 `KOJO_TOKEN_TIERS`，主题基线里已有色） */
export const KOJO_STRUCTURE_BASELINE_TOKENS: readonly SemanticRole[] = [ROLE.comment];

/** 捕获名（+ 可选的节点类型）→ 档位名；表里没有 = `null`（该捕获不着色，并走一次性告警） */
export function tierForCapture(capture: string, nodeType?: string): SemanticRole | null {
  if (nodeType !== undefined) {
    const byNode = KOJO_STRUCTURE_NODE_TIERS[capture]?.[nodeType];
    if (byNode !== undefined) return byNode;
  }
  return KOJO_STRUCTURE_CAPTURE_TIERS[capture] ?? null;
}

/** 语义 token legend 的类型表（档位名去重后按稳定顺序；下标即编码里的 typeIndex） */
export function structureLegendTypes(): SemanticRole[] {
  const seen = new Set<SemanticRole>();
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

/* --------------------------- 旧协议的运行时形状闸 --------------------------- */

/**
 * **旧**回话的收件闸（v2）。v3 的闸在 `./protocol.ts`（这里把 v3 的那个名字再导出一次，
 * 让"协议闸"只有一个入口可 import）。
 *
 * 判据只在形状上，不解释内容——内容解释全在 `semantic.ts` / `providers.ts`。
 */
export function isLegacyStructureReply(value: unknown): value is KojoStructureReply {
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

/* ------------------------------ 协议 v3 的闸 ------------------------------ */

/**
 * v3 回话的收件闸（真源 `./protocol.ts`；此处的再导出只为让调用方一处取名）。
 *
 * 名字在双跑窗口里并存：`isStructureReply`（v3）/ `isLegacyStructureReply`（v2）。
 */
export { isStructureReply, isStructureRequest, isStructureFacet, contentProblem } from './protocol';
