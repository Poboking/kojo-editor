import type * as Monaco from './entry';
import { ERB_DIRECTIVES, ERB_STATEMENT_DIRECTIVES } from './erb-directives';
import { ERB_HIGHLIGHT_EXTRA_WORDS } from './erb-highlight-words';
import { erbEnterRulePatterns, ERB_LINE_COMMENT } from './erb-enter';
import { toMonacoEnterConfig } from './enter-rules';
import {
  erbMonacoExtensions,
  ERB_PREPROC_PATTERNS,
  ERB_SKIP_MARKERS,
  type ErbPreprocRole,
} from '@kojo/plugin-api';
import { defineMonacoThemes } from './theme';
import { CJK_WORD_PATTERN } from './word-separators';
import { ROLE } from '@kojo/kojo-sdk/semantic-roles';
import { ENGINE_VARIABLE_REFERENCE_HEADS } from '@kojo/kojo-vocab/engine';
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
 *   这一层的存在性由语义层背书——`@kojo/plugin-erb-parser` 的 `'form'` 槽判据 +
 *   `condition-extractor` 的 `\` 转义判据同一条语言事实）；
 * - 内联**文本形三元** `\@<条件>?<真文>#<假文>\@` 的边界着色（串内 ⓪ + root 一条整形状群组规则；
 *   形状判据从 `condition-extractor/src/inline.ts` 的顶层记号口径派生、取窄，见 `erbInlineTernaryShape`）。
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
 * 契约层预处理器整行标记正则 → Monarch 行首规则（判据真源在 `plugin-api/erb.ts`，本文件不重抄词形）。
 *
 * `ERB_PREPROC_PATTERNS[role]` 以 `^\[ … \]\s*$` 描述"trim 后整行等值"（`erbPreprocRoleOf` 先
 * trim 再 test）。Monarch 从行首吃**未 trim** 的剩余文本，`^` 又锚在绝对行首，故这里剥掉真源
 * 的行首锚、补一枚 `^\s*` 放行前导缩进，尾部 `\s*$` 与 `i` 标志原样继承。整行严格等值 ⇒ ASCII
 * 画里的 `[ 1 2 3 ]`、裸 `[IF]`（缺条件参数）都不命中——与结构层"宁可漏认不误伤"同一口径。
 */
function erbPreprocRule(role: ErbPreprocRole): RegExp {
  const pattern = ERB_PREPROC_PATTERNS[role];
  return new RegExp(`^\\s*${pattern.source.replace(/^\^/, '')}`, pattern.flags);
}

/**
 * 停用区标记（`ERB_SKIP_MARKERS` 派生）→ Monarch 整行规则：放行前后空白、大小写不敏感。
 * `[` `]` 经 `escapeRegExp` 转正义；标记本体只有真源一份，scanner.ts / 补全面跟着同一枚常量走。
 */
function erbSkipRule(marker: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(marker)}\\s*$`, 'i');
}

/**
 * 内联三元的**词法单一真源**：分段单元（unit）的正则片段。形状前瞻（guard）、root 态那条整形状
 * 与三个相位状态表全从这里派生 ⇒ "guard 说成的形状"与"相位机一路能吃的字符"天生同一把尺子
 * （分叉就是涂错）。
 *
 * `extraForbid` 只有 root 态用得到（`;`）：引号外行尾注释起界，形状不许跨；串里的 `;` 是正文
 * （`codeViewOf` 的注释隔离），照旧允许。**两套状态共用同一份单元表**，只差这一枚 `extraForbid`
 * ——上一版给 root 留的"窄口径"（`% { }` 一律禁越）本批撤了：真语料里裸文本行的三元占比很高
 * （实测 1,334 枚样本行里过半在 root 态），窄着等于把大片已成形的色继续丢掉；而 root 态的 `%`/`{`
 * 本来就没有插值层可回退（`tests/erb-ternary-paint.corpus.test.ts` 的①分母只数**串内**边界，
 * 正是为了让这条口径差可核）。
 *
 * `forbid` 是**分段**附加禁集（cond 禁 `?#`、true 禁 `#`、false 不禁）——`?`/`#` 只在该段顶层算界。
 *
 * - `plain`：段内裸字符。`"` `\` 出现 = 形状被串边界/转义打断 ⇒ 弃；`% { } ( ) [ ]` 出现 =
 *   必须由下面的整块单元吃，裸出现即弃（这样 guard 的"顶层"口径永远可判定，不必数深度）。
 * - `pct`：`%…%` 一枚整块。**段禁集在里面照样算界**——真源 `findTopLevel` 只追 `{} () []` 三种深度，
 *   **不追 `%`**（`inline.ts` L50-57），所以 `%A?B%` 里那枚 `?` 在真源眼里就是顶层界；guard 若把它
 *   当整块吃，就会把界认到后面一枚 `?` 上 ⇒ 着色层与语义层分叉。照真源写：`%` 段内含 `?`/`#` 即弃涂。
 * - `brace` / `paren` / `square`：`{…}` 与配平的 `(…)` `[…]`（同类括号嵌套给到**四层**，见下面
 *   `nestLeaf` 那段的实测口径）里面 `?`/`#` 只是内容——与 `findTopLevel` 的深度计数同调；
 *   五层及以上弃涂（比真源窄，不构成回退）。
 */
function erbTernaryVocab(extraForbid: string) {
  const never = `"\\\\%{}()\\[\\]${extraForbid}`;
  const plain = (forbid: string): string => `[^${never}${forbid}]`;
  const pct = (forbid: string): string => `%[^"%\\\\${forbid}]*%`;
  const brace = `\\{[^"}\\\\]*\\}`;
  /**
   * 括号体：**不**吃 `%`/`{`——插值一律由段级单元或 `strStr` / `strExpr` 层认。实测理由：
   * 括号里坐着插值（`ON({CFLAG:CHARATRANS:差し替え適用})`）时整块吞进段色，会把 `{…}` 的
   * `string.escape` 边界吃掉 ⇒ 那是**回退**不是补色（真语料 2 例，被①零回退闸当场抓到），
   * 这种形状本层照旧整枚弃涂。
   *
   * 但**跨类嵌套要认**：`\@ 充填率([[慧音]],3) >= 5 ? … # …\@` 是 `()` 里坐 `[[ ]]` 双平方括号
   * （`UNLOCK_KYOUKASHITU` 一带的惯用写法）。旧写法括号体只吃普通字符 ⇒ 这类全数弃涂
   * （真语料样本里"没涂上"的主因之一）。现在给一层跨类嵌套：`( … [ … ] … )` 与 `[ … ( … ) … ]`。
   * **深度上限实测＝四层**（`tests/erb-highlight.test.ts` ③b/③c 两侧各钉一枚：`((((A))))` 涂、
   * `(((((A)))))` 弃）——`nestLeaf` 自身含两层同类，`pair` 外壳再夹一层。真源 `findTopLevel` 一路追
   * 深度、不设限，所以第五层起是**本层单向取窄**（不构成回退）；每加一层同类嵌套就是指数级回溯面，
   * 而真语料里深过四层的形状读数只有 1 枚，不值得为它抬风险。
   *
   * 段禁集在括号内**不生效**：真源 `findTopLevel` 追 `()[]{}` 深度，括号里的 `?`/`#` 属内容。
   */
  const nestLeaf =
    `(?:${plain('')}|\\[(?:[^\\[\\]]|\\[[^\\[\\]]*\\])*\\]|\\((?:[^()]|\\([^()]*\\))*\\))`;
  const pair = (open: string, close: string): string =>
    `\\${open}(?:${nestLeaf}*(?:\\${open}${nestLeaf}*\\${close})?${nestLeaf}*)\\${close}`;
  const paren = pair('(', ')');
  const square = pair('[', ']');
  const unit = (forbid: string): string =>
    `(?:${plain(forbid)}|${pct(forbid)}|${brace}|${paren}|${square})`;
  /**
   * **条件段**专用：`.trim()` 后必须非空——真源 `scanTextTernaries` 判的是 `cond.length > 0`
   * （在 `.trim()` 之后），所以 `\@ ?a#b\@` 这种"段里全是空白"真源**不认**，着色层也不许认
   * （上一批这格反而比真源宽，是唯一一处"涂 ⊄ 认"，本批堵掉）。
   * 写法刻意避开"界前一个字符非空白"那种偷懒判据：` ? ` 的排版在真语料里是**主流写法**
   * （`\@ STRLENS(nDesc) ? %nDesc% #…\@`），`(?<!\\s)` 会把这一大片的色一并取消——
   * 首跑就撞上了，覆盖率从 0.738 掉到 0.245，故这里按"段内含至少一枚非空白单元"正面表达。
   */
  const ws = '[ \\t]';
  const plainNoWs = (forbid: string): string => `[^${never}${forbid}\\s]`;
  const unitNoWs = (forbid: string): string =>
    `(?:${plainNoWs(forbid)}|${pct(forbid)}|${brace}|${paren}|${square})`;
  const cond = (forbid: string): string =>
    `(?:${ws})*${unitNoWs(forbid)}(?:${ws}|${unitNoWs(forbid)})*`;
  return { never, plain, pct, brace, paren, square, unit, cond };
}

/**
 * `str` 态用的**相位机**词表（ERB-PAINT-21：把上一批整枚弃涂的 `%…%` / `{…}` / 括号内含界记号
 * 那 21.3% 拿下，同时让插值层一条着色都不回退）。
 *
 * 三个相位状态的边界就是形状的三个记号，换态一律用 `switchTo`（**换栈顶不压栈**）：
 * `cond --?--> true --#--> false --\@--> @pop 回 str`。为什么不能压栈：Monarch 的 `next:'@state'`
 * 是 push，闭合处要一次弹三层，而编译器动作词表里没有"弹 n 层"（实测 `monarchCompile.js`
 * L250-296 只认 `token/next/bracket/goBack/switchTo/log/nextEmbedded`）；`switchTo` 的语义
 * （`monarchLexer.js` L574-586 `stack.switchTo(s) = create(this.parent, s)`）正是"换层保父"。
 * 测试基座 `tests/monarch-harness.ts` 同批补齐了这条动作，判据对着同版本源码抄。
 */
function erbTernaryPhases(vocab: ReturnType<typeof erbTernaryVocab>) {
  const { plain, paren, square } = vocab;
  /** 相位内的"吃一整段正文直到下一个界"跑动（`eol` 收口，绝不让相位状态越行界） */
  const run = (forbid: string, token: string) => ({
    mid: { regex: new RegExp(`${plain(forbid)}+`), token },
    eol: { regex: new RegExp(`${plain(forbid)}+$`), token },
  });
  /** `%…%` 开层：与 guard 的 pct 同一前瞻，交给 `strStr` 层（边界 escape + 内容 variable 照旧） */
  const pctOpen = (forbid: string): RegExp => new RegExp(`%(?=[^"%\\\\${forbid}]*%)`);
  return {
    run,
    pctOpen,
    parenRun: new RegExp(paren),
    squareRun: new RegExp(square),
    braceOpen: new RegExp(`\\{(?=[^"}\\\\]*\\})`),
  };
}

/**
 * 内联**文本形三元** `\@<条件>?<真文>#<假文>\@` 的形状判据（词表 = `erbTernaryVocab`，两套状态共用）：
 *
 * - **root 态（裸文本行）= 整形状一次匹配的群组发射**（本函数返回的 `regex` + `emit`）：root 没有
 *   插值层可复用，一次吃全最简单；多禁 `;`（注释界）。
 * - **`str` 态 = 相位机**（`ERB_TERN_GUARD` + `erbTernaryPhases` 的三张状态表）：段内的 `%…%` / `{…}`
 *   必须交给既有 ④⑤ 两层，才能保证"补色不回退"（一次匹配做不到，见 `erbTernaryPhases` 头注）。
 *
 * 形状判据从语义真源 `condition-extractor/src/inline.ts` 派生，**处处只许比它窄**：
 * - 开记号 `\@`、界记号 `?`、分隔记号 `#`、收记号 `\@` **必须整形状一次认全**——缺 `#`、缺 `?`、
 *   未闭合 `\@`、空条件一律整体不成配 ⇒ 落回 `str` 态规则 ①（`\` 吃一字符 = 普通转义）与
 *   ⑩/⑨ 普通串文本，**不产一枚结构档**（宁可不涂也不误导，与 `erbPreprocRule` 的整行严格等值同向）；
 * - 条件段**含至少一枚非空白单元**（`erbTernaryVocab` 的 `cond()`）：`inline.ts` 的 cond 是
 *   `slice(...).trim()` 后判 `length > 0`，所以 `\@ ?a#b\@` 这种"段里全是空白"真源**不认**，
 *   本层也不涂——上一批在这格反而比真源**宽**（唯一一处涂 ⊄ 认，本批堵掉；由
 *   `tests/erb-ternary-paint.corpus.test.ts` 的真语料活闸与 `tests/erb-highlight.test.ts` ③c 双向钉）；
 *   但 ` ? ` 的排版是主流写法（`\@ STRLENS(nDesc) ? %nDesc% #…\@`），所以判据只能正面写
 *   "段内含非空白"，不能偷懒成"界前一字符非空白"——后者首跑把覆盖率从 0.787 打到 0.245，实测撞出来的；
 * - 段内 `"` `\` 出现 = 形状被串边界/转义打断 ⇒ 整枚弃涂（相位机不进入，走 ①-⑩ 老路）。
 *
 * **档位（全部复用 `theme.ts::BASE_RULE_SPECS` 既有三档，零新造、不动 theme/CSS）**：
 * - `\@` 开闭 / `?` / `#` → `string.escape`：本文件既有"串内嵌结构层边界"档（`{`/`}`/`%` 开闭同用它）；
 * - `<条件>` → `variable`：与 `strExpr` 层内（插值表达式内容）同档——条件的两形都是真谓词表达式；
 * - `<真文>`/`<假文>` → `string`：与串普通字面同档——inline.ts 原文"真 / 假两段只是**输出文本**"。
 *   查档记录：仓内**没有** `erb-tiers.ts`（任务卡点名但它不存在）；查过 `theme.ts`（三套调色板）、
 *   `kojo-theme-rules.ts`（`sugar.*`/`kojo2.*` 表——那是 `.kojo`/2.0 命名空间，ERB 发它会串语言族色）、
 *   `kojo-language.ts`（`.kojo` 侧同形态映射 `sugar.interp.delimiter`+`sugar.interp` = 边界+内容两档，
 *   ERB 对应物即上面 escape/variable/string 三档）。三档在三套主题调色板全部已有落点
 *   （`tests/erb-highlight.test.ts` ④ 的静态对账当场可验）。
 */
function erbInlineTernaryShape(extraForbid: string): { regex: RegExp; emit: string[] } {
  const v = erbTernaryVocab(extraForbid);
  const source = `(\\\\@)(${v.cond('?#')})(\\?)(${v.unit('#')}*)(#)(${v.unit('')}*)(\\\\@)`;
  return {
    regex: new RegExp(source),
    emit: [ROLE.escape, ROLE.variable, ROLE.escape, ROLE.string, ROLE.escape, ROLE.string, ROLE.escape],
  };
}

/**
 * `str` 态的**开记号守卫**：只有从当前位置起整枚形状成立才进相位机（前瞻一次判全，
 * 与 root 态那条整形状**同一份词表**，只差 `extraForbid`）。前瞻体 = `\@` 之后的
 * `cond（含非空白单元） ? true* # false* \@`。
 */
const ERB_TERN_GUARD = (() => {
  const v = erbTernaryVocab('');
  return new RegExp(`\\\\@(?=${v.cond('?#')}\\?${v.unit('#')}*#${v.unit('')}*\\\\@)`);
})();

/** 相位机的三张状态表（`cond` / `true` / `false`；换态 `switchTo`，收尾 `@pop` 回 `str`） */
const ERB_TERN_STATES: Record<string, Monaco.languages.IMonarchLanguageRule[]> = (() => {
  const v = erbTernaryVocab('');
  const phases = erbTernaryPhases(v);
  const cond = phases.run('?#', ROLE.variable);
  const truePhase = phases.run('#', ROLE.string);
  const falsePhase = phases.run('', ROLE.string);
  const pctOpen = phases.pctOpen;
  const braceOpen = phases.braceOpen;
  const parenRun = phases.parenRun;
  const squareRun = phases.squareRun;
  return {
    // `<条件>`：真谓词段 ⇒ variable；`?` 是唯一的界（`#` 由 guard 禁在这段之前）
    erbTernCond: [
      [/\?/, { token: ROLE.escape, switchTo: 'erbTernTrue' }],
      [pctOpen('?#'), { token: ROLE.escape, next: '@strStr' }],
      [braceOpen, { token: ROLE.escape, next: '@strExpr' }],
      [parenRun, ROLE.variable],
      [squareRun, ROLE.variable],
      [/\\@/, ROLE.string], // 理论到不了这里（guard 的段字符类不吃 `\`）；留着当"越界即退化"的兜底
      [cond.eol.regex, { token: cond.eol.token, next: '@popall' }],
      [cond.mid.regex, cond.mid.token],
      [/[^]+$/, { token: ROLE.string, next: '@popall' }], // 任何意外字符：本行内出栈，绝不带过行界
    ],
    // `<真文>`：输出文本 ⇒ string；`#` 是分隔（`?` 在这段是正文疑问句）
    erbTernTrue: [
      [/#/, { token: ROLE.escape, switchTo: 'erbTernFalse' }],
      [pctOpen('#'), { token: ROLE.escape, next: '@strStr' }],
      [braceOpen, { token: ROLE.escape, next: '@strExpr' }],
      [parenRun, ROLE.string],
      [squareRun, ROLE.string],
      [/\\@/, ROLE.string],
      [truePhase.eol.regex, { token: truePhase.eol.token, next: '@popall' }],
      [truePhase.mid.regex, truePhase.mid.token],
      [/[^]+$/, { token: ROLE.string, next: '@popall' }],
    ],
    // `<假文>`：`?` `#` 都是正文；只有闭合 `\@` 退栈回串
    erbTernFalse: [
      [/\\@/, { token: ROLE.escape, next: '@pop' }],
      [pctOpen(''), { token: ROLE.escape, next: '@strStr' }],
      [braceOpen, { token: ROLE.escape, next: '@strExpr' }],
      [parenRun, ROLE.string],
      [squareRun, ROLE.string],
      [falsePhase.eol.regex, { token: falsePhase.eol.token, next: '@popall' }],
      [falsePhase.mid.regex, falsePhase.mid.token],
      [/[^]+$/, { token: ROLE.string, next: '@popall' }],
    ],
  };
})();

/**
 * 变量多段引用的**族头名单**（显示层；`ERB_VARIABLE_REF_PATTERN` 的唯一词形来源）。
 *
 * ## 口径
 * 收**引擎级**词，两类都算：①具名索引族（`CFLAG` / `TALENT` / `MASTERNAME`…）；
 * ②引擎作用域/上下文标量（`MASTER` / `TARGET` / `ASSI` / `PLAYER` / `ARG` / `RESULTS` / `DAY`…，
 * 语料里多是 `TALENT:PLAYER:2` 的中段与裸读）。**不收**作品自造名（`ROOMDATA` / `C_ID`…）——
 * 那是游戏知识，归 adapter（铁律 3）；语言层收了作品专名，换一部作品就是错色。
 *
 * ## 真源（LAU-D2，2026-10-27：词形外提出清）
 * 词形一律来自 `@kojo/kojo-vocab/engine` 的 {@link ENGINE_VARIABLE_REFERENCE_HEADS}——
 * 那是"字典侧具名索引族（`ENGINE_VARIABLE_FAMILIES`，补全 / 成员 / `.kojo` 族头档同源）
 * ＋ 显示层专收三组（作用域标量 / 语言槽位 / 引擎别名与展开形）"的**派生**，本文件零词形。
 *
 * 为什么不再各吃一张表：两份手抄的漂移形态是「屏上有颜色但 `CF|` 补不出来」或反过来。
 * K6 批把双向差集记成台账（30 枚显示层独收 / 1 枚 `JVEL` 补全侧独有）交 LAU-D2 收口；
 * 本批把 30 枚按组登记进共用词表、`JVEL` 作为**显式剔除**（拼写裁决另案），
 * 于是 `tests/erb-family-single-source.test.ts` 的台账从 31 枚收成 1 枚，且显示层是派生不是抄本。
 *
 * ## 保留在原文的证据链（词条本身已迁走，判定口径不变）
 * - **`MASTERNAME`**：族头形 12,272 处 / 149 份、裸形 16 处、全树 0 处 `#DIM` 声明、引擎二进制
 *   名字堆有 `_MASTERNAME`（与 `_CALLNAME`/`CSTRNAME`/`TSTRNAME` 同段）⇒ 引擎内建字符串族。
 * - **`PLAYER`**：6,444 处裸读 + 8,533 处中段作用域形、族头形 `PLAYER:` 0 处 ⇒ 只进显示层，
 *   不进字典侧（`ENGINE_FAMILIES` 把执行上下文量划在表外，补全弹它只误导）。
 * - **`ITEM`**：1,713 行 / 507 份在用、名表在盘（`CSV/Item.csv` + `Item.als`）⇒ 走具名索引族口径，
 *   两处都进、追加在字典表末尾（`resolveFamily` 首中胜次序零反转）。
 * - **`CHILDNAME` 拒收**：作品 `#DIMS` 自造存档名（`DIM.ERH`），引擎串面 0 命中 ⇒ 归 adapter。
 * - **`MONSTER_ACTION` / `MONSTER_EXPLV` / `DUMMY_EXT` 拒收**：引擎串面查无 **且** 语料 0 行，
 *   是裁决认定唯一许删的三项（不许顺手加回来，测试同钉）。
 *
 * ⚠ 词表住在共用包里 ⇒ 本文件不再需要"整块单行字串"那种写法（旧版为绕 `pnpm audit:language`
 * 的 M1 按行计数而挤成一行）；M1 因此在本文件归零。
 */
export const ERB_VARIABLE_FAMILY_HEADS: readonly string[] = ENGINE_VARIABLE_REFERENCE_HEADS;

/**
 * 变量多段引用（`CFLAG:ARG:口上セレクタ` / `TCVAR:50` / `MASTERNAME:1`）整段 `variable`。
 * 词形一律取自 {@link ERB_VARIABLE_FAMILY_HEADS}（本文件不内联第二份名单）。
 * 段尾字符集排除 `;`——否则 `CFLAG:ARG;说明` 把行尾注释整段吞成 variable，与语义层分叉。
 */
export const ERB_VARIABLE_REF_PATTERN: RegExp = new RegExp(
  `\\b(?:${ERB_VARIABLE_FAMILY_HEADS.map(escapeRegExp).join('|')})\\b(?::[^\\s,()\\[\\]{}'"+\\-*/%<>=!&|;]+)*`,
);

/** root 态（裸文本行：`PRINTDATA` 体等无引号位）用：段内禁 `;`。
 *  `str` 态自 ERB-PAINT-21 批起走 `ERB_TERN_GUARD` + `ERB_TERN_STATES` 的相位机，不再吃这条。 */
const ERB_INLINE_TERNARY_ROOT = erbInlineTernaryShape(';');

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
        [/^\s*(?:;!;|;#;)/, ROLE.directive],
        // 行首注释（Emuera 语义：行首 ; 整行注释）
        [/^\s*;.*$/, ROLE.comment],
        // 行内尾注释：引号外的 `;` 起注释到行末。`str` 态是另一状态、串里进不了 root，
        // 所以这条不会把 PRINTL "a;b" 的 `;` 当注释；语义层 codeViewOf 同一判据。
        [/;.*$/, ROLE.comment],
        // 行首函数定义 @NAME / @NAME(...)。**禁集里有 `"`**：ERB 的函数名不许含引号，而真语料里
        // 压在我这条规则位置上的其实是「多参数调用折行」——`CALL PRINTBUTTON_EX,` 的实参 `@"…"`
        // 单独起一行（本盘取样 22 行，全是这形）。旧写法 `[^\s(;]+` 把 `"` 也当名字字符 ⇒ 整行
        // 吞成 `entity.name.function`，串层根本进不去 ⇒ 那行的 `%…%`/`{…}`/`\@…\@` 一律无色。
        // 禁掉 `"` 后该形落到下面的 `"` 规则进 `str` 态（`@` 无规则命中 ⇒ 不发射，与基座一致）。
        [/^(\s*)(@)([^\s(;"]+)/, ['', ROLE.keyword, ROLE.decl]],
        // 行首跳转标签 $LABEL
        [/^(\s*)(\$)([^\s;]+)/, ['', ROLE.keyword, ROLE.label]],
        // 预处理指令 #DIM / #FUNCTION 等（含修饰词）
        [/^(\s*)(#\w+)/, ['', ROLE.directive]],
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
        // 字面量从 `ERB_SKIP_MARKERS` 派生（契约 §一纪律：显示层不再手写 `[SKIPSTART]` 词形）。
        [erbSkipRule(ERB_SKIP_MARKERS.start), { token: ROLE.directive, next: '@skip' }],
        [erbSkipRule(ERB_SKIP_MARKERS.end), ROLE.directive],
        // 预处理器条件块标记 `[IF …]` / `[IF_DEBUG]` / `[IF_NDEBUG]` / `[ELSEIF …]` / `[ELSE]` / `[ENDIF]`。
        //
        // 判据 = 契约真源 `ERB_PREPROC_PATTERNS`（`erbPreprocRoleOf` 用的同一批正则），规则序与它
        // 同（close→branch→open）；档位复用既有 `keyword.preprocessor`（与 `#DIM`/SKIP 同一预处理色，
        // 不新造 token、不动 theme）。整行严格等值才认（`[ 1 2 3 ]`、裸 `[IF]` 不算块）。
        //
        // **必须排在 SKIP 两条之后、`standaloneKeyword` 之前**：本工包根因之一是 `[IF x]` 整行白字、
        // 内层 `IF` 反被控制词档着色。整行一条规则吃掉后，`[IF x]` 里的 `IF` 不再被单独成词，
        // 也就漏不进 `standaloneKeyword`。
        [erbPreprocRule('close'), ROLE.directive],
        [erbPreprocRule('branch'), ROLE.directive],
        [erbPreprocRule('open'), ROLE.directive],
        // 裸文本行上的内联文本形三元（`PRINTDATA`/`SELECTCOM` 体这类无引号位；形状与档位见
        // `erbInlineTernaryShape` 头注，比 `str` 态 ⓪ 多禁 `;`——注释界在引号外才生效）。
        // root 里没有别的规则从 `\` 起手，排位在字符串规则之前只为读序清楚；残形（未闭合 `\@`）
        // 落回既有 root 兜底行为（`?` 被变量续段类吞进多段引用等），与本条互不干扰。
        [ERB_INLINE_TERNARY_ROOT.regex, ERB_INLINE_TERNARY_ROOT.emit],
        // 字符串（含 FORM 串转义）：进 `str` 态，串内 `{…}` / `%…%` 两层在那里解析
        [/"/, { token: ROLE.string, bracket: '@open', next: '@str' }],
        // 整词指令（含高亮补集）：必须排在变量族之前——CFLAG/EQUIP/RAND/DOWNBASE 同时是
        // 变量族头，只靠后面的 cases 会让大写形态吃 variable 色（SUGGEST-2C 的 second root）
        ...(standaloneKeyword ? [[standaloneKeyword, ROLE.keyword] as [RegExp, string]] : []),
        // 变量多段引用：CFLAG:ARG:口上セレクタ / TCVAR:50 / ARG:1 / RESULTS:2 / LOCALS:1 / MASTERNAME:1
        // （词形 = `ERB_VARIABLE_FAMILY_HEADS`，段尾字符集排除 `;` 的理由见该常量头注与本条原注释：
        // 否则 `CFLAG:ARG;说明` 把行尾注释整段吞成 variable，与语义层分叉）
        [ERB_VARIABLE_REF_PATTERN, ROLE.variable],
        // 数值常量
        [/\b\d+\b/, ROLE.number],
        // `'=` 字符串表达式赋值（Emuera ver1813+）：`STR '= TSTR:0 + "ABC"`。
        // `'` 在 ERB 里**只**作为这个运算符的首字符出现（没有单引号字符串），所以单独一条
        // 规则是精确的；排在通用运算符规则之前（后者不含 `'`，但把 `'=` 先收掉可以避免
        // `'` 落空 token）。语义层早就是赋值（`undefined-name.ts` 的 `ASSIGN_LINE_RE`
        // 收了 `'`），此前只有着色不认——同一行两侧口径分叉。
        [/'=/, ROLE.operator],
        // 运算符
        [/[+\-*/%<>!=&|^~?:.,]/, ROLE.operator],
        // 指令 / 函数调用标识符
        [
          /[A-Za-z_][A-Za-z0-9_]*/,
          {
            cases: {
              '@directives': ROLE.keyword,
              '@highlightWords': ROLE.keyword,
              '@default': ROLE.text,
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
              '@directives': ROLE.keyword,
              '@highlightWords': ROLE.keyword,
              '@default': ROLE.text,
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
              '@directives': ROLE.keyword,
              '@highlightWords': ROLE.keyword,
              '@default': ROLE.text,
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
        [/[\u3001-\u303f\uff01-\uff65\u2018-\u201d\u2026\u00b7\u30fb]+/, ROLE.operator],
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
      //      `@kojo/plugin-erb-parser` 的 `'form'` 槽明写"FORM 串，可含 `%…%` / `{…}` 插值"，
      //      `insideInterp` 对未闭合 `{` 判"停在插值内 ⇒ 不猜"；真语料形态见
      //      `erb-parser/src/structure.ts` 头注那条
      //      `@"给%CALLNAME:TARGET%使用避孕套（剩余{ITEM:45}枚）"`（一枚串里两层同时出现）；
      //      `kojo-sugar/src/codegen.ts` 的 `classifyInterpolation` 也把数值插值**降糖成
      //      `{表达式}`** 落进 ERB 产物（规范 §5.2 c）。
      //    ⑥⑦ 落单记号收成字面内容：内容类既然排除了 `{`，就必须有兜底，否则那一枚字符
      //      无规则可配 ⇒ 无色；同时不许它顺手把闭合引号吞进上一层（旧 `%` 层正是这么丢引号的）。
      //    ⑧ 闭合引号 `@pop`；⑨⑩ 行尾出栈（`$` 形须排在无锚 catch-all 之前）。
      str: [
        // ⓪ 内联文本形三元 `\@<条件>?<真文>#<假文>\@` 的**开记号**（ERB-PAINT-21 起改相位机）。
        //
        // 前瞻一次判全形状才进 `erbTernCond`（词表与 root 态那条整形状同一来源，判据处处只许比
        // `inline.ts` 窄）；进不来就落回下面的 ①（`\` 吃一字符 = 普通转义）——残形零枚结构档的老
        // 纪律靠这条前瞻保证，不靠相位机自己判。
        //
        // 为什么要相位机而不是继续整枚群组发射：段内撞 `%…%` / `{…}` 时，整枚吞进段色会**回退
        // `str` 态既有的插值着色**（④⑤ 那两层 escape+variable），所以上一批的处置是"撞上即弃涂"
        // ——语料实测这就是 21.3% 未上色的主因。相位机把 `%`/`{` 交给 ④⑤ 同一对层
        // （`strStr` / `strExpr`，push 后由它们 `@pop` 回本相位），既上色又不回退。
        //
        // **必须排在 ① 之前**（次序即判据）；①-⑩ 一条不改。
        [ERB_TERN_GUARD, { token: ROLE.escape, next: '@erbTernCond' }],
        [/\\./, ROLE.string], // ①
        // ②③ 本行既等不到闭合记号、也等不到闭合引号 ⇒ 残段留在 string 层并出栈
        //（`"台词{未闭合`、记号正好压在行尾的 `"台词{`、`"前段%` 都不许把 strExpr / strStr 带过行界）
        [/\{[^"}]*$/, { token: ROLE.string, next: '@popall' }], // ②
        [/%[^"%]*$/, { token: ROLE.string, next: '@popall' }], // ③
        // ④⑤ 开层（前瞻要求"闭合记号在闭合引号之前"，见 B④）
        [/\{(?=[^"}]*\})/, { token: ROLE.escape, next: '@strExpr' }], // ④
        [/%(?=[^"%]*%)/, { token: ROLE.escape, next: '@strStr' }], // ⑤
        // ⑥⑦ 落单记号（形如 `"…{"`：本行有闭合引号却没有闭合记号）就是**字面内容**——
        // 保住颜色，也保住那枚闭合引号的 `@close`（bracket 配对计数不许被吞掉一层）
        [/\{/, ROLE.string], // ⑥
        [/%/, ROLE.string], // ⑦
        [/"/, { token: ROLE.string, bracket: '@close', next: '@pop' }], // ⑧
        [/[^"{%\\]+$/, { token: ROLE.string, next: '@popall' }], // ⑨
        [/[^"{%\\]+/, ROLE.string],
        // ⑩ 行尾落单的 `\`（续行写法里真会出现）：①要两枚字符、⑨又不吃 `\`，
        // 少了这一条串态就会被带过行界——正是⑨要防的事，所以单独收口。
        [/\\$/, { token: ROLE.string, next: '@popall' }],
      ],
      strExpr: [
        // 插值层里再坐一枚内联三元 ⇒ 同样交给相位机（真语料实测形如
        // `@"%\@ プール > 0 ? ＋ # － \@%{ABS(プール)}枚"`：三元整枚嵌在 `%…%` 里，
        // 层级判据（`strStr` 的 `[^%]+` 一路吃到闭合 `%`）会把它当纯文本吞掉。
        // 相位机收尾用 `@pop` ⇒ 弹回**推它的那一层**（这里是 `strStr`），不是弹回 `str`。
        [ERB_TERN_GUARD, { token: ROLE.escape, next: '@erbTernCond' }],
        [/[^}]+$/, { token: ROLE.variable, next: '@popall' }],
        [/\}/, { token: ROLE.escape, next: '@pop' }],
        [/[^}]+/, ROLE.variable],
      ],
      strStr: [
        [ERB_TERN_GUARD, { token: ROLE.escape, next: '@erbTernCond' }],
        [/[^%]+$/, { token: ROLE.variable, next: '@popall' }],
        [/%/, { token: ROLE.escape, next: '@pop' }],
        [/[^%]+/, ROLE.variable],
      ],
      // 内联三元的三个相位（ERB-PAINT-21）：`cond --?--> true --#--> false --\@--> @pop` 回 `str`。
      // 表体由 `erbTernaryPhases` 从 `erbTernaryVocab('')`（wide 口径）派生，与 `ERB_TERN_GUARD`
      // 同一把尺子——guard 允许吃进的字符，相位里必须有一条规则接得住，否则相位会一路走到
      // 行尾兜底那条 `@popall`（那是兜底，不是常规路径；由 `tests/erb-ternary-phases.test.ts` 钉）。
      ...ERB_TERN_STATES,
      /**
       * `[SKIPSTART]` 后的原样块：逐行整块吃成 `keyword.raw`，只有**整行等值**的
       * `[SKIPEND]` 退栈（与开头进入判据同一把尺子）。块内 `IF` / `;` / `"…"` /
       * 嵌套 `[SKIPSTART]` 一律不解析——引擎既不编译也不执行这些行。
       */
      skip: [
        [erbSkipRule(ERB_SKIP_MARKERS.end), { token: ROLE.directive, next: '@pop' }],
        [/.*$/, ROLE.raw],
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
