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

// @erb-engine-names:begin
/**
 * 引擎内建变量名 —— **生成区间，勿手改**；由 `node tools/gen-erb-engine-names.mjs` 重生成。
 *
 * 真源：eratw-安卓移植计划 `specs/variables.yaml`
 *       （反编译 C# `VariableData.cs` / `VariableCode.cs` / `ConstantData.cs` 等，逐条带行号锚）。
 * 快照：`tools/data/variables.yaml`，sha256 = `f9e75fab0e459afb09ccbbfa736cfc1d25c8669efa2f7bdc1dfc5a0553f2a0fe`。
 * 名数：161 条（A..Z 展开 26、伪变量族拆 3、GAMEBASE 旧拼拆 2）。
 *
 * `dim` / `kind` 是**引擎变量模型**的读数（`dim: 1` = 一维数组、`dim: 0` = 标量；
 * `kind` = int / str / float / mixed）。
 *
 * 缺席（`undefined`）= **该名字的维度没被 spec 钉死，不猜**，消费方必须按「未知」fail-open：
 * `character_vars` 与 `float_vars` 的子段结构不统一；`pseudo_vars` 段根本没有 `dim` 字段，
 * 且成员形态不一（`RAND` 收一个上界、`CHARANUM` 是标量）——这两处任何"按段一把梭"的默认值
 * 都会在真语料上炸（`RAND:n` 在 eraTW 4.981 里有 76,015 处）。
 *
 * 用途：补全与悬停给出维度/类型；维度诊断（`FLAG:a:b` 打在 1 维变量上）的真值来源。
 */
export interface ErbEngineNameEntry {
  readonly name: string;
  readonly section: string;
  /** 数组维度（0 = 标量；缺席 = spec 未钉死，不猜，按未知处理） */
  readonly dim?: number;
  /** 值类型（`int` / `str` / `float` / `mixed`；缺席 = 未知） */
  readonly kind?: string;
}

/** 全部引擎内建名（含来源段与维度/类型）；`ERB_ENGINE_RESERVED_IDENTIFIERS` 由此派生。 */
export const ERB_ENGINE_NAMES: readonly ErbEngineNameEntry[] = [
  { name: "A", section: "整数数组", dim: 1, kind: "int" },
  { name: "ABL", section: "角色变量" },
  { name: "ABLNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "ARG", section: "函数局部", dim: 1, kind: "int" },
  { name: "ARGF", section: "函数局部", dim: 1, kind: "float" },
  { name: "ARGS", section: "函数局部", dim: 1, kind: "str" },
  { name: "ASSI", section: "整数数组", dim: 1, kind: "int" },
  { name: "ASSIPLAY", section: "整数数组", dim: 1, kind: "int" },
  { name: "B", section: "整数数组", dim: 1, kind: "int" },
  { name: "BASE", section: "角色变量" },
  { name: "BASENAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "BOUGHT", section: "整数数组", dim: 1, kind: "int" },
  { name: "C", section: "整数数组", dim: 1, kind: "int" },
  { name: "CALLNAME", section: "角色变量" },
  { name: "CDFLAG", section: "角色变量" },
  { name: "CDFLAGNAME1", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "CDFLAGNAME2", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "CDOWN", section: "角色变量" },
  { name: "CFLAG", section: "角色变量" },
  { name: "CFLAGNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "CHARANUM", section: "伪变量/常量", kind: "int" },
  { name: "COUNT", section: "整数数组", dim: 1, kind: "int" },
  { name: "CSTR", section: "角色变量" },
  { name: "CSTRNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "CUP", section: "角色变量" },
  { name: "D", section: "整数数组", dim: 1, kind: "int" },
  { name: "DA", section: "多维数组", dim: 2, kind: "int" },
  { name: "DAY", section: "整数数组", dim: 1, kind: "int" },
  { name: "DAYNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "DB", section: "多维数组", dim: 2, kind: "int" },
  { name: "DC", section: "多维数组", dim: 2, kind: "int" },
  { name: "DD", section: "多维数组", dim: 2, kind: "int" },
  { name: "DE", section: "多维数组", dim: 2, kind: "int" },
  { name: "DITEMTYPE", section: "多维数组", dim: 2, kind: "int" },
  { name: "DOWN", section: "整数数组", dim: 1, kind: "int" },
  { name: "DOWNBASE", section: "角色变量" },
  { name: "DRAWLINESTR", section: "伪变量/常量", kind: "str" },
  { name: "E", section: "整数数组", dim: 1, kind: "int" },
  { name: "EJAC", section: "整数数组", dim: 1, kind: "int" },
  { name: "EMUERA_VERSION", section: "伪变量/常量", kind: "str" },
  { name: "EQUIP", section: "角色变量" },
  { name: "EQUIPNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "EX", section: "角色变量" },
  { name: "EXNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "EXP", section: "角色变量" },
  { name: "EXPLV", section: "整数数组", dim: 1, kind: "int" },
  { name: "EXPNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "F", section: "整数数组", dim: 1, kind: "int" },
  { name: "FLAG", section: "整数数组", dim: 1, kind: "int" },
  { name: "FLAGNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "G", section: "整数数组", dim: 1, kind: "int" },
  { name: "GAMEBASE_ALLOWVERSION", section: "GAMEBASE 常量", dim: 0, kind: "int" },
  { name: "GAMEBASE_AUTHER", section: "GAMEBASE 常量", dim: 0, kind: "str" },
  { name: "GAMEBASE_AUTHOR", section: "GAMEBASE 常量", dim: 0, kind: "str" },
  { name: "GAMEBASE_DEFAULTCHARA", section: "GAMEBASE 常量", dim: 0, kind: "int" },
  { name: "GAMEBASE_GAMECODE", section: "GAMEBASE 常量", dim: 0, kind: "int" },
  { name: "GAMEBASE_INFO", section: "GAMEBASE 常量", dim: 0, kind: "str" },
  { name: "GAMEBASE_NOITEM", section: "GAMEBASE 常量", dim: 0, kind: "int" },
  { name: "GAMEBASE_TITLE", section: "GAMEBASE 常量", dim: 0, kind: "str" },
  { name: "GAMEBASE_URL", section: "GAMEBASE 常量", dim: 0, kind: "str" },
  { name: "GAMEBASE_VERSION", section: "GAMEBASE 常量", dim: 0, kind: "int" },
  { name: "GAMEBASE_VERSIONNAME", section: "GAMEBASE 常量", dim: 0, kind: "str" },
  { name: "GAMEBASE_YEAR", section: "GAMEBASE 常量", dim: 0, kind: "str" },
  { name: "GLOBAL", section: "整数数组", dim: 1, kind: "int" },
  { name: "GLOBALNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "GLOBALS", section: "字符串数组", dim: 1, kind: "str" },
  { name: "GLOBALSNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "GOTJUEL", section: "角色变量" },
  { name: "H", section: "整数数组", dim: 1, kind: "int" },
  { name: "I", section: "整数数组", dim: 1, kind: "int" },
  { name: "ISASSI", section: "角色变量" },
  { name: "ISTIMEOUT", section: "伪变量/常量", kind: "int" },
  { name: "ITEM", section: "整数数组", dim: 1, kind: "int" },
  { name: "ITEMNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "ITEMPRICE", section: "整数数组", dim: 1, kind: "int" },
  { name: "ITEMSALES", section: "整数数组", dim: 1, kind: "int" },
  { name: "J", section: "整数数组", dim: 1, kind: "int" },
  { name: "JUEL", section: "角色变量" },
  { name: "K", section: "整数数组", dim: 1, kind: "int" },
  { name: "L", section: "整数数组", dim: 1, kind: "int" },
  { name: "LASTLOAD_NO", section: "伪变量/常量", kind: "int" },
  { name: "LASTLOAD_TEXT", section: "伪变量/常量", kind: "str" },
  { name: "LASTLOAD_VERSION", section: "伪变量/常量", kind: "int" },
  { name: "LINECOUNT", section: "伪变量/常量", kind: "int" },
  { name: "LOCAL", section: "函数局部", dim: 1, kind: "int" },
  { name: "LOCALF", section: "函数局部", dim: 1, kind: "float" },
  { name: "LOCALS", section: "函数局部", dim: 1, kind: "str" },
  { name: "LOSEBASE", section: "整数数组", dim: 1, kind: "int" },
  { name: "M", section: "整数数组", dim: 1, kind: "int" },
  { name: "MARK", section: "角色变量" },
  { name: "MARKNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "MASTER", section: "整数数组", dim: 1, kind: "int" },
  { name: "MASTERNAME", section: "角色变量" },
  { name: "MAXBASE", section: "角色变量" },
  { name: "MONEY", section: "整数数组", dim: 1, kind: "int" },
  { name: "MONEYLABEL", section: "伪变量/常量", kind: "str" },
  { name: "MONEYNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "N", section: "整数数组", dim: 1, kind: "int" },
  { name: "NAME", section: "角色变量" },
  { name: "NEXTCOM", section: "整数数组", dim: 1, kind: "int" },
  { name: "NICKNAME", section: "角色变量" },
  { name: "NO", section: "角色变量" },
  { name: "NOITEM", section: "整数数组", dim: 1, kind: "int" },
  { name: "NOWEX", section: "角色变量" },
  { name: "O", section: "整数数组", dim: 1, kind: "int" },
  { name: "P", section: "整数数组", dim: 1, kind: "int" },
  { name: "PALAM", section: "角色变量" },
  { name: "PALAMLV", section: "整数数组", dim: 1, kind: "int" },
  { name: "PALAMNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "PBAND", section: "整数数组", dim: 1, kind: "int" },
  { name: "PLAYER", section: "整数数组", dim: 1, kind: "int" },
  { name: "PREVCOM", section: "整数数组", dim: 1, kind: "int" },
  { name: "Q", section: "整数数组", dim: 1, kind: "int" },
  { name: "R", section: "整数数组", dim: 1, kind: "int" },
  { name: "RAND", section: "伪变量/常量", kind: "int" },
  { name: "RANDDATA", section: "整数数组", dim: 1, kind: "int" },
  { name: "RELATION", section: "角色变量" },
  { name: "RESULT", section: "整数数组", dim: 1, kind: "int" },
  { name: "RESULTF", section: "浮点变量", dim: 0, kind: "float" },
  { name: "RESULTS", section: "字符串数组", dim: 1, kind: "str" },
  { name: "S", section: "整数数组", dim: 1, kind: "int" },
  { name: "SAVEDATA_TEXT", section: "字符串数组", dim: 0, kind: "str" },
  { name: "SAVESTR", section: "字符串数组", dim: 1, kind: "str" },
  { name: "SAVESTRNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "SELECTCOM", section: "整数数组", dim: 1, kind: "int" },
  { name: "SOURCE", section: "角色变量" },
  { name: "SOURCENAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "STAIN", section: "角色变量" },
  { name: "STAINNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "STR", section: "字符串数组", dim: 1, kind: "str" },
  { name: "STRNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "T", section: "整数数组", dim: 1, kind: "int" },
  { name: "TA", section: "多维数组", dim: 3, kind: "int" },
  { name: "TALENT", section: "角色变量" },
  { name: "TALENTNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "TARGET", section: "整数数组", dim: 1, kind: "int" },
  { name: "TB", section: "多维数组", dim: 3, kind: "int" },
  { name: "TCVAR", section: "角色变量" },
  { name: "TCVARNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "TEQUIP", section: "角色变量" },
  { name: "TEQUIPNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "TFLAG", section: "整数数组", dim: 1, kind: "int" },
  { name: "TFLAGNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "TIME", section: "整数数组", dim: 1, kind: "int" },
  { name: "TIMENAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "TRAINNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "TSTR", section: "字符串数组", dim: 1, kind: "str" },
  { name: "TSTRNAME", section: "CSV 常量名字表", dim: 1, kind: "str" },
  { name: "U", section: "整数数组", dim: 1, kind: "int" },
  { name: "UP", section: "整数数组", dim: 1, kind: "int" },
  { name: "V", section: "整数数组", dim: 1, kind: "int" },
  { name: "W", section: "整数数组", dim: 1, kind: "int" },
  { name: "WINDOW_TITLE", section: "伪变量/常量", kind: "str" },
  { name: "X", section: "整数数组", dim: 1, kind: "int" },
  { name: "Y", section: "整数数组", dim: 1, kind: "int" },
  { name: "Z", section: "整数数组", dim: 1, kind: "int" },
  { name: "__FILE__", section: "伪变量/常量", kind: "mixed" },
  { name: "__FUNCTION__", section: "伪变量/常量", kind: "mixed" },
  { name: "__INT_MAX__", section: "伪变量/常量", kind: "int" },
  { name: "__INT_MIN__", section: "伪变量/常量", kind: "int" },
  { name: "__LINE__", section: "伪变量/常量", kind: "mixed" },
];

export const ERB_ENGINE_NAME_LIST: readonly string[] = ERB_ENGINE_NAMES.map((e) => e.name);
// @erb-engine-names:end

// @erb-event-labels:begin
/**
 * 引擎事件标签名 —— **生成区间，勿手改**；由 `node tools/gen-erb-event-labels.mjs` 重生成。
 *
 * 真源：4.981 `IdentifierDictionary.cs::IsEventLabelName` 的 switch 全体 case
 * （快照 `tools/data/IdentifierDictionary.4.981.cs`，EOL 归一化 sha256 `ab05d95d…`）。
 * 引擎对这批标签**允许多处定义且全部执行**（#ONLY → #PRI → 普通 → #LATER 四桶），
 * 非事件函数才是后装载者生效（`SortLabel` 直接赋值；`SortLabels` 是死代码）。
 * 故 `erb.duplicate-function` 按本集合豁免事件族，逐条提示只会制造假问题。
 */
export const ERB_EVENT_LABEL_NAMES: readonly string[] = [
  "BEFORE_ERROR",
  "BEFORE_THROW",
  "EVENTBUY",
  "EVENTCOM",
  "EVENTCOMEND",
  "EVENTEND",
  "EVENTFIRST",
  "EVENTLOAD",
  "EVENTSHOP",
  "EVENTTRAIN",
  "EVENTTURNEND",
];

const ERB_EVENT_LABEL_NAME_SET: ReadonlySet<string> = new Set(ERB_EVENT_LABEL_NAMES);

/** 大小写不敏感（eraTW `emuera.config` 首行 `IGNORE CASE:YES`）。 */
export function isErbEventLabelName(name: string): boolean {
  return ERB_EVENT_LABEL_NAME_SET.has(name.trim().toUpperCase());
}
// @erb-event-labels:end

// @erb-instruction-specs:begin
/**
 * ERB 语句 ISA 规约 —— **生成区间，勿手改**；由 `node tools/gen-erb-instruction-specs.mjs` 重生成。
 *
 * 真源：eratw `specs/isa.yaml`（快照 `tools/data/isa.yaml`，EOL 归一化 sha256
 * `71817091…`），逐条锚 1.824 `FunctionIdentifier.cs` / `Process.cs`：
 * 全量 177 指令 / 69 种 arg_form / 266 个注册别名 / 64 条带 errors。
 *
 * **本区间只带悬停可达的那 72 条**（条目名或别名命中 `ERB_STATEMENT_DIRECTIVES`）。
 * 全量留在快照里供审计；plugin-api 在 PS-10 开机图内，整表 65 KB 会撞 ≤3,430 KB 闸。
 * 生成时按可达面取子集，判据双向对拍：可达面不漏、不可达面不收。
 *
 * `argForm` / `semantics` / `errors` 是**引擎原话**（中文 prose，带行锚），
 * 消费方只做“有则追加”的展示，不拿它猜实参个数——形态到可判定判据的转换必须有 C# 锚。
 */
export interface ErbInstructionSpec {
  readonly name: string;
  readonly kind: string;
  readonly argForm: string;
  readonly semantics: string;
  readonly errors: string;
  readonly source: string;
  readonly aliases: readonly string[];
  readonly confidence: string;
}

export const ERB_INSTRUCTION_SPECS: readonly ErbInstructionSpec[] = [
  { name: "PRINT", kind: "display", argForm: "varies by alias: STR_NULLABLE / STR_EXPRESSION / FORM_STR_NULLABLE / SP_PRINTV",
    semantics: "PRINT 家族统一实现:按语句名后缀决定行为——V=逐项输出表达式,S=输出字符串表达式,FORM=展开文本中 {表达式},FORMS=先求值为字符串再对该字符串二次按 FORM 展开,K=字符串类型转换,D=使用调试配色,SINGLE=单行独立显示,C/LC=右/左对齐定宽输出(宽度取 Config.PrintCLength,非操作数),L=末尾换行,W=末尾换行并等待按键,N=语句名不换行但实现同时置 PRINT_WAITINPUT,故实际仍换行并等待按键(见 source 注释块勘误)。SkipPrint 期间整条跳过。", errors: "语句名解析失败时抛 ExeEE(构造期)。",
    source: "FunctionIdentifier.cs:73-229", aliases: ["PRINT", "PRINTL", "PRINTW", "PRINTV", "PRINTVL", "PRINTVW", "PRINTS", "PRINTSL", "PRINTSW", "PRINTFORM", "PRINTFORML", "PRINTFORMW", "PRINTFORMS", "PRINTFORMSL", "PRINTFORMSW", "PRINTK", "PRINTKL", "PRINTKW", "PRINTVK", "PRINTVKL", ""], confidence: "high" },
  { name: "PRINT_RECT", kind: "display", argForm: "SpPrintShapeArgument (SP_PRINT_RECT)",
    semantics: "在控制台打印矩形色块,参数为尺寸/位置序列(px 或百分比)。", errors: "参数无效时抛 CodeEE。",
    source: "FunctionIdentifier.cs:444-473", aliases: ["PRINT_RECT"], confidence: "high" },
  { name: "CUSTOMDRAWLINE", kind: "display", argForm: "CreateArgument: 1 raw primitive (mandatory) → ExpressionArgument const string",
    semantics: "用参数字符串重复填充一行作为分隔线输出,随后换行。实现类覆写 CreateArgument 自行取参,不走 FunctionArgType 注册表;参数缺失抛 CodeEE（FunctionIdentifier.cs:510-527）。", errors: "参数缺失抛 CodeEE。",
    source: "FunctionIdentifier.cs:506-538", aliases: ["CUSTOMDRAWLINE"], confidence: "high" },
  { name: "DEBUGPRINT", kind: "debug", argForm: "ExpressionArgument (STR_NULLABLE / FORM_STR_NULLABLE)",
    semantics: "把字符串输出到调试窗口(不进入主文字流);L 变体输出后换行,FORM 变体展开表达式。", errors: "",
    source: "FunctionIdentifier.cs:540-568", aliases: ["DEBUGPRINT", "DEBUGPRINTL", "DEBUGPRINTFORM", "DEBUGPRINTFORML"], confidence: "high" },
  { name: "SETBIT", kind: "variable", argForm: "BitArgument (BIT_ARG)",
    semantics: "对目标整型变量的指定位做位运算:SETBIT 置 1、CLEARBIT 清 0、INVERTBIT 取反;可一次指定多个位。", errors: "位号越界(0-63 之外)抛 CodeEE。",
    source: "FunctionIdentifier.cs:731-760", aliases: ["SETBIT", "CLEARBIT", "INVERTBIT"], confidence: "high" },
  { name: "VARSET", kind: "variable", argForm: "SpVarSetArgument (SP_VAR_SET)",
    semantics: "把数组变量的指定下标范围(缺省为全数组)内所有元素统一赋为给定值;START/END 给反时自动交换。", errors: "",
    source: "FunctionIdentifier.cs:1625-1669", aliases: ["VARSET"], confidence: "high" },
  { name: "CVARSET", kind: "variable", argForm: "SpCVarSetArgument (SP_CVAR_SET)",
    semantics: "对全部角色(或指定角色号范围)的角色变量统一赋值;字符串键必须已在常量表中定义。", errors: "范围越界、目标不是角色变量、字符串键未定义时抛 CodeEE。",
    source: "FunctionIdentifier.cs:1671-1732", aliases: ["CVARSET"], confidence: "high" },
  { name: "SPLIT", kind: "variable", argForm: "SpSplitArgument (SP_SPLIT)",
    semantics: "用分隔符把字符串拆分为子串:段数写入计数变量,结果写入字符串数组变量(超出数组容量时截断)。", errors: "",
    source: "Process.cs:1561-1576", aliases: ["SPLIT"], confidence: "high" },
  { name: "ARRAYSHIFT", kind: "variable", argForm: "SpArrayShiftArgument (SP_SHIFT_ARRAY)",
    semantics: "把一维数组从指定下标起整体移位腾出空间,用指定值填充(可限制参与填充的区域范围)。第二参数为移位量,第三参数为起始下标,第四、五参数为填充范围。", errors: "目标不是一维数组抛 CodeEE;移位量不能为 0;填充相关参数为负抛 CodeEE。",
    source: "Process.cs:1614-1660", aliases: ["ARRAYSHIFT"], confidence: "high" },
  { name: "ARRAYREMOVE", kind: "variable", argForm: "SpArrayControlArgument (SP_CONTROL_ARRAY)",
    semantics: "从一维数组的指定下标开始删除指定个数的元素,其余元素前移补齐。", errors: "目标不是一维数组抛 CodeEE;起始下标为负抛 CodeEE。",
    source: "Process.cs:1661-1677", aliases: ["ARRAYREMOVE"], confidence: "high" },
  { name: "ARRAYSORT", kind: "variable", argForm: "SpArraySortArgument (SP_SORTARRAY)",
    semantics: "对一维数组的指定范围按升/降序排序;第二参数为排序方向,第三、四参数为范围。", errors: "目标不是一维数组抛 CodeEE;下标为负抛 CodeEE。",
    source: "Process.cs:1678-1710", aliases: ["ARRAYSORT"], confidence: "high" },
  { name: "ARRAYCOPY", kind: "variable", argForm: "SpCopyArrayArgument (SP_COPY_ARRAY)",
    semantics: "把第一个数组的内容复制到第二个数组(数组以变量名指定)。勘误 2026-10-18：原文写反，源码 VariableEvaluator.cs:947-960 CopyArray(var1, var2) 执行 array2[i]=array[i]（第一→第二），Process.cs:1770 CopyArray(array3[0], array3[1]) 传参顺序即书写顺序。", errors: "参数不是变量名、不是数组、是角色变量或常量、维度不一致、类型不一致时抛 CodeEE。",
    source: "Process.cs:1711-1772", aliases: ["ARRAYCOPY"], confidence: "high" },
  { name: "SWAP", kind: "variable", argForm: "SpSwapVarArgument (SP_SWAPVAR)",
    semantics: "交换两个变量的值(整型或字符串)。", errors: "两变量类型不同抛 CodeEE。",
    source: "Process.cs:1371-1395", aliases: ["SWAP"], confidence: "high" },
  { name: "TIMES", kind: "variable", argForm: "SpTimesArgument (SP_TIMES)",
    semantics: "把目标整型变量乘以语句中书写的小数系数后写回(截断取整);配置允许时用非严格浮点算法。", errors: "",
    source: "FunctionIdentifier.cs:1314-1342", aliases: ["TIMES"], confidence: "high" },
  { name: "ADDCHARA", kind: "variable", argForm: "ExpressionArrayArgument (INT_ANY)",
    semantics: "按 CSV 角色号把角色加入角色列表;ADDSPCHARA 加入 SP 角色(SP 未启用时抛错);DELCHARA 删除参数指定的角色。", errors: "SP 角色未在配置启用时抛 CodeEE。",
    source: "FunctionIdentifier.cs:1344-1397", aliases: ["ADDCHARA", "ADDSPCHARA", "DELCHARA"], confidence: "high" },
  { name: "SWAPCHARA", kind: "variable", argForm: "SpSwapCharaArgument (SP_SWAP)",
    semantics: "交换角色列表中两个角色的位置。", errors: "",
    source: "FunctionIdentifier.cs:1413-1428", aliases: ["SWAPCHARA"], confidence: "high" },
  { name: "PICKUPCHARA", kind: "variable", argForm: "ExpressionArrayArgument (INT_ANY)",
    semantics: "重排角色列表,只保留参数指定的角色(顺序按参数)。", errors: "角色号越界抛 CodeEE(MASTER/ASSI/TARGET 变量除外)。",
    source: "Process.cs:1267-1283", aliases: ["PICKUPCHARA"], confidence: "high" },
  { name: "RESET_STAIN", kind: "variable", argForm: "ExpressionArgument (INT_EXPRESSION)",
    semantics: "把指定角色的污渍(stain)数据重置为默认值。", errors: "",
    source: "Process.cs:1557-1560", aliases: ["RESET_STAIN"], confidence: "high" },
  { name: "RESETCOLOR", kind: "display", argForm: "ExpressionArgument (VOID)",
    semantics: "把前景色恢复为配置默认色。", errors: "",
    source: "FunctionIdentifier.cs:1491-1503", aliases: ["RESETCOLOR"], confidence: "high" },
  { name: "RESETBGCOLOR", kind: "display", argForm: "ExpressionArgument (VOID)",
    semantics: "把背景色恢复为配置默认色。", errors: "",
    source: "FunctionIdentifier.cs:1505-1517", aliases: ["RESETBGCOLOR"], confidence: "high" },
  { name: "SETCOLOR", kind: "display", argForm: "SpColorArgument (SP_COLOR)",
    semantics: "设置前景色,参数为 0xRRGGBB 整数或 R,G,B 三分量。", errors: "分量超出 0-255 抛 CodeEE。",
    source: "Process.cs:1409-1439", aliases: ["SETCOLOR"], confidence: "high" },
  { name: "SETCOLORBYNAME", kind: "display", argForm: "STR (常量字符串)",
    semantics: "按颜色名称(如 RED)设置前景色。", errors: "颜色名无效或为 transparent 抛 CodeEE。",
    source: "Process.cs:1440-1454", aliases: ["SETCOLORBYNAME"], confidence: "high" },
  { name: "SETBGCOLOR", kind: "display", argForm: "SpColorArgument (SP_COLOR)",
    semantics: "设置背景色,参数为 0xRRGGBB 整数或 R,G,B 三分量。", errors: "分量超出 0-255 抛 CodeEE。",
    source: "Process.cs:1455-1492", aliases: ["SETBGCOLOR"], confidence: "high" },
  { name: "FONTBOLD", kind: "display", argForm: "ExpressionArgument (VOID)",
    semantics: "把文字样式追加为粗体。", errors: "",
    source: "FunctionIdentifier.cs:1574-1589", aliases: ["FONTBOLD"], confidence: "high" },
  { name: "FONTITALIC", kind: "display", argForm: "ExpressionArgument (VOID)",
    semantics: "把文字样式追加为斜体。", errors: "",
    source: "FunctionIdentifier.cs:1591-1606", aliases: ["FONTITALIC"], confidence: "high" },
  { name: "FONTREGULAR", kind: "display", argForm: "ExpressionArgument (VOID)",
    semantics: "把文字样式重置为常规。", errors: "",
    source: "FunctionIdentifier.cs:1608-1623", aliases: ["FONTREGULAR"], confidence: "high" },
  { name: "FONTSTYLE", kind: "display", argForm: "ExpressionArgument (INT_EXPRESSION_NULLABLE)",
    semantics: "按位掩码设置字体样式:1=粗体,2=斜体,4=删除线,8=下划线。", errors: "",
    source: "Process.cs:1508-1530", aliases: ["FONTSTYLE"], confidence: "high" },
  { name: "SETFONT", kind: "display", argForm: "STR_EXPRESSION_NULLABLE",
    semantics: "按名称设置后续输出使用的字体;空参数恢复默认字体。段宽随字体变,每段按其字体实测像素宽定位(非静态格表)。", errors: "",
    source: "Process.cs:1531-1534", aliases: ["SETFONT"], confidence: "high" },
  { name: "ALIGNMENT", kind: "display", argForm: "STR (常量字符串)",
    semantics: "设置当前行对齐方式,参数为 LEFT/CENTER/RIGHT。", errors: "参数非法抛 CodeEE。",
    source: "Process.cs:1535-1552", aliases: ["ALIGNMENT"], confidence: "high" },
  { name: "REUSELASTLINE", kind: "display", argForm: "ExpressionArgument (FORM_STR_NULLABLE)",
    semantics: "把最后一行显示内容替换为参数字符串(临时行)。", errors: "",
    source: "FunctionIdentifier.cs:668-681", aliases: ["REUSELASTLINE"], confidence: "high" },
  { name: "CLEARLINE", kind: "display", argForm: "ExpressionArgument (INT_EXPRESSION)",
    semantics: "从当前行向上删除指定数量的显示行并刷新。", errors: "",
    source: "FunctionIdentifier.cs:683-697", aliases: ["CLEARLINE"], confidence: "high" },
  { name: "BAR", kind: "display", argForm: "SpBarArgument (SP_BAR)",
    semantics: "按 (当前值, 最大值, 长度) 生成进度条字符串输出;BARL 变体输出后换行。", errors: "",
    source: "FunctionIdentifier.cs:1289-1312", aliases: ["BAR", "BARL"], confidence: "high" },
  { name: "PRINTBUTTON", kind: "display", argForm: "SpButtonArgument (SP_BUTTON)",
    semantics: "输出一个可点击按钮:显示文本与按钮值(整型或字符串);文本中的换行被移除。", errors: "",
    source: "Process.cs:1107-1124", aliases: ["PRINTBUTTON"], confidence: "high" },
  { name: "PRINTBUTTONC", kind: "display", argForm: "SpButtonArgument (SP_BUTTON)",
    semantics: "以定宽对齐方式输出按钮;PRINTBUTTONC 右对齐,PRINTBUTTONLC 左对齐。", errors: "",
    source: "Process.cs:1125-1144", aliases: ["PRINTBUTTONC", "PRINTBUTTONLC"], confidence: "high" },
  { name: "PRINTPLAIN", kind: "display", argForm: "ExpressionArgument (STR_NULLABLE / FORM_STR_NULLABLE)",
    semantics: "以无样式纯文本形式输出字符串(不套用用户配色);PRINTPLAINFORM 变体展开表达式。", errors: "",
    source: "Process.cs:1145-1154", aliases: ["PRINTPLAIN", "PRINTPLAINFORM"], confidence: "high" },
  { name: "DRAWLINE", kind: "display", argForm: "ExpressionArgument (VOID)",
    semantics: "输出一行默认样式分隔线并换行。", errors: "",
    source: "Process.cs:1155-1161", aliases: ["DRAWLINE"], confidence: "high" },
  { name: "DRAWLINEFORM", kind: "display", argForm: "ExpressionArgument (FORM_STR)",
    semantics: "用参数字符串(可含表达式)重复填充一行作为分隔线输出并换行。", errors: "",
    source: "Process.cs:1162-1170", aliases: ["DRAWLINEFORM"], confidence: "high" },
  { name: "TOOLTIP_SETDELAY", kind: "display", argForm: "ExpressionArgument (INT_EXPRESSION)",
    semantics: "设置工具提示弹出延迟(毫秒)。", errors: "负值抛 CodeEE。",
    source: "FunctionIdentifier.cs:2023-2041", aliases: ["TOOLTIP_SETDELAY"], confidence: "high" },
  { name: "WAIT", kind: "input", argForm: "ExpressionArgument (VOID)",
    semantics: "等待用户按键;FORCEWAIT 变体禁止用消息跳过来中断等待。", errors: "",
    source: "FunctionIdentifier.cs:762-784", aliases: ["WAIT", "FORCEWAIT"], confidence: "high" },
  { name: "WAITANYKEY", kind: "input", argForm: "ExpressionArgument (VOID)",
    semantics: "等待任意按键(不限回车)。", errors: "",
    source: "FunctionIdentifier.cs:786-798", aliases: ["WAITANYKEY"], confidence: "high" },
  { name: "TWAIT", kind: "input", argForm: "SpSwapCharaArgument (SP_SWAP)",
    semantics: "先执行一次普通按键等待,再进行限时输入:参数 1 为时限毫秒数,参数 2 非 0 时为定时等待(无需回车)。", errors: "",
    source: "FunctionIdentifier.cs:800-825", aliases: ["TWAIT"], confidence: "high" },
  { name: "INPUT", kind: "input", argForm: "SpInputsArgument (SP_INPUT)",
    semantics: "请求用户输入整数存入 RESULT;可带默认值与是否接受鼠标输入标志;消息跳过激活时直接采用默认值。", errors: "",
    source: "FunctionIdentifier.cs:827-869", aliases: ["INPUT"], confidence: "high" },
  { name: "INPUTS", kind: "input", argForm: "SpInputsArgument (SP_INPUTS)",
    semantics: "请求用户输入字符串存入 RESULTS;可带默认值与鼠标输入标志;消息跳过激活时直接采用默认值。", errors: "",
    source: "FunctionIdentifier.cs:871-913", aliases: ["INPUTS"], confidence: "high" },
  { name: "ONEINPUT", kind: "input", argForm: "SpInputsArgument (SP_INPUT)",
    semantics: "请求单键整数输入(一个按键即完成);可带默认值;消息跳过激活时直接采用默认值。", errors: "",
    source: "FunctionIdentifier.cs:915-957", aliases: ["ONEINPUT"], confidence: "high" },
  { name: "TINPUT", kind: "input", argForm: "SpTInputsArgument (SP_TINPUT)",
    semantics: "限时整数输入:参数为时限毫秒、默认值、是否接受鼠标、是否显示剩余时间、超时提示语(缺省用配置);超时取默认值;TONEINPUT 为单键变体。", errors: "",
    source: "FunctionIdentifier.cs:1003-1050", aliases: ["TINPUT", "TONEINPUT"], confidence: "high" },
  { name: "TINPUTS", kind: "input", argForm: "SpTInputsArgument (SP_TINPUTS)",
    semantics: "限时字符串输入,行为同 TINPUT;TONEINPUTS 为单键变体。", errors: "",
    source: "FunctionIdentifier.cs:1052-1099", aliases: ["TINPUTS", "TONEINPUTS"], confidence: "high" },
  { name: "BINPUT", kind: "input", argForm: "SpInputsArgument (SP_INPUT)",
    semantics: "等待用户点击画面上已有的整数值按钮,结果存入 RESULT;若无可点击按钮则直接采用默认值;无按钮且无默认值时抛错。执行前先换行并强制刷新显示。", errors: "无可用按钮且未提供默认值抛 CodeEE。",
    source: "FunctionIdentifier.cs:2113-2215", aliases: ["BINPUT"], confidence: "high" },
  { name: "AWAIT", kind: "display", argForm: "ExpressionArgument (EXPRESSION_NULLABLE)",
    semantics: "暂停指定毫秒数后继续;无参数时无限等待。", errors: "参数为负或超过 10000 抛 CodeEE。",
    source: "FunctionIdentifier.cs:2581-2606", aliases: ["AWAIT"], confidence: "high" },
  { name: "CALL", kind: "flow", argForm: "SpCallArgment (SP_CALL / SP_CALLFORM)",
    semantics: "调用用户定义函数并把实参绑定到其 ARG 变量;JUMP 变体不保留返回点(单向跳转);FORM 变体函数名为表达式;TRY 变体在函数不存在时**跳过本行**(继续执行紧随的下一条语句);TRYC 变体在函数不存在时改跳对应的 CATCH 块。不写 RESULT/RESULTS。注:本反编译版本(1.824)未实现\"被调函数体运行期出错转入 CATCH\"——IS_TRYC 无任何运行期读取者,见上方形态清单注释块。", errors: "运行期函数不存在且非 TRY/TRYC 变体抛 CodeEE(NotDefinedFunc, FunctionIdentifier.cs:3579-3581);装载期常量名查不到且非 try 时置 FunctionoNotFoundName 交 ErbLoader.cs:1615-1625 转成 isError 解析错(:3532-3536);实参转换失败运行期抛 CodeEE(:3592-3596)、装载期 Warn(:3550-3555);目标是事件名(:CalledFunction.cs:100-103)或 #FUNCTION 方法名(:106-109)一律抛 CodeEE 且不受 try 影响。",
    source: "FunctionIdentifier.cs:3489-3600", aliases: ["JUMP", "CALL", "TRYJUMP", "TRYCALL", "JUMPFORM", "CALLFORM", "TRYJUMPFORM", "TRYCALLFORM", "TRYCJUMP", "TRYCCALL", "TRYCJUMPFORM", "TRYCCALLFORM"], confidence: "high" },
  { name: "CALLF", kind: "call", argForm: "SpCallFArgment (SP_CALLF / SP_CALLFORMF)",
    semantics: "调用用户 #FUNCTION 方法并对结果求值,但不跳转、结果不写入 RESULT(仅供副作用/校验);CALLFORMF 变体函数名为表达式。", errors: "函数未定义抛 CodeEE;解析期未找到函数报解析错误。",
    source: "FunctionIdentifier.cs:1101-1167", aliases: ["CALLF", "CALLFORMF"], confidence: "high" },
  { name: "TRYCALLF", kind: "call", argForm: "SpCallFArgment (SP_CALLF / SP_CALLFORMF)",
    semantics: "同 CALLF,但函数不存在时静默跳过**本行**(顺序执行下一条),不报错。装载期 :1264-1267 catch-all 直接 return(不产生 warn),运行期 :1285 用 ?.GetValue 做空操作。flag 与 CALLF 相同(38,不含 IS_TRY),try 性只在实现类上。", errors: "",
    source: "FunctionIdentifier.cs:1237-1287", aliases: ["TRYCALLF", "TRYCALLFORMF"], confidence: "high" },
  { name: "GOTO", kind: "flow", argForm: "SpCallArgment (SP_CALL / SP_CALLFORM)",
    semantics: "跳转到同一函数内的 $ 标签;GOTOFORM 变体标签名为表达式;TRYGOTO 在标签不存在时静默跳过**本行**;TRYCGOTO 在标签不存在时跳到对应 CATCH 块。注:本反编译版本(1.824)无\"目标行运行期出错转入 CATCH\"机制(IS_TRYC 无读取者),与 CALL 条目一致。", errors: "标签不存在且非 TRY 变体抛 CodeEE;解析期常量标签不存在报解析错误。",
    source: "FunctionIdentifier.cs:3629-3719", aliases: ["GOTO", "TRYGOTO", "GOTOFORM", "TRYGOTOFORM", "TRYCGOTO", "TRYCGOTOFORM"], confidence: "high" },
  { name: "BREAK", kind: "flow", argForm: "ExpressionArgument (VOID)",
    semantics: "跳出当前循环:对 REPEAT/FOR 先把计数器按步长补进一次再退出,WHILE/DO 直接退出。", errors: "",
    source: "FunctionIdentifier.cs:3302-3320", aliases: ["BREAK"], confidence: "high" },
  { name: "CONTINUE", kind: "flow", argForm: "ExpressionArgument (VOID)",
    semantics: "进入当前循环的下一次迭代:REPEAT/FOR 先步进计数并判断是否继续;WHILE 重新判断条件;DO 重新判断 LOOP 条件。", errors: "不在可识别的循环结构内抛 ExeEE。",
    source: "FunctionIdentifier.cs:3322-3383", aliases: ["CONTINUE"], confidence: "high" },
  { name: "RETURN", kind: "flow", argForm: "ExpressionArrayArgument (INT_ANY)",
    semantics: "从当前函数返回调用者;参数依次写入 RESULT: 0/1/2…,无参数时 RESULT=0。", errors: "",
    source: "FunctionIdentifier.cs:3242-3272", aliases: ["RETURN"], confidence: "high" },
  { name: "RETURNF", kind: "flow", argForm: "ExpressionArgument (EXPRESSION_NULLABLE)",
    semantics: "从 #FUNCTION 函数返回值;无参数返回 0/空串。", errors: "在非 #FUNCTION 函数中使用为解析错误;返回类型与函数声明不符为解析警告。",
    source: "FunctionIdentifier.cs:3444-3487", aliases: ["RETURNF"], confidence: "high" },
  { name: "RESTART", kind: "flow", argForm: "ExpressionArgument (VOID)",
    semantics: "跳回当前函数开头重新执行。", errors: "",
    source: "FunctionIdentifier.cs:3288-3300", aliases: ["RESTART"], confidence: "high" },
  { name: "BEGIN", kind: "flow", argForm: "STR (常量字符串)",
    semantics: "结束当前函数,把执行状态切换为指定的 BEGIN 入口(如 TITLE/SHOW_STATUS)并重置显示样式;FORCE_BEGIN 为强制变体(当前实现行为一致)。", errors: "",
    source: "FunctionIdentifier.cs:2922-2954", aliases: ["BEGIN"], confidence: "high" },
  { name: "SAVEGLOBAL", kind: "io", argForm: "ExpressionArgument (VOID)",
    semantics: "把全局变量写入全局存档文件。", errors: "",
    source: "FunctionIdentifier.cs:1801-1813", aliases: ["SAVEGLOBAL"], confidence: "high" },
  { name: "LOADGLOBAL", kind: "io", argForm: "ExpressionArgument (VOID)",
    semantics: "从全局存档文件读取全局变量;RESULT 记录 1=成功,0=失败。", errors: "",
    source: "FunctionIdentifier.cs:1815-1834", aliases: ["LOADGLOBAL"], confidence: "high" },
  { name: "RESETDATA", kind: "io", argForm: "ExpressionArgument (VOID)",
    semantics: "重置全部变量数据为初始值并重置显示样式。", errors: "",
    source: "FunctionIdentifier.cs:1836-1849", aliases: ["RESETDATA"], confidence: "high" },
  { name: "DELDATA", kind: "io", argForm: "ExpressionArgument (INT_EXPRESSION)",
    semantics: "删除指定编号存档槽的存档文件。", errors: "槽号为负或过大抛 CodeEE。",
    source: "FunctionIdentifier.cs:1944-1957", aliases: ["DELDATA"], confidence: "high" },
  { name: "SAVEDATA", kind: "io", argForm: "SpSaveDataArgument (SP_SAVEDATA)",
    semantics: "把游戏数据保存到指定槽位,第二个参数为存档描述文本。", errors: "槽号为负或超 int 上限、描述含换行抛 CodeEE;保存失败打印错误信息。",
    source: "Process.cs:1327-1349", aliases: ["SAVEDATA"], confidence: "high" },
  { name: "LOADDATA", kind: "io", argForm: "ExpressionArgument (INT_EXPRESSION)",
    semantics: "从指定槽位读取存档并切换到读档后状态;读档成功后清空调用栈。", errors: "槽号为负或超 int 上限、存档损坏抛 CodeEE;读取失败抛 ExeEE。",
    source: "Process.cs:1841-1863", aliases: ["LOADDATA"], confidence: "high" },
  { name: "DATA", kind: "data", argForm: "STR_NULLABLE / FORM_STR_NULLABLE(原始文本行；DATA 取前者 FunctionIdentifier.cs:4017，DATAFORM 取后者 :4018)",
    semantics: "DATA/DATAFORM 数据行:声明数据内容供 PRINT_DATA 等语句随机抽取;运行时本身无独立行为,由消费方读取。", errors: "",
    source: "FunctionIdentifier.cs:4017-4018", aliases: ["DATA", "DATAFORM"], confidence: "high" },
  { name: "RANDOMIZE", kind: "other", argForm: "ExpressionArgument (INT_EXPRESSION_NULLABLE)",
    semantics: "以参数为种子重置随机序列;启用 UseNewRandom 配置时仅发出警告并忽略。", errors: "UseNewRandom 时输出警告。",
    source: "FunctionIdentifier.cs:1734-1755", aliases: ["RANDOMIZE"], confidence: "high" },
  { name: "PLAYSOUND", kind: "other", argForm: "SpHtmlPrint (SP_HTML_PRINT)",
    semantics: "播放 sound 目录下的音频文件,第二参数为重复次数(最小 1);文件不存在时静默跳过。", errors: "音频格式不兼容抛 CodeEE。",
    source: "FunctionIdentifier.cs:2608-2652", aliases: ["PLAYSOUND"], confidence: "high" },
  { name: "STOPSOUND", kind: "other", argForm: "ExpressionArgument (VOID)",
    semantics: "停止全部正在播放的音效。", errors: "",
    source: "FunctionIdentifier.cs:2654-2676", aliases: ["STOPSOUND"], confidence: "high" },
  { name: "SKIPDISP", kind: "other", argForm: "ExpressionArgument (INT_EXPRESSION)",
    semantics: "设置显示跳过标志(参数非 0 开启);RESULT 记录设置后的状态;跳过期间所有 PRINT 类输出被抑制。", errors: "",
    source: "Process.cs:1587-1592", aliases: ["SKIPDISP"], confidence: "high" },
  { name: "GETTIME", kind: "other", argForm: "ExpressionArgument (VOID)",
    semantics: "把当前时间写入 RESULT(YYYYMMDDHHMMSSmmm 数字形式)与 RESULTS(yyyy/MM/dd HH:mm:ss 字符串)。", errors: "",
    source: "Process.cs:1396-1408", aliases: ["GETTIME"], confidence: "high" },
  { name: "THROW", kind: "other", argForm: "ExpressionArgument (FORM_STR_NULLABLE)",
    semantics: "以参数字符串为消息抛出脚本异常,可被 TRYC 结构捕获。", errors: "总是抛 CodeEE(消息为参数值)。",
    source: "Process.cs:1796-1797", aliases: ["THROW"], confidence: "high" },
  { name: "DOTRAIN", kind: "other", argForm: "ExpressionArgument (INT_EXPRESSION)",
    semantics: "切换到指定命令编号的训练执行状态(DO TRAIN 流程)。", errors: "当前系统状态不允许、参数为负或超出 TRAINNAME 数组范围抛 CodeEE。",
    source: "Process.cs:1931-1954", aliases: ["DOTRAIN"], confidence: "high" },
];

const ERB_INSTRUCTION_SPEC_BY_NAME: ReadonlyMap<string, ErbInstructionSpec> = new Map(
  ERB_INSTRUCTION_SPECS.flatMap((spec) => [spec.name, ...spec.aliases].map((n) => [n.toUpperCase(), spec] as const)),
);

/** 按条目名或任一注册别名查（大小写不敏感）；查不到 = 不猜。 */
export function erbInstructionSpecOf(name: string): ErbInstructionSpec | undefined {
  return ERB_INSTRUCTION_SPEC_BY_NAME.get(name.trim().toUpperCase());
}
// @erb-instruction-specs:end

// @erb-engine-error-texts:begin
/**
 * 引擎报错原话 —— **生成区间，勿手改**；由 `node tools/gen-erb-error-texts.mjs` 重生成。
 *
 * 真源：eratw-安卓移植计划 `specs/error-texts.yaml`（原版 `Lang.Error` 文案表）。
 *       日文原文 `MinorShift.Emuera.Runtime.Utils.EvilMask/Lang.cs`、
 *       中文译文 `MinorShift.Emuera.Properties.lang.emuera-zhs.xml`，
 *       抛出点锚在 `ArgumentBuilder.cs` / `ArgumentParser.cs` / `ErbLoader.cs`。
 * 快照：`tools/data/error-texts.yaml`，sha256 = `d83904f70174296a400eb4d241320793dab6f0e1d1db21150a9a0fe2f1ffb0b4`。
 * 条数：104（wired 54 / registered 50）。
 *
 * 为什么要有这张表：这些文案是**玩家实际看到过的原文**（线上项目数千玩家校验），
 * 编辑器自己另写一套措辞，作者按引擎原话去搜社区/提问时就对不上号。凡引擎有原话的诊断，
 * 一律以原文为锚，编辑器要补充定位信息就**追加**在原文之后，不改写原文。
 *
 * 字段口径：
 * - `args` = `string.Format` 占位符个数（`{0}`…`{args-1}`），与 yaml 逐条自洽；
 * - `status` = `wired`（引擎确实会抛）/ `registered`（键已登记、调用点仍用旧串）；
 * - `zhs` = 中文原文**逐字**（只做按序号原位替换，不 trim、不改引号形态、不修误译——
 *   照抄纪律见上游 ADR-005）。
 *
 * 日文原文、英文译文与抛出点锚不在运行时表里：它们只在审计时用，随 yaml 快照留在
 * `tools/data/`，由 `tests/engine-error-texts.test.ts` 读。
 */
export interface ErbEngineErrorText {
  /** `string.Format` 占位符个数（`{0}`…`{args-1}`） */
  readonly args: number;
  /** `wired` = 引擎真会抛；`registered` = 键已登记、调用点仍用旧串 */
  readonly status: 'wired' | 'registered';
  /** 简体中文原话（逐字；占位符留在原位） */
  readonly zhs: string;
}

/** 全部引擎报错原话（键 = `Lang.Error` 的键名，去掉 `Error.` 前缀；按 id 升序） */
export const ERB_ENGINE_ERROR_TEXTS: Readonly<Record<string, ErbEngineErrorText>> = {
  AbnormalPrint: { args: 0, status: "wired", zhs: "PRINT异常" },
  AbnormalPrintdata: { args: 0, status: "registered", zhs: "PRINTDATA异常" },
  ArgIsConst: { args: 1, status: "registered", zhs: "第{0}参数不能指定为只读变量" },
  ArgIsNotRequired: { args: 0, status: "wired", zhs: "不需要参数" },
  ArgIsNotVariable: { args: 1, status: "wired", zhs: "第{0}参数必须为变量" },
  ArgIsOoRBit: { args: 2, status: "registered", zhs: "第{0}参数({1})超出范围(0-63)" },
  ArgsCountNotMatches: { args: 3, status: "wired", zhs: "{0}函数: 需要{1}个参数，但传入了{2}个" },
  ArgsNotFitExpr: { args: 4, status: "wired", zhs: "{0}函数: 参数数量({1})不满足{2}+{3}n" },
  ArgsNotNeeded: { args: 1, status: "wired", zhs: "{0}函数: 不需要参数" },
  ArraycopyArgIsCharaVar: { args: 2, status: "registered", zhs: "ARRAYCOPY命令的第{0}参数\"{1}\"是一个角色变量(不支持)" },
  ArraycopyArgIsNotArray: { args: 2, status: "registered", zhs: "ARRAYCOPY命令的第{0}参数\"{1}\"不是一个数组变量" },
  AssertArgIs0: { args: 0, status: "registered", zhs: "ASSERT的参数为0" },
  AwaitArgIsNegative: { args: 1, status: "registered", zhs: "AWAIT命令:指定了一个负值({0})" },
  AwaitArgIsOver10Seconds: { args: 1, status: "registered", zhs: "AWAIT命令:指定了一个超过10秒的值({0}ms)" },
  BarNotPositive: { args: 0, status: "registered", zhs: "BAR的长度不为正值" },
  CallCharaVarAsVar: { args: 1, status: "wired", zhs: "角色变量\"{0}\"被当作非角色变量调用" },
  CalledFailedFunc: { args: 0, status: "wired", zhs: "调用了一个加载时解析失败的函数" },
  CanNotInterpretSharpLine: { args: 0, status: "registered", zhs: "解析#行失败" },
  CanNotOmitRefArg: { args: 2, status: "wired", zhs: "@{0}的第{1}个参数是引用形式因此无法省略" },
  CanNotRecognizeArg: { args: 1, status: "wired", zhs: "无法识别第{0}参数" },
  CanNotRenameKey: { args: 1, status: "registered", zhs: "发现词法解析中无法被替换(rename)的符号{0}" },
  CanNotUseInstruction: { args: 1, status: "registered", zhs: "不能使用{0}命令" },
  DifferentArraycopyArgsDim: { args: 0, status: "registered", zhs: "ARRAYCOPY命令的两个参数维度不一致" },
  DifferentArraycopyArgsType: { args: 0, status: "registered", zhs: "ARRAYCOPY命令的两个参数的数组变量类型不一致" },
  DivideByZero: { args: 0, status: "registered", zhs: "除数为0的除法运算" },
  DuplicateCharaNo: { args: 1, status: "registered", zhs: "同一个角色登记编号({0})被多次指定" },
  EmptyRefVar: { args: 1, status: "wired", zhs: "引用类型变量\"{0}\"缺少引用对象" },
  EmptyTwoSBrackets: { args: 0, status: "registered", zhs: "空的[[]]" },
  ExtraCharacterAfterArg: { args: 0, status: "wired", zhs: "参数后面有一个多余的字符" },
  GetSize0DCharaVar: { args: 1, status: "wired", zhs: "试图获取一个非数组角色变量\"{0}\"的长度" },
  GetSizeCharaVarWithoutDim: { args: 2, status: "wired", zhs: "试图获取一个{0}维角色变量\"{1}\"的长度" },
  GetSizeDimError: { args: 2, status: "wired", zhs: "试图获取一个{0}维数组变量\"{1}\"的长度" },
  GetSizeNonExistDim: { args: 1, status: "wired", zhs: "试图获取一个不存在该维度的数组变量\"{0}\"的长度" },
  IgnoreArgBecauseNotInt: { args: 0, status: "wired", zhs: "第二个参数因为不是整型数值而被忽略" },
  IncorrectArg: { args: 1, status: "wired", zhs: "第{0}参数的类型错误" },
  Instruction: { args: 0, status: "wired", zhs: "命令:" },
  InstructionNotClosed: { args: 3, status: "registered", zhs: "在{0}没有对应{1}情况下运行到{2}语句" },
  InvalidCharacterAfterInstruction1: { args: 1, status: "registered", zhs: "以命令开始的行在命令后有半角空格和水平制表符以外的文字(此警告可以用系统配置「{0}」来无视)" },
  InvalidCharacterAfterInstruction2: { args: 0, status: "registered", zhs: "以命令开始的行在命令后有半角空格和水平制表符以外的文字" },
  InvalidColorName: { args: 1, status: "registered", zhs: "指定的颜色名\"{0}\"无效" },
  InvalidElse: { args: 1, status: "wired", zhs: "在IF-ENDIF以外使用了\"{0}\"" },
  IsNotInt: { args: 1, status: "wired", zhs: "{0}不是整型" },
  IsNotStr: { args: 1, status: "wired", zhs: "{0}不是字符串型" },
  IsNotVar: { args: 1, status: "wired", zhs: "{0}不是变量" },
  IsUsableOnly1DVar: { args: 1, status: "registered", zhs: "{0}仅对1位数组以及数组型角色变量有效" },
  LoaddataArgIsNegative: { args: 1, status: "registered", zhs: "LOADDATA的参数被指定为负数({0})" },
  MacroOverLimit: { args: 1, status: "registered", zhs: "宏展开的次数超过单次展开上限值{0}(可能是因为自我调用・循环调用)" },
  MaxBarNotPositive: { args: 0, status: "registered", zhs: "BAR的最大值不为正值" },
  MissingArg: { args: 0, status: "wired", zhs: "缺少参数" },
  MissingArgAfterComma: { args: 0, status: "wired", zhs: ",'后面必须存在一个参数" },
  MissingCorresponding: { args: 2, status: "wired", zhs: "缺少\"{0}\"对应的\"{1}\"" },
  MissingNoskip: { args: 1, status: "wired", zhs: "缺少NOSKIP系列命令对应的{0}" },
  MissingPrintdataStrdata: { args: 1, status: "wired", zhs: "缺少PRINTDATA系列命令或STRDATA系列命令对应的{0}" },
  MissingTryc: { args: 0, status: "wired", zhs: "缺少对应的TRYC系统命令" },
  MissingTrycalllist: { args: 1, status: "wired", zhs: "缺少TRYCALLLIST系列命令对应的{0}" },
  MissingTwoSBrackets: { args: 0, status: "registered", zhs: "没有对应\"]]\"的\"[[\"" },
  MissingVarArg: { args: 1, status: "wired", zhs: "变量\"{0}\"缺少必要的参数" },
  Multiply10kToStr: { args: 1, status: "registered", zhs: "字符串无法与超过10000的值({0})进行相乘运算" },
  MultiplyNegativeToStr: { args: 1, status: "registered", zhs: "字符串无法与负值({0})进行相乘运算" },
  NotDefinedLabelName: { args: 1, status: "wired", zhs: "当前函数中不存在指定的标签名\"${0}\"" },
  NotEnoughArgs: { args: 2, status: "wired", zhs: "{0}函数: 至少需要{1}个参数" },
  NotEnoughArguments: { args: 0, status: "wired", zhs: "参数过少" },
  OmittedArg1: { args: 0, status: "wired", zhs: "必要的参数被省略了。Emuera自动补0" },
  OmittedArg2: { args: 0, status: "wired", zhs: "必要的参数被省略了。Emuera自动补0，但在eramaker中的行为未定义" },
  OoRArrayRemove: { args: 2, status: "registered", zhs: "命令ARRAYREMOVE的第二个参数({0})超出了数组\"{1}\"的范围" },
  OoRArrayShift: { args: 2, status: "registered", zhs: "命令ARRAYSHIFT的第四个参数({0})超出了数组\"{1}\"的范围" },
  OoRArraySort: { args: 2, status: "registered", zhs: "命令ARRAYSORT的第三参数({0})超出了数组\"{1}\"的范围" },
  OoRCharaVar: { args: 3, status: "registered", zhs: "角色数组变量\"{0}\"的第{1}参数({2})超出数组范围" },
  OoRCharaVarArg: { args: 3, status: "wired", zhs: "角色数组变量\"{0}\"的第{1}个变量({2})超出角色登记编号的最大范围" },
  OoRCvarsetArg: { args: 2, status: "registered", zhs: "CVARSET命令的第{0}参数({1})超出角色范围" },
  OoRForcekanaArg: { args: 0, status: "registered", zhs: "命令FORCEKANA的参数超过可指定范围(0～3)" },
  OoRInstructionArg: { args: 4, status: "wired", zhs: "{0}命令的第{1}个参数({2})超出数组\"{3}\"的范围" },
  OoRPickupcharaArg: { args: 2, status: "registered", zhs: "命令PICKUPCHARA的第{0}个参数的值({1})超过角色列表的范围" },
  OoRSavecharaArg: { args: 1, status: "registered", zhs: "SAVECHARA第{0}参数的值超出角色登记编号的范围" },
  OoRVarArg: { args: 3, status: "wired", zhs: "数组变量\"{0}\"的第{1}参数({2})超出数组范围" },
  OutsideSelectcase: { args: 1, status: "wired", zhs: "在SELECTCASE语法的分支以外包含命令\"{0}\"" },
  RefUndefinedChara: { args: 0, status: "registered", zhs: "试图引用一个尚未定义的角色" },
  SavedataArgIsNegative: { args: 1, status: "registered", zhs: "对SAVEDATA的参数使用负值({0})" },
  SavetextContainNewLineCharacter: { args: 0, status: "registered", zhs: "SAVEDATA对的提示文本使用了换行符号（由于会导致存档损坏，不能使用换行符）" },
  SetIntToStr: { args: 1, status: "wired", zhs: "尝试将整数赋值给非整数型变量\"{0}\"" },
  SetStrToInt: { args: 1, status: "wired", zhs: "尝试将字符串赋值给非字符串变量\"{0}\"" },
  SetcolorArgLessThan0: { args: 0, status: "registered", zhs: "SETCOLOR的参数指定了小于0的值" },
  SetcolorArgOver255: { args: 0, status: "registered", zhs: "SETCOLOR的参数指定了超过0的值" },
  TooLargeLoaddataArg: { args: 1, status: "registered", zhs: "LOADDATA的参数值({0})过大" },
  TooLargeSavedataArg: { args: 1, status: "registered", zhs: "SAVEDATA的参数值过大({0})" },
  TooLongBar: { args: 0, status: "registered", zhs: "BAR过长" },
  TooManyArg: { args: 0, status: "wired", zhs: "参数过多" },
  TooManyFuncArgs: { args: 1, status: "wired", zhs: "{0}函数: 参数过多" },
  TransparentUnsupported: { args: 0, status: "wired", zhs: "不能将透明(Transparent)指定为颜色" },
  UnexpectedCharacter: { args: 1, status: "registered", zhs: "词法解析中出现意料之外的字符'{0}'" },
  UnexpectedDatalist: { args: 0, status: "registered", zhs: "缺少PRINTDATA系列命令对应的DATALIST" },
  UnexpectedEndcatch: { args: 0, status: "wired", zhs: "缺少CATCH对应的ENDCATCH" },
  UnexpectedEndif: { args: 0, status: "wired", zhs: "缺少IF对应的ENDIF" },
  UnexpectedEndlist: { args: 0, status: "wired", zhs: "缺少DATALIST对应的ENDLIST" },
  UnexpectedEndselect: { args: 0, status: "wired", zhs: "应对selectcase无endselect文。" },
  UnexpectedFullWidthSpace: { args: 1, status: "registered", zhs: "发现意料之外的全角空格(此警告可以用系统配置「{0}」来无视)" },
  Use2EqualToAssign: { args: 0, status: "wired", zhs: "使用”==”作为赋值运算符" },
  VarNameAlreadyUsed: { args: 1, status: "wired", zhs: "变量名\"{0}\"已经被使用" },
  VarStartedHalfDigit: { args: 1, status: "wired", zhs: "变量名\"{0}\"以半角数字开始" },
  WrongFormat: { args: 0, status: "wired", zhs: "格式错误" },
  XmlGetError: { args: 2, status: "registered", zhs: "XML_GET函数:\"{0}\"的解析错误:{1}" },
  XmlGetPathError: { args: 2, status: "registered", zhs: "XML_GET函数:XPath\"{0}\"的解析错误:{1}" },
  ZeroDVarHasArg: { args: 1, status: "wired", zhs: "变量\"{0}\"不是数组却带了一个参数" },
  tooLongEncodetouniArg: { args: 2, status: "registered", zhs: "ENCODETOUNI的参数过长（目前共{0}字符。最大{1}字符）" },
};

/**
 * 按序号原位替换 `{0}`…`{n}`（引擎 `string.Format` 的同口径最小实现）。
 *
 * 三条纪律与上游一致：**只替换、不 trim、不改引号形态**；缺参数时把占位符原样留下
 * （让缺参可见，而不是悄悄插一个空串）。未登记的 id ⇒ `undefined`，**绝不编造文案**——
 * 未登记是上游漏了表，该由审计闸报错，不在这里猜。
 */
export function formatEngineErrorText(
  id: string,
  values: readonly (string | number)[] = [],
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(ERB_ENGINE_ERROR_TEXTS, id)) return undefined;
  const text = ERB_ENGINE_ERROR_TEXTS[id]!.zhs;
  return text.replace(/\{(\d+)\}/g, (whole, digits: string) => {
    const value = values[Number(digits)];
    return value === undefined ? whole : String(value);
  });
}
// @erb-engine-error-texts:end

/**
 * 引擎保留名 = **spec 权威名单 ∪ 语料实证补充名**（ERBDIAG-ERATW）。
 *
 * spec 那一半来自 eratw 的 `specs/variables.yaml`（反编译 C# 逐条带行号锚），
 * 由 `tools/gen-erb-engine-names.mjs` 生成到上方标记区间（共 161 枚）——
 * 覆盖过去手抄表漏掉的 `COUNT` / `Y` / `__INT_MAX__` / `ITEMSALES` / `GLOBALS` 等
 * （语料闸门曾把这几枚定性为 `engine-builtin-vocab-gap`，见
 * `plugins/erb-parser/tests/undefined-name.corpus.test.ts` 的 RESIDUAL_LEDGER）。
 *
 * 语料补充那一半只有 `NOW`：反编译 spec 里查无此名，但 eraTW 语料高频用作循环时刻量，
 * 未定义名诊断不得报它——故保留。判据：任何新增名必须能给出 C# 锚或语料实证，不许拍脑袋。
 */
export const ERB_ENGINE_RESERVED_IDENTIFIERS: readonly string[] = [
  ...new Set([...ERB_ENGINE_NAME_LIST, 'NOW']),
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
