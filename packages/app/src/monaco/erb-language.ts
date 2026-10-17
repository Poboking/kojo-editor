import type * as Monaco from './entry';
import { erbMonacoExtensions } from '@kojo/plugin-api';
import { defineMonacoThemes } from './theme';
import { CJK_WORD_PATTERN } from './word-separators';

/**
 * ERB (EraBasic) 基础语法高亮 —— Monarch 词法定义（v0.1 宽口径版）。
 *
 * 依据（逆向文档《词法与表达式》《口上机制深挖》）：
 * - 行首 `;` 注释、`@` 函数定义、`#` 预处理指令、`$` 跳转标签；
 * - 指令表取口上高频子集；变量多段引用（CFLAG:ARG:口上セレクタ）整体高亮；
 * - FORM 串内 `{表达式}` / `%字符串%` 作为字符串内的第二层（Monarch 嵌套限制，v0.1 简化）。
 */

export const ERB_DIRECTIVES = [
  'PRINT', 'PRINTL', 'PRINTW', 'PRINTV', 'PRINTVL',
  'PRINTFORM', 'PRINTFORML', 'PRINTFORMS', 'PRINTFORMW', 'PRINTFORMV',
  'PRINTDATA', 'PRINTDATAL', 'PRINTDATAW', 'PRINTDATAS',
  'PRINTSINGLE', 'PRINTSINGLEL', 'PRINTSINGLEFORM', 'PRINTSINGLEFORML',
  'IF', 'ELSEIF', 'ELSE', 'ENDIF', 'SIF',
  'SELECTCASE', 'CASE', 'CASEELSE', 'ENDSELECT',
  'FOR', 'NEXT', 'WHILE', 'WEND', 'DO', 'LOOP', 'REPEAT', 'REND', 'BREAK', 'CONTINUE', 'RETURN',
  'CALL', 'CALLL', 'JUMP', 'CALLFORM', 'CALLFORML', 'TRYCALLFORM', 'TRYCALLFORMF',
  'TRYCALL', 'TRYJUMP', 'TRYCCALLFORM', 'CALLF', 'CALLFORMF',
  'DIM', 'DIMS', 'SWAP',
  'SETCOLOR', 'RESETCOLOR', 'FONTBOLD', 'FONTITALIC', 'FONTREGULAR', 'FONTSIZE', 'FONTSTYLE',
  'WAIT', 'WAITANYKEY', 'INPUT', 'INPUTS', 'ONEINPUT', 'TINPUT', 'TINPUTS', 'TWAIT',
  'STRDATA', 'SAVEDATA', 'LOADDATA', 'DELDATA', 'SAVEGLOBAL', 'LOADGLOBAL',
  'GETTIME', 'GETMILLISECOND', 'SETBIT', 'CLEARBIT', 'INVERTBIT', 'GETBIT', 'SETCOLORBYNAME',
  'RANDOMIZE', 'RAND', 'TIMES', 'EXISTCSV', 'BAR', 'BARL', 'DRAWLINE', 'CLEARLINE', 'ALIGNMENT',
  'ADDCHARA', 'ADDSPCHARA', 'DELCHARA', 'SWAPCHARA', 'PICKUPCHARA', 'GETCHARA', 'CHKCHARA',
  'EQUIP', 'UNEQUIP', 'EQUIPCHECK', 'CHANGE_CFLAG', 'CFLAG', 'RESETDATA', 'BEGIN', 'EVENTCOM',
];

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

/**
 * Monarch 词法定义构建器（`directives` 词表参数化——基底与 adapter 派生词表共用同一份
 * tokenizer 骨架，只换词表，别处零分叉）。
 */
function erbMonarch(directives: readonly string[]): Monaco.languages.IMonarchLanguage {
  return {
    ignoreCase: false,
    defaultToken: '',
    directives: [...directives],
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
