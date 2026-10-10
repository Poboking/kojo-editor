/**
 * 表层语法关键字表（规范 §3 / §4 / 附录 A）——**跨游戏语言层**。
 *
 * 中文关键字本身不是某个游戏的领域知识（契约 `sugar.ts` 头注已定调），
 * 故关键字表住在转译器内；eraTW 特定的旗标命名 / 配色常量 /
 * 时机分野模板来自 adapter。
 *
 * 一律「中文主形 + 英文别名」双收（规范 §4.1）。产物永远是原生 ERB——
 * 别名只影响**输入**，不影响输出。
 */

/** 关键字 → 规范语义 id（内部规范形，与输入语言解耦） */
export type KeywordId =
  /* 头部声明 */
  | 'head.char'
  | 'head.family'
  | 'head.title'
  | 'head.desc'
  | 'head.color'
  | 'head.narrationColor'
  | 'head.switch'
  | 'head.alias'
  /* 块头 */
  | 'block.timing'
  | 'block.if'
  | 'block.elif'
  | 'block.else'
  | 'block.when'
  | 'block.is'
  | 'block.random'
  | 'block.choice'
  | 'block.color'
  /* 行内 / 时机子句 */
  | 'inline.cont'
  | 'inline.heart'
  | 'inline.to'
  | 'inline.hideScene'
  | 'inline.hideKojo'
  /* 别名右值 */
  | 'alias.char';
/**
 * 关键字表：英文别名一律**小写 ASCII**（规范 §4.1）。
 * 中文主形按 UTF-16 原文精确匹配（不做全角/半角折叠——关键字本身无全半角变体）。
 */
const KEYWORDS: ReadonlyMap<string, KeywordId> = new Map([
  // 头部
  ['角色', 'head.char'],
  ['char', 'head.char'],
  ['口上', 'head.family'],
  ['family', 'head.family'],
  ['显示名', 'head.title'],
  ['title', 'head.title'],
  ['简介', 'head.desc'],
  ['desc', 'head.desc'],
  ['口上色', 'head.color'],
  ['color', 'head.color'],
  ['旁白色', 'head.narrationColor'],
  ['narration-color', 'head.narrationColor'],
  ['开关', 'head.switch'],
  ['switch', 'head.switch'],
  ['别名', 'head.alias'],
  ['alias', 'head.alias'],
  // 块头
  ['时机', 'block.timing'],
  ['timing', 'block.timing'],
  ['如果', 'block.if'],
  ['if', 'block.if'],
  ['否则如果', 'block.elif'],
  ['elif', 'block.elif'],
  ['elseif', 'block.elif'],
  ['否则', 'block.else'],
  ['else', 'block.else'],
  ['当', 'block.when'],
  ['when', 'block.when'],
  ['是', 'block.is'],
  ['is', 'block.is'],
  ['随机', 'block.random'],
  ['random', 'block.random'],
  ['选项', 'block.choice'],
  ['choice', 'block.choice'],
  ['着色', 'block.color'],
  // 行内
  ['续', 'inline.cont'],
  ['cont', 'inline.cont'],
  ['continue', 'inline.cont'],
  ['心形', 'inline.heart'],
  ['heart', 'inline.heart'],
  ['到', 'inline.to'],
  ['to', 'inline.to'],
  ['隐藏情景', 'inline.hideScene'],
  ['skip-scene', 'inline.hideScene'],
  ['隐藏口上', 'inline.hideKojo'],
  ['skip-kojo', 'inline.hideKojo'],
  // 别名的 `角色 N` 右值形态由 `isAliasCharKeyword` 按上下文判定，
  // **不**在此表登记（否则会覆盖 `head.char`——Map 保留最后一次插入）。
]);

/** 保留代词（规范 §3.8）——`别名` 不得与它们同名（诊断 `alias-name-conflict`） */
export const RESERVED_PRONOUNS: readonly string[] = ['她', '你'];

/** `续`（不等待）标记：中文主形 + 隐藏别名（规范 §3.3） */
export const CONT_MARKS: readonly string[] = ['续', '~', '⏎', 'cont', 'continue'];

/** 查询关键字语义 id（大小写敏感的中文 / 小写英文别名） */
export function lookupKeyword(word: string): KeywordId | undefined {
  return KEYWORDS.get(word);
}

/** 头部声明关键字集合（`角色:` / `口上:` …，行首 `词:` 形态；`开关:` 后跟缩进块） */
export const HEAD_DECL_KEYS: readonly KeywordId[] = [
  'head.char',
  'head.family',
  'head.title',
  'head.desc',
  'head.color',
  'head.narrationColor',
  'head.switch',
];

/**
 * 别名右值的 `角色 N` 形态判定（规范 §3.1 表）。
 * `角色` 既是头部关键字也是别名右值关键字——按**上下文**（右侧是否 `别名 X =`）区分。
 */
export function isAliasCharKeyword(word: string): boolean {
  return word === '角色' || word === 'char';
}

/* --------------------------- 运算符降糖（规范 §4.3） --------------------------- */

/**
 * 中文运算符 → ERB 运算符。
 *
 * 注意匹配顺序：**长词优先**（`不等于` 先于 `等于`），否则 `不等于` 会被
 * 解析成 `不` + `等于`（错误的 `! =`）。表按长度降序，调用方逐个尝试。
 */
const OPERATORS: ReadonlyArray<readonly [string, string]> = (
  [
    ['不等于', '!='],
    ['等于', '=='],
    ['超过', '>'],
    ['至少', '>='],
    ['不足', '<'],
    ['至多', '<='],
    ['且', '&&'],
    ['或', '||'],
    ['非', '!'],
  ] as ReadonlyArray<readonly [string, string]>
).slice().sort((a, b) => b[0].length - a[0].length);

/** 中文运算符表（已按长度降序；`不在` 由条件降糖单独处理——见 `notin`） */
export function operatorTable(): ReadonlyArray<readonly [string, string]> {
  return OPERATORS;
}

/** `不在` 关键字（规范 §3.5：`X 不在 a 到 b` → `!(X >= a && X <= b)`） */
export const NOTIN_KEYWORDS: readonly string[] = ['不在', 'notin'];

/** 全角冒号（块头终止符，规范 §5.3） */
export const FULLWIDTH_COLON = '：';

/** 半角冒号（头部声明的等价终止符；作者可能写 `角色: 12`） */
export const HALF_COLON = ':';

/** 全角空格（规范 §8：全角标点/空格检测） */
export const FULLWIDTH_SPACE = '\u3000';

/** 判断一行是否以「块头终止符」结尾（全角 `：` 或半角 `:`） */
export function endsWithBlockColon(trimmed: string): boolean {
  return trimmed.endsWith(FULLWIDTH_COLON) || trimmed.endsWith(HALF_COLON);
}

/** 去掉行尾的块头终止符（全角/半角各一个） */
export function stripBlockColon(trimmed: string): string {
  if (trimmed.endsWith(FULLWIDTH_COLON)) return trimmed.slice(0, -1);
  if (trimmed.endsWith(HALF_COLON)) return trimmed.slice(0, -1);
  return trimmed;
}
