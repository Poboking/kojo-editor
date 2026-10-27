/**
 * 回车层级（ZH-D4）——「在块头行尾按回车，新行该缩到哪」的**纯判定**。
 *
 * ## 为什么住 `kojo-sugar` 而不是宿主
 *
 * 判型与转译共用同一真源：行分类走 `classifyLine`、层级折算走 `splitLogicalLines`
 * 的 `indentLevel`、词形走 `KEYWORDS`（经 `SUGAR_LEXICON_WORDS` 派生）、单位走
 * `formatter` 的 `TAB_UNIT` / `SPACE_UNIT`。本文件**不写任何词形清单、不抄任何冒号
 * /空白等价规则**——宿主（`packages/app/src/monaco/*`）只把这里的结果翻成
 * Monaco 的 `onEnterRules` / provider 协议。格式化模块头注的警告在这里同样成立：
 * 判据抄的那刻起，"回车跟进的层级 = 转译认的层级"这个保证就没了。
 *
 * ## 两层供给（同一真源的两个出口）+ 一道通用装配
 *
 * 1. {@link sugarEnterRulePatterns}：从词表**派生**的正则族，喂 Monaco 的
 *    `onEnterRules` / `indentationRules`（按键同步生效，零异步抖动）；
 * 2. {@link sugarEnterIndentAfter}：逐字走 `classifyLine` 的**精确判定**，喂
 *    on-type formatter（`editor.formatOnType` 开启时兜住正则族的已知近似缺口，
 *    如块头行尾带 `;` 注释——正则看原文、词法看剥注释后的代码段）；
 * 3. {@link enterRulePatternsFromRoles}：**同一套正则装配**的通用形，入参是一枚
 *    {@link EnterRoleVocabulary}（开块 / 分支 / 闭合 / 单行 + 注释记号 + 大小写口径）。
 *    `.erb` 的词表由宿主从引擎配对表（`erb-parser/scanner.ts` 的 `classifyControlFlow`）
 *    喂进来 ⇒ 两门一等语言的回车层走**同一张派生表**、各自词形单源，宿主不抄第二份清单
 *    （ERB-PARITY / ERB-ENTER-RULES，2026-10-21）。本层不认识任何语言名。
 *
 * ## 已知近似（正则族 vs 精确判定的差集，均由测试钉死、不是口头承诺）
 *
 * - 块头行尾带行内注释：精确判定认（`classifyLine` 先剥注释），正则族不认（只看得见原文）；
 * - `时机：` / `函数：` 这类"关键字 + 冒号但正文为空"的畸形头：词法判为文本行，
 *   正则族会多缩一级——作者正要续写头部，多缩无实害，且整篇重排口径不变；
 * - `若 ：`（关键字后空条件）：同上，正则族多缩一级，精确判定不动。
 */

import {
  FULLWIDTH_COLON,
  FULLWIDTH_SPACE,
  HALF_COLON,
  SUGAR_LEXICON_WORDS,
  type KeywordId,
} from './keywords';
import { classifyLine, splitLogicalLines, type LineClass } from './lexer';
import { SPACE_UNIT, TAB_UNIT } from './formatter';

/* ============================ 块体开启判据（精确层） ============================ */

/**
 * 块头语义 id → 「块体必须更深」的行类（判据逐条抄自 `classifyLine` 的返回：
 * 这些 kind 在 parser 里都走"读更深层"通路）。
 * `ifHead` 带 `inline` 体的是单行形（`如果 X： 内容`，无行尾冒号）⇒ 不开块体，单独排除；
 * `headDecl` 只有 `开关:`（parser 的 `readSwitchItems`）后跟缩进块。
 */
const BODY_OPEN_KINDS: ReadonlySet<LineClass['kind']> = new Set<LineClass['kind']>([
  'timingHead',
  'customCommandHead',
  'whenHead',
  'caseHead',
  'randomHead',
  'groupHead',
  // 规则池（规范 §3.11）：`分支：` 之后写 `[条件]` 标签；标签之后写正文
  'branchHead',
  'ruleTag',
  'sectionHead',
  'onceHead',
  'choiceHead',
  'menuHead',
  'askMHead',
  'askYNHead',
  'colorHead',
  'heartHead',
  'functionHead',
  'exprHead',
  // 预处理条件块（v1.9 P0-C）：`预处理 如果 X：` / `预处理 调试：` 等块头 ⇒ 下一行更深
  'preprocHead',
]);

/** 这一行的分类是否"下一行该更深"（判型只消费 `classifyLine`，不自造第二套词法） */
function opensBody(cls: LineClass): boolean {
  if (cls.kind === 'ifHead') return cls.inline === undefined;
  if (cls.kind === 'headDecl') return cls.key === 'head.switch';
  return BODY_OPEN_KINDS.has(cls.kind);
}

/**
 * 块头行回车后，新行应有的行首空白（`null` = 不该动：判不准 / 非块头 / 折行中间，
 * 一律不动——与 formatter 的"判不准就不动"同口径）。
 *
 * 追加的单位取**该块头自己的书写风格**：缩进里带 TAB → 追加 `TAB_UNIT`；否则 `SPACE_UNIT`。
 * `SPACE_UNIT`（4 空格）是 `indentLevel` 的折算基 ⇒ 无论原缩进是 1~n 个空格还是全角空格，
 * 追加后的层级折算恒等于「原层级 + 1」（`ceil((4L+k+4)/4) = L+1`，k<4 时成立），
 * 连续回车（前一行变成空行）不再进本函数 ⇒ 层级停在 L+1 不漂移。
 */
export function sugarEnterIndentAfter(prevLineText: string): string | null {
  // 折行续接（行尾 `\`）：层级属于整条逻辑行，单物理行判定不作数（与 lexer 同一正则）
  if (/(^|[^\\])\\\s*$/.test(prevLineText)) return null;
  const logical = splitLogicalLines(prevLineText)[0];
  if (!logical || logical.endLine !== logical.line) return null;
  let cls: LineClass;
  try {
    cls = classifyLine(logical);
  } catch {
    return null; // 分类抛错 = 判不准 ⇒ 不动
  }
  if (!opensBody(cls)) return null;
  const unit = logical.rawIndent.includes(TAB_UNIT) ? TAB_UNIT : SPACE_UNIT;
  return logical.rawIndent + unit;
}

/* ============================ 回车规则正则族（同步层） ============================ */

/** 正则元字符转义（词形是活表，未来多一个带元字符的词形也不炸） */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 行首空白与词间空白类（空格 / TAB / 全角空格——与 formatter 的 `isIndentChar` 同集） */
const WS = `[ \\t${esc(FULLWIDTH_SPACE)}]`;
/** 块头终止符（全角/半角等价——与 keywords 的 `endsWithBlockColon` 同一对常量） */
const COLON = `[${esc(FULLWIDTH_COLON)}${esc(HALF_COLON)}]`;

/** 词形组：从 `SUGAR_LEXICON_WORDS` 按语义 id 取词，长度降序（`否则如果` 必须先于 `否则`） */
function wordGroup(ids: readonly KeywordId[]): string {
  const wanted = new Set<string>(ids);
  const words = [...new Set(SUGAR_LEXICON_WORDS.filter((w) => wanted.has(w.id)).map((w) => w.word))];
  if (words.length === 0) throw new Error(`enter.ts: 词表里找不到这些语义 id：${ids.join(', ')}`);
  return words.sort((a, b) => b.length - a.length).map(esc).join('|');
}

/** 「关键字 (空白 任意正文)? 冒号 行尾」的块头尾巴 */
const HEAD_TAIL = `(?:${WS}[^\\r\\n]*)?${COLON}$`;

/** `indentOnEnter` 各正则族的语义分组（回执里的"块头类别覆盖数"按这组分） */
const ENTER_FAMILIES = {
  /** 带正文的块头（时机/如果以外的全部 any-rest 形） */
  openWithRest: () =>
    `^${WS}*(?:${wordGroup([
      'block.timing',
      'block.elif',
      'block.else',
      'block.when',
      'block.is',
      'block.customCommand',
      'block.function',
      'block.once',
      'block.choice',
      'block.askM',
      'block.askYN',
      'block.color',
    ])})${HEAD_TAIL}`,
  /** `如果` 系块头——排除单行形 `如果 X 则 Y：`（`则` 界标词形取自 `inline.then`） */
  openIf: () =>
    `^${WS}*(?:${wordGroup(['block.if'])})(?!(?:${WS}[^\\r\\n]*)?${WS}(?:${wordGroup([
      'inline.then',
    ])})(?:${WS}|$))${HEAD_TAIL}`,
  /** 裸块头（后不许跟正文：`随机 …` 带正文是行内简写，不开块体） */
  openBare: () => `^${WS}*(?:${wordGroup(['block.random', 'block.group', 'block.menu', 'inline.heart'])})${COLON}$`,
  /** 段头 `若 <条件>：`——行尾终止符只认全角（判据同 `parseSectionHead` 的头位闸） */
  openSection: () => `^${WS}*(?:${wordGroup(['block.section'])})${WS}[^\\r\\n]*${esc(FULLWIDTH_COLON)}$`,
  /** `开关:` 头部声明（后跟缩进块，判据同 parser 的 `readSwitchItems`） */
  openSwitch: () => `^${WS}*(?:${wordGroup(['head.switch'])})${WS}*${COLON}[^\\r\\n]*$`,
  /**
   * 预处理条件块头（v1.9 P0-C）：`预处理 如果 X：` / `预处理 否则如果 X：` / `预处理 否则：` /
   * `预处理 调试：` / `预处理 非调试：`——子词必须落在闭集里，否则 `预处理 一下：` 这类日常中文
   * 会被误当成块头（与 `classifyLine` 的闭集闸同一口径）。
   */
  openPreproc: () =>
    `^${WS}*(?:${wordGroup(['block.preproc'])})${WS}+(?:${wordGroup([
      'block.if',
      'block.elif',
      'block.else',
      'inline.preprocDebug',
      'inline.preprocNonDebug',
    ])})${HEAD_TAIL}`,
  /** 表达式位块头 `目标 = 如果/当 …：`（`=` 左侧不许再有 `=`，判据同 `parseExprHead`） */
  openExpr: () => {
    const rawStart = `(?:[A-Z][A-Z0-9_]*(?:[:.][^\\s]*)?(?:${WS}|$)|[@$])`;
    const declStart = `(?:${wordGroup(['head.alias', 'head.const'])})${WS}`;
    return (
      `^(?!${WS}*${rawStart})(?!${WS}*${declStart})[^=\\r\\n]*${WS}*=${WS}*(?:${wordGroup([
        'block.if',
        'block.when',
      ])})(?:${WS}[^\\r\\n]*)?${COLON}$`
    );
  },
} as const;

export interface SugarEnterRulePatterns {
  /** 回车后新行 +1 级的行形状（每族一条，宿主逐条翻成 `onEnterRules` 的 Indent 动作） */
  readonly indentOnEnter: readonly RegExp[];
  /** `indentationRules.increaseIndentPattern`（粘贴 / 行中回车智能缩进） */
  readonly increaseIndentPattern: RegExp;
  /** `indentationRules.decreaseIndentPattern`：光标落到段头（`否则`/`是`/`组`…）⇒ 与父块平级 */
  readonly decreaseIndentPattern: RegExp;
}

/** 段头（与前一同级块头对齐的收束+开放形）——回车落到这些行上时先退一级 */
const SEGMENT_ALIGN_IDS: readonly KeywordId[] = ['block.elif', 'block.else', 'block.is', 'block.group'];

/**
 * 回车规则的**角色词表**（ERB-ENTER-RULES，2026-10-21）。
 *
 * 一门语言的块角色分四档（开块 / 分支 / 闭合 / 只抬下一行），词形**必须来自该语言自己的
 * 真源**：`.kojo` 从 `SUGAR_LEXICON_WORDS`（本包 `keywords.ts`），`.erb` 从引擎配对表
 * （`erb-parser/scanner.ts` 的 `classifyControlFlow`，由宿主喂进来）。本层不写词形清单、
 * 更不认识语言名——它只把"词表 + 注释记号 + 大小写口径"翻成 Monaco 要的三格正则。
 *
 * 为什么分支与开块同抬一级、同时又要进闭合档（口径来自真实语料的排版习惯，
 * 基线盘 `COMMON.ERB` 105-117 / 1059-1064 逐行量得）：
 * `SELECTCASE` 在 d 层 ⇒ `CASE` 落在 d+1；`CASE` 的**兄弟**行回到 d+1（不是 d+2），
 * 而 `CASE` 的正文落在 d+2 ⇒ `CASE` 既抬下一行（分支形）、又与父块同层（收束形）。
 */
export interface EnterRoleVocabulary {
  /** 开块语句：下一行更深一级（`IF` / `SELECTCASE` / `REPEAT` …） */
  readonly open: readonly string[];
  /** 分支语句：下一行更深一级，且本行与兄弟分支同层（`ELSE` / `CASE` / `CATCH` …） */
  readonly branch: readonly string[];
  /** 闭合语句：本行退回开块那一层（`ENDIF` / `ENDSELECT` / `REND` …） */
  readonly close: readonly string[];
  /** 只抬下一行的单行形（无闭合语句，如 `SIF`） */
  readonly indentNextLine?: readonly string[];
  /** 行注释记号（`;`）：命中它的行不参与缩进继承，也不被别的规则改动 */
  readonly lineComment?: string;
  /** 关键字大小写不敏感（Emuera 引擎事实；糖侧是 `false`——小写另有别名档） */
  readonly caseInsensitive?: boolean;
}

/**
 * 词表派生出的回车规则族（三格必有、两格按需）。
 * 与 {@link SugarEnterRulePatterns} 同形且多两格可选：糖侧那份是本类型的特例，
 * 宿主的 Monaco 翻译层（`app/src/monaco/enter-rules.ts`）只认这一种形状，
 * 两门语言从同一道门出去。
 */
export interface EnterRulePatterns {
  /** 回车后新行 +1 级的行形状（每族一条，宿主逐条翻成 `onEnterRules` 的 Indent 动作） */
  readonly indentOnEnter: readonly RegExp[];
  /** `indentationRules.increaseIndentPattern`（粘贴 / 行中回车智能缩进） */
  readonly increaseIndentPattern: RegExp;
  /** `indentationRules.decreaseIndentPattern`：落到收束形上 ⇒ 与父块平级 */
  readonly decreaseIndentPattern: RegExp;
  /** `indentationRules.indentNextLinePattern`：只抬下一行的单行形（`SIF` 一类） */
  readonly indentNextLinePattern?: RegExp;
  /** `indentationRules.unIndentedLinePattern`：注释行不改自己的缩进、也不参与下一行的继承 */
  readonly unIndentedLinePattern?: RegExp;
}

/** 关键字后的"词已尽"判据（与 `erb-parser/scanner.ts::controlFlowToken` 的 `^([A-Za-z_]+)` 同口径） */
const KEYWORD_TAIL = '(?![A-Za-z_])';

/** 词形 → 交替组（长词优先，与 `wordGroup` 同一排序纪律；重复词形去重） */
function roleAlternation(words: readonly string[]): string {
  return [...new Set(words)]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    .map(esc)
    .join('|');
}

/** `^\s*(?:词形)` 的行首锚（行首空白集与糖侧同一个 `WS`：空格 / TAB / 全角空格） */
function roleLineStart(words: readonly string[]): string | null {
  if (words.length === 0) return null;
  return `^${WS}*(?:${roleAlternation(words)})${KEYWORD_TAIL}`;
}

/** 若干"行首锚"并成一条（空档自动跳过） */
function unionLineStart(sources: readonly (string | null)[]): string | null {
  const kept = sources.filter((s): s is string => s !== null && s.length > 0);
  if (kept.length === 0) return null;
  return kept.length === 1 ? kept[0]! : `(?:${kept.join('|')})`;
}

/**
 * 从块角色词表派生回车规则族（无副作用；宿主注册期各调一次）。
 *
 * 分档去向：`open` ∪ `branch` ⇒ `increaseIndentPattern` 与 `indentOnEnter`（抬下一行）；
 * `close` ∪ `branch` ⇒ `decreaseIndentPattern`（收束回父块那一层）；
 * `indentNextLine` ⇒ `indentNextLinePattern`（只抬下一行，正文再回车不叠加）；
 * `lineComment` ⇒ `unIndentedLinePattern`（注释行不参与继承：列 0 的注释不把后续行拖到列 0）。
 */
export function enterRulePatternsFromRoles(vocab: EnterRoleVocabulary): EnterRulePatterns {
  const flags = vocab.caseInsensitive === true ? 'i' : '';
  const open = roleLineStart(vocab.open);
  const branch = roleLineStart(vocab.branch);
  const close = roleLineStart(vocab.close);
  const next = vocab.indentNextLine === undefined ? null : roleLineStart(vocab.indentNextLine);
  const comment = vocab.lineComment === undefined ? null : `^${WS}*${esc(vocab.lineComment)}`;
  const increase = unionLineStart([open, branch]);
  if (increase === null) {
    throw new Error('enterRulePatternsFromRoles: 词表里没有任何开块 / 分支词形（空表 = 这门语言的回车层不存在，不许静默注册）');
  }
  const indentOnEnter = [open, branch].filter((s): s is string => s !== null).map((s) => new RegExp(s, flags));
  // 词表可以没有收束形（纯缩进语言），但 `indentationRules` 这一格 Monaco 要求必填 ⇒
  // 用恒不成立的空负向预查顶上，**不是**"匹配空行"（`^$` 会把每个空行都当收束形）
  const neverMatch = new RegExp('(?!)', flags);
  const decrease = unionLineStart([close, branch]);
  const patterns: EnterRulePatterns = {
    indentOnEnter,
    increaseIndentPattern: new RegExp(increase, flags),
    decreaseIndentPattern: decrease === null ? neverMatch : new RegExp(decrease, flags),
    ...(next === null ? {} : { indentNextLinePattern: new RegExp(next, flags) }),
    ...(comment === null ? {} : { unIndentedLinePattern: new RegExp(comment, flags) }),
  };
  return patterns;
}

/** 从词表派生回车正则族（无参无副作用；宿主注册期调用一次即可） */
export function sugarEnterRulePatterns(): SugarEnterRulePatterns {
  const indentOnEnter = Object.values(ENTER_FAMILIES).map((build) => new RegExp(build()));
  const segmentTail = `(?:${WS}[^\\r\\n]*)?${COLON}${WS}*$`;
  const segmentAlign = `^${WS}*(?:${wordGroup(SEGMENT_ALIGN_IDS)})${segmentTail}`;
  // 预处理块的回退形（v1.9 P0-C）：分支头与父块头同级回退；`预处理结束` 无冒号、整行独立
  const preprocAlign =
    `^${WS}*(?:(?:${wordGroup(['block.preproc'])})${WS}+(?:${wordGroup(['block.elif', 'block.else'])})${segmentTail}` +
    `|(?:${wordGroup(['block.preprocEnd'])})${WS}*$)`;
  return {
    indentOnEnter,
    increaseIndentPattern: new RegExp(indentOnEnter.map((r) => r.source).join('|')),
    decreaseIndentPattern: new RegExp(`(?:${segmentAlign}|${preprocAlign})`),
  };
}
