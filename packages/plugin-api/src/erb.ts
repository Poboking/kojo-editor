/**
 * ERB 解析器契约（服务键 `erb.parser`）。
 *
 * 定位（架构文档 §5.2）：**结构感知的解析**，不做完整 EraBasic 解释器。
 * v0.1 覆盖：函数边界、#DIM 声明、#FUNCTION(S) 文件标记、SKIPSTART/SKIPEND 区间。
 * v0.2 追加：PRINT 变体、IF/SELECTCASE 嵌套、TRYCALLFORM 引用、条件谓词抽取。
 */
// 类型专用 import：调用槽语义的格式化指向契约类型本身，**不**把 `game.ts` 的运行时常量
// 拽进桶图（LAU-4 之前 +45.4 KB 的教训，见 `active-adapter.ts` 头注）。
import type { KojoCallProtocol, KojoCallSlot } from './game';


/** ERB 函数形参 */
export interface ErbParam {
  /** 形参名（如 `ARGS`、`ARG:1`、`OVERRIDE_TARGET`） */
  name: string;
  /** 是否有默认值（实参省略时的兜底） */
  hasDefault: boolean;
}

/** 单个函数定义（结构性事实，不含语义） */
export interface ErbFunction {
  /** 原样函数名（如 `M_KOJO_MESSAGE_COM_K1_30`） */
  name: string;
  /**
   * 归一化名：大写（Emuera 函数名大小写不敏感）。
   * 位置索引与查重一律用归一化名。
   */
  normalizedName: string;
  params: ErbParam[];
  /** 定义行（@ 行，1 基） */
  startLine: number;
  /** 函数体结束行（下一个定义前 / 文件尾，1 基，含） */
  endLine: number;
  /** 定义所在文件（绝对路径） */
  filePath: string;
  /**
   * 名字**起点列**（**additive 可选**，W-DEF-COL 批）：`@` 之后第一个属于名字的码元所在的列。
   *
   * 口径与 {@link ErbReference.column} 逐字相同：**1 基、UTF-16 码元、结束列不含端点**
   * （结束列 = `nameColumn + name.length`，Monaco 的列坐标系就是这个单位，代理对占两格）。
   * 与 {@link ErbFile.labels} / `#DIM` 那两条腿交给宿主的 `span` 同源同形，
   * 落点夹取单源于宿主的 `reveal-position`，**这里只出事实、不出区间对象**。
   *
   * 为什么值得为它付索引体积：`startLine` 只能把光标放到**行首**，而作者按 F12 想停在
   * 名字上（接着往下改名字 / 看形参表）。真语料 113,833 条 `@` 定义里 230 条带前导缩进
   * （210 条制表符 / 16 条空格 / 4 条其它空白），缩进最深的到第 10 列——落在行首就是
   * "跳到了但没跳到那个词上"。
   *
   * **缺席 = 索引没有这个事实**（旧盘快照、或来源文本不可得），消费方必须退化成
   * "只给行"；**绝不许用 `1` 之类的好看值补位**——那是一条假事实，比没有更糟。
   */
  nameColumn?: number;
  /**
   * 表达式函数标记（`#FUNCTION` / `#FUNCTIONS` 声明，可在表达式中调用）。
   * 真实写法：标记行出现在 `@` 行**之后**的函数体内（AUTO_AEGI.ERB:60-61 实证）；
   * 宽容解析同样接受写在 `@` 行之前的形式。
   */
  isExpressionFunction?: boolean;
  /**
   * 函数声明**上方紧邻**的 `;` 注释块（已去装饰线、去 `;` 前缀、按行拼接）。
   * 无注释块 = 缺省（不写空串，避免索引里堆一堆无意义字段）。
   *
   * 为什么值得为它付索引体积（用户反馈 9「函数名几乎都是大写 + 长前缀，初看难解其意」）：
   * 实测真实语料 100,532 个口上函数里 **51.5% 带这样的注释块**，平均 76 字符，
   * 总计约 3.7 MB——一半函数因此能在函数树上直接读出人类可读的名字与说明。
   * 典型形态（eraTW 作者手写惯例）：
   *   ;==================================================
   *   ;660,読書
   *   ;TFLAG:193(選択肢文学(1=忍殺(文学？) 2=失敗 3=文学),…)
   *   ;==================================================
   * 长度上限见 scanner 的 `DOC_MAX_CHARS`（离群长文截断，防单函数吃掉整份快照）。
   */
  docComment?: string;
}

/**
 * `#DIM` 族声明行收集到的名字（**族成员以扫描器 `DIM_RE` 为准**，此处只描述它现在认什么）。
 *
 * `name` 只有**一个**：`#DIM 名, 尺寸` 的第二槽是数组维度/初值，不是第二个变量
 * （基线语料 1,774 条带顶层逗号的声明里没有一个多变量形——判据与读数见 `erb-parser/scanner.ts`）。
 * `#LOCALSIZE` / `#LOCALSSIZE`（同族、量大：基线语料 17,109 行）**不在这一张表里**：
 * 它们是函数局部作用域的声明，而 `ErbDim` 没有作用域字段 ⇒ 收进来就是"别的功能里也
 * 声明了这个名字"的假事实；要收得先给契约加作用域，另单。
 */
export interface ErbDim {
  name: string;
  /** 声明指令（大写归一）：`DIM` / `DIMS` / `DIMF` / `DIMSTR` / `DIMCHAR` / `DEFINE` */
  directive: string;
  line: number;
}

/**
 * `$` 标签定义（函数局部跳转目标；**additive 可选**，2026-10-16 语言服务批）。
 *
 * 标签是**函数局部作用域**：跨函数的同名 `$` 定义各归各的函数（`functionStartLine`
 * 归属判据），`[SKIPSTART]` 区间内与第一个 `@` 之前的标签不收集（引擎不编译它们）。
 */
export interface ErbLabel {
  /** 标签名（原样；查表按大写归一——Emuera 标签名大小写不敏感） */
  name: string;
  /** 标签所在行（1 基） */
  line: number;
  /** 所属函数的定义行（1 基，`@` 行）——"当前函数内有没有这个标签"的判据 */
  functionStartLine: number;
}

/** 单个 ERB 文件的解析结果 */
export interface ErbFile {
  path: string;
  functions: ErbFunction[];
  dims: ErbDim[];
  /**
   * 函数内收集到的 `$` 标签（**additive 可选**，2026-10-16 语言服务批）。
   * 缺省 = 本文件没有标签（解析器不给空数组，避免索引堆空字段——与 `docComment` 同纪律）。
   */
  labels?: ErbLabel[];
  /**
   * 含 `#FUNCTION` / `#FUNCTIONS` 指令。
   * 关键用途：Emuera LazyLoading 对含该指令的文件**整文件排除**（不参与懒加载索引），
   * 编辑器必须识别这个规则才能正确预测"函数在引擎里是否可见"。
   */
  hasFunctionDirective: boolean;
  /** 文件行数 */
  lineCount: number;
}

/** 函数定义位置引用 */
export interface ErbFunctionRef {
  name: string;
  normalizedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /** 见 {@link ErbFunction.nameColumn}（转到定义 / 跳到实现的落点列；缺席 = 索引没这个事实） */
  nameColumn?: number;
  /** 见 {@link ErbFunction.docComment}（导航树悬停提示消费） */
  docComment?: string;
}

/**
 * 控制流语句（线性记录 + 块深度）——scanControlFlow 的产物。
 *
 * 结构事实，零语义：只记录"这行是什么语句、条件原文是什么、嵌套多深"。
 * 条件谓词化（表达式解析、变量语义）由消费方（如 condition-extractor）完成。
 *
 * depth 约定：语句所在块深度（最外层函数体 = 0）。
 * - 开块语句（IF/SELECTCASE/FOR/…）记**开启前**深度，其体内语句 +1；
 * - 分支语句（ELSEIF/ELSE/CASE/CASEELSE）与闭合语句（ENDIF/ENDSELECT/…）
 *   与所配对的开块语句**同深度**。
 */
export interface ControlFlowStatement {
  /**
   * 语句关键字（大写）：IF / ELSEIF / ELSE / SIF / ENDIF / SELECTCASE / CASE /
   * CASEELSE / ENDSELECT / FOR / NEXT / WHILE / WEND / REPEAT / REND / DO / LOOP /
   * PRINTDATA 系 / DATALIST / STRDATA / NOSKIP / TRY 系 / CATCH / ENDCATCH / ENDFUNC 等。
   */
  kind: string;
  /** 条件/表达式原文（无表达式语句为空串；行内注释已截断，字符串内分号保留） */
  expression: string;
  /** 块深度（0 = 函数体顶层） */
  depth: number;
  /** 行号（1 基） */
  line: number;
}

/**
 * 结构体检的一条发现（2026-10-13 UI 反馈 7：`.ERB` 编辑器波浪线）。
 *
 * 与 `ControlFlowStatement` 的分工：那张表是**骨架**（消费方拿去算深度、抽条件），
 * 这一张是**配对失败的证据**。两者共用 `erb-parser/scanner.ts` 里的同一份配对表——
 * 各抄一份表就必然漂移，漂移的表现是"波浪线指的行骨架里根本没有"。
 *
 * 闭集六类，且**只报可证明的**（口径：错标比不标危险）：
 * - `orphan-close`：闭合语句找不到对应开块（多写了 `ENDIF`）；
 * - `unclosed-open`：走到函数边界（`@` 行）或文件结尾仍有开块没闭合；
 * - `orphan-branch`：`ELSE` / `CASE` / `CATCH` 这类分支语句前面没有它要归属的开块；
 * - `dim-invalid`：`#DIM` 族声明违反引擎硬规则（维数 / CONST / REF / 初值个数）——
 *   这类错误的后果是**整个文件加载失败**，所以提前到打字时（2026-10-25 P1-4）；
 * - `return-form`：`#FUNCTION` 式中函数用裸 `RETURN` 收尾（返回值静默丢失；P1-3）；
 * - `erh-invalid`：`.ERH` 头文件里出现了引擎不认的行或指令——引擎的头文件加载器只认
 *   `#DIM` / `#DIMS` / `#DEFINE`，一遇其它形状就**中止整轮**（连后面的 `.ERH` 也不再读，
 *   见 `ErhLoader.loadHeaderFiles` 的 `if (!noError) break`）。2026-10-26 A4 · P1-4 第七条。
 *   只有 `.ERH` 会被判（`checkStructure` 拿到路径才跑这一趟，见该方法注）。
 * 未知变量名、未知函数名、表达式语法**不在这一层**（要全项目语义或表达式解析器）。
 */
export interface ErbStructureIssue {
  readonly kind: 'orphan-close' | 'unclosed-open' | 'orphan-branch' | 'dim-invalid' | 'return-form' | 'erh-invalid';
  /** 1 基行号（与 `ControlFlowStatement.line` 同一坐标系） */
  readonly line: number;
  /** 出问题的语句原词（`ENDIF` / `IF` / `ELSE`…）；未闭合类给的是那个**开块**的原词 */
  readonly statement: string;
  /** 给作者看的中文一句话（说清缺谁、在哪儿，不复述引擎术语） */
  readonly message: string;
  /**
   * 波浪线严重级（additive，2026-10-25）：缺省 `'error'`（配对错误都是硬错）。
   * 声明面两类要分档——`#DIM` 违反硬规则 = `'error'`（文件加载失败），
   * `#FUNCTION` 收尾形态 = `'warning'`（能跑，但返回值静默丢失）。
   */
  readonly severity?: 'error' | 'warning';
  /**
   * 缺失的闭合语句原词（`ENDIF` / `ENDSELECT` …）。**只有 `unclosed-open` 才给**，
   * 且配对表说不出闭合词时也不给（`''` 的情形一律省略）。additive：缺省 = 现状。
   */
  readonly closer?: string;
  /**
   * 建议插入点：**在这一行之前**插入 `closer`（1 基）。大于文件行数 = 追加到文件末尾。
   *
   * 为什么只有未闭合类有插入点，而孤儿闭合/无主分支没有：**修法不对称**。
   * 少写一个 `ENDIF` 是"这一层在本函数内一定没关"，补在函数边界之前语义确定；
   * 而多写一条 `ENDIF` 也可能是**我们把函数边界漏判了**（漏判是安全方向，见
   * `erb-parser/structure.ts` 的 `isFunctionBoundary`），据同一条证据去删用户的行
   * 就是拿不确定的推断改文件——所以那两类只报位置，不给动作。
   */
  readonly fixBeforeLine?: number;
}

/** 项目级函数索引（重名函数保留全部定义，由消费方判定） */
export interface ErbIndex {
  /** 绝对路径 → 文件解析结果 */
  files: Map<string, ErbFile>;
  /**
   * 归一化函数名 → 定义列表。
   *
   * MEM-19 起是**列式查找表**（{@link ErbFunctionLookup}）：名字 → 定义句柄，
   * `ErbFunctionRef` 对象只在 `firstOf` / `defsOf` / `values` 被调用时构造。
   * 旧写法对照：`byName.get(n)?.[0]` → `firstOf(n)`、`byName.get(n) ?? []` → `defsOf(n)`、
   * `byName.has(n)` / `.size` 原样、`[...byName.keys()]` → `keys()`、
   * `byName.values()` / `entries()` 原样（仍会按组构造数组）。
   */
  byName: ErbFunctionLookup;
  /**
   * 项目体量指纹（`plugin-api/fingerprint` —— 全部 ERB 的 路径+mtime+size 哈希）。
   *
   * 索引构建时**顺手已有** stat 结果，故这个判据不额外花一次读盘。下游的整项目粒度
   * 派生缓存（条件抽取 / 约定校验）以它为失效判据：文件没变 ⇒ 纯函数产出必变不了。
   * `null` = 有文件取不到 stat ⇒ 派生缓存一律不命中（保守失效）。
   */
  readonly fingerprint?: string | null;
  /**
   * 逐文件 mtime（与 `SnapshotEntry.mtimeMs` 同源：重扫文件取 `readText` 的、复用文件取快照的）。
   *
   * 为什么单独暴露：整项目指纹是"任一文件变 ⇒ 全部作废"，而**作者天天只改几个文件**——
   * 按文件粒度复用才对症。下游（条件抽取）拿它逐文件比对快照桶，只重算变过的那些。
   * 某文件取不到 stat ⇒ 该路径值为 `null` ⇒ 下游对**该文件**永不复用（保守，不影响别的文件）。
   */
  readonly fileMtimes?: ReadonlyMap<string, number | null>;
  /**
   * 逐文件字节数（**additive 可选**，2026-10-16 PERF-7 快照批）。与 `fileMtimes` 同源
   * （walkDir 顺带带回的 size / 逐文件 stat 兜底），用途是同族：下游按文件比对快照桶时
   * 给 mtime 判据**再叠一层 size 判据**——mtime 相同的替换（保留时间戳的拷贝/工具改写）
   * 靠它兜住；只有 mtime 一层时那种改写会被静默复用。
   *
   * 缺省 = 提供方未建（消费方退回纯 mtime 判据）；某文件取不到 stat ⇒ 该路径值为 `null`
   * ⇒ 下游对**该文件**退回纯 mtime 判据（与 `fileMtimes` 的保守方向一致，不伪造）。
   */
  readonly fileSizes?: ReadonlyMap<string, number | null>;
  /**
   * 反向引用索引（归一化名 → 定义点与引用点；**additive 可选**，2026-10-15）。
   * 缺省 = 提供方未建（消费方降级），语义同 `functionAt?`。
   */
  readonly references?: ErbReferenceIndex;
  /**
   * **范围戳**（W7 NAV-SCOPE，additive 可选）：这份索引（或这份**派生视图**）是在
   * 哪个"只看"范围下成立的。
   *
   * 为什么盖在索引上而不是让每个消费方自己去判"这个文件属不属于当前范围"：
   * 后者等于把同一条归属判据抄到函数树 / `Ctrl+T` / `Ctrl+P` / 全文检索四遍——
   * 实测那四份早就各抄各的（其中一份按函数名正则、另三份按目录前缀，选定范围后
   * 搜索面板只扫该目录而函数树仍扫全量）。戳只有一个来源（`search.scope` 提供方
   * 给出的 `roots`），过滤只有一个谓词（`pathInScope`，见 `semantic-locate.ts`）。
   *
   * 缺省 = 未收窄（全量）。`roots` 为空数组**同样**是全量——"空范围"不是"什么都不给"，
   * 那是选择器失效时最危险的读法（整棵树空白会被读成"这个项目没有函数"）。
   */
  readonly scope?: ErbScopeStamp;
}

/**
 * 一条"只看"范围的**戳**（W7 NAV-SCOPE）：范围身份 + 它覆盖的位置。
 *
 * `key` 是提供方命名空间化后的稳定标识（宿主与插件都**不理解**它的内容，只拿它比对）；
 * `roots` 是该范围的位置集合（目录或文件，由提供方决定形状）。
 */
export interface ErbScopeStamp {
  readonly key: string;
  readonly roots: readonly string[];
}

/**
 * 「只看」范围变更的**广播事件名**（W7 NAV-SCOPE）：宿主在用户拨动那条选择器时发出，
 * 载荷就是 {@link ErbScopeStamp}（`null` = 回到不限）。
 *
 * 为什么做成常量而不是两侧各写一遍字符串：这条通道连接的是**宿主**与**插件**，
 * 而插件不许 import 宿主——字符串抄两份的话，一侧改名另一侧静默失联，
 * 表现正是这批要根治的那个症状（"选了范围，函数树还是全量"）。
 * 命名空间前缀 `workbench:` = 发起方是壳层（内核事件表之外的自定义事件纪律）。
 */
export const NAV_SCOPE_EVENT = 'workbench:navScopeChanged';

/* ---------------- 候选预算（W7 NAV-SCOPE：四通道一处口径） ---------------- */

/**
 * 检索候选的**显式预算表**（此前四处各写一个裸数字：100 / 200 / 200 / 50，
 * 没人说得清谁是谁的上一档）。分层照旧：
 * - `providerQuery` = 提供方侧的**对象分配**预算（十万条名字不许整份造出来）；
 * - `render` = 宿主侧的 **DOM 行**预算（面板一屏灌不下）；
 * - `quickOpen` = 文件候选预算（快速打开的输入域比符号面板窄）；
 * - `ceiling` = 任何请求方允许的上限（防止"我全都想要"把预算字段变成内存事故）。
 *
 * 预算**不等于丢弃**：被挡掉的条数必须由 `totalMatched` / `hidden` 报给作者（铁律 4）。
 */
export const CANDIDATE_BUDGETS = {
  providerQuery: 200,
  render: 100,
  quickOpen: 50,
  ceiling: 2000,
} as const;

/** 预算档位（消费方按**自己的层**取，不许跨层借用别人的数字） */
export type CandidateBudgetTier = keyof typeof CANDIDATE_BUDGETS;

/**
 * 收窄状态下的**追加倍率**：宿主按范围过滤发生在提供方产出**之后**，
 * 若仍按原预算截断，被截掉的那批里可能有范围外的，范围内的那批反而没进来。
 * 所以带范围查询时向提供方多要 `× SCOPED_QUERY_FACTOR` 条（仍在 `ceiling` 之内）。
 */
export const SCOPED_QUERY_FACTOR = 4;

/**
 * 取一档预算（**唯一**的兜底处）：非有限 / ≤0 的脏输入落回档位值；
 * 超过 `ceiling` 的请求**收到上限**而不是原样放行——预算字段的存在就是为了
 * 挡住"我全都想要"，把它读成"那就给你全都的"等于让一个参数废掉整层保护。
 */
export function candidateBudget(tier: CandidateBudgetTier, requested?: number): number {
  const base = CANDIDATE_BUDGETS[tier];
  if (requested === undefined) return base;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return base;
  const n = Math.trunc(requested);
  if (n <= 0) return base;
  return Math.min(n, CANDIDATE_BUDGETS.ceiling);
}

/**
 * ERB 解析器服务。
 * 纯结构：只看函数边界与声明；不执行、不做变量求值、不解析调用链（那是 replay 的领域）。
 */
export interface ErbParserService {
  /** 解析单个文件（自动处理编码探测，走内核 io） */
  parseFile(path: string): Promise<ErbFile>;
  /** 解析内存文本（测试与预览用；纯函数） */
  parseText(text: string, path?: string): ErbFile;
  /** 扫描若干目录（递归 .ERB/.erb）并构建全局索引 */
  buildIndex(roots: string[]): Promise<ErbIndex>;
  /**
   * 控制流骨架扫描（纯函数）：提取全部控制流语句（含嵌套深度与条件原文）。
   * 供条件抽取、矩阵等消费方使用；不做表达式解析（那是消费方的领域）。
   */
  scanControlFlow(text: string): ControlFlowStatement[];
  /**
   * 同上，但**走计算池的并行通道**（2026-10-12「内核优化」批，additive）。
   *
   * 语义与 `scanControlFlow` 完全一致，只是执行位置可能不在主线程。
   * 给"整批文件扫描"这类消费方用（如条件抽取 ~2,317 文件 / 6.2 s）——
   * **扫描是纯文本变换、无外部依赖，天生的可搬运任务**；单文件场景直接调同步版即可。
   *
   * 分层：可搬运任务由本服务的所有者（erb-parser）注册与分发，消费方**不需要**
   * 知道 kind / worker / 回退的存在（无并行通道时自动内联，行为与同步版一致）。
   */
  scanControlFlowOffloaded(text: string): Promise<ControlFlowStatement[]>;
  /**
   * 索引这一轮的**可查事实**（IDX-STATE，2026-10-19，**additive 可选**）。
   *
   * 补的是 `currentIndex()` 兜不住的那一面：它只能答"有没有索引"，答不出
   * "为什么没有 / 扫了哪几个位置 / 这一轮是不是少扫了一类位置"。铁律 4 要求
   * inactive 可见，而"读不到工作区根"此前只有一声 console `warn`，作者侧零落点。
   *
   * 同步、纯数据、**不读盘**：返回提供方在自己时机里记下的那一份，绝不在这里现算
   * 形状判据（消费方也不许替它算——见 {@link ErbIndexState.coverage}）。
   *
   * **可选**：既有实现不提供时消费方退化成它原来的等待文案（契约演进的 additive 纪律，
   * 同 `checkStructure?` / `functionAt?`），旧消费方零改动。
   */
  indexState?(): ErbIndexState;
  /**
   * 跨轮保留的**解码后快照**（MEM 批的量测面，**additive 可选**，2026-10-29）。
   *
   * 只服务内存归因：这份对象是热载路径上最大的一块常驻（插件靠它做增量合并），
   * 但它在实现里是构建函数的局部量，外面只能靠"索引总量 − byName"倒推。
   * 纯读、不触发懒还原、不读盘；`null` = 当前没有保留（未开项目 / 已关）。
   * 消费方**不应**拿它做业务判断——它不是索引，形状随实现版本变。
   */
  snapshotForDebug?(): { readonly entries: Readonly<Record<string, unknown>> } | null;
  /**
   * 上面那份快照的**结构普查**（同批，additive 可选）：条目数、函数数、名字/注释字符数、
   * 引用条数、候选集字符数。纯读，用来回答"这 100+ MB 到底挂在元组还是候选集上"。
   */
  snapshotStatsForDebug?(): {
    entries: number;
    lazyShells: number;
    materialized: number;
    textLength: number;
    functions: number;
    dims: number;
    refs: number;
    labels: number;
    nameChars: number;
    docChars: number;
    /** 候选记号**哈希**枚数合计（v12 起；每枚 4 B） */
    candidateHashes: number;
    candidatesKnown: number;
    withRefs: number;
  } | null;
  /**
   * 结构体检（2026-10-13 UI 反馈 7，**additive 可选**）：配对失败的三类可证明错误。
   *
   * 与 `scanControlFlow` 的分工：那张表是骨架（算深度、抽条件），这一份是"配不上对"的证据。
   * 两者共用 `erb-parser/scanner.ts` 的同一份配对表与同一套行过滤规则，所以不会出现
   * "波浪线指的行骨架里没有"。纯文本入、纯数据出（编辑器每 250ms 去抖后调一次，不能读盘）。
   *
   * **`path` 是 additive 的可选第二参**（2026-10-26 A4）：不传 = 与旧语义逐字相同
   * （配对 + 预处理块 + 声明面两类），传了才按**文件种类**多跑一趟——目前只有 `.erh`
   * 有专属判据（`erh-invalid`：头文件只允许 `#DIM` / `#DIMS` / `#DEFINE`）。
   *
   * 为什么不另开一个 `checkHeader?(text)`：宿主只认"这一份文本有什么问题"这一个答案，
   * 按文件种类分派是自己这层的事；多一个方法就把"该调哪个"变成每个调用方的知识，
   * 漏调的表现是"头文件里写错一行，编辑器一声不响"——而那正是这条规则要防的事故。
   * 为什么是可选而不是必填：老实现与测试替身不该为一次加派陪跑（契约演进的 additive
   * 纪律，HANDOFF §十一）；提供方缺省时行为与从前一致。
   *
   * **为什么是可选**：波浪线是新增能力，缺了它编辑器只是不出提示（= 现状），
   * 不该逼着所有实现者同批改完——契约演进的 additive 纪律（HANDOFF §十一）。
   * 消费方（`ui.editor.decorator` 贡献者）必须在方法缺席时返回空装饰。
   */
  checkStructure?(text: string, path?: string): ErbStructureIssue[];
  /**
   * 当前已构建的索引（未构建 / 未打开项目时为 null）。
   * 解析器订阅 `project.opened` 自动构建并在完成后发 `kojo.functionChanged`，
   * 消费方（函数树、校验器）订阅事件按需刷新。
   */
  currentIndex(): ErbIndex | null;
  /** 取当前索引；未构建则触发构建（若已有在途构建则等待它完成） */
  ensureIndex(): Promise<ErbIndex>;
  /**
   * 重建当前索引（**additive 可选**，2026-10-27 重命名迁移批）。
   *
   * 与 `ensureIndex()` 的差别只有一条：**已有索引也重扫**。盘上事实变了（目录/文件改名、
   * 外部搬迁）之后，索引里的旧路径不会自己消失——函数树 / 引用面板会留下指向旧路径的
   * 幽灵行。宿主在盘上收尾时刻调一次，索引就跟上盘上的新路径。
   *
   * 口径：无项目 ⇒ reject（与 `ensureIndex` 同口径，别悄悄返回空索引）；实现方必须走
   * 既有构建通道（含快照复用 / 代际作废 / `kojo.functionChanged` 广播），不另造扫描循环。
   *
   * **可选**：旧实现不提供时消费方跳过（契约演进的 additive 纪律），下一次自然重建
   * 仍会跟上——缺了它只是旧路径多活一会儿，不是数据错误。
   */
  rebuildIndex?(): Promise<ErbIndex>;
  /**
   * 盘上**增量**更新索引（**additive 可选**，WS-05，2026-10-27）。
   *
   * 补的是"文件增删改名 / 保存之后，索引要立刻跟上"这条腿：`rebuildIndex()` 是整树重扫
   * （walk + 逐文件 stat），给每次保存都来一遍等于拿整项目的代价换一份文件的改动。
   *
   * 语义（提供方契约）：
   * - `changed` = 新增或内容变了的**文件**路径（实现方只在该路径落在当前扫描根内、
   *   且是方言扩展名时读它；其余忽略，不算失败）；
   * - `removed` = 移除的路径，**目录按前缀整体移除**其下已索引条目；
   * - 返回新索引（`currentIndex()` 立刻换成它）并广播 `kojo.functionChanged`；
   * - **无索引 ⇒ 返回 null**（不凭空造一份"只有这几个文件"的索引）；
   * - 读 / 解析失败等无法增量收尾的情形，实现方必须**回退出既有整扫通道**
   *   （`rebuildIndex` 那条），并把原因记进日志——不许静默留下一份半新半旧的索引。
   *
   * 派生面的保守口径（允许实现方自行取舍并记录在案）：**`references`（反向引用）
   * 不保证随增量更新**——实现方可以把它标成不可用（下一次整扫恢复），因为复用旧引用边
   * 会给"查找引用"答一份与当前正文不符的名单，那比"暂不可用"坏得多。
   *
   * **可选**：旧实现不提供时消费方跳过（契约演进的 additive 纪律，同 `rebuildIndex?`）。
   */
  applyFileChanges?(input: {
    readonly changed: readonly string[];
    readonly removed: readonly string[];
  }): Promise<ErbIndex | null>;
  /**
   * 位置 → 符号反查（additive，2026-10-15 语言服务批）：返回**包围该行**的函数定义。
   *
   * 这是 definition / hover / highlight 三类语言智能的共同前置——"我此刻在哪个
   * 函数里"必须由解析器的索引回答（消费方各扫一遍文本必然与索引漂移）。
   *
   * 纯函数、**不读盘**：只读当前已构建的索引（未构建 → undefined）。
   * 边界口径见 `erb-parser/symbols.ts`，一句话：越界/空文件/不在任何函数体内
   * 一律 undefined，**不夹取**（静默夹取会把"行号过期"伪装成"命中旁边那个函数"）。
   *
   * **可选**：既有实现不提供时消费方自行降级（契约演进的 additive 纪律，
   * 同 `checkStructure?`）；提供方须与索引同时生效。
   */
  functionAt?(path: string, line: number): ErbFunction | undefined;

  /**
   * 谁引用了 `name`（**additive 可选**，2026-10-15 反向索引批）：定义点与引用点全集，
   * 按构建序 → 行 → 列确定排序。`name` 原样 / 大写均可（内部归一）。
   *
   * 与 `functionAt` 同纪律：只读已构建索引、**不读盘**；未构建或名字无记录 → 空数组。
   * find-references / rename 的唯一前置；口径（什么算引用）见 {@link ErbReference.kind}。
   */
  referencesTo?(name: string): ErbReference[];
}

/* ---------------- 反向引用索引（2026-10-15 批，全部 additive） ---------------- */

/** 引用点种类（口径详注见 {@link ErbReference.kind}） */
export type ErbReferenceKind = 'definition' | 'call' | 'mention';

/** 函数名的一处出现（1 基行列；`endColumn` 为不含端点，与 {@link SymbolToken} 同口径） */
export interface ErbReference {
  /** 出现所在文件（索引的方言文件路径，绝对路径） */
  filePath: string;
  /** 行号（1 基） */
  line: number;
  /** 起始列（1 基，指向名字首字符） */
  column: number;
  /** 结束列（不含端点 = column + 名字长度） */
  endColumn: number;
  /**
   * - `definition`：`@NAME` 定义行**自身**的名字（rename 必须连定义一起改，故入表；
   *   find-references 消费方按需过滤）；
   * - `call`：行首关键字是 CALL 直系族（CALL / TRYCALL / TRYCCALL / TRYCALLLIST /
   *   TRYCCALLLIST）时，关键字后**紧邻的第一个记号**且命中索引名——这是名字出现在
   *   引擎"按名调用"语法位上的可证明子集；
   * - `mention`：其余任何可见代码记号整串等于某个索引名（表达式函数调用、条件、
   *   PRINT 实参……）。
   *
   * **不算引用**（口径与 `scanControlFlow` 的屏蔽面一致，实现见 `erb-parser/references.ts`）：
   * 注释（整行 `;` 与行内 `;` 尾巴——改名不该重写散文，find-references 也不想看注释）、
   * 字符串字面量**内容**（数据而非符号）、`[SKIPSTART]…[SKIPEND]` 死代码段（引擎根本不编译，
   * 指过去会误导）、`#DIM` / `$label` 行（声明的是变量与标签，不是函数）、
   * 变量成员访问（`:` / `：` 紧邻的记号两段都不算——`CFLAG:ALPHA`、`ALPHA:CFLAG` 都是变量世界）。
   * 记号字符集 = Unicode 字母/数字/下划线（真语料 21% 的函数名含 CJK，ASCII 集会静默漏两成）；
   * 定义名按解析器终止符口径（`(` / 空白 / `;`）截，与 `@` 头解析同源。
   * **已知排除**：`JUMP`/`GOTO` 目标与 `*CALLFORM` 参数——前者的目标是行号/标签而非函数名；
   * 后者的参数是表达式（裸记号在那里是变量），要正确解析得做数据流，超出"可证明正确"边界，
   * 宁可少报不误报。
   */
  kind: ErbReferenceKind;
}

/** 项目级反向引用索引（只由构建产出，查询不改变它） */
export interface ErbReferenceIndex {
  /** 归一化函数名 → 该名的定义点与引用点全集（构建序 → 行 → 列，确定排序） */
  bySymbol: ReadonlyMap<string, readonly ErbReference[]>;
}

/* ---------------- 索引状态事实（IDX-STATE 2026-10-19，全部 additive） ---------------- */

/**
 * 扫描根的**来源种类**（契约层只有这两个泛型词，零游戏名词）。
 * 事实面按来源逐条陈述 ⇒ "少扫了哪一类位置"是读出来的，不是猜出来的。
 */
export type ErbScanSourceKind = 'project' | 'workspace';

/** 一类来源本轮的事实（提供方读到什么就写什么，读不到也**把"读不到"写成事实**） */
export interface ErbScanSourceFact {
  readonly source: ErbScanSourceKind;
  /** 本轮该来源**交出**的根条数（读不到 ⇒ 0；这一寸就是"少了什么"的读数） */
  readonly offered: number;
  /** 该来源本轮是否读得到：服务键缺席 / `roots()` 自己抛 ⇒ false */
  readonly available: boolean;
  /** 读不到时的原始原因（逐字进悬停 `title`，不当第一眼文案） */
  readonly reason?: string;
}

/**
 * 一个**走到、但没进索引**的方言文件的失败事实（IDX-SILENT，2026-10-20，additive）。
 *
 * 与 `ErbIndex.fileMtimes` 的 `null` 位分工：那里说"这个文件取不到 stat"（下游复用判据），
 * 这里说"这个文件这一轮没有可用的解析结果"（作者面的失败事实）。
 */
export interface ErbIndexFileFailure {
  /** walk 交出的原样路径（与 `filesScanned` 数的是同一批文件） */
  readonly path: string;
  /**
   * - `read`：正文没读到（打开 / 解码失败，或批量读交回的缺席位）；
   * - `parse`：正文读到了、解析抛错。
   */
  readonly reason: 'read' | 'parse';
}

/**
 * 索引这一轮走到哪一步（**可查的裁决**，取代"永远不变的占位文案"）：
 * - `idle`：还没扫（没有项目 / 从未起跑过构建）；
 * - `scanning`：正在扫（`filesScanned` 是已扫文件数的进度读数）；
 * - `ready`：扫完了，名录非空；
 * - `nothing-to-scan`：**没有任何可扫描的位置**（本轮一个根都没走到）；
 * - `empty`：**位置走到了、也扫了，名录里确实一个函数都没有**；
 * - `failed`：构建抛错（原因原文在 {@link ErbIndexState.error}）。
 *
 * `nothing-to-scan` 与 `empty` 是两条**不同的事实**（"没地方可扫" ≠ "扫了什么都没有"），
 * 而这一刀由**提供方**判（`erb-parser/index-state.ts` 的 `phaseOf()`）：消费方只许按
 * phase 查文案，不许自己拿 `roots`/`functions` 的条数再裁一次——那是第二份真相，
 * 由 `ui-kojo-navigator/tests/index-state-single-source.test.ts` 按处数守死。
 */
export type ErbIndexPhase = 'idle' | 'scanning' | 'ready' | 'nothing-to-scan' | 'empty' | 'failed';

/**
 * 覆盖形状 = **降级与成功不同形**的那一枚事实。
 * - `full`：每一类位置本轮都读到了，且至少走到了一个根；
 * - `partial`：**至少一类位置本轮读不到**（典型：工作区根缺席 ⇒ 这棵树只由口上根建成）；
 * - `none`：本轮一个位置都没走到（无根可扫）。
 *
 * 判据只住提供方那一枚函数（`erb-parser/index-state.ts` 的 `coverageOf()`）：
 * 消费方再写一次 `roots.length === 0` 之类的形状比较就是第二份真相，由
 * `ui-kojo-navigator/tests/index-state-single-source.test.ts` 按处数守死。
 */
export type ErbIndexCoverage = 'full' | 'partial' | 'none';

/** 索引的对外事实（纯数据：字段全部由提供方在自己时机里记下，取用不改变它） */
export interface ErbIndexState {
  readonly phase: ErbIndexPhase;
  /** 逐来源事实（条数 = 提供方陈述的来源种类数；顺序固定 project 在前） */
  readonly sources: readonly ErbScanSourceFact[];
  /** 本轮**实际去遍历**的根数（去重折叠之后 ⇒ 与"谁交了几条"是两回事，都能读出来） */
  readonly rootsWalked: number;
  /** 已扫到的方言文件数：`scanning` 期间是进度，收尾后是总数 */
  readonly filesScanned: number;
  /**
   * 名录里的**归一化名字**条数（= `ErbIndex.byName` 的键数；与"定义条数"相差的那些
   * 是同名多定义 —— 两个数不是同一个戳，本字段只交前者）。
   * `ready` 之后才有意义；其余阶段照实记当前值（聚合前就是 0，不猜）。
   */
  readonly functions: number;
  /** 覆盖形状（判据见 {@link ErbIndexCoverage}） */
  readonly coverage: ErbIndexCoverage;
  /**
   * 本轮**走到、但没读进来 / 没解析出来**的文件数（IDX-SILENT，2026-10-20，**additive 可选**）。
   *
   * 为什么需要它：这类文件通常既不进 `index.files`、也不进 `byName`，此前只有一声 console `warn`；
   * 唯一能推断的信号是 `filesScanned − index.files.size`，而那条差**答不出"是哪个文件"**，
   * 也**看不全**：上一轮快照顶替过的文件这一轮同样没读成，但旧内容补进了 `index.files`
   * ⇒ 差仍是 0，与全成功**同形**（铁律 4 的静默降级）。
   *
   * 口径三条：
   * - 分母是 **walk 交出的方言文件**（与 {@link filesScanned} 同一批）；读失败与解析抛错都算，
   *   每个文件至多计一次（读都没成，谈不上解析）。
   * - 被快照旧内容顶替的**也计**：它这一轮确实没读成，索引里那份是旧事实。
   * - **失败 ≠ 没有这个文件**：某个名字在索引里查不到时，"这一轮读/解析失败"与
   *   "这个来源的根下根本没有它"必须分得开——前者从本字段读得出来，不许被当成后者。
   *   反向引用那一段的重读失败（`Refs scan skipped`）**不算**在这里：那些文件解析成功、
   *   只是引用表少边，属于另一张事实面。
   *
   * **缺席 = 提供方没陈述**（旧实现 / 手写的测试字面量），消费方**不许**把缺席读成 0。
   */
  readonly filesFailed?: number;
  /**
   * 失败文件的**前若干条**路径与原因（完整条数见 {@link filesFailed}；两处同一份来源，
   * 条数只从列表长度派生）。只给样本：磁盘级故障会让全树失败，契约面不该为此搬一整张路径表。
   * 本轮没有失败 ⇒ **不写空数组**（同 `docComment` / `error` 的缺省纪律）。
   */
  readonly failures?: readonly ErbIndexFileFailure[];
  /** 构建失败的原始原因（只进悬停，一条技术信息都不丢） */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// 预处理器 `[...]` 标记（语言事实的唯一落点）
// ---------------------------------------------------------------------------

/**
 * 预处理器条件块的三种角色。
 *
 * `[IF …]` / `[IF_DEBUG]` / `[IF_NDEBUG]` 开块，`[ELSEIF …]` / `[ELSE]` 分支，`[ENDIF]` 收束
 * ——三个开块形共用一枚 `[ENDIF]`（引擎按"宏是否 #DEFINE / 是否调试模式"裁剪），所以配对
 * 按**开块族**认，不做词一一映射。
 */
export type ErbPreprocRole = 'open' | 'branch' | 'close';

/**
 * 三张**整行严格等值**正则（允许尾随空白）——ERB 预处理器标记的唯一真源。
 *
 * 判据两条，都是实测逼出来的：
 * - **严格等值**：整行只有标记才认。宁可漏认一行，也不要把 ASCII 画里的方括号行当块边界
 *   （与 `[SKIPSTART]` 同一条纪律）。
 * - **大小写不敏感**（`i` 标志）：同一份语料里 `[IF_DEBUG]`（41 行）与 `[IF DEBUG]`（40 行）
 *   并存，预处理器命令本身不区分大小写。
 *
 * 本表落地前，这份事实存在**三处副本**：`erb-parser/src/structure.ts` 的 `PREPROC_*`、
 * `erb-syntax-tree/src/index.ts` 的 `PREPROC_*`、以及显示层**根本没有**（`[IF_DEBUG]` 整行白字、
 * `[IF x]` 里的 `IF` 反被当成 ERB 控制词着色、`[` 位补全只有 SKIP 两枚）。三处副本靠对拍表钉住
 * 只能防漂移，防不了"第三处从来没写"——现在显示层与结构层都从这里派生，写一处即处处。
 *
 * 消费面：结构体检（`erb-parser/src/structure.ts`）、CST 折叠（`erb-syntax-tree` 走
 * `structure.json` 的构建期投影，文法侧不吃运行期 import）、Monarch 着色与 `[` 位补全
 * （`packages/app/src/monaco/`）。正则**无 `g` 标志**，`test()` 无状态，可安全共享。
 */
export const ERB_PREPROC_PATTERNS: Readonly<Record<ErbPreprocRole, RegExp>> = Object.freeze({
  open: /^\[(?:IF\s+[^\]]*\S|IF_DEBUG|IF_NDEBUG)\]\s*$/i,
  branch: /^\[(?:ELSEIF\s+[^\]]*\S|ELSE)\]\s*$/i,
  close: /^\[ENDIF\]\s*$/i,
});

/**
 * `[` 行的预处理器角色；不是预处理器标记 ⇒ `null`。
 *
 * 判定顺序固定为 **close → branch → open**（与两枚原实现逐字同序：`[ENDIF]` 里的 `IF` 形态
 * 不参与匹配，但顺序换了会给将来的 `IFEND` 一类新词留出踩脚面）。
 */
export function erbPreprocRoleOf(lineText: string): ErbPreprocRole | null {
  const text = lineText.trim();
  if (ERB_PREPROC_PATTERNS.close.test(text)) return 'close';
  if (ERB_PREPROC_PATTERNS.branch.test(text)) return 'branch';
  if (ERB_PREPROC_PATTERNS.open.test(text)) return 'open';
  return null;
}

/** 一条 `[` 位补全候选：`label` 是上屏文本，`needsArgument` 标记"作者还得补一段"的骨架形 */
export interface ErbPreprocCandidate {
  readonly label: string;
  readonly role: ErbPreprocRole;
  readonly needsArgument: boolean;
}

/**
 * `[` 行的**补全候选表**（由 {@link ERB_PREPROC_PATTERNS} 的同一批词形导出，显示层不再手抄）。
 *
 * `[IF ` / `[ELSEIF ` 带尾随空格 = 骨架形：这两枚标记**必须**带条件表达式才成块，
 * 补全插入后作者直接写条件即可（严格等值判据意味着裸 `[IF]` 不是开块标记，不能给）。
 */
export const ERB_PREPROC_CANDIDATES: readonly ErbPreprocCandidate[] = Object.freeze([
  { label: '[IF ', role: 'open', needsArgument: true },
  { label: '[IF_DEBUG]', role: 'open', needsArgument: false },
  { label: '[IF_NDEBUG]', role: 'open', needsArgument: false },
  { label: '[ELSEIF ', role: 'branch', needsArgument: true },
  { label: '[ELSE]', role: 'branch', needsArgument: false },
  { label: '[ENDIF]', role: 'close', needsArgument: false },
]);

/**
 * 停用区标记（`[SKIPSTART]`…`[SKIPEND]`，区间内原文引擎不编译）。
 *
 * 与预处理器条件块同属"`[` 起手的整行严格等值标记"，故并列在同一份真源里：显示层
 * （Monarch 的两条 SKIP 规则 + `[` 位补全）与结构层（scanner 的 `trimmed === '[SKIPSTART]'`）
 * 从此共用同一条字符串，改一处不会只改到一半。
 */
export const ERB_SKIP_MARKERS: Readonly<{ start: string; end: string }> = Object.freeze({
  start: '[SKIPSTART]',
  end: '[SKIPEND]',
});

// ---------------------------------------------------------------------------
// `{` … `}` 行连接（语言事实的唯一落点）
// ---------------------------------------------------------------------------

/**
 * 行连接的两个标记字符（Emuera `EraStreamReader.ReadEnabledLine` 的 line-continuation）。
 *
 * ## 语言事实
 *
 * **整行只有 `{`** 的那一行是"行连接开始"，**整行只有 `}`** 的是收束；两者之间的物理行
 * 在引擎里被拼成**一条逻辑行**（`{` 与 `}` 本身不进正文）。所以它改变的是**行数语义**：
 * `IF A &&` / `B` 两行是"半句 + 半句"，拼起来才是引擎看到的那条语句。
 *
 * 严格等值（`trim` 之后逐字等于标记）是引擎侧的实际判据，也是这里的判据：
 * `{ 1, 2 }` 这类行内花括号是 FORM 插值，**不是**行连接；ASCII 画里落单的 `{`
 * 若按"行首是 `{` 就算"判，会把整段画吞成一条语句。
 *
 * **不剥代码前缀**（与 `[SKIPSTART]` 那类判据不同）：引擎在 `{` 分支里判的是
 * `line.Trim() != "{"`——对**整行**比。所以 `;!;{` 不成立行连接，它会走
 * `CharacterAfterContinuation` 直接报错。宽容一档就会把"引擎拒绝加载的行"在我们这边
 * 静默拼成合法逻辑行，作者永远看不到那条错。
 *
 * ## 为什么住在 `plugin-api`
 *
 * 这条判据至少有三处消费面，且分属**两个插件 + 一个语言包**：
 * 结构体检的头文件形态（`erb-parser/src/erh.ts`）、条件抽取的多行条件拼接
 * （`condition-extractor/src/extract.ts::joinBracedExpression`）、语法树的 CST 块
 * （`erb-syntax-tree/grammar.js`）。插件之间禁止互相 import（解耦审计 C 项），语言包不许
 * 依赖插件，所以**只有契约层能同时被三方引用**——与 `[SKIPSTART]` / 预处理三枚正则住在
 * 同一层的理由完全相同（PITFALLS 211 那条纪律）。
 *
 * 本表落地前，这条判据在 `condition-extractor` 与 `erb-parser` 里**各写了一份**
 * （`trim() === '{'` / `body === '{'`，且两处的拼接分隔符**还不一样**：`join(' ')` 与
 * `join('')`），`erb-syntax-tree` 侧则根本没有（`{` 只当普通语句行）。第三处不是漂移，
 * 是"从来没写"——与 PITFALLS 216 同族。
 */
export const ERB_CONTINUATION_MARKERS: Readonly<{ open: string; close: string }> = Object.freeze({
  open: '{',
  close: '}',
});

/**
 * 行连接块内各物理行之间的**替换串**（引擎：`Config.ReplaceContinuationBR`）。
 *
 * 引擎原文是 `b.Append(line); b.Append(Config.ReplaceContinuationBR.Replace("\"", ""));`——
 * 配置项默认值在 `ConfigData.setDefault()` 里写的是 `"\" \""`（引号 + 空格 + 引号），
 * 去引号后就是**一个半角空格**。所以"两行直拼"（`join('')`）不是引擎行为：
 * `LOCAL` / `1` 两行会拼成 `LOCAL1` 这种不存在的名字，而引擎看到的是 `LOCAL 1`。
 */
export const ERB_CONTINUATION_SEPARATOR = ' ';

/** 行连接标记的角色：开始 / 收束 */
export type ErbContinuationRole = 'open' | 'close';

/**
 * 一行的行连接角色；不是标记行 ⇒ `null`。
 *
 * **严格等值**：`trim` 之后整行必须恰好是那一个字符。`{ 1, 2 }` 是 FORM 插值，
 * `;!;{` 是引擎会报 `CharacterAfterContinuation` 的坏行，两者都不是行连接。
 */
export function erbContinuationRoleOf(lineText: string): ErbContinuationRole | null {
  const text = lineText.trim();
  if (text === ERB_CONTINUATION_MARKERS.open) return 'open';
  if (text === ERB_CONTINUATION_MARKERS.close) return 'close';
  return null;
}

/**
 * 把 `{`…`}` 之间的物理行拼成引擎看到的那**一条**逻辑行。
 *
 * 逐行原样拼接、行间补 {@link ERB_CONTINUATION_SEPARATOR}（空行也占一格，与引擎
 * 无条件 `Append` 一致）。末尾不补分隔符——调用方一律 `trim()` 后使用，差一个尾随空格
 * 不影响判据。
 *
 * **不做的事**：不剥 `;` 注释、不解释字符串。块内出现 `;` 时引擎会在合并后的单行流上
 * 走 `SkipWhiteSpace` 的 `Seek(End)`，**把整条逻辑行的剩余部分全注释掉**；那是"判据该
 * 看到的文本"层面的语义，不是拼接层面的，本函数只管拼。
 */
export function erbContinuationJoin(lines: readonly string[]): string {
  return lines.join(ERB_CONTINUATION_SEPARATOR);
}



/* ============ 引擎保留标识符（LAU-D2 外提，2026-10-27；erb-parser 诊断的唯一词表来源） ============ */

/**
 * **引擎保留标识符**：任何 era 系作品都不需要 `#DIM` 的名字（族头 / 内置标量 / 系统变量）。
 *
 * ## 为什么住契约包
 * 唯一消费方 `@kojo/plugin-erb-parser` 的未定义名诊断**不许自带词表**（语言面零引擎名词），
 * 而插件只许依赖 `@kojo/plugin-api`（铁律 2）；词表的另一份（着色显示层
 * `ENGINE_VARIABLE_REFERENCE_HEADS`）在 `@kojo/kojo-vocab/engine`，宿主侧消费、与这里同口径
 * 但**消费面不同**（那张收"要着色的族头形"，这张收"永远有定义的名字"）。两边的交集是刻意的，
 * 各自只有一份定义。
 *
 * ## 迁移原件（逐枚原样、零增删）
 * = `erb-parser/src/undefined-name.ts` 的两张表（`ERB_KEYWORD_LIST` 的引擎成员 +
 * `ENGINE_BUILTIN_NAMES` 全表）。依据是引擎语法事实而不是某部作品：`TALENT` / `ITEM` /
 * `EQUIP` / `ABL` / `EXP` 等是 `GETNUM(<変数族>, …)` 第一参的族头（写全名即是合法写法）；
 * `NOITEM` / `TEQUIP` / `FLAG` / `TCVAR` / `NOWEX` / `STAIN` 等是内置标量 / 数组；
 * `GAMEBASE_*` 是系统变量。语料实测（eraTW 4.980，4,385 份 `.erb`）这批名字贡献约 440 条
 * 误报——它们从未有过 `#DIM` 声明，却永远有定义。
 *
 * **只收实测出现过 / 引擎语法点名的名字**（不抄整张 Emuera 变量表）：多收一个就可能掩盖
 * 作者对同名用户变量的真实拼写错误。
 */
/**
 * ERB 行首 / 槽位判据的**空白字符类**（源码串，不含外层方括号）——`\t` / 半角空格 /
 * U+3000 全角空格三种，**不是** JS 的 `\s`（NBSP 不算空白）。
 *
 * ## 为什么在契约层再落一枚
 *
 * 同一份口径此前只有一处落点：`@kojo/kojo-lang/completion` 的 `BLANK_CLASS_STR`（未盘
 * 层 lexer、`.kojo` / `.erb` 两条宿主补全位置判据共用）。LAU-4 补全腿把 ERB 的位置门
 * 搬进常驻解析器插件之后，**插件读不到 `@kojo/kojo-lang/completion`**（静态引它会把整个
 * 2.0 补全词表链拉上首屏，实测 +6 文件 / +113 KB），而插件读得到契约层。
 *
 * 处置按"同一事实、两个分层落点、由测试钉死相等"办：ERB 侧一律用本枚，`.kojo` 侧继续用
 * `BLANK_CLASS_STR`，`packages/plugins/erb-parser/tests/completion-lexical.test.ts` 逐字符
 * 断言两枚接受同一字符集——谁改了其中一处都会当场红。**不许在任何 ERB 判据里再手写
 * `[ \t]`**（PITFALLS 里那四套手抄写法就是这么长出来的）。
 */
export const ERB_BLANK_CLASS_STR = '\\t \\u3000';

/** 由 {@link ERB_BLANK_CLASS_STR} 派生的**空格判定**（无 `g` 标志 ⇒ `.test` 无状态） */
export const ERB_BLANK_RE: RegExp = new RegExp(`[${ERB_BLANK_CLASS_STR}]`);

/** 单字符是否 ERB 空白（口径见 {@link ERB_BLANK_CLASS_STR}） */
export function isErbBlank(ch: string): boolean {
  return ch.length === 1 && ERB_BLANK_RE.test(ch);
}

/** 整段是否**全空白**（空串为真；行首判据用） */
export function isAllErbBlank(text: string): boolean {
  for (const ch of text) if (!isErbBlank(ch)) return false;
  return true;
}

export const ERB_ENGINE_RESERVED_IDENTIFIERS: readonly string[] = [
  // —— 调用协议槽 / 作用域标量 / 引擎时间与循环量 ——
  'ARG',
  'ARGS',
  'RESULT',
  'RESULTS',
  'ASSI',
  'ASSIPLAY',
  'MASTER',
  'TARGET',
  'PLAYER',
  'DAY',
  'TIME',
  'MONEY',
  'NOW',
  'CHARANUM',
  'LINECOUNT',
  'SELECTCOM',
  'PREVCOM',
  'STR',
  'NAME',
  'CALLNAME',
  'MASTERNAME',
  'TRAINNAME',
  'BASE',
  'MAXBASE',
  // —— 变量族头（`GETNUM/CSV*` 第一参、也可直接带 `:` 索引）——
  'ABL',
  'CFLAG',
  'CDFLAG',
  'EQUIP',
  'EX', // `EXP` 族的 Emuera 别名（语料 1,740 处 `EX:…`，全无 #DIM）
  'EXP',
  'FLAG',
  'JUEL',
  'MARK',
  'NOWEX',
  'PALAM',
  'SOURCE',
  'STAIN',
  'TALENT',
  'TCVAR',
  'TEQUIP',
  'TFLAG',
  // —— 内置标量 / 数组 / 系统变量 ——
  'BASENAME',
  'DRAWLINESTR',
  'EQUIPNAME',
  'ABLNAME',
  'EXPNAME',
  'GAMEBASE_TITLE',
  'GAMEBASE_VERSION',
  'ITEM',
  'NICKNAME',
  'NO',
  'NOITEM',
  'RAND',
];

/**
 * **字符串型引擎伪变量**：赋值右侧可以是无引号文本，整行不扫（未定义名诊断的行为判据）。
 *
 * 语料实证（eraTW 4.980）：`ARGS = 共通` / `STR:16 = 破旧小屋` / `TSTR:1 = 科技蓝白呼吸`
 * 这类写法有 150+ 处——右侧的裸词是作者写的**文本**，不是变量引用。`CSTR` 是同一族里
 * 过去以字面量形式直接写在诊断规则里的唯一一枚，本批一并归队（零增删）。
 */
export const ERB_ENGINE_STRING_IDENTIFIERS: readonly string[] = [
  'ARGS',
  'CALLNAME',
  'CSTR',
  'MASTERNAME',
  'NAME',
  'NICKNAME',
  'RESULTS',
  'SAVESTR',
  'STR',
  'TRAINNAME',
  'TSTR',
];

/**
 * `ErbIndex.byName` 的**列式查找表**（MEM-19，2026-10-30）。
 *
 * ## 为什么不是 `Map<string, ErbFunctionRef[]>`
 *
 * MEM-9 在真实语料上量过三条路线（`erb-parser/src/snapshot.ts` 的注释留了读数）：
 * 条件展开 33.2 MB / 固定形状字面量 35.7 MB / 四种形状各写一条 32.8 MB —— 改**对象形状**
 * 没有任何收益。311 B/条的成本来自结构本身：11 万枚对象 + 11 万枚 1 元素数组 +
 * 11 万条 Map 项 + 11 万条大写名串。
 *
 * 而真实语料 **110,049 个名字里 110,043 个只有一条定义**：数组与对象几乎全是"一条一建"。
 * 所以这里改成列式：名字 → `[起点, 条数]`（两枚 `Uint32Array`），每条定义只占
 * 六个机器字（文件序号 / 名字池序号 / 起止行 / 名字列 / 注释序号），**`ErbFunctionRef`
 * 对象与数组一律按需构造**。稳态省掉的是"常驻对象"，不是"字段"。
 *
 * ## 语义必须与旧形态逐位一致
 *
 * - `keys()` 的迭代顺序 = 聚合顺序里**归一化名首次出现**的顺序（旧 `Map` 的插入序）；
 * - 同名多定义的组内顺序 = 聚合顺序（旧数组的 push 序）；
 * - `firstOf` = 旧写法 `byName.get(name)?.[0]`；`defsOf` = 旧写法 `byName.get(name) ?? []`；
 * - `has` / `countOf` / `size` 一律不构造对象。
 *
 * ## 构造入口只有两条
 *
 * - {@link buildFunctionLookup}：生产侧（`aggregateIndex` / 派生视图）走**回调式喂数**，
 *   不要求入参已经物化成 `ErbFunction[]`（快照懒外壳正是靠这一点才不用为了建索引
 *   把每文件的函数对象全部还原，见 `erb-parser/snapshot.ts` 的 `forEachFn` 纪律）；
 * - {@link functionLookupOf}：测试与"手里已经有一张 Map"的调用方（mock / 小表）用。
 */

/** 构造 `ErbFunctionLookup` 时逐条喂进来的定义事实（字段口径同 {@link ErbFunctionRef}）。 */
/** 构造 `ErbFunctionLookup` 时逐条喂进来的定义事实（字段口径同 `ErbFunctionRef`）。 */
export interface ErbFunctionDef {
  /** 原样拼写（大小写按源文件） */
  readonly name: string;
  /** 归一化名（大写）；**它就是查找键**，调用方负责算好（`name.toUpperCase()`） */
  readonly normalizedName: string;
  /** 定义所在文件（绝对路径） */
  readonly filePath: string;
  /** 定义行（1 基） */
  readonly startLine: number;
  /** 函数体结束行（1 基，含） */
  readonly endLine: number;
  /** 名字起点列；`undefined` / `null` = 没有这个事实（构造 ref 时不挂该属性） */
  readonly nameColumn?: number | null;
  /** 注释块；非字符串 = 没有这个事实（构造 ref 时不挂该属性） */
  readonly docComment?: string | null;
}

/**
 * 归一化名 → 定义列表的只读查找表（`ErbIndex.byName` 的形态）。
 *
 * 与 `ReadonlyMap<string, ErbFunctionRef[]>` 的对应关系见文件头：读法一一对应，
 * 只是 `get` 拆成 `firstOf`（只看首条）/ `defsOf`（要全部，会构造数组）/
 * `forEachDef`（只要遍历，不建数组）。
 */
export interface ErbFunctionLookup {
  /** 名字条数（= 旧 `Map.size`；不是定义条数） */
  readonly size: number;
  /** 该归一化名是否有定义（不构造对象） */
  has(normalizedName: string): boolean;
  /** 该归一化名的定义条数（不构造对象）；无定义 = 0 */
  countOf(normalizedName: string): number;
  /** 第一条定义（聚合顺序第一枚）；无定义 = `undefined` */
  firstOf(normalizedName: string): ErbFunctionRef | undefined;
  /** 全部定义（聚合顺序）；无定义 = 空数组。**每次调用新建**，别在热路径里反复调 */
  defsOf(normalizedName: string): ErbFunctionRef[];
  /** 归一化名，按首次出现顺序 */
  keys(): IterableIterator<string>;
  /** 逐名字吐出定义数组（顺序同 {@link keys}）——给"必须按组处理"的旧消费方 */
  values(): IterableIterator<ErbFunctionRef[]>;
  /** 逐名字吐出 `[归一化名, 定义数组]`——给旧 `Map` 的 `entries()` 用法 */
  entries(): IterableIterator<[string, ErbFunctionRef[]]>;
  /** 按名字顺序逐**定义**回调（不建数组、不建组），遍历全量时的首选 */
  forEachDef(cb: (ref: ErbFunctionRef, normalizedName: string) => void): void;
}

/** 构造期的一次喂数回调：调用方每有一条定义就调一次（顺序 = 聚合顺序）。 */
export type EmitFunctionDef = (def: ErbFunctionDef) => void;

/** 列式表里"没有这个事实"的哨兵（名字列 / 注释都靠它区分）。 */
const ABSENT = -1;

/**
 * 列式表的**最终**存储（{@link collectFunctionFacts} 的产物）：一排 TypedArray + 三枚
 * 保引用用的普通数组。构建期那些可 push 的 `number[]` 缓冲**不在这里**——
 * 见 {@link collectFunctionFacts} 上方的"为什么必须是独立作用域"。
 */
interface FunctionFacts {
  /** 归一化名，按首次出现顺序（= 旧 `Map` 的插入序） */
  keyOrder: string[];
  bucketOf: Map<string, number>;
  /** 每名字一段连续区间的起点（下标进 `bucketOrdinals`） */
  starts: Uint32Array;
  counts: Uint32Array;
  /** 定义序号流：同一名字的定义在下标上连续 */
  bucketOrdinals: Uint32Array;
  /** 每条定义的原形名 / 注释块（保引用用；这两样本来就是字符串，压不成数字） */
  names: string[];
  docs: (string | null)[];
  filePaths: string[];
  startLineArr: Uint32Array;
  endLineArr: Uint32Array;
  columnArr: Int32Array;
  fileArr: Uint32Array;
}

/**
 * 喂数 + 压平（**独立作用域，返回的只有最终存储**）。
 *
 * ## 为什么必须是独立函数，而不是 `buildFunctionLookup` 里的一段
 *
 * 本函数返回的 `ErbFunctionLookup` 是把 `refAt` / `refsOfBucket` / 各个方法收进一个对象，
 * 它们都是**闭包**，会捕获 `buildFunctionLookup` 的作用域。而 V8 把一个作用域里被内部函数
 * 捕获的变量**整体**放进同一个 `Context` 对象，且不做按需裁剪——构建期的 `startLines`
 * `endLines` `columns` `defFile` `buckets`（各 11 万格 `number[]`，合计约 7 MB）以及
 * `ordinalsOfName` 里 11 万枚单元素数组，会**跟着闭包一起活到进程结束**。
 *
 * 实测（真实语料 4,258 文件热载，堆快照对拍）：写成一个函数时 `array (object elements)`
 * 反而 **+9.2 MB**、稳态 **+4.0 MB**——比不改还差；拆开之后缓冲在返回时整层不可达。
 * 结论记在 PITFALLS：**"局部临时变量"在闭包工厂里不等于"可回收"**。
 */
function collectFunctionFacts(visit: (emit: EmitFunctionDef) => void): FunctionFacts {
  const ordinalsOfName = new Map<string, number[]>();
  const keyOrder: string[] = [];
  const filePaths: string[] = [];
  const fileIndexOf = new Map<string, number>();
  const names: string[] = [];
  const docs: (string | null)[] = [];
  const startLines: number[] = [];
  const endLines: number[] = [];
  const columns: number[] = [];
  const defFile: number[] = [];

  visit((def) => {
    let fileOrdinal = fileIndexOf.get(def.filePath);
    if (fileOrdinal === undefined) {
      fileOrdinal = filePaths.length;
      filePaths.push(def.filePath);
      fileIndexOf.set(def.filePath, fileOrdinal);
    }
    const ordinal = names.length;
    names.push(def.name);
    docs.push(typeof def.docComment === 'string' ? def.docComment : null);
    startLines.push(def.startLine);
    endLines.push(def.endLine);
    columns.push(typeof def.nameColumn === 'number' ? def.nameColumn : ABSENT);
    defFile.push(fileOrdinal);

    const list = ordinalsOfName.get(def.normalizedName);
    if (list === undefined) {
      ordinalsOfName.set(def.normalizedName, [ordinal]);
      keyOrder.push(def.normalizedName);
    } else {
      list.push(ordinal);
    }
  });

  // 压平：每个名字一段连续区间（`starts[i] .. starts[i] + counts[i]`）
  const size = keyOrder.length;
  const starts = new Uint32Array(size);
  const counts = new Uint32Array(size);
  const buckets: number[] = [];
  for (let i = 0; i < size; i += 1) {
    const list = ordinalsOfName.get(keyOrder[i]!) as number[];
    starts[i] = buckets.length;
    counts[i] = list.length;
    for (let j = 0; j < list.length; j += 1) buckets.push(list[j]!);
  }
  const bucketOf = new Map<string, number>();
  for (let i = 0; i < size; i += 1) bucketOf.set(keyOrder[i]!, i);

  return {
    keyOrder,
    bucketOf,
    starts,
    counts,
    bucketOrdinals: Uint32Array.from(buckets),
    names,
    docs,
    filePaths,
    startLineArr: Uint32Array.from(startLines),
    endLineArr: Uint32Array.from(endLines),
    columnArr: Int32Array.from(columns),
    fileArr: Uint32Array.from(defFile),
  };
}

/**
 * 生产侧构造：`visit` 拿到 `emit`，按聚合顺序把每条定义喂进来。
 *
 * 回调式而不是 `Iterable<ErbFunction>`：快照懒外壳的函数事实在扁平流水里
 * （`FN_STRIDE`），物化成 `ErbFunction[]` 只为建索引是本批之前的浪费。
 */
export function buildFunctionLookup(visit: (emit: EmitFunctionDef) => void): ErbFunctionLookup {
  const {
    keyOrder,
    bucketOf,
    starts,
    counts,
    bucketOrdinals,
    names,
    docs,
    filePaths,
    startLineArr,
    endLineArr,
    columnArr,
    fileArr,
  } = collectFunctionFacts(visit);
  const size = keyOrder.length;

  const refAt = (ordinal: number, normalizedName: string): ErbFunctionRef => {
    const ref: ErbFunctionRef = {
      name: names[ordinal]!,
      normalizedName,
      filePath: filePaths[fileArr[ordinal]!]!,
      startLine: startLineArr[ordinal]!,
      endLine: endLineArr[ordinal]!,
    };
    const column = columnArr[ordinal]!;
    if (column !== ABSENT) ref.nameColumn = column;
    const doc = docs[ordinal];
    if (doc !== null && doc !== undefined) ref.docComment = doc;
    return ref;
  };

  const refsOfBucket = (bucket: number): ErbFunctionRef[] => {
    const key = keyOrder[bucket]!;
    const out: ErbFunctionRef[] = [];
    const from = starts[bucket]!;
    const end = from + counts[bucket]!;
    for (let i = from; i < end; i += 1) out.push(refAt(bucketOrdinals[i]!, key));
    return out;
  };

  return {
    size,
    has: (normalizedName) => bucketOf.has(normalizedName),
    countOf: (normalizedName) => {
      const bucket = bucketOf.get(normalizedName);
      return bucket === undefined ? 0 : counts[bucket]!;
    },
    firstOf: (normalizedName) => {
      const bucket = bucketOf.get(normalizedName);
      if (bucket === undefined) return undefined;
      return refAt(bucketOrdinals[starts[bucket]!]!, keyOrder[bucket]!);
    },
    defsOf: (normalizedName) => {
      const bucket = bucketOf.get(normalizedName);
      return bucket === undefined ? [] : refsOfBucket(bucket);
    },
    *keys() {
      for (let i = 0; i < size; i += 1) yield keyOrder[i]!;
    },
    *values() {
      for (let i = 0; i < size; i += 1) yield refsOfBucket(i);
    },
    *entries() {
      for (let i = 0; i < size; i += 1) yield [keyOrder[i]!, refsOfBucket(i)] as [string, ErbFunctionRef[]];
    },
    forEachDef: (cb) => {
      for (let i = 0; i < size; i += 1) {
        const key = keyOrder[i]!;
        const from = starts[i]!;
        const end = from + counts[i]!;
        for (let j = from; j < end; j += 1) cb(refAt(bucketOrdinals[j]!, key), key);
      }
    },
  };
}

/**
 * 测试 / 小表用：把一张已经建好的 `[归一化名, 定义[]]` 序列直接装成查找表。
 *
 * 只用于 mock 与个位数条目的小表——生产侧不要用它绕开 {@link buildFunctionLookup}
 * （那会把对象常驻回去，正是本批要消掉的东西）。
 */
export function functionLookupOf(
  entries: Iterable<readonly [string, readonly ErbFunctionRef[]]>,
): ErbFunctionLookup {
  const groups = new Map<string, ErbFunctionRef[]>();
  for (const [name, refs] of entries) {
    const list = groups.get(name);
    if (list === undefined) groups.set(name, [...refs]);
    else list.push(...refs);
  }
  const keyOrder = [...groups.keys()];
  const refsOf = (name: string): ErbFunctionRef[] => [...(groups.get(name) as ErbFunctionRef[])];
  return {
    size: keyOrder.length,
    has: (name) => groups.has(name),
    countOf: (name) => groups.get(name)?.length ?? 0,
    firstOf: (name) => groups.get(name)?.[0],
    defsOf: (name) => (groups.has(name) ? refsOf(name) : []),
    *keys() {
      for (const name of keyOrder) yield name;
    },
    *values() {
      for (const name of keyOrder) yield refsOf(name);
    },
    *entries() {
      for (const name of keyOrder) yield [name, refsOf(name)] as [string, ErbFunctionRef[]];
    },
    forEachDef: (cb) => {
      for (const name of keyOrder) {
        for (const ref of refsOf(name)) cb(ref, name);
      }
    },
  };
}

/* ------------------- 调用槽位格式化（LAU-4 补全腿第三批，2026-10-31） ------------------- */

/**
 * 槽位的显示标签（`ARG:0 含义` / `ARGS:1 含义`）——签名浮层与括号调用骨架**共用这一枚**。
 *
 * 为什么住在契约层：同一句格式化要在两个地方出现——签名帮助的形参表（宿主）与补全的
 * `名字(${1:ARG:0 含义})` 骨架（判据搬进插件之后由插件拼）。两边各写一份的代价是
 * 「列表里看到的和签名浮层看到的」不一致；槽的语义本来就是 `KojoCallSlot` 自己的事，
 * 格式化跟着类型走 ⇒ 一个落点、两侧 import。
 */
export function slotParameterLabel(slot: KojoCallSlot): string {
  return `${slot.kind === 'str' ? 'ARGS' : 'ARG'}:${slot.index} ${slot.label}`;
}

/** snippet 控制字符（反斜杠 / 美元符 / 右花括号）转义——槽含义原文可能带它们 */
export function escapeSnippetText(text: string): string {
  return text.replace(/[\\$}]/g, (ch) => `\\${ch}`);
}

/**
 * 形参槽 → 带 tabstop 的调用片段（**纯函数**）。
 * `slots === undefined`（协议缺席 / 不认 / 抛错）⇒ `undefined` ⇒ 调用方保持纯文本（**不猜形参**）；
 * `slots` 为空数组是协议明确声明"无槽"这一**事实** ⇒ 给 `名字()`。
 */
export function buildCallSnippetText(
  name: string,
  slots: readonly KojoCallSlot[] | undefined,
): string | undefined {
  if (slots === undefined) return undefined;
  if (slots.length === 0) return `${name}()`;
  const stops = slots.map((slot, i) => {
    const placeholder = escapeSnippetText(slotParameterLabel(slot).replace(/\s+/g, ' ').trim());
    return `\${${String(i + 1)}:${placeholder}}`;
  });
  return `${name}(${stops.join(', ')})`;
}

/**
 * 依次用这几个键回协议表取槽（命中仍来自表本身）；全不认 / 表缺席 ⇒ `undefined`。
 *
 * `onError` 可选（additive）：协议实现抛错时把 `(键, 错误)` 交给调用方——宿主用它记一行
 * warn（不静默）；插件侧不传（判据相同、只是没有日志面）。**空数组是命中**（协议声明
 * "无槽"），只有 `null` / `undefined` 是"不认"。
 */
export function callSlotsOf(
  protocol: KojoCallProtocol | undefined,
  keys: readonly (string | undefined)[],
  onError?: (key: string, error: unknown) => void,
): readonly KojoCallSlot[] | undefined {
  if (protocol === undefined) return undefined;
  for (const key of keys) {
    if (key === undefined || key.length === 0) continue;
    try {
      const slots = protocol.slotsFor(key);
      if (slots) return slots;
    } catch (error: unknown) {
      onError?.(key, error);
    }
  }
  return undefined;
}

/** 签名详情行（`调用签名 \`名字(ARG:0 含义)\``）；取不到槽 ⇒ `undefined`（不进文档，不猜） */
export function callSignatureLine(
  display: string,
  keys: readonly (string | undefined)[],
  protocol: KojoCallProtocol | undefined,
  onError?: (key: string, error: unknown) => void,
): string | undefined {
  const slots = callSlotsOf(protocol, keys, onError);
  if (slots === undefined) return undefined;
  return `调用签名 \`${display}(${slots.map(slotParameterLabel).join(', ')})\``;
}
