/**
 * Kojo 2.0 的 **Monaco 语言面**（U6）：词法分档 + 语言配置（配色数据见零依赖叶子）。
 *
 * ## 定位
 * 这是 2.0 前端的**第一刀**，暂挂扩展名 `.kojo2`（**不抢** v1 的 `.kojo`）：真正的切流
 * 由 `K2-CUTOVER` 把 `languages.ts` 的 descriptor 指过来。本文件因此**不碰** v1 的
 * `kojo-language.ts` / `languages.ts` / `language-registry.ts`，只导出
 * {@link registerKojo2Language} 供 CUTOVER 调用。
 *
 * ## 分档目标（"一眼看出这行是哪种脸"）
 * 五锚点（`# @ > ? !`）是骨架；台词 / 旁白 / 原生 / 注释 / 提示各自一档；插值与数字/运算符
 * 在正文里单独一档。token 名一律 `kojo2.*`，与 v1 的 `sugar.*` / `keyword.erb*` **不撞名**
 * （档位表见 {@link KOJO2_TOKEN_TIERS}，配色见 {@link KOJO2_THEME_RULES}）。
 *
 * 主题合并**不在本文件**：`theme.ts` 是仓里唯一的主题装配点（`kojo-dark` / `kojo-light` /
 * `kojo-mint-dark` 一次定义）。2.0 的规则数据住在零 import 叶子 `kojo-theme-rules.ts`，
 * `theme.ts` 在 flag 开时把它并进 v1 三套（K2-CUTOVER-THEME）；本文件不 defineTheme，
 * 避免出现第二份主题。
 *
 * ## 词表零抄本
 * 所有中文字形来自 {@link ./kojo2-lexicon}（core / 糖聚合的转发）；本文件**只有正则与状态机**。
 * `kojo2-language-lexicon.test.ts` 扫本目录源码：字符串字面量不得等于 2.0 词表里的任何词形。
 *
 * ## 状态机口径（为什么不是逐行正则一把梭）
 * 台词 `「…」`、旁白 `> …`、`@原生` 围栏是**跨记号/跨行**的：台词里的 `#`/`?`/`>` 是正文，
 * 围栏内的 `;`/`//`/`{}` 是 ERB 原文。三者用三个小状态机（`speech` / `narration` /
 * `nativeN`）承接；**每个状态都有"行尾必回根"的收尾规则**（台词未闭合也只在行内着色，
 * 绝不把下一行拖进台词脸），`@原生` 用"比栏头更深才算体"的缩进阶梯状态收口。
 *
 * Monarch 只是**最佳努力**的词法层：精确结构判定在 `@kojo/kojo-core`（lexer/parser），
 * 波浪线由 core 诊断出。这里不为难 Monarch 做它做不到的事。
 */

import type * as Monaco from './entry';
import {
  KOJO2_BLOCK_HEADER_COLON_RE,
  KOJO2_INDENT_UNIT,
  kojo2IndentationRules,
  kojo2OnEnterRules,
} from './kojo2-enter';
import {
  KOJO2_DECL_WORDS,
  KOJO2_DISPATCH_WORDS,
  KOJO2_DOMAIN_SYMBOLS,
  KOJO2_INDENT_WIDTH,
  KOJO2_NATIVE_FENCE_WORD,
  KOJO2_OPERATOR_WORDS,
  KOJO2_RESERVED_WORDS,
  KOJO2_TABLE_DEFAULT_WORD,
  KOJO2_TEMPLATE_SLOT,
  KOJO2_WAIT_CONTINUE,
  escapeRegExp,
} from './kojo2-lexicon';
import { CJK_WORD_PATTERN } from './word-separators';
import { KOJO2_LANGUAGE_ID, KOJO2_SOURCE_EXTENSION } from './kojo2-constants';
import { KOJO2_THEME_RULES, KOJO2_TOKEN } from './kojo-theme-rules';

/**
 * 语言 id 与源扩展名：**定义处已下沉**零 import 叶子 `kojo2-constants.ts`（K2-CUTOVER-THEME）。
 *
 * 为什么不留在本文件：本文件一加载就经 `kojo2-lexicon` 拖上 `@kojo/plugin-kojo-sugar`
 * （~900 KB 词表链），而路由层（`ui/kojo2-cutover.ts`）与 model 重挂层只需要这两枚字符串。
 * 此处按**同一字面源** re-export：既有 import 点（`languages.ts` / `ui/kojo2-open.ts` /
 * 测试）读到的值一字不变，别在这里复制第二份。
 */
export { KOJO2_LANGUAGE_ID, KOJO2_SOURCE_EXTENSION };

/* ============================== token 分档 ============================== */

/**
 * token 名与配色：**定义处已下沉**零 import 叶子 `kojo-theme-rules.ts`（K2-CUTOVER-THEME）。
 *
 * `theme.ts` 在开机静态图里，要在 flag 开时把 2.0 规则并进 v1 三套主题，就不能经本文件
 * 取那批数据（等于把糖词表挂回首屏）。因此 `KOJO2_TOKEN` / `KOJO2_THEME_RULES` /
 * `KOJO2_LIGHT_THEME_RULES` 住在叶子，本文件与 `kojo2-theme.ts` 各自 re-export 同一对象本体。
 */
export { KOJO2_THEME_RULES, KOJO2_TOKEN };
export type { Kojo2TokenName } from './kojo-theme-rules';

/**
 * 档位表（作者可见的分层口径 → token 名；同档共享前景色）。
 * 这张表同时是**主题验收清单**：新增一档必须在这里登记，测试会问"它和谁撞色/撞名"。
 */
export interface Kojo2TokenTier {
  /** 档名（面向作者的中文口径，只用于报错文案，不参与配色计算） */
  readonly tier: string;
  /** 该档 token 名（同档共享前景色） */
  readonly tokens: readonly string[];
  /** 为什么值得单独一档（写不出理由的不配成为一档） */
  readonly why: string;
}

export const KOJO2_TOKEN_TIERS: readonly Kojo2TokenTier[] = [
  { tier: '锚点', tokens: [KOJO2_TOKEN.anchor], why: '五锚点是句子的第一眼，必须先看见' },
  { tier: '声明与调度词', tokens: [KOJO2_TOKEN.declaration], why: '`#`/`@` 后的词决定这一行是不是声明' },
  { tier: '保留词', tokens: [KOJO2_TOKEN.keyword, KOJO2_TOKEN.delimiter], why: '`由`/`否`/`续`/类型词改的是语义，标点只是骨架' },
  { tier: '说话人', tokens: [KOJO2_TOKEN.speaker], why: '谁在说话与说了什么必须两层' },
  { tier: '台词与字面文本', tokens: [KOJO2_TOKEN.speech, KOJO2_TOKEN.string], why: '作者写的字，语法层要退到后面' },
  { tier: '旁白', tokens: [KOJO2_TOKEN.narration], why: '旁白与台词是两种脸（一个 `>` 一个 `角色：`）' },
  { tier: '插值', tokens: [KOJO2_TOKEN.interp], why: '「正文里的表达式」自成一层' },
  { tier: '表演提示', tokens: [KOJO2_TOKEN.hint], why: '提示不打印、只改演出，必须与正文分色' },
  { tier: '原生围栏', tokens: [KOJO2_TOKEN.raw], why: '不透明 ERB 原文，一眼看出"这里 2.0 不解释"' },
  { tier: '注释', tokens: [KOJO2_TOKEN.comment], why: '不参与演出的说明' },
  { tier: '数字', tokens: [KOJO2_TOKEN.number, KOJO2_TOKEN.hex], why: '字面量在表达式里要能扫读' },
  { tier: '运算符', tokens: [KOJO2_TOKEN.operator], why: '中文运算符词与符号同档，判定位一眼可辨' },
];

/* ============================== 词法状态机 ============================== */

/** `@原生` 围栏缩进阶梯：0..7 级（28 空格）；再深的结构缩进按 0 级兜底（无效缩进由 core 报错）。 */
const NATIVE_FENCE_MAX_LEVEL = 8;

type Rule = Monaco.languages.IMonarchLanguageRule;

/** 行尾收口：`<body>$` 这类"吃到行尾就回根"的规则统一 `next: '@pop'`（Monarch 的 `$` 只匹配行尾）。 */
const POP = '@pop';

function action(token: string, next?: string): { token: string; next?: string } {
  return next === undefined ? { token } : { token, next };
}

/** `#` 行：`#` + 空白 + 词（词按 `@declWords` 分声明/未知两路）。 */
const DECL_LINE = /^(\s*#[ \t\u3000]+)(\S+)/;

/** `@` 行：`@` + 词（`@原生` 栏头由更专有的规则先接走）。 */
const DISPATCH_LINE = /^(\s*@)([^\s(（,，:：]*)/;

/** `!` 行：`!` + 空白 + 被调名（池 / 模板 / 函数；名后允许实参括号）。 */
const TRIGGER_LINE = /^(\s*!\s+)([^\s(（,，:：]+)/;

/** `# 表` 两列行：默认分支 `否 <值>`。 */
const TABLE_DEFAULT_ROW = new RegExp(
  `^(\\s*)(${escapeRegExp(KOJO2_TABLE_DEFAULT_WORD)})(\\s+)(\\S.*)$`,
);

/** `# 表` 两列行：`<范围> <值>`（`0..99` / `500..` / `..100` / `5` / 常量名..）。 */
const TABLE_RANGE_ROW = /^(\s*)((?:[^\s]*\.[^\s]*|[-+]?\d+))(\s+)(\S.*)$/;

/** `@原生` 栏头：任意缩进；缩进阶梯由 `cases` 逐级分派到 `nativeN` 状态。 */
const NATIVE_HEADER = new RegExp(
  `^(\\s*)@${escapeRegExp(KOJO2_NATIVE_FENCE_WORD)}[ \\t\\u3000]*$`,
);

/** 行尾 `续`（必须前接空白；字形从词表单源派生，本文件不写这个字）。 */
const CONTINUATION_TAIL = new RegExp(
  `[ \\t\\u3000]+${escapeRegExp(KOJO2_WAIT_CONTINUE)}[ \\t\\u3000]*$`,
);

/** 台词正文的"停在行尾续之前"判据（惰性匹配 + 前瞻；避免把行尾 `续` 吞进正文色）。 */
const SPEECH_BEFORE_CONTINUATION = new RegExp(
  `[^」{(]+?(?=[ \\t\\u3000]+${escapeRegExp(KOJO2_WAIT_CONTINUE)}[ \\t\\u3000]*$)`,
);

/** 旁白正文的"停在行尾续之前"判据（同上，旁白正文不吃 `(` / `{`）。 */
const NARRATION_BEFORE_CONTINUATION = new RegExp(
  `[^({]+?(?=[ \\t\\u3000]+${escapeRegExp(KOJO2_WAIT_CONTINUE)}[ \\t\\u3000]*$)`,
);

/** `@原生` 栏头缩进 → 状态（精确到 4 空格一级；非法缩进一律按 0 级兜底，core 会报错）。 */
function nativeHeaderCases(): Record<string, unknown> {
  const cases: Record<string, unknown> = {};
  for (let level = 0; level < NATIVE_FENCE_MAX_LEVEL; level += 1) {
    cases[`$1==${' '.repeat(KOJO2_INDENT_WIDTH * level)}`] = action(
      KOJO2_TOKEN.anchor,
      `@native${level}`,
    );
  }
  cases['@default'] = action(KOJO2_TOKEN.anchor, '@native0');
  return cases;
}

/**
 * 一级 `@原生` 围栏状态：空白行原样保留（规范 §8.5）；比栏头更深（≥ 栏头 + 1 字符）的行
 * 整行 `kojo2.raw`；其余行零宽退回根状态重新分派（`^` 匹配零宽，Monarch 允许"栈变了就算有进展"）。
 */
function nativeState(level: number): Rule[] {
  const deeper = new RegExp(
    `^[ \\t]{${KOJO2_INDENT_WIDTH * level + 1},}\\S.*$`,
  );
  return [
    [/^\s*$/, KOJO2_TOKEN.raw],
    [deeper, KOJO2_TOKEN.raw],
    // 零宽回根：行首若不再比栏头深，说明围栏到此结束 —— 状态退回根、整行从列 0 重新分派。
    // 这里给一枚**零宽** `kojo2.raw` token 而不是空 token：真机两种写法等价（零宽不发色），
    // 而仓内 `tests/monarch-harness.ts` 的驱动器会把"空 token 动作"的 `next` 丢掉（真 Monarch
    // 保留）⇒ 用零宽 raw 让同一条语义在闸里也可驱动。屏上任何字符都不因此染色。
    [/^/, { token: KOJO2_TOKEN.raw, next: POP }],
  ];
}

/**
 * 台词态（进入时开引号 `「` 已消费）：正文 / 插值 / 提示 / 行尾 `续` / 收束引号。
 *
 * 每条"可能吃到行尾"的支路都带 `next: '@pop'`：**未闭合台词只到行尾**，下一行从根状态起步。
 */
const SPEECH_STATE: Rule[] = [
  // 行尾提示（`(心形)` / `(别过头)`）——先于正文，避免被正文吞掉
  [/\([^()\n]*\)[ \t\u3000]*$/, action(KOJO2_TOKEN.hint, POP)],
  // 行尾 `续`（必须前接空白；`「续` 这种"正文恰好是续"不误判）
  [CONTINUATION_TAIL, action(KOJO2_TOKEN.keyword, POP)],
  // 收束引号 + 可选空白到行尾
  [/」[ \t\u3000]*$/, action(KOJO2_TOKEN.delimiter, POP)],
  // 行尾闭合插值
  [/\{[^{}\n]*\}[ \t\u3000]*$/, action(KOJO2_TOKEN.interp, POP)],
  // 未闭合插值吃到行尾（错误由 core 报）
  [/\{[^{}\n]*$/, action(KOJO2_TOKEN.interp, POP)],
  // 行中提示 / 插值 / 收束引号（台词内继续）
  [/[ \t\u3000]*\([^()\n]*\)/, KOJO2_TOKEN.hint],
  [/\{[^{}\n]*\}/, KOJO2_TOKEN.interp],
  [/」/, KOJO2_TOKEN.delimiter],
  // 正文：先尝试停在"行尾续"之前，再是"整段吃到行尾并回根"，最后才是普通正文段
  [SPEECH_BEFORE_CONTINUATION, KOJO2_TOKEN.speech],
  [/[^」{(]+$/, action(KOJO2_TOKEN.speech, POP)],
  [/[^」{(]+/, KOJO2_TOKEN.speech],
  // 落单 `(`（半角）——未成组时仍是正文
  [/\([ \t\u3000]*$/, action(KOJO2_TOKEN.speech, POP)],
  [/\(/, KOJO2_TOKEN.speech],
  // 落单 `{`（未闭合插值已被上面吃走；这里只防嵌套花括号卡死）
  [/\{/, KOJO2_TOKEN.interp],
];

/**
 * 旁白态（进入时 `> ` 已消费）：正文 / 插值 / 提示 / 行尾 `续`。
 * 全角 `（……）` 是正文（会打印），只有半角 `(…)` 才有提示义。
 */
const NARRATION_STATE: Rule[] = [
  [/\([^()\n]*\)[ \t\u3000]*$/, action(KOJO2_TOKEN.hint, POP)],
  [CONTINUATION_TAIL, action(KOJO2_TOKEN.keyword, POP)],
  [/\{[^{}\n]*\}[ \t\u3000]*$/, action(KOJO2_TOKEN.interp, POP)],
  [/\{[^{}\n]*$/, action(KOJO2_TOKEN.interp, POP)],
  [/\([^()\n]*\)/, KOJO2_TOKEN.hint],
  [/\{[^{}\n]*\}/, KOJO2_TOKEN.interp],
  [NARRATION_BEFORE_CONTINUATION, KOJO2_TOKEN.narration],
  [/[^({]+$/, action(KOJO2_TOKEN.narration, POP)],
  [/[^({]+/, KOJO2_TOKEN.narration],
  [/\([ \t\u3000]*$/, action(KOJO2_TOKEN.narration, POP)],
  [/\(/, KOJO2_TOKEN.narration],
  [/\{/, KOJO2_TOKEN.interp],
];

/** 根状态：先按行首形状分派（五锚点 / 台词 / 表行 / 注释），其余走行内表达式词法。 */
function buildRoot(): Rule[] {
  const rules: Rule[] = [
    // ---- 整行注释（2.0 只认整行 `//`，行尾注释是 ERB 的事）----
    [/^\s*\/\/.*$/, KOJO2_TOKEN.comment],
    // ---- `@原生` 围栏头：缩进阶梯 → nativeN 状态 ----
    [NATIVE_HEADER, { cases: nativeHeaderCases() }],
    // ---- 五锚点 ----
    [DECL_LINE, [KOJO2_TOKEN.anchor, { cases: { '@declWords': KOJO2_TOKEN.declaration, '@default': '' } }]],
    [DISPATCH_LINE, [KOJO2_TOKEN.anchor, { cases: { '@dispatchWords': KOJO2_TOKEN.declaration, '@default': '' } }]],
    [/^\s*>\s+(?=\S)/, action(KOJO2_TOKEN.anchor, '@narration')],
    [/^\s*>/, KOJO2_TOKEN.anchor],
    [/^\s*\?\s+/, KOJO2_TOKEN.anchor],
    [/^\s*\?/, KOJO2_TOKEN.anchor],
    [TRIGGER_LINE, [KOJO2_TOKEN.anchor, KOJO2_TOKEN.declaration]],
    [/^\s*!/, KOJO2_TOKEN.anchor],
    // ---- 行首 `\`：字面文本行（`\>` 不是旁白）----
    [/^(\s*\\)(.*)$/, [KOJO2_TOKEN.anchor, KOJO2_TOKEN.narration]],
    // ---- 台词：`角色：` 前导（说话人），`「` 由下面行内规则接进 speech 态 ----
    [/^\s*[^\s：:]+：(?=「)/, KOJO2_TOKEN.speaker],
    // ---- `# 表` 两列行（默认分支 / 范围）----
    [TABLE_DEFAULT_ROW, ['', KOJO2_TOKEN.keyword, '', KOJO2_TOKEN.speech]],
    [TABLE_RANGE_ROW, ['', KOJO2_TOKEN.number, '', KOJO2_TOKEN.speech]],
    // ---- 台词开引号（行首裸引号与 `角色：「` 共用）；`(?=.)` 防"孤引号"把下一行拖进台词态 ----
    [/「(?=.)/, action(KOJO2_TOKEN.delimiter, '@speech')],
    // ---- 字符串字面量（闭合 / 未闭合到行尾）----
    [/"(?:[^"\\\n]|\\.)*"/, KOJO2_TOKEN.string],
    [/"(?:[^"\\\n]|\\.)*$/, KOJO2_TOKEN.string],
    // ---- 插值（闭合 / 未闭合到行尾；`{条件 ? A : B}` 整格一档）----
    [/\{[^{}\n]*\}/, KOJO2_TOKEN.interp],
    [/\{[^{}\n]*$/, KOJO2_TOKEN.interp],
    // ---- 模板插槽 `[插槽]`（整格是词，不是标识符）----
    [new RegExp(escapeRegExp(KOJO2_TEMPLATE_SLOT)), KOJO2_TOKEN.keyword],
    // ---- 字面量 ----
    [/\b0[xX][0-9a-fA-F]+\b/, KOJO2_TOKEN.hex],
    [/\b\d+\b/, KOJO2_TOKEN.number],
    // ---- 中文词形：运算符 / 保留词 / 域符号各一档，其余是名字（不上色）----
    [
      /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/,
      {
        cases: {
          '@operators': KOJO2_TOKEN.operator,
          '@keywords': KOJO2_TOKEN.keyword,
          '@domainSymbols': KOJO2_TOKEN.speaker,
          '@default': '',
        },
      },
    ],
    // ---- ASCII 名字（英文运算符别名 `notin` 单独一档；其余不上色）----
    [
      /[A-Za-z_][A-Za-z0-9_]*/,
      { cases: { '@operators': KOJO2_TOKEN.operator, '@default': '' } },
    ],
    // ---- 运算符符号（含 `.长度` 的点与 `..` 区间）----
    [/[+\-*/%<>=!&|^~?:.]+/, KOJO2_TOKEN.operator],
    // ---- 结构性标点 ----
    [/[()\[\]{}（）「」『』,，、。；;]/, KOJO2_TOKEN.delimiter],
    [/：/, KOJO2_TOKEN.delimiter],
  ];
  return rules;
}

/** 词法定义（导出给测试直接交给 `monarch-harness` 的真编译器）。 */
export const KOJO2_MONARCH: Monaco.languages.IMonarchLanguage = {
  ignoreCase: false,
  defaultToken: '',
  // 档位/状态用到的词表属性（`@declWords` 等 cases 通过它取；全部来自词表单源）
  declWords: KOJO2_DECL_WORDS,
  dispatchWords: KOJO2_DISPATCH_WORDS,
  keywords: KOJO2_RESERVED_WORDS,
  domainSymbols: KOJO2_DOMAIN_SYMBOLS,
  operators: KOJO2_OPERATOR_WORDS,
  tokenizer: {
    root: buildRoot(),
    speech: SPEECH_STATE,
    narration: NARRATION_STATE,
    ...Object.fromEntries(
      Array.from({ length: NATIVE_FENCE_MAX_LEVEL }, (_, level) => [
        `native${level}`,
        nativeState(level),
      ]),
    ),
  },
};

/* ============================== 语言配置 / 注册 ============================== */

/**
 * 打字期成对记号（**一处登记、三格消费**：`brackets` = 配对高亮 / 对着色 / 跳到配对，
 * `autoClosingPairs` = 敲开括号补闭括号，`surroundingPairs` = 选中文本敲括号包住它）。
 *
 * 每一对都要有 2.0 语法事实背书：
 * - `「」` 台词引号（§4.5；台词体内的 `#` / `?` / `>` 是正文，靠这一对圈住）；
 * - `{}` 插值（§4.12；闭合插值的收束记号）；
 * - `[]` 数组类型后缀 `字符串[3]`（§3.4）与 `# 模` 的 `[插槽]`（§7.2）；
 * - `（）` / `()` 旁白括注 / 实参括注（全角括注是正文，半角才是表演提示，§4.8）；
 * - `""` 字符串字面量（表值 / 函数默认参数）。
 *
 * **不许进这张表的**：全角 `：` / `，`（块头终止符与分隔符，不是括号对）、`『』`（语法不认这一对，
 * 正文里出现也只是字面文本）。`autoClosingPairs` 的 `notIn` 只有 `string` / `comment` / `regex`
 * 三档，表达不了"我在 `@原生` 围栏里"——那条上下文判定住 `kojo2-indent.ts` 的 on-type 层
 * （同一台词法器判 `kind === 'native'`），不在语言配置里造假。
 */
export const KOJO2_PAIRS: readonly (readonly [open: string, close: string])[] = Object.freeze([
  ['{', '}'],
  ['[', ']'],
  ['「', '」'],
  ['（', '）'],
  ['(', ')'],
  ['"', '"'],
] as const);

/** 语言配置（`comments` / `wordPattern` / 成对记号 / 回车层级；全部由单源派生）。 */
export function kojo2LanguageConfiguration(
  monaco: typeof Monaco,
): Monaco.languages.LanguageConfiguration {
  return {
    // 2.0 注释唯一正典：整行 `//`（`;` 只属于 `@原生` 里的 ERB，不能进这一格）
    comments: { lineComment: '//' },
    // 中文整词（复用既有 CJK 判据，不另写字符集）
    wordPattern: CJK_WORD_PATTERN,
    // 三格同一张表派生；`open === close` 的 `"` 不是括号，只进闭合/包裹两格
    brackets: KOJO2_PAIRS.filter(([open, close]) => open !== close).map(
      ([open, close]) => [open, close] as [string, string],
    ),
    autoClosingPairs: KOJO2_PAIRS.map(([open, close]) => ({ open, close })),
    surroundingPairs: KOJO2_PAIRS.map(([open, close]) => ({ open, close })),
    onEnterRules: kojo2OnEnterRules(monaco),
    indentationRules: kojo2IndentationRules(),
  };
}

/**
 * 注册 `kojo2` 语言面（**只为 CUTOVER 准备**：本函数不被 `languages.ts` 调用，
 * 暂挂 `.kojo2` 扩展名，绝不抢 v1 的 `.kojo`）。
 *
 * 幂等：同一 Monaco 实例重复调用只登记一次（与 v1 `registerKojoLanguage` 同形）。
 */
export function registerKojo2Language(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === KOJO2_LANGUAGE_ID)) {
    return;
  }
  monaco.languages.register({
    id: KOJO2_LANGUAGE_ID,
    extensions: [KOJO2_SOURCE_EXTENSION],
    aliases: ['kojo2'],
  });
  monaco.languages.setMonarchTokensProvider(KOJO2_LANGUAGE_ID, KOJO2_MONARCH);
  monaco.languages.setLanguageConfiguration(
    KOJO2_LANGUAGE_ID,
    kojo2LanguageConfiguration(monaco),
  );
}

/** 块头判据的 re-export：测试与 CUTOVER 的回车 handler 从语言面取同一份（不另写正则）。 */
export { KOJO2_BLOCK_HEADER_COLON_RE, KOJO2_INDENT_UNIT };
