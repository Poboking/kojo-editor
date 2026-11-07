/**
 * ERB **词法判据**的契约层单一出口（零 import 叶子，子路径 `@kojo/plugin-api/erb-lexical`）。
 *
 * 本文件收两把尺，各自回答一个问题、互不替代：
 * | 尺 | 问题 | 读者 |
 * | --- | --- | --- |
 * | 行首代码前缀（`;!;` / `;#;`） | 这一行是注释还是代码 | 骨架扫描 / 控制流遍历 / 预处理体检 / 可见行遍历 / 着色 / 条件抽取 |
 * | 引擎名字段尺（`ERB_ENGINE_NAME_DELIMITERS`） | 引擎读一个变量名读到哪为止 | 未定义名腿 / 宿主改名台账 / 引用面板取词 |
 *
 * 两把尺同住一枚叶子的理由（2026-11-07 rebase 到 dev 的合并裁决）：它们的**落点约束逐字相同**
 * ——跨插件共享（审计 C 禁插件互引）⇒ 只能住契约层；被 `erb-parser/scanner.ts` 再导出，而
 * scanner 由 `erb-syntax-tree/tools/gen-erb-structure.mjs` 用**裸 node** 动态 import ⇒ 必须零
 * import 且单开 `exports` 一格。PS-10 开机图**文件闸 197 顶格**，两枚同约束的叶子各占一格就
 * 越闸 ⇒ 合成一枚"ERB 词法判据"模块，判据份数不变（各仍只有一份定义），图内少一枚文件。
 *
 * ## 语言事实：行首「代码前缀」——`;!;` 与 `;#;` **不是注释**（2026-10-25 ERB 语法缺口批 P2-1）
 *
 * Emuera 认两种以 `;` 起头的**有效代码**前缀（来源：Era Wiki `Emuera/exetc`）：
 * - `;!;` —— "这行是 Emuera 专用语句"：eramaker 会当注释跳过，Emuera 照常执行。
 *   作者用它写"老引擎跑不动、但我不想让它变成注释"的行；
 * - `;#;` —— "这行只在调试模式执行"（等价于把这一行包进 `[IF_DEBUG]`）。
 *
 * 两种前缀之后的整段都是**正常 ERB 代码**：`;!;PRINTL あ` 会真的输出，
 * `;!;[SKIPSTART]` 会真的开停用区。把它们当整行注释吞掉，后果不止"少着一点色"——
 * `;!;[SKIPSTART]` 与后面对称的 `[SKIPEND]` 会**失配**，之后整篇文件的行可见性全错
 * （索引、波浪线、条件矩阵一起歪）。
 *
 * ## 为什么住在 `plugin-api`
 *
 * 这条判据要落到七个地方：骨架扫描（`parseErbText`）、控制流遍历
 * （`forEachControlFlowLine`）、预处理块体检（`checkPreprocStructure`）、
 * 可见行遍历（`visibleCodeLines`）、语法着色（`erb-highlight` / Monarch）、
 * 条件抽取（`condition-extractor`）。七处各写一遍 `startsWith(';!;')` 就是七份判据，
 * 迟早漂一次 ⇒ 与 `[SKIPSTART]` 的严格等值判据同一条纪律：**判据只有一个出口**。
 * 出口必须落在 `plugin-api`：`condition-extractor` 与 `erb-parser` 是**两个插件**，
 * 插件之间禁止互相 import（解耦审计 C 项），而两边都要这条判据 ⇒ 只有契约层能同时被两边引用
 * （与 `isErbDialectPath` / `MODEL_TOKEN_CLASS` 住在同一层的理由相同）。
 *
 * ## 口径细节
 *
 * - 前缀**必须顶格**（`trimmed` 之后判断）：缩进允许，因为 `trimmed` 已去掉行首空白；
 *   但 `;!;` 与代码之间**不要求**空白（`;!;PRINTL` 合法，语料里就是这么写的）。
 * - 大小写不敏感（`;#;` 与 `;!;` 都不含字母，但判据仍按不敏感写，避免将来加前缀时口径分叉）。
 * - `;!;` / `;#;` 之后的 `;` **仍是注释**（`;!;PRINTL x ;说明` 的尾巴由 `codeViewOf` 刷白）。
 * - 前缀本身**不产生列偏移修正**：本模块只回答"去掉前缀后的正文是什么"，
 *   `prefixLength` 单独给，让算列坐标的调用方自己加（`nameColumn` / `keywordEnd` 两处）。
 */

/** 行首代码前缀（顺序即匹配优先级；都是 3 个字符，故长度按 `PREFIX_LENGTH` 常量） */
export const ERB_CODE_PREFIXES: readonly string[] = [';!;', ';#;'];

/** 三种前缀的长度（`;!;` / `;#;` 同为 3；留常量是为了调用方不必再算） */
export const ERB_CODE_PREFIX_LENGTH = 3;

/**
 * 行首代码前缀的**长度**（0 = 没有前缀）。
 *
 * 只认 `trimmed` 起头的前缀；`; !;` / `;! ;` 这类中间带空白的形态**不认**——
 * 引擎是按字面前缀匹配的，宽容会让 `;!;` 与 `; !;` 两种写法走出不同语义。
 */
export function erbCodePrefixLength(trimmed: string): number {
  if (trimmed.length < ERB_CODE_PREFIX_LENGTH) return 0;
  const head = trimmed.slice(0, ERB_CODE_PREFIX_LENGTH);
  for (const prefix of ERB_CODE_PREFIXES) {
    if (head === prefix) return ERB_CODE_PREFIX_LENGTH;
  }
  return 0;
}

/**
 * 去掉行首代码前缀后的**代码正文**（无前缀 ⇒ 原样返回，零分配）。
 *
 * 注意返回的是 `trimmed` 的子串，**列坐标按调用方原串算**：正文比原串短
 * `erbCodePrefixLength()` 个字符。
 */
export function erbCodeBodyOf(trimmed: string): string {
  const len = erbCodePrefixLength(trimmed);
  return len === 0 ? trimmed : trimmed.slice(len);
}

/**
 * 是否**真注释行**（`;` 起头，且不是 `;!;` / `;#;` 代码前缀）。
 *
 * 所有"整行注释"的判定都该走这里——直接写 `startsWith(';')` 会把 `;!;` 的代码行也吞掉。
 */
export function isErbCommentLine(trimmed: string): boolean {
  return trimmed.startsWith(';') && erbCodePrefixLength(trimmed) === 0;
}

/* ============================ 第二把尺：引擎名字段 ============================
 *
 * 引擎名字尺（D01b，2026-11-06）：「Emuera 把这一串字符读作**一枚**名字」的判据，
 * **全仓唯一一份定义**（守门测试＝`packages/plugin-api/tests/erb-name-ruler-single-source.test.ts`）。
 * 落点约束（契约层 + 零 import + 子路径）与本文件第一把尺逐字相同，见文件头注。
 *
 * ## 与 `semantic-locate.ts` 的 `MODEL_TOKEN_CLASS` 是**两把尺、两个问题**，不许合并
 *
 * - `MODEL_TOKEN_CLASS`（`[\p{L}\p{N}_]`）答的是「**着色 / 补全**把哪个字符范围当一个记号」——
 *   记号尺，服务编辑器外观与函数记号查表；
 * - 下面这枚答的是「**引擎**读一个变量名时读到哪为止」——名字段尺，服务引用判据与改名台账。
 *
 * 把 `MODEL_TOKEN_CLASS` 改成引擎尺＝同时打坏着色与改名两条链（引擎的 `.` `~` `?` `#` `$` `@`
 * 一旦进记号集，`FORM_P0` 与 `P0` 会连成一坨）；反过来把本尺收窄成记号尺＝`P23温泉·更衣间`
 * 在 `·`(U+00B7) 处被劈成两段，引擎眼里的一枚名字在编辑器里变两枚。故两把尺**并存**是设计，
 * 不是债；守门测试里有一条专门钉「两把尺的字符类不相等」。
 *
 * ## 分隔集的真源
 *
 * 引擎 `Emuera/Runtime/Script/Parser/LexicalAnalyzer.cs` 的 `_searchValues`，**逐码位抄录**，
 * 一字符不许多、不许少。`ReadSingleIdentifierROS` 就是「读到任一分隔符为止」⇒
 * **引擎眼里的名字 = 不含下列字符的极大段**。
 *
 * 注意引擎这串里 `.` `~` `?` `#` `$` `@` **是**分隔符、反引号 **不是**；
 * 非 ASCII 只列了全角空格 `\u3000`（半角空格与制表也在内）。与声明侧排除集的逐字符差异
 * 由 `erb-parser/tests/undefined-name.drift.test.ts` 钉死，不许静默漂移。
 */

export const ERB_ENGINE_NAME_DELIMITERS = ' \t　.+-*/%=!<>|&^~?#)}],:({[$\'"@;';

/** 引擎分隔集的 ASCII 查表位（由上面那一串填出，不另抄） */
const ENGINE_DELIM_ASCII = new Uint8Array(128);
/** 引擎分隔集里的非 ASCII 码位（由上面那一串填出；现只有 `\u3000`） */
const ENGINE_DELIM_EXTRA = new Set<number>();
for (const ch of ERB_ENGINE_NAME_DELIMITERS) {
  const code = ch.codePointAt(0)!;
  if (code < 128) ENGINE_DELIM_ASCII[code] = 1;
  else ENGINE_DELIM_EXTRA.add(code);
}

/**
 * 引擎口径的**名字字符**判据（码位；未定义名腿切记号用的就是它）。
 *
 * `NaN` = 空串上的 `charCodeAt(0)`：不是字符，也就不是名字字符。
 */
export function isErbEngineNameCode(code: number): boolean {
  if (!Number.isFinite(code)) return false;
  if (code < 128) return ENGINE_DELIM_ASCII[code] === 0;
  return !ENGINE_DELIM_EXTRA.has(code);
}

/** 由同一串真源组装的正则字符类（`u` 旗安全：控制码位与非 ASCII 一律写 `\uXXXX`） */
function engineNameClassSource(): string {
  let out = '[^';
  for (const ch of ERB_ENGINE_NAME_DELIMITERS) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code > 0x7e ? `\\u${code.toString(16).padStart(4, '0')}` : /[\\\]^[-]/.test(ch) ? `\\${ch}` : ch;
  }
  return `${out}]`;
}

/**
 * 名字段的**正则形态**（与 {@link isErbEngineNameCode} 同源的另一个出口）：
 * `new RegExp(ERB_NAME_RUN_SOURCE + '+', 'gu')` 切出来的段 = 引擎读到的极大名字段。
 * 需要正则的消费方**只许**引这一枚，再写一遍字符类就是第二判据。
 */
export const ERB_NAME_RUN_SOURCE = engineNameClassSource();
