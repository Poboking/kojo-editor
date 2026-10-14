import type * as Monaco from 'monaco-editor';
import type { LineDecoration } from '@kojo/plugin-api';
import { RESERVED_PRONOUNS, SUGAR_LEXICON_OPERATORS, SUGAR_LEXICON_WORDS, SUGAR_KEYWORD_ROLE_LABEL, SYSTEM_FUNCTION_ALIASES } from '@kojo/plugin-kojo-sugar';

/**
 * 语法糖（`.kojo` 表层 DSL）编辑器支持 —— Monarch 词法 + 语言配置 + 补全 provider。
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

/** 中文主形关键字（补全默认只显示这些；规范 §4.1「中英双收但中英不对等展示」） */
const PRIMARY_WORDS = SUGAR_LEXICON_WORDS.filter((w) => w.primary);
/** 英文隐藏别名（输入即生效，高亮为次要色；不进补全列表） */
const ALIAS_WORDS = SUGAR_LEXICON_WORDS.filter((w) => !w.primary).map((w) => w.word);

/** 表层 `续`/`cont` 等不等待标记（规范 §3.3）——单独着色以示"它改的是行为" */
const CONT_MARKS = ['续', 'cont', 'continue'];
/** `不在` 介于关键字与运算符之间（规范 §3.5），与运算符同色 */
const NOTIN_MARKS = ['不在', 'notin'];

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
const SYSTEM_FUNCTION_WORDS: string[] = [...SYSTEM_FUNCTION_ALIASES.keys()];

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

  monaco.languages.setLanguageConfiguration(KOJO_LANGUAGE_ID, {
    comments: { lineComment: ';' },
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

  registerCompletion(monaco);
}

/* ============================== 补全 ============================== */

/** 头部 `别名 X = 目标` / `alias X = 目标` 的名字（补全用；轻量扫描，不重复转译器） */
const ALIAS_DECL = /^\s*(?:别名|alias)\s+([^\s=：:,，]+)/gm;

function aliasNamesOf(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(ALIAS_DECL)) {
    const name = m[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function registerCompletion(monaco: typeof Monaco): void {
  monaco.languages.registerCompletionItemProvider(KOJO_LANGUAGE_ID, {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const suggestions: Monaco.languages.CompletionItem[] = [];

      // 1. 文件内 `别名` 名字（别名补全——最常用，排最前）
      for (const name of aliasNamesOf(model.getValue())) {
        suggestions.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Variable,
          insertText: name,
          detail: '别名（本文件）',
          range,
          sortText: `1_${name}`,
        });
      }
      // 2. 保留代词（她 / 你）
      for (const p of RESERVED_PRONOUNS) {
        suggestions.push({
          label: p,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: p,
          detail: '保留代词',
          range,
          sortText: `2_${p}`,
        });
      }
      // 3. 中文主形关键字（英文隐藏别名**不进**补全，规范 §4.1）
      for (const w of PRIMARY_WORDS) {
        suggestions.push({
          label: w.word,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: w.word,
          detail: SUGAR_KEYWORD_ROLE_LABEL[w.role],
          range,
          sortText: `3_${w.role}_${w.word}`,
        });
      }
      // 4. 中文运算符 + `不在`
      for (const op of [...SUGAR_LEXICON_OPERATORS, ...NOTIN_MARKS]) {
        suggestions.push({
          label: op,
          kind: monaco.languages.CompletionItemKind.Operator,
          insertText: op,
          detail: '运算符',
          range,
          sortText: `4_${op}`,
        });
      }
      // 5. 中文系统函数名（HK-11①；从 `SYSTEM_FUNCTION_ALIASES` 派生）
      //    补全即调用形态——插入 `名字(`，作者接着写实参加 `)`
      for (const name of SYSTEM_FUNCTION_WORDS) {
        suggestions.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: `${name}(`,
          detail: '系统函数',
          range,
          sortText: `5_${name}`,
        });
      }

      return { suggestions };
    },
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
      source: d.code,
      startLineNumber: line,
      startColumn,
      endLineNumber: line,
      endColumn,
    });
  }
  return markers;
}