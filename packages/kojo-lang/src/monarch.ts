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
  KOJO2_TYPE_WORDS,
  KOJO2_WAIT_CONTINUE,
  escapeRegExp,
} from './lexicon';
import { KOJO2_TOKEN } from '@kojo/kojo-sdk/semantic-roles';
import { KOJO_TABLE_ARROWS } from '@kojo/kojo-core';

/**
 * Kojo 2.0 的 **Monarch 词法面**（U6；**SDK B4 起住在 `@kojo/kojo-lang`**：本文件交出契约
 * `ui.monaco.language` 的 `monarch` 那一副数据，由 `@kojo/plugin-kojo-lang` 供、宿主落
 * `monaco.languages.setMonarchTokensProvider`）。
 *
 * ## 定位
 * 这一层只回答"一段文本被切成哪些记号、各发哪个 token 名"。它今天只服务 2.0；
 * 认领（语言 id / 扩展名）在宿主的 descriptor，装配（把数据落进 Monaco）在宿主的
 * `monaco/monaco-language-surface.ts`——两处都不认词法。
 *
 * ## 分档目标（"一眼看出这行是哪种脸"）
 * 五锚点（`# @ > ? !`）是骨架；台词 / 旁白 / 原生 / 注释 / 提示各自一档；插值与数字/运算符
 * 在正文里单独一档。**token 名从 LAU-2 起不再是 `kojo2.*`，而是语义角色 `role.*`**
 * ——与 v1（`role.keyword` 一档）和 ERB 共用同一张角色表（同在本包的 `semantic-roles.ts`），
 * 于是"同一段文本在两门语言里同色"不再靠三处各配一遍色来维持。作者面口径仍在
 * {@link KOJO2_TOKEN_TIERS}（档位表），配色在 `theme-rules.ts` 的角色调色板。
 *
 * 主题装配**不在本文件**：六套 `kojo-*` 由宿主的 `theme.ts` 一次定义，2.0 那三套的身份在
 * `monaco-theme.ts`。本文件不 defineTheme，避免出现第二份主题。
 *
 * ## 词表零抄本
 * 所有中文字形来自 `./lexicon`（core / 聚合词表的转发）；本文件**只有正则与状态机**。
 * `kojo2-language-lexicon.test.ts` 扫本包源码：字符串字面量不得等于 2.0 词表里的任何词形。
 *
 * ## 状态机口径（为什么不是逐行正则一把梭）
 * 台词 `「…」`、旁白 `> …`、`@原生` 围栏是**跨记号/跨行**的：台词里的 `#`/`?`/`>` 是正文，
 * 围栏内的 `;`/`//`/`{}` 是 ERB 原文。三者用三个小状态机（`speech` / `narration` /
 * `nativeN`）承接；**每个状态都有"行尾必回根"的收尾规则**（台词未闭合也只在行内着色，
 * 绝不把下一行拖进台词脸），`@原生` 用"比栏头更深才算体"的缩进阶梯状态收口。
 *
 * Monarch 只是**最佳努力**的词法层：精确结构判定在 `@kojo/kojo-core`（lexer/parser），
 * 波浪线由 core 诊断出。这里不为难 Monarch 做它做不到的事。
 *
 * ## 为什么本文件不 import Monaco，也不 import 契约
 * 两条都是 purity：包一旦引 `monaco-editor`（**含 `import type`**）就只能被宿主用，插件化
 * 立刻倒退；引 `@kojo/plugin-api` 桶则给"语言面依赖契约桶"开门（那条闸分不清 type import，
 * 放行一个就是放行两类）。所以下面只有两枚**只为元组推断存在**的锚类型
 * （{@link Action} / {@link Rule}）：`[正则, 动作]` 不加锚会被推成 `(RegExp|string)[]`，
 * 交出去时当场对不上契约的两元组。真正的形状对拍在两处——供方把它赋给契约字段
 * （编译期）、宿主落 Monaco 时按未知键 / 非法档位丢弃并 warn（运行期）。
 */

/* ============================== 锚类型（只为元组推断） ============================== */

type Action =
  | string
  | { readonly token?: string; readonly next?: string; readonly cases?: Record<string, Action> }
  | readonly Action[];

type Rule = readonly [pattern: RegExp | string, action: Action];


/* ============================== token 分档 ============================== */

/** 档位名 → 语义角色（定义在 `semantic-roles.ts`；这里原样转交，宿主 shim 与测试都读同一枚对象） */
export { KOJO2_TOKEN };
export type { Kojo2TokenName } from '@kojo/kojo-sdk/semantic-roles';

export interface Kojo2TokenTier {
  /** 档名（面向作者的中文口径，只用于报错文案，不参与配色计算） */
  readonly tier: string;
  /** 该档的角色名（同档共享前景色；角色表见 `semantic-roles.ts`） */
  readonly tokens: readonly string[];
  /** 为什么值得单独一档（写不出理由的不配成为一档） */
  readonly why: string;
}

/**
 * 档位表（作者可见的分层口径 → 角色名；同档共享前景色）。
 * 这张表同时是**主题验收清单**：新增一档必须在这里登记，测试会问"它和谁撞色/撞名"。
 */
export const KOJO2_TOKEN_TIERS: readonly Kojo2TokenTier[] = [
  { tier: '锚点', tokens: [KOJO2_TOKEN.anchor], why: '五锚点是句子的第一眼，必须先看见' },
  { tier: '声明与调度词', tokens: [KOJO2_TOKEN.declaration], why: '`#`/`@` 后的词决定这一行是不是声明' },
  // 2026-10-26 色值批：标点从"保留词"档拆出来独立成档——同一枚 `「`（`：`）必须与 v1 的
  // `sugar.speech.delimiter` 同色（`theme.ts` 头注写死的跨语言不变量），而 v1 的保留词与
  // 分隔符本来就是两档（`c678dd` vs `7f9cc0`）。档位表 = "一档一色"的验收清单，拆档才是
  // 事实：拆前这格是"一档两色"，测试会当场红。
  { tier: '保留词', tokens: [KOJO2_TOKEN.keyword], why: '`依据`/`否`/`续`/存储期词/织入修饰词改的是语义' },
  {
    tier: '结构性标点',
    tokens: [KOJO2_TOKEN.delimiter],
    why: '`：`/`「」`/括号只是骨架，且与 v1 同色（同一枚 `「` 两门语言同色）',
  },
  { tier: '说话人', tokens: [KOJO2_TOKEN.speaker], why: '谁在说话与说了什么必须两层' },
  { tier: '台词与字面文本', tokens: [KOJO2_TOKEN.speech, KOJO2_TOKEN.string], why: '作者写的字，语法层要退到后面' },
  { tier: '旁白', tokens: [KOJO2_TOKEN.narration], why: '旁白与台词是两种脸（一个 `>` 一个 `角色：`）' },
  { tier: '插值', tokens: [KOJO2_TOKEN.interp], why: '「正文里的表达式」自成一层' },
  { tier: '表演提示', tokens: [KOJO2_TOKEN.hint], why: '提示不打印、只改演出，必须与正文分色' },
  { tier: '原生围栏', tokens: [KOJO2_TOKEN.raw], why: '不透明 ERB 原文，一眼看出"这里 2.0 不解释"' },
  { tier: '注释', tokens: [KOJO2_TOKEN.comment], why: '不参与演出的说明' },
  { tier: '数字', tokens: [KOJO2_TOKEN.number, KOJO2_TOKEN.hex], why: '字面量在表达式里要能扫读' },
  { tier: '运算符', tokens: [KOJO2_TOKEN.operator], why: '中文运算符词与符号同档，判定位一眼可辨' },
  // 2026-10-27 第三色批：本仓此前只有紫（保留/关键字）与蓝（声明调度词）两层，"这一列存什么"
  // 一直没有自己的色。两个发射点：类型词（`整数` / `字符串`，Monarch）与结构定义头
  // （`# 对照表` / `# 池` / `# 模`，worker 的 highlights 查询）。与 v1 侧的 `support.type` 逐字同色。
  // ⚠ 叠层默认开时，`# 变量 … 整数 …` 整行由 `(variable_decl)` 一档盖住（叶子节点，语法层
  // 没给类型词单独的子记号节点 ⇒ 判不出来就不硬拆），那一行的类型色只在叠层关时露出；
  // 结构定义头那一档两条链都发同一个色，默认态可见。
  { tier: '类型与结构名', tokens: [KOJO2_TOKEN.type], why: '`整数`/`字符串` 说这一列存什么，`# 对照表`/`池`/`模` 定义一个结构——都不改判定，改的是形状' },
];

/* ============================== 词法状态机 ============================== */

/** `@原生` 围栏缩进阶梯：0..7 级（28 空格）；再深的结构缩进按 0 级兜底（无效缩进由 core 报错）。 */
const NATIVE_FENCE_MAX_LEVEL = 8;


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

/** 表行分档箭头：`->` / `→`（core 词表单源；本文件不写字形）。 */
const TABLE_ARROW = `(?:${KOJO_TABLE_ARROWS.map(escapeRegExp).join('|')})`;

/** `# 对照表` 分档行：默认分支 `否 -> <值>`。 */
const TABLE_DEFAULT_ROW = new RegExp(
  `^(\\s*)(${escapeRegExp(KOJO2_TABLE_DEFAULT_WORD)})(\\s+)(${TABLE_ARROW})(\\s+)(\\S.*)$`,
);

/** `# 对照表` 分档行：`<范围> -> <值>`（`0..99` / `500..` / `..100` / `5` / 常量名..）。 */
const TABLE_RANGE_ROW = new RegExp(
  `^(\\s*)((?:[^\\s]*\\.[^\\s]*|[-+]?\\d+))(\\s+)(${TABLE_ARROW})(\\s+)(\\S.*)$`,
);

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
function nativeHeaderCases(): Record<string, Action> {
  const cases: Record<string, Action> = {};
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
    // ---- `# 对照表` 分档行（默认分支 / 范围）----
    [TABLE_DEFAULT_ROW, ['', KOJO2_TOKEN.keyword, '', KOJO2_TOKEN.keyword, '', KOJO2_TOKEN.speech]],
    [TABLE_RANGE_ROW, ['', KOJO2_TOKEN.number, '', KOJO2_TOKEN.keyword, '', KOJO2_TOKEN.speech]],
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
    // ---- 中文词形：运算符 / **类型词** / 保留词 / 域符号各一档，其余是名字（不上色）----
    // 类型词必须排在 `@keywords` 之前：`整数` / `字符串` 同时也在保留词表里（core 的
    // `KOJO2_RESERVED_WORDS` 逐项拼出来就含它们），cases 卫兵取先命中的一档，反序就永远不出类型档。
    [
      /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/,
      {
        cases: {
          '@operators': KOJO2_TOKEN.operator,
          '@typeWords': KOJO2_TOKEN.type,
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

/**
 * 2.0 的 Monarch 词法面（契约 `MonacoMonarchData` 的形状）。导出给测试直接交给
 * `tests/monarch-harness.ts` 的真编译器；宿主落 `setMonarchTokensProvider`。
 *
 * `wordLists` 由宿主铺到 monarch 对象根部——Monarch 的 `@declWords` 这类 cases 卫兵
 * 就从那里取，词形全部来自 `./lexicon` 的单源转发（本文件零字形）。
 */
export const KOJO2_MONARCH = {
  ignoreCase: false,
  defaultToken: '',
  // 档位/状态用到的词表（`@declWords` 等 cases 卫兵从宿主铺回的根部属性取）
  wordLists: {
    // 档位/状态用到的词表属性（`@declWords` 等 cases 通过它取；全部来自词表单源）
    declWords: KOJO2_DECL_WORDS,
    dispatchWords: KOJO2_DISPATCH_WORDS,
    keywords: KOJO2_RESERVED_WORDS,
    // 类型词单独一档（2026-10-27 第三色批）；词表原样转发自 core `KOJO_TYPE_WORDS`，零抄本
    typeWords: KOJO2_TYPE_WORDS,
    domainSymbols: KOJO2_DOMAIN_SYMBOLS,
    operators: KOJO2_OPERATOR_WORDS,
  },
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
