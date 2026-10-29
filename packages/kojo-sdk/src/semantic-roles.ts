/**
 * **语义角色表**（LAU-2 · 架构 §4.2 的落地件；**SDK B5a 起住在 `@kojo/kojo-sdk`**）：
 * 屏幕上一共分几层，以及"哪个旧 token 名属于哪一层"。
 *
 * ## 为什么最终住 SDK（架构 §7.2 第 2 条：角色表住 SDK，不住 app）
 *
 * 搬动有两跳，每一跳都是"判据只有一份"的同一条理由：
 *
 * 1. **LAU-2：宿主 → `@kojo/kojo-lang`**。它在宿主时，插件拿不到宿主的常量，只能在包里
 *    重抄 `role.*` 字符串——抄一遍就是第二份判据；
 * 2. **B5a：`@kojo/kojo-lang` → 本包（SDK）**。`kojo-lang` 是**实现库**（符号树怎么摆、
 *    缩进阶梯怎么算），而角色表是**作者面契约**：第三方语言包要发一套主题规则，就必须先拿到
 *    同一批角色名。它的法定落点是 SDK，`kojo-lang` 只是消费者（依赖方向
 *    `kojo-lang → kojo-sdk → kojo-core`，单向）。
 *
 * 两跳都是纯搬家；为什么不认 Monaco（连 type 也不引）写在 `@kojo/kojo-lang/theme-rules` 头注。
 *
 * ## 为什么要有这一层
 *
 * 收口之前，"token 名 → 颜色"这件事在三处各写一遍（三份捕获表 + 三套 Monarch + 六份主题
 * 调色板，共 48 条规则 × 6 套）。加一档要改三处，漏一处就是"这枚捕获悄悄没色"。本表把
 * 中间那一层抽出来：
 *
 * ```
 * 捕获名 / 词法记号  →  角色（本文件）  →  每套主题给角色一个前景色
 * ```
 *
 * - **捕获侧**（`tree-sitter/erb-tiers.ts`、`tree-sitter/types.ts`、`kojo2-semantic.ts`）与
 *   **词法侧**（三份 Monarch）只发角色名，不再认识任何一门语言的颜色；
 * - **主题侧**（`theme.ts` / `kojo-lang/theme-rules.ts` / 2.0 的主题装配）只铺 `token: role.*`
 *   规则，六套主题对同一批角色各给一色。
 *
 * 名字空间带 `role.` 前缀：既避免与 Monaco 基线 token（`keyword` / `string` …）意外撞名，
 * 也让"这一档是本仓定义的"一眼可辨。Monarch 发的 token 名会被追加语言 id 后缀
 * （`role.keyword.kojo-legacy`），Monaco 的主题匹配是**最长前缀**，故 `role.keyword` 照样命中。
 *
 * ## 档数是 34，不是设计稿 §4.2 的 18——这是本批的**硬约束决定**，不是随手改口径
 *
 * §4.2 的 18 档是**定稿色卡**的目标形状，且 LAU-2a（`f006547c`）只证明"18 档在六套底色上
 * 数学可解"，那 18 枚见证色**未经可读性与语义联想评审**。本批的约束是另一条：
 * **六套主题一个色值都不许改**（重构只做命名与形状）。
 *
 * 把 48 个现役 token 名折叠到 18 档，必然要让今天**颜色不同**的若干档合并——例如暗色盘里
 * `kojo2.keyword` 是青 `8be9fd`、`keyword` 是紫 `c678dd`；`sugar.slot` 是薄荷 `5cc9a8`、
 * `variable` 是红 `e06c75`。合并即改屏上颜色，直接违反硬约束。所以本批的档数取**下界**：
 * 恰好让"每个角色在每一套主题里只有一枚色"成立的最小划分（即"六套主题上色值与字重全同"
 * 的等价类）。实测六套主题的独立色：dark 25 / light 18 / mint 16 / One Dark 16 /
 * Rosé Pine 10 / Synthwave 11，等价类上界由 dark 的 25 枚决定，加上字重（bold / italic）
 * 带来的三处分家，最终 **34 档**。
 *
 * ⇒ 18 档定稿色卡落地时，本表的 `*.alt` 与若干同色档会被合并（见下条）；那是一次
 * **配色决策**，须人工评审色卡，不在 LAU-2。
 *
 * ## 三种分家理由（为什么不是 1 token 1 角色）
 *
 * 1. **同义档同色**（合并）：`sugar.speech` 与 `kojo2.speech` 在六套主题里逐字同色
 *    ⇒ 同一个 `role.speech`（"台词正文"在两门语言里就是一档）。`theme-color-gates.test.ts`
 *    的跨语言同义档五组也是这条。
 * 2. **`.alt` = 同一语义槽在当前色盘里的第二个色档**：`role.keyword` / `role.keyword.alt`、
 *    `role.operator` / `role.operator.alt`、`role.number` / `role.number.alt`、
 *    `role.interp` / `role.interp.alt`。它们在**语义上是一层**，只是六套主题里两门语言拿到了
 *    不同的色值（多数只在 dark / One Dark 分家）。18 档定稿色卡落地时这四对合并。
 * 3. **字重不同 ⇒ 必须分档**：`role.interp`（无字重）与 `role.interp.delimiter`（bold）——
 *    主题规则把前景色与 `fontStyle` 绑在同一条规则上，合并即丢字重。
 *
 * ## 名字层不在这张表里（D6）
 *
 * `EDITOR_SEMANTIC_TOKEN_TYPES` 那三值（`function` / `variable` / `parameter`）是**名字层**
 * 语义（"这枚标识符是函数、变量还是参数"），与"这段语法是什么角色"是两个正交维度
 * （架构 §4.2 尾注、决策 D6）。合并成一份 legend 会让插件作者为一枚变量同时选语法角色与
 * 名字层类别，而 Monaco 的多 provider 合并是"重叠时先注册者胜"——维度混淆后无谁该赢可推。
 * 所以名字层那五条主题规则（`KOJO_SEMANTIC_THEME_RULES`）**原样留着**，不进本表。
 *
 * ## 别名表是旧 token 名的唯一落点
 *
 * {@link LEGACY_ROLE_ALIASES} 是**全仓唯一**出现旧 token 名（`sugar.*` / `kojo2.*` /
 * `keyword.erb*` 及裸词法名）的地方——`tools/audit-language.mjs` 的 M3 类就是按这条钉的
 * （改前 254 行散在 20 个文件，本批收敛到本文件一处）。它有两个用途：①`audit` 的落点；
 * ②**零改色的证明**：`semantic-roles.test.ts` 拿本表把"旧 token 名 → 角色 → 主题色"还原成
 * 改前那份色值快照（`tests/fixtures/legacy-token-colors.json`），逐套主题逐档比对，一个
 * hex / 一个字重都不许差。
 *
 * 别名表在即可回滚：任何一个旧名都还能算出它原来那枚色（LAU-2 的回滚点）。
 */

/* ============================== 角色名（单一真源） ============================== */

/**
 * 角色名常量。**所有地方都从这里取**，不手抄字符串（手抄就会漂，且漂了没有闸）。
 *
 * 顺序 = 作者读屏的次序（正文 → 注释 → 骨架 → 字面 → 对话 → 名字 → 结构 → 不透明块），
 * 也是六套主题规则表的**规则序**（`ROLE_THEME_RULES` 等按此序生成，测试按此序断言）。
 */
export const ROLE = {
  /** 正文 / 裸标识符（作者写的字，语法层要退到后面） */
  text: 'role.text',
  /** 注释 */
  comment: 'role.comment',
  /** 语言骨架：中文关键字 / 保留词 / 引擎关键字 */
  keyword: 'role.keyword',
  /** 英文隐藏别名：输入生效但弱化一档 */
  keywordAlias: 'role.keyword.alias',
  /** 同上，2.0 侧的独立色档（见头注 `.alt`） */
  keywordAlt: 'role.keyword.alt',
  /** 外来指令：预处理行 / 标签行 / `#` 行 */
  directive: 'role.directive',
  /** 未中文化的引擎骨架（整行外来，最扎眼的一档） */
  engine: 'role.engine',
  /** 引擎族头（族头后面还挂着槽位原名） */
  engineFamily: 'role.engine.family',
  /** 运算符（符号形） */
  operator: 'role.operator',
  /** 中文运算符（`不在` 与比较词） */
  operatorWord: 'role.operator.word',
  /** 同上，2.0 侧的独立色档 */
  operatorAlt: 'role.operator.alt',
  /** 数值字面量 */
  number: 'role.number',
  /** 同上，2.0 侧的独立色档（含十六进制） */
  numberAlt: 'role.number.alt',
  /** 字符串字面量 */
  string: 'role.string',
  /** 串内转义 / 插值定界（ERB 的 `\` 与 `{` `%` 开闭） */
  escape: 'role.escape',
  /** 插值记号与其中的表达式 */
  interp: 'role.interp',
  /** 插值定界（加粗，与内容分档看边界） */
  interpDelimiter: 'role.interp.delimiter',
  /** 同上，2.0 侧的独立色档 */
  interpAlt: 'role.interp.alt',
  /** 结构性标点：台词引号、块头冒号、`「」` */
  punctuation: 'role.punctuation',
  /** 台词正文 */
  speech: 'role.speech',
  /** 说话人 */
  speaker: 'role.speaker',
  /** 旁白正文（`>` 之后） */
  narration: 'role.narration',
  /** 行尾表演提示 / 行尾记号 */
  hint: 'role.hint',
  /** 不等待标记（`续` / `~` / `⏎`） */
  cont: 'role.cont',
  /** 名字层：作者还得记住的原名（CJK 非词表 = 槽位原名 / 自定名） */
  slot: 'role.slot',
  /** 保留代词（`她` / `你`） */
  pronoun: 'role.pronoun',
  /** 变量引用（引擎变量族多段引用） */
  variable: 'role.variable',
  /** 标签 / 跳转目标 */
  label: 'role.label',
  /** 声明名（函数名 / 定义点） */
  decl: 'role.decl',
  /** 声明词（2.0 `#` / `@` / `!` 之后的那枚名字） */
  declaration: 'role.declaration',
  /** 调用位（被调名） */
  call: 'role.call',
  /** 类型 / 结构名 */
  type: 'role.type',
  /** 不透明整块（原生直通 / 停用区） */
  raw: 'role.raw',
  /** 锚点（`#` `@` `>` `?` `!` 五记号） */
  anchor: 'role.anchor',
} as const;

export type SemanticRole = (typeof ROLE)[keyof typeof ROLE];

/** 全部角色（顺序 = 规则序；测试与主题表按此序） */
export const SEMANTIC_ROLES: readonly SemanticRole[] = Object.freeze([
  ROLE.text,
  ROLE.comment,
  ROLE.keyword,
  ROLE.keywordAlias,
  ROLE.keywordAlt,
  ROLE.directive,
  ROLE.engine,
  ROLE.engineFamily,
  ROLE.operator,
  ROLE.operatorWord,
  ROLE.operatorAlt,
  ROLE.number,
  ROLE.numberAlt,
  ROLE.string,
  ROLE.escape,
  ROLE.interp,
  ROLE.interpDelimiter,
  ROLE.interpAlt,
  ROLE.punctuation,
  ROLE.speech,
  ROLE.speaker,
  ROLE.narration,
  ROLE.hint,
  ROLE.cont,
  ROLE.slot,
  ROLE.pronoun,
  ROLE.variable,
  ROLE.label,
  ROLE.decl,
  ROLE.declaration,
  ROLE.call,
  ROLE.type,
  ROLE.raw,
  ROLE.anchor,
]);

/**
 * 角色 → 字重（缺省 = 不加字重）。**只有这六档有字重**，理由各自写在册：
 * - `comment` 斜体：注释不是正文；
 * - `cont` 粗体：`续` 是"这一行不停"的开关，必须比正文重；
 * - `interpDelimiter` 粗体：插值边界要与插值内容分开看；
 * - `decl` 粗体：定义点比调用点重（沿用既有 `function.declaration` 的判据）；
 * - `anchor` 粗体：五锚点是句子的第一眼；
 * - `hint` 斜体：提示不打印、只改演出。
 *
 * 其余角色一律不加字重——CJK 环境里的伪斜体会糊（与 `keyword` 同一口径）。
 */
export const ROLE_FONT_STYLES: Readonly<Partial<Record<SemanticRole, 'bold' | 'italic'>>> = Object.freeze({
  [ROLE.comment]: 'italic',
  [ROLE.cont]: 'bold',
  [ROLE.interpDelimiter]: 'bold',
  [ROLE.decl]: 'bold',
  [ROLE.anchor]: 'bold',
  [ROLE.hint]: 'italic',
});

/** 是不是一个角色名（类型守卫；别名表的值与主题调色板的键都靠它自查） */
export function isSemanticRole(value: string): value is SemanticRole {
  return (SEMANTIC_ROLES as readonly string[]).includes(value);
}

/* ============================== 旧名 → 角色（迁移桥） ============================== */

/**
 * 旧 token 名 → 角色。**全仓唯一出现旧 token 名的表**（`audit:language` M3 的法定落点）。
 *
 * 分三段：①ERB / v1 共用的裸词法名；②v1 糖层 `sugar.*` 与引擎档 `keyword.erb*`；
 * ③2.0 的 `kojo2.*`。键集合**必须覆盖三侧现役全部 token 名**（ERB 15 / v1 15 / kojo2 16
 * ＝ 46 枚语言面 token 名，其中 6 对在六套主题里逐字同色故合并到同一角色），另加 ERB
 * Monarch 的四枚子档（`string.quote` / `keyword.preprocessor.skip.*` / `comment-code`）
 * ——它们是同一档的细分形，与母档落同一角色。
 *
 * 加新档的顺序照旧：先在 `ROLE` 里加角色 → 再在这里加一行旧名；两处都不许"只在词法里
 * 写个新字符串"。
 */
export const LEGACY_ROLE_ALIASES: Readonly<Record<string, SemanticRole>> = Object.freeze({
  /* ① 裸词法名（ERB / v1 共用；Monaco 基线 token 与 `entity.name.function` 一类） */
  comment: ROLE.comment,
  keyword: ROLE.keyword,
  'keyword.preprocessor': ROLE.directive,
  'keyword.preprocessor.skip.start': ROLE.directive,
  'keyword.preprocessor.skip.end': ROLE.directive,
  'keyword.preprocessor.comment-code': ROLE.directive,
  'entity.name.function': ROLE.decl,
  'support.type': ROLE.type,
  variable: ROLE.variable,
  string: ROLE.string,
  'string.quote': ROLE.string,
  'string.escape': ROLE.escape,
  number: ROLE.number,
  label: ROLE.label,
  operator: ROLE.operator,
  identifier: ROLE.text,

  /* ② v1 糖层（`.kojo`）与引擎档 */
  'sugar.keyword': ROLE.keyword,
  'sugar.keyword.alias': ROLE.keywordAlias,
  'sugar.system-function': ROLE.call,
  'sugar.operator': ROLE.operatorWord,
  'sugar.cont': ROLE.cont,
  'sugar.pronoun': ROLE.pronoun,
  'sugar.speech': ROLE.speech,
  'sugar.speech.delimiter': ROLE.punctuation,
  'sugar.interp': ROLE.interp,
  'sugar.interp.delimiter': ROLE.interpDelimiter,
  'sugar.colon': ROLE.punctuation,
  'sugar.slot': ROLE.slot,
  'keyword.raw': ROLE.raw,
  'keyword.erb': ROLE.engine,
  'keyword.erb.family': ROLE.engineFamily,

  /* ③ 2.0（`.kojo2`） */
  'kojo2.anchor': ROLE.anchor,
  'kojo2.declaration': ROLE.declaration,
  'kojo2.keyword': ROLE.keywordAlt,
  'kojo2.keyword.delimiter': ROLE.punctuation,
  'kojo2.speaker': ROLE.speaker,
  'kojo2.speech': ROLE.speech,
  'kojo2.speech.string': ROLE.string,
  'kojo2.narration': ROLE.narration,
  'kojo2.interp': ROLE.interpAlt,
  'kojo2.hint': ROLE.hint,
  'kojo2.raw': ROLE.raw,
  'kojo2.comment': ROLE.comment,
  'kojo2.number': ROLE.numberAlt,
  'kojo2.number.hex': ROLE.numberAlt,
  'kojo2.operator': ROLE.operatorAlt,
  'kojo2.type': ROLE.type,
});

/** 旧名 → 角色；表外返回 `undefined`（**不猜**：没有别名就等于没有这一档） */
export function roleForLegacyToken(token: string): SemanticRole | undefined {
  return LEGACY_ROLE_ALIASES[token];
}

/**
 * 名字层的五个主题键（D6：与语法角色**正交**，不进 {@link SEMANTIC_ROLES}）。
 *
 * 它们不是"旧 token 名"而是 Monaco 语义 token 的 `[type, ...modifiers].join('.')` 键，
 * 契约侧的真源是 `EDITOR_SEMANTIC_TOKEN_TYPES` / `..._MODIFIERS`（本表只是把顺序与字重
 * 钉在宿主侧，供主题表按同一份清单铺规则）。
 */
export const NAME_LAYER_RULES: readonly { readonly token: string; readonly fontStyle?: 'bold' | 'italic' }[] =
  Object.freeze([
    { token: 'function' },
    { token: 'function.declaration', fontStyle: 'bold' },
    { token: 'parameter' },
    { token: 'variable.declaration' },
    { token: 'variable.declaration.readonly', fontStyle: 'italic' },
  ]);

/* ============================== 2.0 词法档位名 → 角色 ============================== */

/**
 * 2.0 的**词法档位名 → 角色**（`.kojo2` 的 Monarch、捕获表与主题三侧共用的中间层）。
 *
 * 保留这一层不是为了多一层翻译，而是因为 2.0 的档位名是**作者面口径**（"锚点 / 声明名 /
 * 对话"三类、锚点五记号共用一档…），档位表的可读性不因角色表而消失；且多对一是有意的：
 * `keyword` 族四支（`keyword` / `.control` / `.function` / `.directive`）落同一角色，
 * `number.hex` 与 `number` 同档（十六进制常量与十进制整数同色）。
 *
 * 住在 `semantic-roles.ts`（零依赖）而不是词法文件里：主题侧（`kojo2-theme.ts`）与词法侧
 * （`kojo2-language.ts`）都要读它，而词法文件拖着糖词表（PS-10 断链纪律）。
 */
export const KOJO2_TOKEN = Object.freeze({
  /** 五锚点符号（`# @ > ? !` 与行首转义 `\`） */
  anchor: ROLE.anchor,
  /** 声明词 / 调度词（`#` 后的词、`@` 后的词、`!` 的被调名） */
  declaration: ROLE.declaration,
  /** 保留词（`依据` / `否` / `续` / `空行` / 类型词 / 存储期词 / 织入修饰词 / `[插槽]`） */
  keyword: ROLE.keywordAlt,
  /** 结构性标点（`：` / `「」` / 括号 / 逗号）——与 v1 的台词标点**同角色**：同一枚 `「` 必须同色 */
  delimiter: ROLE.punctuation,
  /** 说话人（`角色：` 的整段前导 + 域符号 `我/你/她`） */
  speaker: ROLE.speaker,
  /** 台词正文 */
  speech: ROLE.speech,
  /** 字符串字面量（`"…"`） */
  string: ROLE.string,
  /** 旁白正文（`>` 之后） */
  narration: ROLE.narration,
  /** 插值 `{…}` / `{条件 ? A : B}`（含花括号） */
  interp: ROLE.interpAlt,
  /** 行尾表演提示 `(心形)` / `(别过头)` */
  hint: ROLE.hint,
  /** `@原生` 围栏体（整行原文，不解释）——与 v1 的整行原生直通同角色 */
  raw: ROLE.raw,
  /** 整行 `//` 注释 */
  comment: ROLE.comment,
  /** 十进制整数 */
  number: ROLE.numberAlt,
  /** 十六进制颜色/常量字面量（与十进制同档） */
  hex: ROLE.numberAlt,
  /** 运算符（ASCII 符号与中文运算符词） */
  operator: ROLE.operatorAlt,
  /** 类型 / 结构名（`# 对照表` / `# 池` / `# 模` 头与 `# 设` 行的类型词）——与 v1 的类型档同角色 */
  type: ROLE.type,
});

export type Kojo2TokenName = (typeof KOJO2_TOKEN)[keyof typeof KOJO2_TOKEN];

/* ============================== 规则构造 ============================== */

/**
 * 一条主题前景规则——**与 `monaco.editor.ITokenThemeRule` 逐字同形，但不 import 它**
 * （为什么连 type 也不引、宿主怎么结构化赋过去，都写在 `theme-rules.ts` 头注）。
 */
export interface KojoTokenThemeRule {
  readonly token: string;
  readonly foreground: string;
  readonly fontStyle?: 'bold' | 'italic';
}

/** 角色 → 一条主题规则（前景色来自调用方的调色板；字重来自 {@link ROLE_FONT_STYLES}） */
export function roleRule(role: SemanticRole, foreground: string): KojoTokenThemeRule {
  const fontStyle = ROLE_FONT_STYLES[role];
  return fontStyle === undefined ? { token: role, foreground } : { token: role, foreground, fontStyle };
}

/** 把角色调色板铺成规则数组（漏一档当场抛：少配一档在模块加载期变红，而不是静默掉色） */
export function rulesFromRolePalette(
  palette: Readonly<Record<string, string>>,
): KojoTokenThemeRule[] {
  return SEMANTIC_ROLES.map((role) => {
    const foreground = palette[role];
    if (foreground === undefined) {
      throw new Error(`[semantic-roles] 角色调色板缺少「${role}」`);
    }
    return roleRule(role, foreground);
  });
}

/** 名字层五条规则（按 {@link NAME_LAYER_RULES} 的序与字重） */
export function nameLayerRules(palette: Readonly<Record<string, string>>): KojoTokenThemeRule[] {
  return NAME_LAYER_RULES.map((spec) => {
    const foreground = palette[spec.token];
    if (foreground === undefined) {
      throw new Error(`[semantic-roles] 名字层调色板缺少「${spec.token}」`);
    }
    return spec.fontStyle === undefined
      ? { token: spec.token, foreground }
      : { token: spec.token, foreground, fontStyle: spec.fontStyle };
  });
}

/** 角色调色板的键集自查（装配期与测试共用）：必须恰好 = {@link SEMANTIC_ROLES} */
export function assertRolePalette(palette: Readonly<Record<string, string>>, label: string): void {
  const missing = SEMANTIC_ROLES.filter((role) => palette[role] === undefined);
  if (missing.length > 0) {
    throw new Error(`[semantic-roles] ${label} 缺 ${missing.length} 档角色：${missing.join(' / ')}`);
  }
  const extra = Object.keys(palette).filter((key) => !isSemanticRole(key));
  if (extra.length > 0) {
    throw new Error(`[semantic-roles] ${label} 有 ${extra.length} 个未登记的角色：${extra.join(' / ')}`);
  }
}
