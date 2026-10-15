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

/** #DIM / #DIMS / #DIMSTR / #DIMCHAR 等声明的变量 */
export interface ErbDim {
  name: string;
  /** 声明指令（DIM / DIMS / DIMSTR / DIMCHAR / DIMF …） */
  directive: string;
  line: number;
}

/** 单个 ERB 文件的解析结果 */
export interface ErbFile {
  path: string;
  functions: ErbFunction[];
  dims: ErbDim[];
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

