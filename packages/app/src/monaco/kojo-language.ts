import type * as Monaco from './entry';
import type { LineDecoration } from '@kojo/plugin-api';
import { kojoMonacoExtensions } from '@kojo/plugin-api';
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/kojo-vocab/engine';
import { sugarEditorLexicon } from '@kojo/kojo-vocab/keywords';
import { SYSTEM_FUNCTION_ALIASES } from '@kojo/kojo-vocab/system-functions';
import { sugarEnterRulePatterns } from '@kojo/kojo-vocab/enter';
import { ERB_DECLARATION_LINE_RE, ERB_DIRECTIVES, ERB_PREPROC_LINE_RE } from './erb-directives';
import { ERB_HIGHLIGHT_EXTRA_WORDS } from './erb-highlight-words';
import { toMonacoEnterConfig } from './enter-rules';
import { CJK_WORD_PATTERN } from './word-separators';
import { ROLE } from '@kojo/kojo-sdk/semantic-roles';

/**
 * `.kojo` 表层 DSL 编辑器支持 —— Monarch 词法 + 语言配置。
 *
 * 依据：`docs/SYNTAX-SUGAR-SURFACE-SPEC.md`（表层语法 v1.2）。本文件住**宿主层**
 * （app 壳），因为 Monaco 不属任何插件（插件契约刻意不依赖 Monaco）。
 *
 * 词表**单一真源**：中文主形 / 英文别名 / 运算符 / 不等待标记 / `不在` / 保留代词
 * 一律取自 `kojo-sugar` 转译器自身的聚合词表 `sugarEditorLexicon()`（HK-11① 的中文
 * 系统函数名取 `SYSTEM_FUNCTION_ALIASES`，引擎族头取 `ENGINE_VARIABLE_FAMILIES`），
 * 故**高亮 / 补全 / 悬停与转译器词法永不脱节**——本文件不复制任何词形清单
 * （守卫：`packages/app/tests/kojo-lexicon-single-source.test.ts` 逐文件扫宿主源码，
 * 词表里的中文词形一旦在本层被手抄成字面量就红）。
 * 与手写 ASCII 词表（叶子模块 `erb-directives.ts` 的 `ERB_DIRECTIVES`）的取舍不同：
 * `.kojo` 词表是活表，并行批次随时往表里登记新的中文主形，宿主侧必须**零改动**就认得；
 * 而原生直通行的指令档（`ERB_COMMANDS`）恰恰**派生自**那份 ASCII 真源——
 * 本文件不写任何指令字串，凡出现即手抄（守卫扫描见 `erb-directive-words.test.ts`）。
 *
 * 着色分层（"屏上一眼看出还剩哪一层没中文化"）：档位表见 `KOJO_TOKEN_TIERS`，
 * 判据（每档前景互不相同 + 对比度/色差不得低于既有档位基线）在
 * `packages/app/tests/kojo-token-tiers.test.ts` 里复跑。
 *
 * 高亮是**最佳努力**（Monarch 非 LR 解析器，规范 §7 已定调 v1 走 Monarch；
 * 精确结构判定在 `kojo-sugar` 转译器，波浪线由 `ui.editor.decorator` 槽给出）。
 */

/**
 * **封存层（kojo1 / 命令式 Kojo）的语言 id**（LAU-3，2026-10-27 改名批）。
 *
 * 旧值 `'kojo-sugar'`。改名的理由与边界：
 * - 作者面只有一个「kojo」＝ 2.0（`kojo2` 的 label 就是 `kojo`）；v1 上屏一律叫
 *   「kojo1（封存）」，id 跟着叫 `kojo-legacy`，屏上/代码里不再出现 `kojo-sugar` 这个
 *   看起来像"当前语言"的名字；
 * - **只改语言 id，不改插件 id**：`plugins/kojo-sugar/src/index.ts` 那枚 `id: 'kojo-sugar'`
 *   是插件注册名，2.0 侧还在 import 这个包（`kojo2-language-lexicon.test.ts` 取 `sugarEditorLexicon`），
 *   改它是另一场迁移，不在本批；
 * - 常量名仍叫 `KOJO_LANGUAGE_ID`（全仓 200+ 处引用；`audit:language` 的 M2 棘轮按
 *   `*_LANGUAGE_ID` **常量名**计数，改名不减反增）。名字是历史包袱，语义由本注与
 *   descriptor 的 `availability: 'legacy'` 说清。
 * - 旧 id 的兼容读在 `ui/language-mode-pref.ts`（作者手工钉过的语言模式覆盖值）。
 */
export const KOJO_LANGUAGE_ID = 'kojo-legacy';

/**
 * kojo1 的**行注释起头**（ERB-PARITY G9，addition）。
 *
 * 唯一一份：本文件 `setLanguageConfiguration` 的 `comments.lineComment` 格与
 * `languages.ts` 里 descriptor 的 `lineComment` 格都取它——宿主的文档链接按 descriptor 判
 * 注释口径，两处各写一个 `';'` 就是"两把尺子"（链接会在 `;` 与别的记号之间摇摆）。
 * 与 ERB 同为 `;` 是语法事实（v1 的 `;` 是行注释，`#` 是声明锚），不是巧合，也不许合并常量：
 * 两门语言各有一份自己的注释记号，改一门不该顺带改另一门。
 */
export const KOJO1_LINE_COMMENT = ';';

/**
 * 宿主唯一词表入口（`sugarEditorLexicon()` 的聚合原样转发，**不做任何加工**：
 * 加工即抄本，抄本必发散）。
 */
export const KOJO_LEXICON = sugarEditorLexicon();

/** 中文主形关键字（语义高亮用；规范 §4.1「中英双收但中英不对等展示」） */
export const PRIMARY_WORDS = KOJO_LEXICON.words.filter((w) => w.primary);
/** 英文隐藏别名（输入即生效，高亮为次要色；不进补全列表） */
const ALIAS_WORDS = KOJO_LEXICON.words.filter((w) => !w.primary).map((w) => w.word);

/** 表层不等待标记（规范 §3.3：`续` / `~` / `⏎` / `cont` / `continue`）——单独着色以示"它改的是行为" */
export const CONT_MARKS: readonly string[] = KOJO_LEXICON.contMarks;
/** `不在` 介于关键字与运算符之间（规范 §3.5），与运算符同色；补全亦归运算符组 */
export const NOTIN_MARKS: readonly string[] = KOJO_LEXICON.notin;
/** 中文运算符词形 + `不在`（同一档着色、同一档补全） */
export const OPERATOR_WORDS: readonly string[] = [...KOJO_LEXICON.operators, ...NOTIN_MARKS];
/** 保留代词（规范 §3.8） */
export const PRONOUN_WORDS: readonly string[] = KOJO_LEXICON.reservedPronouns;

/**
 * 标记里的**非字词形**（`~` / `⏎`）：CJK 与 ASCII 两支词形各由 `@contMarks` 命中，
 * 符号形没有任何一条词形规则能命中它 ⇒ 必须单开一条规则（这正是缺陷「作者写 `~` 不高亮」
 * 的成因：抄本 `['续','cont','continue']` 里根本没有符号形，也就没人给它规则）。
 */
const WORD_CHAR = /[A-Za-z0-9_\u3040-\u30ff\u4e00-\u9fff\uff66-\uff9f]/;
export const CONT_SYMBOLS: readonly string[] = CONT_MARKS.filter((m) => !WORD_CHAR.test(m));

/** 字符类正则（词表符号 → Monarch 规则；正则元字符逐个转义，不假定词表只用 `~`） */
function charClassPattern(words: readonly string[]): RegExp {
  const body = words.map((w) => w.replace(/([\\\]^-])/g, '\\$1')).join('');
  return new RegExp(`[${body}]`);
}

/**
 * 引擎**族头**指令（`CFLAG` / `TFLAG` / `ABL` / `PALAM` …）——派生自 `kojo-sugar` 的
 * `ENGINE_VARIABLE_FAMILIES`（与降糖器 `resolveFamily` 同一张族清单，宿主零抄本）。
 * 族头与输出/控制流指令在屏上必须是两档：前者是"还有中文槽位名可换"的接口，后者是
 * "整条语句还没中文化"的骨架。
 */
export const ERB_FAMILY_HEADS: readonly string[] = ENGINE_VARIABLE_FAMILIES;

/**
 * 原生直通行里可识别的高频 ERB 指令（高亮口径；不做语义分析；族头已另立一档）。
 * **派生自** `erb-directives.ts` 的单一真源（与 `.erb` 高亮/补全同一份清单）：
 * 叶模块 import 是防环形态——本文件已在 `erb-language → theme → kojo-language` 环上，
 * 经 `erb-language` 取值会踩 TDZ。族头由 `FAMILY_HEAD_SET` 滤出，另发 `keyword.erb.family`。
 */
const FAMILY_HEAD_SET = new Set(ERB_FAMILY_HEADS);
export const ERB_COMMANDS: readonly string[] = ERB_DIRECTIVES.filter((d) => !FAMILY_HEAD_SET.has(d));

/**
 * `.kojo` 原生行**高亮**用的指令表 = `ERB_COMMANDS` + 高亮补集（去族头，补集出处见
 * `erb-highlight-words.ts`）。为什么不直接扩 `ERB_COMMANDS`：那张表的口径与
 * `ERB_DIRECTIVES` 逐项同位（既有恒等式测试钉着），补全是另一条消费线；高亮多认
 * `ENDCATCH` / `NOSKIP` / `SETVAR` 不等于把它们塞进补全候选。行首/行内的大写判定
 * 不变——小写仍是糖英文别名（本文件 `ignoreCase: false`）。
 */
export const ERB_HIGHLIGHT_COMMANDS: readonly string[] = [
  ...ERB_COMMANDS,
  ...ERB_HIGHLIGHT_EXTRA_WORDS.filter((w) => !FAMILY_HEAD_SET.has(w)),
];

/**
 * 中文系统函数名（HK-11①）——从 `kojo-sugar` 的 `SYSTEM_FUNCTION_ALIASES`
 * **派生**（单一真源，本文件不复制词形）。
 */
export const SYSTEM_FUNCTION_WORDS: string[] = [...SYSTEM_FUNCTION_ALIASES.keys()];

/**
 * `kojo-dark` 的**角色**着色规则（LAU-2 起：主题按语义角色铺，不再按 token 名）。
 *
 * **定义处已下沉**零依赖叶子 `kojo-theme-rules.ts`（PS-10 断链：本文件静态挂着
 * `@kojo/plugin-kojo-sugar` 词表，`theme.ts` 在开机静态图里，经本文件取规则等于把
 * 糖包挂回开机图）。此处按**同一数组本体** re-export：既有 import 点（主题装配、
 * `kojo-token-tiers.test.ts` 的同对象引用断言）读到的对象不变，别在这里复制第二份。
 *
 * 取色口径（**深底可读**，判据复跑见 `kojo-token-tiers.test.ts`）：
 * - 已中文化的糖层走冷色族（紫=关键字、青=运算符、蓝=函数、绿=台词、玫=代词）；
 * - 还没中文化的原生层走"外来族"（粉=引擎指令、蓝紫=族头、灰=整行原生直通），
 *   名字层（CJK 非词表 = 槽位原名 / 作者自定名）走薄荷绿；
 * - 亮度全部 ≥ 4.5:1，不为了分层引入刺眼的高饱和。
 */
export { ROLE_THEME_RULES } from '@kojo/kojo-lang/theme-rules';

/**
 * 档位表：**作者看得见的分层口径** → 该档的**语义角色**（多角色 = 同档同色）。
 *
 * 为什么把这张表放进源码而不只放测试：它同时是**主题的验收清单**——新增一档就得在这里
 * 登记，`kojo-token-tiers.test.ts` 立刻会问"这一档的前景色与谁撞了"。
 */
export interface KojoTokenTier {
  /** 档名（面向作者的中文口径；只用于报错文案，不参与配色计算） */
  readonly tier: string;
  /** 该档的角色名（同档共享前景色；角色表见 `semantic-roles.ts`） */
  readonly tokens: readonly string[];
  /** 为什么值得单独一档（写不出理由的不配成为一档） */
  readonly why: string;
}

export const KOJO_TOKEN_TIERS: readonly KojoTokenTier[] = [
  { tier: '中文关键字', tokens: [ROLE.keyword], why: '句子的骨架，作者最常确认的一眼位' },
  { tier: '中文运算符', tokens: [ROLE.operatorWord], why: '`不在` 与比较词都改判定，须与关键字分色' },
  { tier: '中文系统函数', tokens: [ROLE.call], why: '调用位（中文函数名）与关键字不同层' },
  { tier: '保留代词', tokens: [ROLE.pronoun], why: '`她`/`你` 是引用而非控制流' },
  { tier: '不等待标记', tokens: [ROLE.cont], why: '`续`/`~`/`⏎` 改的是运行行为' },
  { tier: '台词', tokens: [ROLE.speech], why: '作者写的正文，语法层要退到后面' },
  { tier: '结构性标点', tokens: [ROLE.punctuation], why: '块头与台词的边界，一族即可' },
  { tier: '插值记号', tokens: [ROLE.interp, ROLE.interpDelimiter], why: '「台词里的表达式」自成一层' },
  { tier: '名字层（槽位原名 / 作者自定名）', tokens: [ROLE.slot], why: '既不是语法词也不是英文残留，是"还得记住的原名"' },
  { tier: '英文隐藏别名', tokens: [ROLE.keywordAlias], why: '输入生效但不必展示 ⇒ 弱化一档，看得见但别抢戏' },
  { tier: '引擎指令', tokens: [ROLE.engine], why: '一整条还没中文化的骨架，需要最扎眼的外来色' },
  { tier: '引擎族头', tokens: [ROLE.engineFamily], why: '族头后面还挂着槽位原名 ⇒ 与指令分档才看得出差一层' },
  { tier: '整行原生直通', tokens: [ROLE.raw], why: '围栏 / `$标签` / `@函数` = 不透明整块，与行内指令分档' },
];

/**
 * `.kojo` 打字期的**成对记号**（一处登记、三格消费：`brackets` = 配对高亮 / 对着色 / 跳到配对，
 * `autoClosingPairs` = 敲开括号补闭括号，`surroundingPairs` = 选中文本敲括号包住它）。
 *
 * 每一对都要有语法事实背书，事实住在 `kojo-sugar`，本表只做 Monaco 形态的翻译：
 * - `{}` 插值 `{表达式}`（本文件 tokenizer 的 `interp` 态 ⇄ `codegen.ts` 的 `classifyInterpolation`）；
 * - `[]` 规则池标签 `[条件]`（`lexer.ts` 的 `RULE_TAG_RE`）与 `[[属性名]]` 名字段；
 * - `「」` 台词标记（`lexer.ts` / `codegen.ts` 的台词引号判据）；
 * - `（）` / `()` 条件与实参的括注；
 * - `""` 字符串值（`初回 "key"：`；`lexer.ts` 的 `inlineCommentIndex` 认 `"` 为串界，
 *   与它同一条判据的 ERB 侧早就配了这一对，`.kojo` 此前漏了一格）。
 *
 * **不许进这张表的**：全角 `：` / `，`（块头终止符与分隔符，`keywords.ts` 的 `FULLWIDTH_COLON`
 * 只作行尾判据，从来不是括号对）；台词标记的**异体形** `｢｣` / `『』`——糖包目前没导出成对标记
 * 清单（那两份引号表是 `codegen.ts` 里的私有常量），在本层另抄一串括号就是第二个真源，
 * 要收这一格得先在糖包导出。钉测：`packages/app/tests/kojo-language-config.test.ts`。
 */
const KOJO_PAIRS: readonly (readonly [open: string, close: string])[] = [
  ['{', '}'],
  ['[', ']'],
  ['「', '」'],
  ['（', '）'],
  ['(', ')'],
  ['"', '"'],
];

/**
 * 行内内容规则（root 与 `@dquote` 串态**共用同一批规则对象**）。
 *
 * 为什么串态要复用这一批：Monarch 的行尾 `;` 注释规则是非锚定的，`"…"` 里的 `;`
 * 若也交给它就会把字符串值涂成注释（作者写 `初回 "key;说明"：` 被切成两段）。真源
 * `kojo-sugar/lexer.ts::inlineCommentIndex` 只把 `"` 当串界、串里的 `;` 不剥，故串态
 * 的唯一职责是**把串内的 `;` 从注释规则手里藏起来**：串内内容仍走同一批词法（不复制
 * 第二套词表/规则），`;` 在该状态没有规则可命中 ⇒ 不发 comment（与旧版串外 `;` 落空
 * token 同相）。台词 `「」` 另由 speech 系列状态保护，不经过这里。
 */
const KOJO_CONTENT_RULES: Monaco.languages.IMonarchLanguageRule[] = [
  // 台词引号（「」/｢｣/『』）——台词 = 作者色（规范 §1.3 的 99% 相关律）
  [/「/, { token: ROLE.punctuation, next: '@speech' }],
  [/｢/, { token: ROLE.punctuation, next: '@speechAlt' }],
  [/『/, { token: ROLE.punctuation, next: '@speechIn' }],
  // 插值 `{…}`（旁白行/台词行皆可出现）
  [/\{/, { token: ROLE.interpDelimiter, next: '@interp' }],
  // 标记的**符号形**（`~` / `⏎`，词表派生）：词支命中不到的那一批，单独一条规则给 `sugar.cont`
  [charClassPattern(CONT_SYMBOLS), ROLE.cont],
  // 中文词形：运算符 → 不等待标记 → 保留代词 → 关键字 → 系统函数 → 名字层
  [
    /[\u3040-\u30ff\u4e00-\u9fff\uff66-\uff9f]+/,
    {
      cases: {
        '@contMarks': ROLE.cont,
        '@operators': ROLE.operatorWord,
        '@pronouns': ROLE.pronoun,
        '@primaryWords': ROLE.keyword,
        '@systemFunctions': ROLE.call,
        // 词表里没有的中文/日文名字 = 槽位原名或作者自定名（既不是语法词也不是英文残留）
        '@default': ROLE.slot,
      },
    },
  ],
  // 英文隐藏别名（小写）/ ERB 指令（全大写，行首已分档，此处兜底）
  [
    /[A-Za-z_][A-Za-z0-9_]*/,
    {
      cases: {
        '@contMarks': ROLE.cont,
        '@englishAliases': ROLE.keywordAlias,
        // 运算符组的 ASCII 形（`不在` 的别名 `notin`）也要落档——此前漏 cases 会掉 identifier
        '@operators': ROLE.operatorWord,
        '@erbFamilyHeads': ROLE.engineFamily,
        '@erbCommands': ROLE.engine,
        '@default': ROLE.text,
      },
    },
  ],
  [/\b0x[0-9a-fA-F]+\b/, ROLE.number],
  [/\b\d+\b/, ROLE.number],
  [/：/, ROLE.punctuation],
  [/[+\-*/%<>!=&|^~?:.,()\[\]]/, ROLE.operator],
];

export function registerKojoLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((l) => l.id === KOJO_LANGUAGE_ID)) return;

  // 扩展名映射与 ERB 侧**同一形态**（DRIFT-APP 3，2026-10-19）：清单只住在契约层那一份
  // （`plugin-api/sugar.KOJO_SOURCE_EXTENSION`），大小写两种写法由 `kojoMonacoExtensions()`
  // 现算派生——Monaco 按字面量匹配扩展名，盘上的大写形态也得命中。改前这里自己抄了一份
  // 只含小写的清单，与 ERB 侧的派生形态分叉。本文件此后不得再出现任何扩展名字面量
  // （守卫：`tests/kojo-extension-single-source.test.ts`）。
  monaco.languages.register({
    id: KOJO_LANGUAGE_ID,
    extensions: kojoMonacoExtensions(),
    aliases: ['kojo'],
  });

  monaco.languages.setMonarchTokensProvider(KOJO_LANGUAGE_ID, {
    ignoreCase: false,
    defaultToken: '',
    primaryWords: PRIMARY_WORDS.map((w) => w.word),
    operators: OPERATOR_WORDS,
    contMarks: CONT_MARKS,
    pronouns: [...PRONOUN_WORDS],
    englishAliases: ALIAS_WORDS,
    erbCommands: ERB_HIGHLIGHT_COMMANDS,
    erbFamilyHeads: ERB_FAMILY_HEADS,
    systemFunctions: SYSTEM_FUNCTION_WORDS,
    tokenizer: {
      root: [
        // 行首 `;` = 整行注释（真源 `lexer.ts::classifyLine` 的 `content.startsWith(';')`）。
        // 旧版还把 `^\s*//` 一并涂成 comment——`//` 在转译器里**不是**注释，本批删掉那一形。
        [/^\s*;.*$/, ROLE.comment],
        // 行尾 `;` 注释（非锚定，`;` 起至行末）：对位 `lexer.ts::stripInlineComment`。
        // `"…"` 内的 `;` 由下面的 `dquote` 先吃掉，`「…」` 内的 `;` 由 speech 态先吃掉。
        [/;.*$/, ROLE.comment],
        // 停用块 `[SKIPSTART] … [SKIPEND]`：引擎原样输出（真源 `classifyLine` 的
        // `skipStart` / `skipEnd`，**整行严格等值**）。块内不是 `.kojo` 代码 ⇒ 与
        // ```erb 围栏同档：标记与内容一律 `keyword.raw`，作者一眼看出这是不透明区。
        [/^\s*\[SKIPSTART\]\s*$/, { token: ROLE.raw, next: '@skipBlock' }],
        [/^\s*\[SKIPEND\]\s*$/, ROLE.raw],
        // 预处理条件标记（v1.9 P2）：整行严格等值（真源 `plugin-api/erb.ts` 的
        // `ERB_PREPROC_PATTERNS`），连宏名一起涂成外来指令档——必须排在行内 `[` 运算符之前，
        // 否则 `[IF 恋慕开关]` 会先被内容规则拆成标点 + 普通名。
        [ERB_PREPROC_LINE_RE, ROLE.directive],
        // `#` 声明族（v1.9 §3.3）：`#DIM` 族 + 文件级 / 返回类型 8 枚，逐字节直通，整行一档。
        [ERB_DECLARATION_LINE_RE, ROLE.directive],
        // 行连接标记 `{` / `}`：**独占一行**才是引擎记号（整行严格等值）；行内 `{` 仍是插值分隔符，
        // 由内容规则着色。故只认整行形态（前后仅许缩进 / 尾随空白）。
        [/^\s*[{}]\s*$/, ROLE.raw],
        // 原生 ERB 围栏（```erb … ```）：整块不透明，逐行着色为原生
        [/^\s*```\s*erb\b.*$/i, { token: ROLE.raw, next: '@rawFence' }],
        // 行首 `@erb` 逃生舱（规范 §3.10）
        [/^\s*@\s*erb\b.*$/i, ROLE.raw],
        // 原生直通行：`$标签` / `@函数` = 不透明整块 ⇒ 前缀与名字一律走原生档（不吃基线 label/function 色）
        [/^\s*\$[^\s;]+/, ROLE.raw],
        [/^\s*@[^\s;(]+/, ROLE.raw],
        // 行首全大写 ERB 指令：族头一档、其余指令一档、没见过的照旧当普通名字
        [
          /^(\s*)([A-Z][A-Z0-9_]*)\b/,
          [
            '',
            {
              cases: {
                '@erbFamilyHeads': ROLE.engineFamily,
                '@erbCommands': ROLE.engine,
                '@default': ROLE.text,
              },
            },
          ],
        ],
        // 双引号串：只为隔离行尾注释（真源 `inlineCommentIndex` 把 `"` 当串界）。
        // 开引号要求**本行**还有闭合引号（`(?=[^"]*")`）⇒ 串态天然不跨行，压在行尾的
        // 落单 `"` 不会让下一行的行首 `;` 注释失明；落单引号按普通标点走（旧版同相）。
        // 与串外共用同一批内容规则；引号本身给 `string.quote`（基线串色），内容各归原档。
        [/"(?=[^"]*")/, { token: ROLE.string, next: '@dquote' }],
        // 其余行内词法（台词 / 插值 / 中文词形 / 英文别名 / 数字 / 标点）——
        // 与 `dquote` 串态**同一批规则对象**，见 KOJO_CONTENT_RULES 头注。
        ...KOJO_CONTENT_RULES,
      ],
      /**
       * 双引号串内：内容走同一批规则；`;` 在此状态没有规则可命中 ⇒ 不发 comment，
       * 与真源「只剥引号外 `;`」同判。闭合引号必在同一行（开引号的前瞻已保证），
       * 故本状态没有 `$` 兜底、也绝不带过行界。
       */
      dquote: [
        [/"/, { token: ROLE.string, next: '@pop' }],
        ...KOJO_CONTENT_RULES,
      ],
      /** ```erb 围栏内部：逐行原生，遇闭合围栏退出 */
      rawFence: [
        [/^\s*```\s*$/, { token: ROLE.raw, next: '@pop' }],
        [/.*$/, ROLE.raw],
      ],
      /** `[SKIPSTART] … [SKIPEND]` 停用区内部：逐行原生，遇整行等值标记退出 */
      skipBlock: [
        [/^\s*\[SKIPEND\]\s*$/, { token: ROLE.raw, next: '@pop' }],
        [/.*$/, ROLE.raw],
      ],
      speech: [
        [/[^」{\\]+/, ROLE.speech],
        [/\{/, { token: ROLE.interpDelimiter, next: '@interp' }],
        [/\\$/, ROLE.speech],
        [/」/, { token: ROLE.punctuation, next: '@pop' }],
        [/./, ROLE.speech],
      ],
      speechAlt: [
        [/[^｣{\\]+/, ROLE.speech],
        [/\{/, { token: ROLE.interpDelimiter, next: '@interp' }],
        [/｣/, { token: ROLE.punctuation, next: '@pop' }],
        [/./, ROLE.speech],
      ],
      speechIn: [
        [/[^』{\\]+/, ROLE.speech],
        [/\{/, { token: ROLE.interpDelimiter, next: '@interp' }],
        [/』/, { token: ROLE.punctuation, next: '@pop' }],
        [/./, ROLE.speech],
      ],
      interp: [
        [/[^}]+/, ROLE.interp],
        [/\}/, { token: ROLE.interpDelimiter, next: '@pop' }],
      ],
    },
  } as Monaco.languages.IMonarchLanguage);

  // ZH-D4 回车层级：正则族由 `kojo-sugar` 从关键字表**派生**（本文件零词形硬编码）。
  // ERB-ENTER-RULES（2026-10-21）：Monaco 协议翻译收进 `enter-rules.ts` 一处，`.erb` 与
  // `.kojo` 从同一道门出去；本文件的产物逐字不变（可选格不写 = 既有手感零改动）。
  const enterConfig = toMonacoEnterConfig(monaco, sugarEnterRulePatterns());
  monaco.languages.setLanguageConfiguration(KOJO_LANGUAGE_ID, {
    comments: { lineComment: KOJO1_LINE_COMMENT },
    // 全角标点按词分隔（A3）；`：` 触发字在 quickSuggestions 关后靠它走显式触发通道（见 word-separators.ts 头注）
    wordPattern: CJK_WORD_PATTERN,
    // 块头行回车 ⇒ 新行 +1 级（`beforeText` 匹配"光标以左整行"⇒ 天然只在冒号后回车触发）；
    // 精确判型另见 `kojo-format.ts` 的 on-type 兜底层。
    onEnterRules: enterConfig.onEnterRules,
    indentationRules: enterConfig.indentationRules,
    // 三格同一张表派生；`open === close` 的那一对（`"`）不是括号，只进闭合与包裹两格
    brackets: KOJO_PAIRS.filter(([open, close]) => open !== close).map(
      ([open, close]) => [open, close] as [string, string],
    ),
    autoClosingPairs: KOJO_PAIRS.map(([open, close]) => ({ open, close })),
    surroundingPairs: KOJO_PAIRS.map(([open, close]) => ({ open, close })),
  });
}

/* ============================== 波浪线（markers） ============================== */

/** `ui.editor.decorator` 的 severity → Monaco MarkerSeverity */
function markerSeverity(monaco: typeof Monaco, s: LineDecoration['severity']): Monaco.MarkerSeverity {
  if (s === 'error') return monaco.MarkerSeverity.Error;
  if (s === 'warning') return monaco.MarkerSeverity.Warning;
  return monaco.MarkerSeverity.Info;
}

/**
 * 把装饰贡献（`LineDecoration[]`，含可选列区间）翻译为 Monaco markers。
 * 列越界一律**夹到行内**（装饰是外部数据，不能假定它算准了列）。
 *
 * 诊断码走 `code` 字段（B9）：这是 Monaco 里"这条诊断的标识"，快速修复按它认领、
 * 同类问题按它归组；早先放在 `source` 只是拿悬浮提示当出口，波浪线与 💡 之间并没有
 * 可对齐的键（悬浮里仍会显示，形态从 `code：消息` 变成 `消息 (code)`）。
 */
export function decorationsToMarkers(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  decorations: readonly LineDecoration[],
): Monaco.editor.IMarkerData[] {
  const lineCount = model.getLineCount();
  const markers: Monaco.editor.IMarkerData[] = [];
  for (const d of decorations) {
    const line = Math.min(Math.max(1, Math.trunc(d.line)), lineCount);
    const maxColumn = model.getLineMaxColumn(line);
    const startColumn = Math.min(Math.max(1, Math.trunc(d.startColumn ?? 1)), maxColumn);
    // 跨行装饰（additive，B3 收口最后一格）：`endLine` 缺省 = 同行，行为与加之前逐字相同。
    // 终点行自带行宽，终点列必须按**那一行**夹（拿起始行的行宽夹跨行终点会把区间截短）。
    const endLine = Math.min(Math.max(line, Math.trunc(d.endLine ?? line)), lineCount);
    const endMaxColumn = model.getLineMaxColumn(endLine);
    const endColumn = Math.min(
      Math.max(endLine === line ? startColumn : 1, Math.trunc(d.endColumn ?? endMaxColumn)),
      endMaxColumn,
    );
    markers.push({
      severity: markerSeverity(monaco, d.severity),
      message: d.message,
      code: d.code,
      startLineNumber: line,
      startColumn,
      endLineNumber: endLine,
      endColumn,
    });
  }
  return markers;
}