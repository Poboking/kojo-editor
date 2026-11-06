/**
 * ERB 解析器契约的**类型面**（从 `erb.ts` 拆出的图外叶子，2026-11-07 MCP-PERF-S17）。
 *
 * 为什么单独成文件：ps10 开机闸按**源码字节**累加静态值依赖图，而类型声明经
 * `import type` / `export type` 会被整段擦除——类型面住这里（没有任何图内文件值 import
 * 本枚）就不进开机图；`erb.ts` 只留运行时常量与纯函数，经文件尾的
 * `export type * from './erb-types'` 保持旧的 `./erb` 导入路径可用（S15 治理批
 * `slots/sugar/replay` 三笔的同一形态）。
 *
 * 铁律：**本文件只许有类型**（interface / type /JSDoc）。一枚 `export const` 都会把
 * 本枚拽回图内文件的值依赖图——运行时真源照旧住 `erb.ts`。
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
 *
 * `name` 是**裸名**（2026-11-04 ERH 批）：数组维度（`#DIM 配列[10]` → `配列`）、二维尺寸
 * （`#DIM MAP:10:20` → `MAP`）与行尾注释（`#DIM X;备注` → `X`）都**不属于**名字。
 * 为什么这写进契约而不是留给解析细节：消费方要拿它跟**光标处的记号**做大小写比对，
 * 两边必须是同一把尺子（`isErbDimNameChar`）——此前索引里存 `配列[10]`、光标读到 `配列`，
 * 结果是 F12 永远空跳、补全把 `配列[10]` 当变量名插进正文。
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
   * **变量**的项目级引用索引（归一化名 → 全局出现点；**additive 可选**，2026-11-05）。
   *
   * 与 {@link references} 的分工：那一张收的是**函数名**（`CALL` 族与裸提及），这一张收的是
   * `#DIM` 族声明的**全局名**（函数体内的局部声明不进——它们跨不出函数，见
   * {@link ErbDimReferenceIndex}）。两张表的名字域可以重叠（真语料里 `ADD_VICTIM`
   * 既是函数也是全局变量），查询按各自的光标入口分流，不互相排除。
   *
   * 缺省 = 提供方未建（消费方降级为"只看本文件"，即 2026-11-05 之前的既有行为）。
   * 增量更新后按反向引用的同一条保守纪律失效（新定义会让别的文件多边）。
   */
  readonly dimReferences?: ErbDimReferenceIndex;
  /**
   * **索引版本号**（**additive 可选**，MCP-PERF-S2，2026-11-06）。
   *
   * 每次索引换代 +1：整扫、盘上增量更新各算一次。消费方拿它判断"我手里的派生
   * 数据对不对应当前索引"（比对象身份比较直白——增量轮每次都交出新对象，但
   * 只读派生缓存未必每一代都要重建）。缺省 = 提供方未标，消费方按"无从比较"处理。
   */
  readonly version?: number;
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
  /**
   * 产出这份视图时的**索引版本号**（**additive 可选**，MCP-PERF-S2，2026-11-06）。
   *
   * 与 {@link ErbIndex.version} 同源同值：每次索引换代（整扫或增量更新）+1。查询方
   * 拿它和手里的旧读数比一下就知道数据是不是同一代的，不必自己记 `ErbIndex` 对象。
   * 缺省 = 提供方未标（旧形态，消费方按"无从比较"处理）。
   */
  readonly version?: number;
  /**
   * **显式失效标注**（**additive 可选**，MCP-PERF-S2，2026-11-06）：归一化名 →
   * 这一轮增量里**判不了**（溯源未知 / 重扫失败）的名字。这些名字的组内容仍是
   * 尽力而为的最新账（**绝不答空**），但可信度由这里的成员如实声明——消费方
   * （面板 / MCP）可据此显示"此名引用正在重建"而不是默默把旧账当真账。
   *
   * 常态（单文件保存）增量轮把受影响名字全部就地重建 ⇒ 这里是空集（键缺席）。
   * 缺省 = 全部名字都可信（与旧形态同观感）。
   */
  readonly staleNames?: ReadonlySet<string>;
}

/* ---------------- 变量（`#DIM` 族）的项目级引用（2026-11-05，全部 additive） ---------------- */

/**
 * 一处变量名出现。
 *
 * 与 {@link ErbReference} 分开而不是复用：两者字段同形，但**值域不同**——变量只有
 * `definition` / `mention` 两种（`call` 是函数调用语法位，变量没有）。
 *
 * 为什么是**判别联合**而不是一枚带可选字段的平表：声明点与提及点的列事实**不一样多**。
 * 提及点在可见代码行里，`#DIM NAME` 的 `NAME` 起止列索引**没有**（`ErbDim` 只有名字/指令/行，
 * 见 `ErbIndex.dimReferences` 的注）——给个 `1 + 名字长度` 的假跨度，任何照着它画高亮的
 * 消费方都会把 `#DI` 三个字符涂上色。缺席比编造好，所以 `definition` 分支干脆没有 `endColumn`，
 * 由类型系统替调用方记住这件事（`symbols.ts` 的查询腿对声明点一律不给 `span`）。
 *
 * `kind` 在末尾：`definition` 与 `mention` 的差别只在 `endColumn` 一处，写在前面的字段
 * 两种分支逐字相同，审的时候一眼能看出"少的只是列事实"。
 */
export type ErbDimReference = ErbDimDefinitionReference | ErbDimMentionReference;

/** 变量名的**全局声明点**（`#DIM` 族行自身；函数体内的局部声明不进这张表） */
export interface ErbDimDefinitionReference {
  /** 出现所在文件（方言文件绝对路径） */
  filePath: string;
  /** 行号（1 基） */
  line: number;
  /** 起始列：**恒 1**（索引无列事实；落点是"这一行"，不是"这一行的某个字符"） */
  column: number;
  kind: 'definition';
}

/** 变量名在可见代码里的**一次提及** */
export interface ErbDimMentionReference {
  /** 出现所在文件（方言文件绝对路径） */
  filePath: string;
  /** 行号（1 基） */
  line: number;
  /** 起始列（1 基） */
  column: number;
  /** 结束列（不含端点 = `column` + 名字长度） */
  endColumn: number;
  /**
   * `mention`：可见代码里整串等于该名字的记号（注释 / 字符串内容 / `[SKIPSTART]` 段不算；
   * 紧邻半/全角冒号的成员名不算——`CFLAG:ALPHA` 里 `ALPHA` 是成员，`CFLAG` 仍是变量提及）。
   */
  kind: 'mention';
}

/**
 * 项目级变量引用索引（**只收全局声明名**）。
 *
 * 为什么只收全局：`#DIM` 在函数体内是**调用栈局部**的（真语料 67.7% 的声明都是这种），
 * 跨函数同名互不相干；把局部名字收进来，项目级查找引用就会把 A 函数的变量算到 B 头上。
 * 局部变量的引用由文件内那条腿答（`erbDimReferencesAt` 的本地分支）。
 *
 * 声明点与提及点**同表**：find-references 要把"定义在哪、谁在用"一起给出（rename 也靠它）。
 * 排序 = 构建序（文件遍历序）→ 行 → 列，与 {@link ErbReferenceIndex} 同一条确定性纪律。
 */
export interface ErbDimReferenceIndex {
  /** 归一化变量名（大写）→ 该名在项目内的全局出现点全集 */
  readonly byName: ReadonlyMap<string, readonly ErbDimReference[]>;
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

/** 一条 `[` 位补全候选：`label` 是上屏文本，`needsArgument` 标记"作者还得补一段"的骨架形 */
export interface ErbPreprocCandidate {
  readonly label: string;
  readonly role: ErbPreprocRole;
  readonly needsArgument: boolean;
}

/** 行连接标记的角色：开始 / 收束 */
export type ErbContinuationRole = 'open' | 'close';

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
