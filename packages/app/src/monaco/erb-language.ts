import type * as Monaco from 'monaco-editor';

/**
 * ERB (EraBasic) 基础语法高亮 —— Monarch 词法定义（v0.1 宽口径版）。
 *
 * 依据（逆向文档《词法与表达式》《口上机制深挖》）：
 * - 行首 `;` 注释、`@` 函数定义、`#` 预处理指令、`$` 跳转标签；
 * - 指令表取口上高频子集；变量多段引用（CFLAG:ARG:口上セレクタ）整体高亮；
 * - FORM 串内 `{表达式}` / `%字符串%` 作为字符串内的第二层（Monarch 嵌套限制，v0.1 简化）。
 */

const DIRECTIVES = [
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

export function registerErbLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((l) => l.id === ERB_LANGUAGE_ID)) return;

  monaco.languages.register({ id: ERB_LANGUAGE_ID, extensions: ['.ERB', '.erb'], aliases: ['ERB', 'EraBasic'] });

  monaco.languages.setMonarchTokensProvider(ERB_LANGUAGE_ID, {
    ignoreCase: false,
    defaultToken: '',
    directives: DIRECTIVES,
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
        // 日文/中文全角标识符（变量名、参数名）
        [/[\u3040-\u30ff\u4e00-\u9fff\uff66-\uff9f]+/, 'identifier'],
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
  } as Monaco.languages.IMonarchLanguage);

  monaco.languages.setLanguageConfiguration(ERB_LANGUAGE_ID, {
    comments: { lineComment: ';' },
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

  monaco.editor.defineTheme('kojo-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6a737d', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c678dd' },
      { token: 'keyword.preprocessor', foreground: 'e5c07b' },
      { token: 'entity.name.function', foreground: '61afef', fontStyle: 'bold' },
      { token: 'variable', foreground: 'e06c75' },
      { token: 'string', foreground: '98c379' },
      { token: 'number', foreground: 'd19a66' },
      { token: 'label', foreground: '56b6c2' },
      { token: 'identifier', foreground: 'abb2bf' },
      { token: 'string.escape', foreground: 'd19a66' },
    ],
    colors: {},
  });
}
