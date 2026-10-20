/**
 * ERB 解析器契约（服务键 `erb.parser`）。
 *
 * 定位（架构文档 §5.2）：**结构感知的解析**，不做完整 EraBasic 解释器。
 * v0.1 覆盖：函数边界、#DIM 声明、#FUNCTION(S) 文件标记、SKIPSTART/SKIPEND 区间。
 * v0.2 追加：PRINT 变体、IF/SELECTCASE 嵌套、TRYCALLFORM 引用、条件谓词抽取。
 */

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
 * 闭集三类，且**只报可证明的**（口径：错标比不标危险）：
 * - `orphan-close`：闭合语句找不到对应开块（多写了 `ENDIF`）；
 * - `unclosed-open`：走到函数边界（`@` 行）或文件结尾仍有开块没闭合；
 * - `orphan-branch`：`ELSE` / `CASE` / `CATCH` 这类分支语句前面没有它要归属的开块。
 * 未知变量名、未知函数名、表达式语法**不在这一层**（要全项目语义或表达式解析器）。
 */
export interface ErbStructureIssue {
  readonly kind: 'orphan-close' | 'unclosed-open' | 'orphan-branch';
  /** 1 基行号（与 `ControlFlowStatement.line` 同一坐标系） */
  readonly line: number;
  /** 出问题的语句原词（`ENDIF` / `IF` / `ELSE`…）；未闭合类给的是那个**开块**的原词 */
  readonly statement: string;
  /** 给作者看的中文一句话（说清缺谁、在哪儿，不复述引擎术语） */
  readonly message: string;
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
  /** 归一化函数名 → 定义列表 */
  byName: Map<string, ErbFunctionRef[]>;
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
   * 结构体检（2026-10-13 UI 反馈 7，**additive 可选**）：配对失败的三类可证明错误。
   *
   * 与 `scanControlFlow` 的分工：那张表是骨架（算深度、抽条件），这一份是"配不上对"的证据。
   * 两者共用 `erb-parser/scanner.ts` 的同一份配对表与同一套行过滤规则，所以不会出现
   * "波浪线指的行骨架里没有"。纯文本入、纯数据出（编辑器每 250ms 去抖后调一次，不能读盘）。
   *
   * **为什么是可选**：波浪线是新增能力，缺了它编辑器只是不出提示（= 现状），
   * 不该逼着所有实现者同批改完——契约演进的 additive 纪律（HANDOFF §十一）。
   * 消费方（`ui.editor.decorator` 贡献者）必须在方法缺席时返回空装饰。
   */
  checkStructure?(text: string): ErbStructureIssue[];
  /**
   * 当前已构建的索引（未构建 / 未打开项目时为 null）。
   * 解析器订阅 `project.opened` 自动构建并在完成后发 `kojo.functionChanged`，
   * 消费方（函数树、校验器）订阅事件按需刷新。
   */
  currentIndex(): ErbIndex | null;
  /** 取当前索引；未构建则触发构建（若已有在途构建则等待它完成） */
  ensureIndex(): Promise<ErbIndex>;
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


