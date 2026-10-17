import type * as Monaco from './entry';
import { ERB_DIRECTIVES } from './erb-directives';
import { ERB_HIGHLIGHT_EXTRA_WORDS } from './erb-highlight-words';
import { erbMonacoExtensions } from '@kojo/plugin-api';
import { defineMonacoThemes } from './theme';
import { CJK_WORD_PATTERN } from './word-separators';

/**
 * ERB (EraBasic) 基础语法高亮 —— Monarch 词法定义（v0.1 宽口径版）。
 *
 * 依据（逆向文档《词法与表达式》《口上机制深挖》）：
 * - 行首 `;` 注释、`@` 函数定义、`#` 预处理指令、`$` 跳转标签；
 * - 指令表 = 口上高频子集（单一真源 `erb-directives.ts`）；高亮另吃补集
 *   `erb-highlight-words.ts`（控制流语句 + 引擎内建单行语句，补全不消费）；
 * - 变量多段引用（CFLAG:ARG:口上セレクタ）整体高亮；
 * - FORM 串内 `{表达式}` / `%字符串%` 作为字符串内的第二层（Monarch 嵌套限制，v0.1 简化）。
 *
 * **大小写（2026-10-18 SUGGEST-2C）**：Emuera 关键字大小写不敏感，词表只存一种写法；
 * `ignoreCase: true` 让 `call` / `If` / `setcolor` 与全大写同档。若哪天关掉它，
 * `tests/erb-highlight.test.ts` 的三形态逐词发射会整片变红。
 */

/**
 * 指令词表单一真源在叶子模块 `erb-directives.ts`（零 import——kojo 侧要同一份清单，
 * 走本文件会踩 `erb-language → theme → kojo-language` 模块环的 TDZ）。
 * 此处**原样 re-export**：既有 import 点（`erb-completion` / `editor-global-providers` /
 * 测试）逐字零改动，引用的是同一数组本体。
 */
export { ERB_DIRECTIVES };

export const ERB_LANGUAGE_ID = 'kojo-erb';

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
        // 行首注释（Emuera 语义：行首 ; 整行注释）
        [/^\s*;.*$/, 'comment'],
        // 行首函数定义 @NAME / @NAME(...)
        [/^(\s*)(@)([^\s(;]+)/, ['', 'keyword', 'entity.name.function']],
        // 行首跳转标签 $LABEL
        [/^(\s*)(\$)([^\s;]+)/, ['', 'keyword', 'label']],
        // 预处理指令 #DIM / #FUNCTION 等（含修饰词）
        [/^(\s*)(#\w+)/, ['', 'keyword.preprocessor']],
        // 预处理区间标记
        [/\[SKIPSTART\]|\[SKIPEND\]/, 'keyword.preprocessor'],
        // 字符串（含 FORM 串转义）：v0.1 整体字符串着色；{}/%% 表单式在 v0.2 做二级解析
        [/"/, { token: 'string.quote', bracket: '@open', next: '@str' }],
        // 整词指令（含高亮补集）：必须排在变量族之前——CFLAG/EQUIP/RAND/DOWNBASE 同时是
        // 变量族头，只靠后面的 cases 会让大写形态吃 variable 色（SUGGEST-2C 的 second root）
        ...(standaloneKeyword ? [[standaloneKeyword, 'keyword'] as [RegExp, string]] : []),
        // 变量多段引用：CFLAG:ARG:口上セレクタ / TCVAR:50 / ARG:1 / RESULTS:2 / LOCALS:1
        [/\b(?:CFLAG|CDFLAG|CSTR|TCVAR|TSTR|TFLAG|TALENT|MARK|EXP|BASE|MAXBASE|ABL|TALENT|RELATION|RESULTS|LOCALS|LOCAL|ARGS|ARG|FLAG|DAY|TIME|MONEY|NAME|CALLNAME|MASTER|TARGET|ASSI|NO|RAND|SELECTCOM|TFLAG|PALAM|JUEL|GOTJUEL|UP|DOWN|LOSEBASE|CUP|CDOWN|DOWNBASE|SOURCE|NOWEX|EQUIP|TEQUIP|EX|PALAMLV|STAIN|STAIN_1|STAIN_2)\b(?::[^\s,()\[\]{}'"+\-*/%<>=!&|]+)*/, 'variable'],
        // 数值常量
        [/\b\d+\b/, 'number'],
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
        // 名）同样出 keyword——词表派生自 adapter 时非 ASCII 名才有着落
        [
          /[\u3040-\u30ff\u4e00-\u9fff\uff66-\uff9f]+/,
          {
            cases: {
              '@directives': 'keyword',
              '@highlightWords': 'keyword',
              '@default': 'identifier',
            },
          },
        ],
      ],
      str: [
        [/[^"%\\]+/, 'string'],
        [/\{/, { token: 'string.escape', next: '@strExpr' }],
        [/%/, { token: 'string.escape', next: '@strStr' }],
        [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
      ],
      strExpr: [
        [/\}/, { token: 'string.escape', next: '@pop' }],
        [/[^}]+/, 'variable'],
      ],
      strStr: [
        [/%/, { token: 'string.escape', next: '@pop' }],
        [/[^%]+/, 'variable'],
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

  monaco.languages.setLanguageConfiguration(ERB_LANGUAGE_ID, {
    comments: { lineComment: ';' },
    // 全角标点按词分隔（A3）；双击/Ctrl+方向键另经编辑器选项 wordSeparators，两处同源 word-separators.ts
    wordPattern: CJK_WORD_PATTERN,
    brackets: [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '"', close: '"' },
    ],
  });

  // 主题单一装配点（`theme.ts`）：kojo-dark / kojo-light / kojo-mint-dark 三套一次定义
  defineMonacoThemes(monaco);
}
