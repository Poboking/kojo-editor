/**
 * ERB 解析器契约（服务键 `erb.parser`）——**运行时面**。
 *
 * 定位（架构文档 §5.2）：**结构感知的解析**，不做完整 EraBasic 解释器。
 * v0.1 覆盖：函数边界、#DIM 声明、#FUNCTION(S) 文件标记、SKIPSTART/SKIPEND 区间。
 * v0.2 追加：PRINT 变体、IF/SELECTCASE 嵌套、TRYCALLFORM 引用、条件谓词抽取。
 *
 * 类型面（interface / type）已整块拆到 `./erb-types`（2026-11-07 MCP-PERF-S17）：
 * 类型经 `import type` / `export type` 擦除、不进开机图，本文件只留运行时真源
 * （常量表与纯函数）。旧导入路径不变——文件尾 `export type *` 原样转出全部类型。
 */
// 类型专用 import：调用槽语义的格式化指向契约类型本身，**不**把 `game.ts` 的运行时常量
// 拽进桶图（LAU-4 之前 +45.4 KB 的教训，见 `active-adapter.ts` 头注）。
import type { KojoCallProtocol, KojoCallSlot } from './game';
import type {
  ErbContinuationRole,
  ErbFunctionLookup,
  ErbFunctionRef,
  ErbPreprocCandidate,
  ErbPreprocRole,
  EmitFunctionDef,
} from './erb-types';

/** 类型面已拆到 ./erb-types（图外文件）：这里 re-export 只为保持旧的 ./erb 导入路径可用。
 *  `export type *` 会被擦除，不产生运行时面，也不把类型文件拽回图。 */
export type * from './erb-types';

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

// ---------------------------------------------------------------------------
// 预处理器 `[...]` 标记（语言事实的唯一落点）
// ---------------------------------------------------------------------------

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
