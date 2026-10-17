import type * as Monaco from './entry';
import type { LineDecoration } from '@kojo/plugin-api';
import { ENGINE_VARIABLE_FAMILIES, sugarEditorLexicon, SYSTEM_FUNCTION_ALIASES, sugarEnterRulePatterns } from '@kojo/plugin-kojo-sugar';
import { CJK_WORD_PATTERN } from './word-separators';

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
 * 与 `erb-language.ts` 硬编码 ASCII `ERB_DIRECTIVES` 的取舍不同：`.kojo` 词表是活表，
 * 并行批次随时往表里登记新的中文主形，宿主侧必须**零改动**就认得。
 *
 * 着色分层（"屏上一眼看出还剩哪一层没中文化"）：档位表见 `KOJO_TOKEN_TIERS`，
 * 判据（每档前景互不相同 + 对比度/色差不得低于既有档位基线）在
 * `packages/app/tests/kojo-token-tiers.test.ts` 里复跑。
 *
 * 高亮是**最佳努力**（Monarch 非 LR 解析器，规范 §7 已定调 v1 走 Monarch；
 * 精确结构判定在 `kojo-sugar` 转译器，波浪线由 `ui.editor.decorator` 槽给出）。
 */

export const KOJO_LANGUAGE_ID = 'kojo-sugar';

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

/** 原生直通行里可识别的高频 ERB 指令（高亮口径；不做语义分析；族头已另立一档） */
const ERB_COMMANDS_BASE = [
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
];
const FAMILY_HEAD_SET = new Set(ERB_FAMILY_HEADS);
export const ERB_COMMANDS: readonly string[] = ERB_COMMANDS_BASE.filter((d) => !FAMILY_HEAD_SET.has(d));

/**
 * 中文系统函数名（HK-11①）——从 `kojo-sugar` 的 `SYSTEM_FUNCTION_ALIASES`
 * **派生**（单一真源，本文件不复制词形）。
 */
export const SYSTEM_FUNCTION_WORDS: string[] = [...SYSTEM_FUNCTION_ALIASES.keys()];

/**
 * `kojo-dark` 主题里糖专属 token 的着色规则（由 `erb-language.ts` 合并进主题定义）。
 *
 * 取色口径（**深底可读 + 一档一色**，判据复跑见 `kojo-token-tiers.test.ts`）：
 * - 已中文化的糖层走冷色族（紫=关键字、青=运算符、蓝=函数、绿=台词、玫=代词）；
 * - 还没中文化的原生层走"外来族"（粉=引擎指令、蓝紫=族头、灰=整行原生直通），
 *   名字层（CJK 非词表 = 槽位原名 / 作者自定名）走薄荷绿；
 * - 亮度全部 ≥ 4.46:1（既有档位里最弱的一档），不为了分层引入刺眼的高饱和。
 */
export const KOJO_SUGAR_THEME_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'sugar.keyword', foreground: 'c678dd' },
  { token: 'sugar.keyword.alias', foreground: '8b7bb8' },
  { token: 'sugar.system-function', foreground: '61afce' },
  { token: 'sugar.operator', foreground: '56b6c2' },
  { token: 'sugar.cont', foreground: 'e5c07b', fontStyle: 'bold' },
  { token: 'sugar.pronoun', foreground: 'e06c75' },
  { token: 'sugar.speech', foreground: '98c379' },
  { token: 'sugar.speech.delimiter', foreground: '7f9cc0' },
  { token: 'sugar.interp', foreground: 'd19a66' },
  { token: 'sugar.interp.delimiter', foreground: 'd19a66', fontStyle: 'bold' },
  { token: 'sugar.colon', foreground: '7f9cc0' },
  { token: 'sugar.slot', foreground: '5cc9a8' },
  { token: 'keyword.raw', foreground: '9aa0a6' },
  { token: 'keyword.erb', foreground: 'ff7ab2' },
  { token: 'keyword.erb.family', foreground: '9d7bea' },
];

/**
 * 档位表：**作者看得见的分层口径** → 该档的 token 名（多 token = 同档同色）。
 *
 * 为什么把这张表放进源码而不只放测试：它同时是**主题的验收清单**——新增一档就得在这里
 * 登记，`kojo-token-tiers.test.ts` 立刻会问"这一档的前景色与谁撞了"。
 */
export interface KojoTokenTier {
  /** 档名（面向作者的中文口径；只用于报错文案，不参与配色计算） */
  readonly tier: string;
  /** 该档的 token 名（同档共享前景色） */
  readonly tokens: readonly string[];
  /** 为什么值得单独一档（写不出理由的不配成为一档） */
  readonly why: string;
}

export const KOJO_TOKEN_TIERS: readonly KojoTokenTier[] = [
  { tier: '中文关键字', tokens: ['sugar.keyword'], why: '句子的骨架，作者最常确认的一眼位' },
  { tier: '中文运算符', tokens: ['sugar.operator'], why: '`不在` 与比较词都改判定，须与关键字分色' },
  { tier: '中文系统函数', tokens: ['sugar.system-function'], why: '调用位（中文函数名）与关键字不同层' },
  { tier: '保留代词', tokens: ['sugar.pronoun'], why: '`她`/`你` 是引用而非控制流' },
  { tier: '不等待标记', tokens: ['sugar.cont'], why: '`续`/`~`/`⏎` 改的是运行行为' },
  { tier: '台词', tokens: ['sugar.speech'], why: '作者写的正文，语法层要退到后面' },
  { tier: '结构性标点', tokens: ['sugar.speech.delimiter', 'sugar.colon'], why: '块头与台词的边界，一族即可' },
  { tier: '插值记号', tokens: ['sugar.interp', 'sugar.interp.delimiter'], why: '「台词里的表达式」自成一层' },
  { tier: '名字层（槽位原名 / 作者自定名）', tokens: ['sugar.slot'], why: '既不是语法词也不是英文残留，是"还得记住的原名"' },
  { tier: '英文隐藏别名', tokens: ['sugar.keyword.alias'], why: '输入生效但不必展示 ⇒ 弱化一档，看得见但别抢戏' },
  { tier: '引擎指令', tokens: ['keyword.erb'], why: '一整条还没中文化的骨架，需要最扎眼的外来色' },
  { tier: '引擎族头', tokens: ['keyword.erb.family'], why: '族头后面还挂着槽位原名 ⇒ 与指令分档才看得出差一层' },
  { tier: '整行原生直通', tokens: ['keyword.raw'], why: '围栏 / `$标签` / `@函数` = 不透明整块，与行内指令分档' },
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
    operators: OPERATOR_WORDS,
    contMarks: CONT_MARKS,
    pronouns: [...PRONOUN_WORDS],
    englishAliases: ALIAS_WORDS,
    erbCommands: ERB_COMMANDS,
    erbFamilyHeads: ERB_FAMILY_HEADS,
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
        // 原生直通行：`$标签` / `@函数` = 不透明整块 ⇒ 前缀与名字一律走原生档（不吃基线 label/function 色）
        [/^\s*\$[^\s;]+/, 'keyword.raw'],
        [/^\s*@[^\s;(]+/, 'keyword.raw'],
        // 行首全大写 ERB 指令：族头一档、其余指令一档、没见过的照旧当普通名字
        [
          /^(\s*)([A-Z][A-Z0-9_]*)\b/,
          [
            '',
            {
              cases: {
                '@erbFamilyHeads': 'keyword.erb.family',
                '@erbCommands': 'keyword.erb',
                '@default': 'identifier',
              },
            },
          ],
        ],
        // 台词引号（「」/｢｣/『』）——台词 = 作者色（规范 §1.3 的 99% 相关律）
        [/「/, { token: 'sugar.speech.delimiter', next: '@speech' }],
        [/｢/, { token: 'sugar.speech.delimiter', next: '@speechAlt' }],
        [/『/, { token: 'sugar.speech.delimiter', next: '@speechIn' }],
        // 插值 `{…}`（旁白行/台词行皆可出现）
        [/\{/, { token: 'sugar.interp.delimiter', next: '@interp' }],
        // 标记的**符号形**（`~` / `⏎`，词表派生）：词支命中不到的那一批，单独一条规则给 `sugar.cont`
        [charClassPattern(CONT_SYMBOLS), 'sugar.cont'],
        // 中文词形：运算符 → 不等待标记 → 保留代词 → 关键字 → 系统函数 → 名字层
        [
          /[\u3040-\u30ff\u4e00-\u9fff\uff66-\uff9f]+/,
          {
            cases: {
              '@contMarks': 'sugar.cont',
              '@operators': 'sugar.operator',
              '@pronouns': 'sugar.pronoun',
              '@primaryWords': 'sugar.keyword',
              '@systemFunctions': 'sugar.system-function',
              // 词表里没有的中文/日文名字 = 槽位原名或作者自定名（既不是语法词也不是英文残留）
              '@default': 'sugar.slot',
            },
          },
        ],
        // 英文隐藏别名（小写）/ ERB 指令（全大写，行首已分档，此处兜底）
        [
          /[A-Za-z_][A-Za-z0-9_]*/,
          {
            cases: {
              '@contMarks': 'sugar.cont',
              '@englishAliases': 'sugar.keyword.alias',
              '@erbFamilyHeads': 'keyword.erb.family',
              '@erbCommands': 'keyword.erb',
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