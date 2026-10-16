import type * as Monaco from './entry';
import type { LineDecoration } from '@kojo/plugin-api';
import { RESERVED_PRONOUNS, SUGAR_LEXICON_OPERATORS, SUGAR_LEXICON_WORDS, SYSTEM_FUNCTION_ALIASES, sugarEnterRulePatterns } from '@kojo/plugin-kojo-sugar';
import { CJK_WORD_PATTERN } from './word-separators';

/**
 * 语法糖（`.kojo` 表层 DSL）编辑器支持 —— Monarch 词法 + 语言配置。
 *
 * 依据：`docs/SYNTAX-SUGAR-SURFACE-SPEC.md`（表层语法 v1.2）。本文件住**宿主层**
 * （app 壳），因为 Monaco 不属任何插件（插件契约刻意不依赖 Monaco）。
 *
 * 词表**单一真源**：中文主形 / 英文别名 / 运算符一律取自 `kojo-sugar` 转译器自身的
 * 关键字表（`SUGAR_LEXICON_*`），系统函数中文名（HK-11①）取自 `SYSTEM_FUNCTION_ALIASES`，
 * 故高亮/补全与词法**永不脱节**——本文件不复制任何
 * 词形清单（与 `erb-language.ts` 硬编码 DIRECTIVES 的取舍不同：糖词表是活表）。
 *
 * 高亮是**最佳努力**（Monarch 非 LR 解析器，规范 §7 已定调 v1 走 Monarch；
 * 精确结构判定在 `konjo-sugar` 转译器，波浪线由 `ui.editor.decorator` 槽给出）。
 */

export const KOJO_LANGUAGE_ID = 'kojo-sugar';

/** 中文主形关键字（语义高亮用；规范 §4.1「中英双收但中英不对等展示」） */
export const PRIMARY_WORDS = SUGAR_LEXICON_WORDS.filter((w) => w.primary);
/** 英文隐藏别名（输入即生效，高亮为次要色；不进补全列表） */
const ALIAS_WORDS = SUGAR_LEXICON_WORDS.filter((w) => !w.primary).map((w) => w.word);

/** 表层 `续`/`cont` 等不等待标记（规范 §3.3）——单独着色以示"它改的是行为" */
const CONT_MARKS = ['续', 'cont', 'continue'];
/** `不在` 介于关键字与运算符之间（规范 §3.5），与运算符同色；补全亦归运算符组 */
export const NOTIN_MARKS = ['不在', 'notin'];

/** 原生直通行里可识别的高频 ERB 指令（高亮口径；不做语义分析） */
const ERB_DIRECTIVES = [
  'PRINT', 'PRINTL', 'PRINTW', 'PRINTV', 'PRINTVL',
  'PRINTFORM', 'PRINTFORML', 'PRINTFORMS', 'PRINTFORMW', 'PRINTFORMV',
  'PRINTDATA', 'PRINTDATAL', 'PRINTDATAW', 'PRINTDATAS',
  'PRINTSINGLE', 'PRINTSINGLEL', 'PRINTSINGLEFORM', 'PRINTSINGLEFORML',
  'IF', 'ELSEIF', 'ELSE', 'ENDIF', 'SIF',
  'SELECTCASE', 'CASE', 'CASEELSE', 'ENDSELECT',
  'FOR', 'NEXT', 'WHILE', 'WEND', 'DO', 'LOOP', 'REPEAT', 'REND', 'BREAK', 'CONTINUE', 'RETURN',
  'CALL', 'CALLL', 'JUMP', 'CALLFORM', 'TRYCALLFORM', 'TRYCALL', 'TRYJUMP',
  'DIM', 'DIMS', 'SWAP', 'SETCOLOR', 'RESETCOLOR', 'FONTBOLD', 'FONTITALIC', 'FONTSIZE',
  'WAIT', 'INPUT', 'INPUTS', 'RAND', 'TIMES', 'BAR', 'BARL', 'DRAWLINE',
  'CFLAG', 'TFLAG', 'TCVAR', 'TALENT', 'ABL', 'EXP', 'MARK', 'BASE', 'PALAM',
];

/**
 * 中文系统函数名（HK-11①）——从 `kojo-sugar` 的 `SYSTEM_FUNCTION_ALIASES`
 * **派生**（单一真源，本文件不复制词形）。
 */
export const SYSTEM_FUNCTION_WORDS: string[] = [...SYSTEM_FUNCTION_ALIASES.keys()];

/** `kojo-dark` 主题里糖专属 token 的着色规则（由 `erb-language.ts` 合并进主题定义） */
export const KOJO_SUGAR_THEME_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'sugar.keyword', foreground: 'c678dd' },
  { token: 'sugar.keyword.alias', foreground: '8b7bb8' },
  { token: 'sugar.keyword.value', foreground: '56b6c2' },
  { token: 'sugar.system-function', foreground: '61afce' },
  { token: 'sugar.operator', foreground: '56b6c2' },
  { token: 'sugar.cont', foreground: 'e5c07b', fontStyle: 'bold' },
  { token: 'sugar.pronoun', foreground: 'e06c75' },
  { token: 'sugar.speech', foreground: '98c379' },
  { token: 'sugar.speech.delimiter', foreground: '7f9cc0' },
  { token: 'sugar.interp', foreground: 'd19a66' },
  { token: 'sugar.interp.delimiter', foreground: 'd19a66', fontStyle: 'bold' },
  { token: 'sugar.colon', foreground: '7f9cc0' },
  { token: 'keyword.raw', foreground: 'e5c07b' },
  { token: 'keyword.erb', foreground: 'c678dd' },
];

export function registerKojoLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((l) => l.id === KOJO_LANGUAGE_ID)) return;

  monaco.languages.register({
    id: KOJO_LANGUAGE_ID,
    extensions: ['.kojo'],
    aliases: ['kojo'],
  });

  monaco.languages.setMonarchTokensProvider(KOJO_LANGUAGE_ID, {
    ignoreCase: false,
    defaultToken: '',
    primaryWords: PRIMARY_WORDS.map((w) => w.word),
    operators: [...SUGAR_LEXICON_OPERATORS, ...NOTIN_MARKS],
    contMarks: CONT_MARKS,
    pronouns: [...RESERVED_PRONOUNS],
    englishAliases: ALIAS_WORDS,
    erbDirectives: ERB_DIRECTIVES,
    systemFunctions: SYSTEM_FUNCTION_WORDS,
    tokenizer: {
      root: [
        // 空行 / 注释（表层同时接受 `;` 与 `//`，规范 §3.10）
        [/^\s*[;].*$/, 'comment'],
        [/^\s*\/\/.*$/, 'comment'],
        // 原生 ERB 围栏（```erb … ```）：整块不透明，逐行着色为原生
        [/^\s*```\s*erb\b.*$/i, { token: 'keyword.raw', next: '@rawFence' }],
        // 行首 `@erb` 逃生舱（规范 §3.10）
        [/^\s*@\s*erb\b.*$/i, 'keyword.raw'],
        // 原生直通行：`$标签` / `@函数` / 全大写 ERB 指令
        [/^(\s*)(\$)([^\s;]+)/, ['', 'keyword.raw', 'label']],
        [/^(\s*)(@)([^\s;(]+)/, ['', 'keyword.raw', 'entity.name.function']],
        [
          /^(\s*)([A-Z][A-Z0-9_]*)\b/,
          ['', { cases: { '@erbDirectives': 'keyword.erb', '@default': 'identifier' } }],
        ],
        // 台词引号（「」/｢｣/『』）——台词 = 作者色（规范 §1.3 的 99% 相关律）
        [/「/, { token: 'sugar.speech.delimiter', next: '@speech' }],
        [/｢/, { token: 'sugar.speech.delimiter', next: '@speechAlt' }],
        [/『/, { token: 'sugar.speech.delimiter', next: '@speechIn' }],
        // 插值 `{…}`（旁白行/台词行皆可出现）
        [/\{/, { token: 'sugar.interp.delimiter', next: '@interp' }],
        // 中文词形：运算符 → 不等待标记 → 保留代词 → 关键字 → 裸标识符
        [
          /[\u3040-\u30ff\u4e00-\u9fff\uff66-\uff9f]+/,
          {
            cases: {
              '@contMarks': 'sugar.cont',
              '@operators': 'sugar.operator',
              '@pronouns': 'sugar.pronoun',
              '@primaryWords': 'sugar.keyword',
              '@systemFunctions': 'sugar.system-function',
              '@default': 'identifier',
            },
          },
        ],
        // 英文隐藏别名（小写）/ ERB 指令（全大写，仅行首已处理，此处兜底）
        [
          /[A-Za-z_][A-Za-z0-9_]*/,
          {
            cases: {
              '@contMarks': 'sugar.cont',
              '@englishAliases': 'sugar.keyword.alias',
              '@default': 'identifier',
            },
          },
        ],
        [/\b0x[0-9a-fA-F]+\b/, 'number.hex'],
        [/\b\d+\b/, 'number'],
        [/：/, 'sugar.colon'],
        [/[+\-*/%<>!=&|^~?:.,()\[\]]/, 'operator'],
      ],
      /** ```erb 围栏内部：逐行原生，遇闭合围栏退出 */
      rawFence: [
        [/^\s*```\s*$/, { token: 'keyword.raw', next: '@pop' }],
        [/.*$/, 'keyword.raw'],
      ],
      speech: [
        [/[^」{\\]+/, 'sugar.speech'],
        [/\{/, { token: 'sugar.interp.delimiter', next: '@interp' }],
        [/\\$/, 'sugar.speech'],
        [/」/, { token: 'sugar.speech.delimiter', next: '@pop' }],
        [/./, 'sugar.speech'],
      ],
      speechAlt: [
        [/[^｣{\\]+/, 'sugar.speech'],
        [/\{/, { token: 'sugar.interp.delimiter', next: '@interp' }],
        [/｣/, { token: 'sugar.speech.delimiter', next: '@pop' }],
        [/./, 'sugar.speech'],
      ],
      speechIn: [
        [/[^』{\\]+/, 'sugar.speech'],
        [/\{/, { token: 'sugar.interp.delimiter', next: '@interp' }],
        [/』/, { token: 'sugar.speech.delimiter', next: '@pop' }],
        [/./, 'sugar.speech'],
      ],
      interp: [
        [/[^}]+/, 'sugar.interp'],
        [/\}/, { token: 'sugar.interp.delimiter', next: '@pop' }],
      ],
    },
  } as Monaco.languages.IMonarchLanguage);

  // ZH-D4 回车层级：正则族由 `kojo-sugar` 从关键字表**派生**（本文件零词形硬编码）。
  const enterPatterns = sugarEnterRulePatterns();
  monaco.languages.setLanguageConfiguration(KOJO_LANGUAGE_ID, {
    comments: { lineComment: ';' },
    // 全角标点按词分隔（A3）；`：` 触发字在 quickSuggestions 关后靠它走显式触发通道（见 word-separators.ts 头注）
    wordPattern: CJK_WORD_PATTERN,
    // 块头行回车 ⇒ 新行 +1 级（`beforeText` 匹配"光标以左整行"⇒ 天然只在冒号后回车触发）；
    // 精确判型另见 `kojo-format.ts` 的 on-type 兜底层。
    onEnterRules: enterPatterns.indentOnEnter.map((beforeText) => ({
      beforeText,
      action: { indentAction: monaco.languages.IndentAction.Indent },
    })),
    indentationRules: {
      increaseIndentPattern: enterPatterns.increaseIndentPattern,
      decreaseIndentPattern: enterPatterns.decreaseIndentPattern,
    },
    brackets: [
      ['{', '}'],
      ['「', '」'],
      ['（', '）'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '「', close: '」' },
      { open: '（', close: '）' },
      { open: '(', close: ')' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '「', close: '」' },
    ],
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
    const endColumn = Math.min(Math.max(startColumn, Math.trunc(d.endColumn ?? maxColumn)), maxColumn);
    markers.push({
      severity: markerSeverity(monaco, d.severity),
      message: d.message,
      code: d.code,
      startLineNumber: line,
      startColumn,
      endLineNumber: line,
      endColumn,
    });
  }
  return markers;
}