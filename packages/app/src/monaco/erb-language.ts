import type * as Monaco from './entry';
import { ERB_DIRECTIVES, ERB_STATEMENT_DIRECTIVES } from './erb-directives';
import { ERB_HIGHLIGHT_EXTRA_WORDS } from './erb-highlight-words';
import { erbEnterRulePatterns, ERB_LINE_COMMENT } from './erb-enter';
import { toMonacoEnterConfig } from './enter-rules';
import { erbMonacoExtensions } from '@kojo/plugin-api';
import { defineMonacoThemes } from './theme';
import { CJK_WORD_PATTERN } from './word-separators';
/**
 * ERB (EraBasic) 基础语法高亮 —— Monarch 词法定义（v0.1 宽口径版）。
 *
 * 依据（逆向文档《词法与表达式》《口上机制深挖》）：
 * - 行首 `;` 注释、引号外行尾 `;` 起注释到行末、`@` 函数定义、`#` 预处理指令、`$` 跳转标签
 *   （注释/字符串两判据与语义层 `erb-parser/references.ts` 的 `codeViewOf` **同口径**——
 *   同一份"什么是注释/什么是串"不许有两个真相：串里的 `;` 不是注释、未闭合引号只到行尾）；
 * - 指令表 = 口上高频子集（单一真源 `erb-directives.ts`）；高亮另吃补集
 *   `erb-highlight-words.ts`（控制流语句 + 引擎内建单行语句，补全不消费）；
 * - 变量多段引用（CFLAG:ARG:口上セレクタ）整体高亮；
 * - FORM 串内 `{表达式}` / `%字符串%` 是字符串内的第二层（`str` 态规则序，见该态注；
 *   这一层的存在性由语义层背书——`erb-completion-context.ts` 的 `'form'` 槽判据 +
 *   `condition-extractor` 的 `\` 转义判据同一条语言事实）。
 *
 * **大小写（2026-10-18 SUGGEST-2C）**：Emuera 关键字大小写不敏感，词表只存一种写法；
 * `ignoreCase: true` 让 `call` / `If` / `setcolor` 与全大写同档。若哪天关掉它，
 * `tests/erb-highlight.test.ts` 的三形态逐词发射会整片变红。
 */

/**
 * 指令词表单一真源在叶子模块 `erb-directives.ts`（零 app 内依赖——kojo 侧要同一份清单，
 * 走本文件会踩 `erb-language → theme → kojo-language` 模块环的 TDZ）。
 * 此处**原样 re-export**：既有 import 点（`erb-completion` / `editor-global-providers` /
 * 测试）逐字零改动，引用的是同一数组本体。
 *
 * 2026-10-25 P0-2 起该模块导出两份：`ERB_STATEMENT_DIRECTIVES`（手写常用语句）与
 * `ERB_DIRECTIVES`（= 手写 ∪ 结构真源派生的控制流词）；两者都从这里转出，消费方不必
 * 直接摸叶子模块。
 */
export { ERB_DIRECTIVES, ERB_STATEMENT_DIRECTIVES };

export const ERB_LANGUAGE_ID = 'kojo-erb';

/**
 * ERB 的成对记号（**一处登记、四格消费**：`brackets` 配对高亮 / `colorizedBracketPairs`
 * 嵌套括号着色 / `autoClosingPairs` 敲开补闭 / `surroundingPairs` 选中包裹）。
 *
 * 只收 ASCII 三对：`{}` 是 FORM 插值记号（`erc-syntax-tree` 的 `form_interpolation` /
 * `form_substitution` 两侧都有结构事实），`[]` 是标签行与数组索引，`()` 是条件/实参。
 * **全角括号 `（）` / `「」` 不收**：ERB 里它们是普通正文标点，不是结构括号（与 `.kojo`
 * 的 `KOJO_PAIRS` 不同——那边 `「」` 是台词标记）；ERB 的 `"` 也不进 `brackets`
 * （引号不是嵌套结构，只进自动闭合/包裹两格）。
 */
export const ERB_BRACKET_PAIRS: readonly (readonly [string, string])[] = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
];

/** 引号对：只进 `autoClosingPairs` / `surroundingPairs`（见上：它不是嵌套括号） */
export const ERB_QUOTE_PAIR = ['"', '"'] as const;


/**
 * 合并基底词表与 adapter 词表（**纯函数**，两表进、合并词表出）：
 * - 并集按**大小写不敏感**去重（Emuera 关键字大小写不敏感；先出现者保留原样——基底在前，
 *   英文指令保持基底写法，adapter 同名异写不产生重复项）；
 * - 产物**排序确定**（按 UTF-16 码元比较），同一输入恒得同一顺序；
 * - `extra` 缺席（adapter 表缺席 / 未提供枚举能力）⇒ 返回基底的确定性排序拷贝。
 */
export function mergeDirectiveWords(
  base: readonly string[],
  extra: readonly string[] | undefined | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of extra ? [...base, ...extra] : base) {
    if (word.length === 0) continue;
    const key = word.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 正则元字符转义（词表 → 单条规则时用；词表外部输入，不假定只含 `\w`） */
function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 词表里 ASCII 词形的**整词**规则（**行首/行中都生效，且优先于变量族规则**）。
 *
 * 为什么不能只靠下面的 ASCII 兜底 `cases`：`CFLAG` / `EQUIP` / `RAND` / `DOWNBASE`
 * 既是指令（词表里）又是变量族头（变量规则在兜底之前），只靠 `cases` 会让它们在
 * **大写形态**下照样吃 `variable` 色。这里把"整词命中词表"提前成一条独立规则；
 * 末尾 `(?![:\[])` 把「词 + 索引」留给变量规则（`CFLAG:ARG` 仍整段 `variable`）。
 */
function standaloneKeywordPattern(words: readonly string[]): RegExp | null {
  const ascii = words.filter((w) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(w));
  if (ascii.length === 0) return null;
  // 长词优先：`TRYCCALLFORM` 不被 `TRYCCALL` 截胡（`\b` 已能挡住，排序是双保险）
  const body = [...new Set(ascii)]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    .map(escapeRegExp)
    .join('|');
  return new RegExp(`\\b(?:${body})\\b(?![\\[:])`);
}

/**
 * Monarch 词法定义构建器（`directives` 词表参数化——基底与 adapter 派生词表共用同一份
 * tokenizer 骨架，只换词表，别处零分叉）。
 *
 * `highlightWords` 是"真正吃 keyword 色的全表"：基底指令 + 高亮补集
 * （`ERB_HIGHLIGHT_EXTRA_WORDS`，出处见 `erb-highlight-words.ts`）。`directives`
 * 属性保持**传入原样**——补全面是 monarch 内部实现，不改变 `setErbDirectiveWords`
 * 的公开语义（测试与宿主都按"传什么就回什么"读）。
 */
function erbMonarch(directives: readonly string[]): Monaco.languages.IMonarchLanguage {
  const highlightWords = mergeDirectiveWords(ERB_DIRECTIVES, [
    ...directives,
    ...ERB_HIGHLIGHT_EXTRA_WORDS,
  ]);
  const standaloneKeyword = standaloneKeywordPattern(highlightWords);
  return {
    ignoreCase: true,
    defaultToken: '',
    directives: [...directives],
    highlightWords,
    tokenizer: {
      root: [
        // 行首**代码前缀** `;!;` / `;#;`（Emuera 有效代码，不是注释）——必须排在
        // 行首注释规则**之前**，否则整行会被下面的 `^\s*;.*$` 吞成注释。
        // 只吃前缀本身（3 个字符），其后的正文继续交给本状态的其余规则按代码着色；
        // 判据与语义层同源（`plugin-api` 的 `ERB_CODE_PREFIXES`），此处只做字形匹配。
        [/^\s*(?:;!;|;#;)/, 'keyword.preprocessor.comment-code'],
        // 行首注释（Emuera 语义：行首 ; 整行注释）
        [/^\s*;.*$/, 'comment'],
        // 行内尾注释：引号外的 `;` 起注释到行末。`str` 态是另一状态、串里进不了 root，
        // 所以这条不会把 PRINTL "a;b" 的 `;` 当注释；语义层 codeViewOf 同一判据。
        [/;.*$/, 'comment'],
        // 行首函数定义 @NAME / @NAME(...)
        [/^(\s*)(@)([^\s(;]+)/, ['', 'keyword', 'entity.name.function']],
        // 行首跳转标签 $LABEL
        [/^(\s*)(\$)([^\s;]+)/, ['', 'keyword', 'label']],
        // 预处理指令 #DIM / #FUNCTION 等（含修饰词）
        [/^(\s*)(#\w+)/, ['', 'keyword.preprocessor']],
        // 预处理停用区 `[SKIPSTART] … [SKIPEND]`（引擎原样输出，块内不是 ERB 代码）。
        //
        // 判据 = 真源 lexer 的**整行等值**（`erb-parser/src/scanner.ts`：
        // `line.trim() === '[SKIPSTART]' / '[SKIPEND]'`），不是"行内出现即生效"——
        // 字符串 / 行首注释 / 行尾残留里的同形文本不改变块状态（所以两条规则都带
        // `^\s*…\s*$` 锚）。`ignoreCase: true` 是 ERB 全语言的大小写口径（Emuera 关键字
        // 大小写不敏感），这里不另开例外：小写形态同样进块，属高亮层的宽松超集。
        //
        // 标记另发 `keyword.preprocessor.skip.*`（前缀落在既有预处理标记色上），
        // 块内逐行发 `keyword.raw`（与 `.kojo` 原生围栏同档的"不透明"色）——
        // 两档分开，作者一眼能看出"这是停用块"而不是"活代码里混进了关键字"。
        [/^\s*\[SKIPSTART\]\s*$/, { token: 'keyword.preprocessor.skip.start', next: '@skip' }],
        [/^\s*\[SKIPEND\]\s*$/, 'keyword.preprocessor.skip.end'],
        // 字符串（含 FORM 串转义）：进 `str` 态，串内 `{…}` / `%…%` 两层在那里解析
        [/"/, { token: 'string.quote', bracket: '@open', next: '@str' }],
        // 整词指令（含高亮补集）：必须排在变量族之前——CFLAG/EQUIP/RAND/DOWNBASE 同时是
        // 变量族头，只靠后面的 cases 会让大写形态吃 variable 色（SUGGEST-2C 的 second root）
        ...(standaloneKeyword ? [[standaloneKeyword, 'keyword'] as [RegExp, string]] : []),
        // 变量多段引用：CFLAG:ARG:口上セレクタ / TCVAR:50 / ARG:1 / RESULTS:2 / LOCALS:1
        // （段尾字符集排除 `;`——否则 `CFLAG:ARG;说明` 把行尾注释整段吞成 variable，与语义层分叉）
        [/\b(?:CFLAG|CDFLAG|CSTR|TCVAR|TSTR|TFLAG|TALENT|MARK|EXP|BASE|MAXBASE|ABL|TALENT|RELATION|RESULTS|LOCALS|LOCAL|ARGS|ARG|FLAG|DAY|TIME|MONEY|NAME|CALLNAME|MASTER|TARGET|ASSI|NO|RAND|SELECTCOM|TFLAG|PALAM|JUEL|GOTJUEL|UP|DOWN|LOSEBASE|CUP|CDOWN|DOWNBASE|SOURCE|NOWEX|EQUIP|TEQUIP|EX|PALAMLV|STAIN|STAIN_1|STAIN_2)\b(?::[^\s,()\[\]{}'"+\-*/%<>=!&|;]+)*/, 'variable'],
        // 数值常量
        [/\b\d+\b/, 'number'],
        // `'=` 字符串表达式赋值（Emuera ver1813+）：`STR '= TSTR:0 + "ABC"`。
        // `'` 在 ERB 里**只**作为这个运算符的首字符出现（没有单引号字符串），所以单独一条
        // 规则是精确的；排在通用运算符规则之前（后者不含 `'`，但把 `'=` 先收掉可以避免
        // `'` 落空 token）。语义层早就是赋值（`undefined-name.ts` 的 `ASSIGN_LINE_RE`
        // 收了 `'`），此前只有着色不认——同一行两侧口径分叉。
        [/'=/, 'operator'],
        // 运算符
        [/[+\-*/%<>!=&|^~?:.,]/, 'operator'],
        // 指令 / 函数调用标识符
        [
          /[A-Za-z_][A-Za-z0-9_]*/,
          {
            cases: {
              '@directives': 'keyword',
              '@highlightWords': 'keyword',
              '@default': 'identifier',
            },
          },
        ],
        // 日文/中文全角标识符（变量名、参数名）；命中词表（adapter 派生的指令名，含中日文
        // 名）同样出 keyword——词表派生自 adapter 时非 ASCII 名才有着落。
        // 假名段**挖掉 U+30FB**：那是 KATAKANA MIDDLE DOT（中黒，General Category = Po），
        // 被块区间 `\u3040-\u30ff` 顺手收成"词字符"是块区间的老毛病——语义层的记号判据
        // `MODEL_TOKEN_CLASS = [\p{L}\p{N}_]` 不认它（Po 既非字母也非数字），分词侧
        // （word-separators 标点表）也把它当分隔符。让它落到下面的标点档，三条口径对齐。
        [
          /[\u3040-\u30fa\u30fc-\u30ff\u4e00-\u9fff\uff66-\uff9f]+/,
          {
            cases: {
              '@directives': 'keyword',
              '@highlightWords': 'keyword',
              '@default': 'identifier',
            },
          },
        ],
        // 全角字母数字（Ａ-Ｚ/ａ-ｚ/０-９/々）：Emuera 视同半角同族记号，反向索引侧
        // `normalizedUpper` 的 `ａ-ｚ`、`MODEL_TOKEN_CLASS` 的 `\p{L}\p{N}` 都是这个口径——
        // 着色层跟着进词表判定，缺省 identifier，不落空 token
        [
          /[\uff10-\uff19\uff21-\uff3a\uff41-\uff5a\u3005]+/,
          {
            cases: {
              '@directives': 'keyword',
              '@highlightWords': 'keyword',
              '@default': 'identifier',
            },
          },
        ],
        // 全角/CJK 标点（U+3001-\u303F ∪ \uff01-\uff65 残部：`：，。（）「」《》、；！？＿…` 等）
        // ∪ 假名段里的中黒 U+30FB ∪ 弯引号 / 省略号 / 间隔号：语义层判"非记号字符"
        // （MODEL_TOKEN_CLASS 不含标点），.kojo 侧同类字符是关键字标点——归 operator，
        // 不再坠 defaultToken 空色。全角 `；` 只是标点：语义层 codeViewOf 只认半角 0x3B，
        // 注释判据不许在这 widening
        //
        // **为什么还要单列 \u2018-\u201d / \u2026 / \u00b7 / \u30fb**：上面两段是**Unicode 块**，
        // 不是"中文标点"的枚举——\uff01-\uff65 是 Halfwidth and Fullwidth Forms 的 ASCII 镜像段
        // （段内每枚都有一个半角同族：！↔! ～↔~ ＿↔_），\u3001-\u303f 是 CJK Symbols and Punctuation
        // （汉字文化圈固有记号：。、「」《》【】）。而 `“ ” ‘ ’`（U+2018-U+201D）与 `…`（U+2026）
        // 住在 General Punctuation（U+2000-U+206F，西文排版族）、`·`（U+00B7）住在 Latin-1
        // Supplement——它们在 ASCII 里没有同族镜像、也不属汉字固有记号，只是中文输入法按**排版习惯**
        // 把它们当全角用，所以块区间天然不收；`・`（U+30FB）更尴尬地住在**假名段**里（Po 被块区间
        // 误当词字符，上面刚从标识符类里挖出来）。它们全在 word-separators 的标点表里
        // （分词侧早认它们是分隔符），着色侧漏一枚就是"同一枚字符两边口径分叉"；
        // `tests/erb-highlight.test.ts` 的 ③′ 拿标点表反查这一整段，加一枚标点忘加归属当场红。
        [/[\u3001-\u303f\uff01-\uff65\u2018-\u201d\u2026\u00b7\u30fb]+/, 'operator'],
      ],
      // 串内第二层（FORM 记号）。两条纪律叠在一起才成立：
      // **A. 内容字符类必须排除 `{`**（`[^"{%\\]`）：上一批点名的"`strExpr` 历史不可达"根因就在
      //    这里——旧类 `[^"%\\]+` 把 `{` 也算内容，于是从串首一枚字符起一路吞到闭合引号，
      //    入层规则连被尝试的机会都没有（**只调规则顺序毫无用处**，实测发射仍是
      //    `台词{LOCAL:1}尾巴=string`）。`.kojo` 侧的台词层靠 `[^」{\\]+`（`kojo-language.ts`
      //    的 speech 态）排除 `{` 才让插值层活着，两门语言同一写法。
      //    `}` **留在**类内：串里落单的右括号是字面内容，不许坠空 token。
      // **B. 规则序**（①-⑩，各有不可交换的位置）：
      //    ① `\` + 一枚字符 = 转义，必须最先：语义层同一判据（`condition-extractor/src/expr.ts`
      //      的串词法 `\` 吞下一个字符、`splitTopLevelCommas` 同款），所以 `\{` 是**字面括号**、
      //      不许开插值层（旧写法把 `\` 从字符类里排除却没写这条规则，落单 `\` 既不出色也不推进）。
      //    ②③ "本行等不到闭合" 两条闸必须先于开层规则：不开这道闸，`"台词{未闭合` 与记号正好
      //      压在行尾的 `"台词{` 会把 strExpr / strStr 带过行界，下一整行染成 variable——
      //      上一批定下的那条"未闭合只到本行行尾"纪律当场破功。保守方向与 codeViewOf 一致：
      //      等不到闭合的残段留在串里，不冒充表达式。
      //    ④⑤ 开层（前瞻要求闭合记号出现在闭合引号之前）。这一层的存在性由语义层背书：
      //      `erb-completion-context.ts` 的 `'form'` 槽明写"FORM 串，可含 `%…%` / `{…}` 插值"，
      //      `insideInterp` 对未闭合 `{` 判"停在插值内 ⇒ 不猜"；真语料形态见
      //      `erb-parser/src/structure.ts` 头注那条
      //      `@"给%CALLNAME:TARGET%使用避孕套（剩余{ITEM:45}枚）"`（一枚串里两层同时出现）；
      //      `kojo-sugar/src/codegen.ts` 的 `classifyInterpolation` 也把数值插值**降糖成
      //      `{表达式}`** 落进 ERB 产物（规范 §5.2 c）。
      //    ⑥⑦ 落单记号收成字面内容：内容类既然排除了 `{`，就必须有兜底，否则那一枚字符
      //      无规则可配 ⇒ 无色；同时不许它顺手把闭合引号吞进上一层（旧 `%` 层正是这么丢引号的）。
      //    ⑧ 闭合引号 `@pop`；⑨⑩ 行尾出栈（`$` 形须排在无锚 catch-all 之前）。
      str: [
        [/\\./, 'string'], // ①
        // ②③ 本行既等不到闭合记号、也等不到闭合引号 ⇒ 残段留在 string 层并出栈
        //（`"台词{未闭合`、记号正好压在行尾的 `"台词{`、`"前段%` 都不许把 strExpr / strStr 带过行界）
        [/\{[^"}]*$/, { token: 'string', next: '@popall' }], // ②
        [/%[^"%]*$/, { token: 'string', next: '@popall' }], // ③
        // ④⑤ 开层（前瞻要求"闭合记号在闭合引号之前"，见 B④）
        [/\{(?=[^"}]*\})/, { token: 'string.escape', next: '@strExpr' }], // ④
        [/%(?=[^"%]*%)/, { token: 'string.escape', next: '@strStr' }], // ⑤
        // ⑥⑦ 落单记号（形如 `"…{"`：本行有闭合引号却没有闭合记号）就是**字面内容**——
        // 保住颜色，也保住那枚闭合引号的 `@close`（bracket 配对计数不许被吞掉一层）
        [/\{/, 'string'], // ⑥
        [/%/, 'string'], // ⑦
        [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }], // ⑧
        [/[^"{%\\]+$/, { token: 'string', next: '@popall' }], // ⑨
        [/[^"{%\\]+/, 'string'],
        // ⑩ 行尾落单的 `\`（续行写法里真会出现）：①要两枚字符、⑨又不吃 `\`，
        // 少了这一条串态就会被带过行界——正是⑨要防的事，所以单独收口。
        [/\\$/, { token: 'string', next: '@popall' }],
      ],
      strExpr: [
        [/[^}]+$/, { token: 'variable', next: '@popall' }],
        [/\}/, { token: 'string.escape', next: '@pop' }],
        [/[^}]+/, 'variable'],
      ],
      strStr: [
        [/[^%]+$/, { token: 'variable', next: '@popall' }],
        [/%/, { token: 'string.escape', next: '@pop' }],
        [/[^%]+/, 'variable'],
      ],
      /**
       * `[SKIPSTART]` 后的原样块：逐行整块吃成 `keyword.raw`，只有**整行等值**的
       * `[SKIPEND]` 退栈（与开头进入判据同一把尺子）。块内 `IF` / `;` / `"…"` /
       * 嵌套 `[SKIPSTART]` 一律不解析——引擎既不编译也不执行这些行。
       */
      skip: [
        [/^\s*\[SKIPEND\]\s*$/, { token: 'keyword.preprocessor.skip.end', next: '@pop' }],
        [/.*$/, 'keyword.raw'],
      ],
    },
  };
}

/**
 * 当前 Monarch tokens provider 的句柄（`setMonarchTokensProvider` 的返回值）。
 *
 * **重设纪律**：重设前先 dispose 旧的（Monaco 的 TokenizationRegistry 对"句柄已过期"
 * 的 dispose 是守卫过的——旧句柄在新 provider 就位后 dispose 是安全空操作，但先 dispose
 * 再 set 语义最干净）；项目切换 / EditorPane 卸载必须回到基底词表（`setErbDirectiveWords`
 * 传 `null`），**不得残留上一项目的词表**——与 hover 的"表随项目现取"同一纪律。
 */
let monarchDisposable: Monaco.IDisposable | null = null;

/**
 * 重设 ERB 的 Monarch directive 词表（宿主装配点调用）。
 *
 * `words` = 合并后的词表（`mergeDirectiveWords(ERB_DIRECTIVES, adapterNames)`）；
 * `null` / 缺省 = 回基底 `ERB_DIRECTIVES`（项目关闭 / 卸载）。同一份 tokenizer 骨架，
 * 只换词表；重设时 dispose 旧 provider。
 */
export function setErbDirectiveWords(monaco: typeof Monaco, words?: readonly string[] | null): void {
  monarchDisposable?.dispose();
  monarchDisposable = monaco.languages.setMonarchTokensProvider(
    ERB_LANGUAGE_ID,
    erbMonarch(words ?? ERB_DIRECTIVES),
  );
}

export function registerErbLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((l) => l.id === ERB_LANGUAGE_ID)) return;

  // 扩展名映射取自契约层单一真源（`plugin-api/erb-ext`，FT-2 收口）：
  // 索引收哪些方言 ⇔ 高亮覆盖哪些方言，一条清单管两头。大小写两种写法由
  // `erbMonacoExtensions` 现算派生（Monaco 按字面量匹配，盘上 `X.ERB`/`X.ERH` 都得命中），
  // 不是第二处手抄。`.ERH` 自本批起进映射——声明文件同样是 `#DIM`/`#DEFINE` 的 ERB 语法。
  monaco.languages.register({
    id: ERB_LANGUAGE_ID,
    extensions: erbMonacoExtensions(),
    aliases: ['ERB', 'EraBasic'],
  });

  monarchDisposable = monaco.languages.setMonarchTokensProvider(ERB_LANGUAGE_ID, erbMonarch(ERB_DIRECTIVES));

  // ERB-ENTER-RULES（2026-10-21）：回车层级与 `.kojo` 走同一道翻译层（`enter-rules.ts`），
  // 词表由引擎配对表派生（`erb-enter.ts`，零手抄词形）——ERB 是一等语言，
  // 打字手感这一格不是 `.kojo` 的专属福利。
  const enterConfig = toMonacoEnterConfig(monaco, erbEnterRulePatterns());
  monaco.languages.setLanguageConfiguration(ERB_LANGUAGE_ID, {
    comments: { lineComment: ERB_LINE_COMMENT },
    // 全角标点按词分隔（A3）；双击/Ctrl+方向键另经编辑器选项 wordSeparators，两处同源 word-separators.ts
    wordPattern: CJK_WORD_PATTERN,
    onEnterRules: enterConfig.onEnterRules,
    indentationRules: enterConfig.indentationRules,
    brackets: ERB_BRACKET_PAIRS.map(([open, close]) => [open, close] as [string, string]),
    // additive：同一张表再喂一格，让嵌套括号按层着色（Monaco 0.57 的 LanguageConfiguration）
    colorizedBracketPairs: ERB_BRACKET_PAIRS.map(([open, close]) => [open, close] as [string, string]),
    autoClosingPairs: [
      ...ERB_BRACKET_PAIRS.map(([open, close]) => ({ open, close })),
      { open: ERB_QUOTE_PAIR[0], close: ERB_QUOTE_PAIR[1] },
    ],
    surroundingPairs: [
      ...ERB_BRACKET_PAIRS.map(([open, close]) => ({ open, close })),
      { open: ERB_QUOTE_PAIR[0], close: ERB_QUOTE_PAIR[1] },
    ],
  });

  // 主题单一装配点（`theme.ts`）：kojo-dark / kojo-light / kojo-mint-dark 三套一次定义
  defineMonacoThemes(monaco);
}
