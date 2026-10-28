/**
 * 宿主的 **Monaco 语言面落点**（SDK B4：插件供数据、宿主落 Monaco）。
 *
 * ## 这一层只做四件事
 *
 * 1. 从槽 `ui.monaco.language` 取供方交出的语言面（经下面的模块级登记表）；
 * 2. 把契约形状**翻译**成 Monaco 的入参：`setMonarchTokensProvider` /
 *    `setLanguageConfiguration` / `defineTheme`；
 * 3. 翻译时**校验形状**：未知键、非法档位、非两元组规则 ⇒ 丢弃那一条并 `console.warn`
 *    带贡献 id（铁律 4：坏数据必须说出来，不能被吞成"有时候亮有时候不亮"）；
 * 4. **没有供方**时按契约头注写死的那一种退化办事：语言仍认领、那一副面不存在、warn 一条。
 *
 * 本模块不认识 kojo2、不认识 ERB、不认识任何角色名——它只认契约字段。
 * "这门语言的词法长什么样"全在供方（`@kojo/kojo-lang` 的数据 + `@kojo/plugin-kojo-lang` 的贡献）。
 *
 * ## 为什么走模块级登记表，而不是直接读 `kernel.slots`
 *
 * 语言注册跑在 Monaco 装配链上（`languages.ts` 的 `descriptor.register`，EditorPane 模块顶层
 * 一次性），而 kernel 只在编辑器实例挂载后才拿得到；插件也看不见宿主模块。同一处矛盾在
 * B2c / B3a 各解决过一次：**模块级登记表**（范式照 `@kojo/kojo-lang/adapter-source`）——
 * 宿主组合根在 `ensureGlobalProviders` 里登记 getter，本模块在要用的时候现取。
 * 三条口径照抄那张表：零登记 ⇒ 不猜（走退化）、用时现取、后登记优先且注销只撤自己。
 *
 * ## 幂等与"晚到的供方"
 *
 * `setMonarchTokensProvider` / `setLanguageConfiguration` 都是"后写覆盖"，重复调用安全；
 * 台账按 (Monaco 实例, 语言 id, 副) 记，所以：
 * - descriptor 注册时调一次（供方已在 ⇒ 直接上色；供方未到 ⇒ 退化 + warn 一条）；
 * - 组合根（每次 EditorPane 挂载）再调 `applyAllMonacoLanguageSurfaces`，把晚激活的插件
 *   补上；这一遍不再重复说 warn（同一台账），免得每次挂载都喊一遍。
 *
 * ## 主题那一副
 *
 * `rules` 来自供方（按 `role.*` 铺），**部件色来自宿主**：六套 `kojo-*` 与三套 `kojo2-*`
 * 共用同一批 `editor.*` / `menu.*` values（2026-10-26 部件色批的"逐键相等、缺键 0"那条闸），
 * 语言包抄一份就是第七份色表。供方只声明侧名（`componentPalette`），这里查表补全并逐键校验。
 */
import type * as Monaco from './entry';
import type {
  MonacoComponentPaletteSide,
  MonacoLanguageConfigurationData,
  MonacoLanguageContribution,
  MonacoLanguageSurface,
  MonacoMonarchData,
  MonacoOnEnterRule,
  MonacoThemeContributionData,
} from '@kojo/plugin-api';
import { errorText } from '@kojo/plugin-api';
// 部件色三套（宿主真源）。`theme.ts` 对本模块的引用是**动态 import**（它只在真的要
// 定义 2.0 三套时才取），所以这条静态反向依赖不成环——同 `kojo2-theme.ts` 旧的形态。
import { KOJO_DARK_COLORS, KOJO_LIGHT_COLORS, KOJO_MINT_COLORS } from './theme';
// 词边界判据：全编辑器一条线（双击选词 / 补全触发字符共用那份 CJK 标点集）。
// 供方不写 `wordPattern` 时用这一份——它是编辑器 chrome，不是某门语言的判据。
import { CJK_WORD_PATTERN } from './word-separators';

/* ============================== 取数缝（模块级登记表） ============================== */

type SurfaceSource = () => readonly MonacoLanguageContribution[];

let surfaceSource: SurfaceSource | null = null;

/**
 * 登记"从哪里拿语言面"。后登记者优先；返回的注销函数**只撤自己那一枚**
 * （登记的还是现在这一位时才清，免得把别人换上去的 getter 撤走）。
 */
export function registerMonacoLanguageSurfaceSource(getter: SurfaceSource): void {
  surfaceSource = getter;
}

/** 撤销登记（只在"登记的还是这一枚"时清）。⚠ 不是 `() => void` 语义的 dispose，宿主装配层按 id 成对调用。 */
export function unregisterMonacoLanguageSurfaceSource(getter: SurfaceSource): void {
  if (surfaceSource === getter) surfaceSource = null;
}

/** 现在有没有登记来源（测试与自检读它；0 = 装配还没跑到这一步） */
export function monacoLanguageSurfaceSourceCount(): number {
  return surfaceSource === null ? 0 : 1;
}

/** 一条贡献 + 它的语言面（报错文案要指名是谁，光说语言 id 找不到人） */
interface SurfaceEntry {
  readonly contributionId: string;
  readonly surface: MonacoLanguageSurface;
}

/**
 * 槽里的贡献去重后的条目：同一个 `languageId` **第一家胜**，第二家 `console.error`
 * （铁律 4：冲突必须 error）。
 *
 * 为什么不合并：状态机规则顺序即优先级，两家规则并起来得到的不是"两家之和"而是
 * 谁也说不清的第三份判据。为什么不排序不投票：与 `ui.editor.languageService` 同一口径
 * ——槽按注册顺序交回，消费者逐家问。
 */
function surfaceEntries(): readonly SurfaceEntry[] {
  const source = surfaceSource;
  if (source === null) return [];
  let contributions: readonly MonacoLanguageContribution[];
  try {
    contributions = source();
  } catch (e: unknown) {
    console.warn(`[monaco-language-surface] 语言面来源抛错，按"没有供方"处理：${errorText(e)}`);
    return [];
  }
  const out: SurfaceEntry[] = [];
  const seen = new Set<string>();
  for (const contribution of contributions ?? []) {
    const surface = contribution?.surface;
    if (!surface || typeof surface.languageId !== 'string' || surface.languageId === '') {
      console.error(
        `[monaco-language-surface] 贡献 '${contribution?.id}' 没有给出 languageId，已跳过（判据不许猜）`,
      );
      continue;
    }
    if (!surface.monarch && !surface.configuration && !surface.themes) {
      console.error(
        `[monaco-language-surface] 贡献 '${contribution.id}' 三副面全空（词法 / 配置 / 主题），已跳过——空对象不是语言面`,
      );
      continue;
    }
    if (seen.has(surface.languageId)) {
      console.error(
        `[monaco-language-surface] 语言「${surface.languageId}」有第二枚语言面贡献（'${contribution.id}'），后者被忽略：规则顺序即优先级，合并等于造第三份判据`,
      );
      continue;
    }
    seen.add(surface.languageId);
    out.push({ contributionId: contribution.id, surface });
  }
  return out;
}

/** 槽里全部语言面（按 languageId 第一家胜；顺序 = 槽注册顺序） */
export function monacoLanguageSurfaces(): readonly MonacoLanguageSurface[] {
  return surfaceEntries().map((entry) => entry.surface);
}

/** 这门语言此刻有没有供方（状态读数与测试反查） */
export function hasMonacoLanguageSurface(languageId: string): boolean {
  return surfaceEntries().some((entry) => entry.surface.languageId === languageId);
}

/* ============================== Monarch 翻译 ============================== */

const MONARCH_ACTION_KEYS = new Set(['token', 'next', 'cases']);
const MONARCH_ROOT_KEYS = new Set(['ignoreCase', 'defaultToken', 'tokenizer', 'wordLists']);

function warnShape(contribution: string, message: string): void {
  console.warn(
    `[monaco-language-surface] 贡献 '${contribution}' 的语言面有一处不合形状，已跳过那一条：${message}`,
  );
}

/**
 * 契约动作 → Monaco 动作。三形态（字符串 / `{token,next,cases}` / 动作数组）逐字同构，
 * 这里只剔未知键、校验类型，不改语义、不补默认值。
 */
function toMonacoAction(action: unknown, label: string): unknown {
  if (typeof action === 'string') return action;
  if (Array.isArray(action)) return action.map((item) => toMonacoAction(item, label));
  if (action && typeof action === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(action as Record<string, unknown>)) {
      if (!MONARCH_ACTION_KEYS.has(key)) {
        warnShape(label, `动作里不认识的键「${key}」`);
        continue;
      }
      out[key] = key === 'cases' ? toMonacoCases(value, label) : value;
    }
    return out;
  }
  warnShape(label, `动作既不是字符串、对象也不是数组（${String(action)}）`);
  return '';
}

function toMonacoCases(cases: unknown, label: string): Record<string, unknown> {
  if (!cases || typeof cases !== 'object' || Array.isArray(cases)) {
    warnShape(label, '`cases` 不是字符串键的字典');
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [guard, action] of Object.entries(cases as Record<string, unknown>)) {
    out[guard] = toMonacoAction(action, label);
  }
  return out;
}

/**
 * 契约 Monarch → `monaco.languages.IMonarchLanguage`。
 *
 * `wordLists` 被铺到 monarch 对象**根部**：Monarch 的 `@declWords` 这类 cases 卫兵就从根部
 * 属性取，这是 Monaco 的机制，不是本仓的发明。根部未知键只 warn 不丢（供方将来要加
 * `brackets` 之类的合法字段时，先扩契约与这张键表，别在这里静默放行）。
 */
export function toMonacoMonarch(
  data: MonacoMonarchData,
  label: string,
): Monaco.languages.IMonarchLanguage {
  const monarch: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    if (!MONARCH_ROOT_KEYS.has(key)) warnShape(label, `Monarch 根部不认识的键「${key}」`);
  }
  if (data.ignoreCase !== undefined) monarch.ignoreCase = data.ignoreCase;
  if (data.defaultToken !== undefined) monarch.defaultToken = data.defaultToken;
  for (const [name, words] of Object.entries(data.wordLists ?? {})) {
    monarch[name] = [...words];
  }
  const tokenizer: Record<string, unknown[]> = {};
  for (const [state, rules] of Object.entries(data.tokenizer ?? {})) {
    const mapped: unknown[] = [];
    for (const rule of rules ?? []) {
      if (!Array.isArray(rule) || rule.length !== 2) {
        warnShape(label, `状态「${state}」里有一条不是 [模式, 动作] 的规则`);
        continue;
      }
      const [pattern, action] = rule as [unknown, unknown];
      if (typeof pattern !== 'string' && !(pattern instanceof RegExp)) {
        warnShape(label, `状态「${state}」里有一条模式既不是正则也不是字符串`);
        continue;
      }
      mapped.push([pattern, toMonacoAction(action, label)]);
    }
    tokenizer[state] = mapped;
  }
  monarch.tokenizer = tokenizer;
  return monarch as unknown as Monaco.languages.IMonarchLanguage;
}

/* ============================== 语言配置翻译 ============================== */

/**
 * 契约档位名 → `monaco.languages.IndentAction` 的成员名。
 *
 * 四档就是那张枚举的全部（`None / Indent / IndentOutdent / Outdent`）。这里刻意不写数字：
 * `indentAction: 1` 那种写法把枚举值抄进了语言面，换一版 Monaco 就可能对不上，
 * 而屏上的表现是"回车少缩一级"——没人会去查契约。
 */
const INDENT_ACTION_MEMBER: Readonly<Record<string, string>> = {
  none: 'None',
  indent: 'Indent',
  indentOutdent: 'IndentOutdent',
  outdent: 'Outdent',
};

function indentActionOf(
  monaco: typeof Monaco,
  tier: string,
  label: string,
): Monaco.languages.IndentAction | undefined {
  const member = INDENT_ACTION_MEMBER[tier];
  const table = monaco.languages
    .IndentAction as unknown as Record<string, Monaco.languages.IndentAction>;
  const hit = member === undefined ? undefined : table[member];
  if (hit === undefined) {
    warnShape(label, `onEnterRules 里不认识的缩进档位「${tier}」`);
    return undefined;
  }
  return hit;
}

/**
 * 契约 `onEnterRules` → Monaco `onEnterRules`（导出给宿主的第二条腿）。
 *
 * 除了槽落点自己用，`kojo2-enter.ts` 也用它——`kojo2-indent.ts` 的打字合并层要拿 Monaco 形状的
 * 两格，而"档位名 → 枚举成员"这张表只许有一份（抄第二份的地方就是错的那份）。
 */
export function toMonacoOnEnterRules(
  monaco: typeof Monaco,
  rules: readonly MonacoOnEnterRule[] | undefined,
  label: string,
): Monaco.languages.OnEnterRule[] | undefined {
  if (rules === undefined) return undefined;
  const out: Monaco.languages.OnEnterRule[] = [];
  for (const rule of rules) {
    const tier = rule?.action?.indentAction ?? '';
    const action = indentActionOf(monaco, tier, label);
    if (action === undefined) continue;
    // `beforeText` 是 Monaco 的必填格：没有它这条规则无从命中（契约因此也标必填）。
    // 运行期仍查一次——供方是第三方时，形状不合的那一条要说出来再丢，不能让整副配置报废。
    if (!(rule.beforeText instanceof RegExp)) {
      warnShape(label, 'onEnterRules 里有一条缺 `beforeText`（Monaco 无法命中）');
      continue;
    }
    const enterRule: Monaco.languages.OnEnterRule = {
      beforeText: rule.beforeText,
      action: {
        indentAction: action,
        ...(rule.action.removeText !== undefined ? { removeText: rule.action.removeText } : {}),
      },
    };
    if (rule.afterText) enterRule.afterText = rule.afterText;
    if (rule.previousLineText) enterRule.previousLineText = rule.previousLineText;
    out.push(enterRule);
  }
  return out;
}

/**
 * 契约配置 → `monaco.languages.LanguageConfiguration`。
 *
 * `wordPattern` 缺省时补宿主那一份 CJK 判据（编辑器 chrome，见文件头）；供方写了就以它为准。
 * `blockComment` 从契约的只读两元组摊成 Monaco 的可写两元组（同一对字符，不是第二份数据）。
 */
export function toMonacoLanguageConfiguration(
  monaco: typeof Monaco,
  data: MonacoLanguageConfigurationData,
  label: string,
): Monaco.languages.LanguageConfiguration {
  const config: Monaco.languages.LanguageConfiguration = {
    wordPattern: data.wordPattern ?? CJK_WORD_PATTERN,
  };
  if (data.comments) {
    const comments: NonNullable<Monaco.languages.LanguageConfiguration['comments']> = {};
    if (data.comments.lineComment !== undefined) comments.lineComment = data.comments.lineComment;
    const block = data.comments.blockComment;
    if (block) comments.blockComment = [block[0], block[1]];
    config.comments = comments;
  }
  if (data.brackets) {
    config.brackets = data.brackets.map(([open, close]) => [open, close] as [string, string]);
  }
  if (data.autoClosingPairs) {
    config.autoClosingPairs = data.autoClosingPairs.map((pair) => ({
      open: pair.open,
      close: pair.close,
      ...(pair.notIn ? { notIn: [...pair.notIn] } : {}),
    }));
  }
  if (data.surroundingPairs) {
    config.surroundingPairs = data.surroundingPairs.map(({ open, close }) => ({ open, close }));
  }
  const onEnterRules = toMonacoOnEnterRules(monaco, data.onEnterRules, label);
  if (onEnterRules) config.onEnterRules = onEnterRules;
  if (data.indentationRules) config.indentationRules = { ...data.indentationRules };
  return config;
}

/* ============================== 主题翻译 ============================== */

/** 宿主侧的部件色三套（键集相同、值各一套；`theme-color-gates` 量的就是这批） */
const COMPONENT_PALETTES: Readonly<
  Record<MonacoComponentPaletteSide, Readonly<Record<string, string>>>
> = {
  dark: KOJO_DARK_COLORS,
  light: KOJO_LIGHT_COLORS,
  mint: KOJO_MINT_COLORS,
};

/** 某侧部件色的键表（主题"部件面"的键集合真源只在这三张表里；供方要自带色时以它为准） */
export function componentColorKeysFor(side: MonacoComponentPaletteSide): readonly string[] {
  const palette = COMPONENT_PALETTES[side];
  if (!palette) throw new Error(`[monaco-language-surface] 宿主没有登记名为「${side}」的部件色侧`);
  return Object.keys(palette);
}

/**
 * 供方主题 → Monaco 主题字面量（**顶层数组拷贝 + 逐键校验**）。
 *
 * 拷贝只发生在**容器**上：Monaco 的 `colors` 与 `rules` 是可写记录，不把供方那张只读表本体
 * 交给它；但 `rules` 的**每一格沿用供方对象**——"暗色角色调色板只有一份"这条不变量
 * （`semantic-roles.test.ts` 逐档比对 v1 与 2.0 的规则对象）不能被装配层改成"值相等、对象两份"。
 * 校验：前景色与部件色都必须 6/8 位十六进制——少配 / 配错当场抛，不静默掉色
 * （与供方 `monaco-theme.ts` 的加载期纪律同一半，这里管装配那一半）。
 */
export function materializeMonacoTheme(
  theme: MonacoThemeContributionData,
): Monaco.editor.IStandaloneThemeData {
  const rules = (theme.rules ?? []).map((rule) => {
    if (typeof rule?.token !== 'string' || rule.token === '') {
      throw new Error(`[monaco-language-surface] 主题「${theme.id}」里有一条规则没有 token`);
    }
    if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(rule.foreground ?? '')) {
      throw new Error(
        `[monaco-language-surface] 主题「${theme.id}」的角色「${rule.token}」没有合法前景色`,
      );
    }
    if (rule.fontStyle !== undefined && !/^(bold|italic)?$/.test(rule.fontStyle)) {
      throw new Error(
        `[monaco-language-surface] 主题「${theme.id}」的角色「${rule.token}」的 fontStyle「${rule.fontStyle}」不受支持`,
      );
    }
    return rule as Monaco.editor.ITokenThemeRule;
  });
  const side = theme.componentPalette ?? 'dark';
  const source = theme.colors ?? COMPONENT_PALETTES[side];
  if (!source) {
    throw new Error(
      `[monaco-language-surface] 主题「${theme.id}」的部件色侧「${side}」在宿主没有登记`,
    );
  }
  const colors: Record<string, string> = {};
  for (const key of Object.keys(source)) {
    const value = (source as Record<string, string>)[key]!;
    if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
      throw new Error(
        `[monaco-language-surface] 主题「${theme.id}」的部件色「${key}」不是合法十六进制色：${value}`,
      );
    }
    colors[key] = value;
  }
  return { base: theme.base, inherit: theme.inherit, rules, colors };
}

/* ============================== 落地 ============================== */

/** 已落过 / 已说过 warn 的 (实例, 键) 台账——WeakMap 不拖住 Monaco 实例 */
const applied = new WeakMap<object, Set<string>>();
/** 已定义过供方主题的实例 */
const themedInstances = new WeakSet<object>();

function ledgerOf(monaco: typeof Monaco): Set<string> {
  const key = monaco as unknown as object;
  let set = applied.get(key);
  if (set === undefined) {
    set = new Set<string>();
    applied.set(key, set);
  }
  return set;
}

/**
 * 把一门语言的语言面落进 Monaco（词法 + 配置两副）。返回是否真的落了东西。
 *
 * `absentIsVisible`：这门语言刚被 descriptor 认领却没有供方 ⇒ 说一条 warn
 * （契约头注写死的退化形态：语言仍认领、面不存在、必须说出来）。
 */
export function applyMonacoLanguageSurface(
  monaco: typeof Monaco,
  languageId: string,
  options?: { readonly absentIsVisible?: boolean },
): boolean {
  const ledger = ledgerOf(monaco);
  const entry = surfaceEntries().find((item) => item.surface.languageId === languageId);
  if (!entry) {
    const key = `absent:${languageId}`;
    if (options?.absentIsVisible === true && !ledger.has(key)) {
      ledger.add(key);
      console.warn(
        `[monaco-language-surface] 「${languageId}」没有语言面供方（插件未激活）：文件可打开、语言 id 正确，但没有语法着色与缩进规则`,
      );
    }
    return false;
  }
  const { surface, contributionId: label } = entry;
  let did = false;
  const monarchKey = `${languageId}:monarch`;
  if (surface.monarch && !ledger.has(monarchKey)) {
    monaco.languages.setMonarchTokensProvider(languageId, toMonacoMonarch(surface.monarch, label));
    ledger.add(monarchKey);
    did = true;
  }
  const configKey = `${languageId}:config`;
  if (surface.configuration && !ledger.has(configKey)) {
    monaco.languages.setLanguageConfiguration(
      languageId,
      toMonacoLanguageConfiguration(monaco, surface.configuration, label),
    );
    ledger.add(configKey);
    did = true;
  }
  return did;
}

/** 全表扫一遍：把晚激活的供方补上（每次 EditorPane 挂载调一次，幂等） */
export function applyAllMonacoLanguageSurfaces(monaco: typeof Monaco): void {
  const registered = new Set(monaco.languages.getLanguages().map((language) => language.id));
  for (const surface of monacoLanguageSurfaces()) {
    if (!registered.has(surface.languageId)) continue;
    applyMonacoLanguageSurface(monaco, surface.languageId);
  }
}

/**
 * 定义全部供方主题（**幂等**：同一 Monaco 实例真铺过一轮之后不再铺）。
 *
 * 调用时机由宿主决定（`theme.ts` 末尾那一段：切流阶段闸开着才定义 `kojo2-*` 三套），
 * 本模块不读开关——阶段是产品决策，不是语言事实（同 `LARGE_FILE_LINES` 那条分工）。
 * 返回这一轮是否真的定义了东西（`false` = 已铺过或这一轮没有供方）。
 * **空供方不算"铺过"**：晚到的供方下一轮仍能补上（与 monarch / config 的逐键台账同口径）。
 *
 * `absentIsVisible`：确实**一枚供方都没有**（不是"这一轮已经铺过"）时说一条 warn——
 * 主题名没定义 = 设置页选了 `kojo2-*` 会回落，这条必须看得见；同一台账保证只说一次。
 */
export function applyAllMonacoLanguageThemes(
  monaco: typeof Monaco,
  options?: { readonly absentIsVisible?: boolean },
): boolean {
  const instance = monaco as unknown as object;
  if (themedInstances.has(instance)) return false;
  let defined = 0;
  for (const surface of monacoLanguageSurfaces()) {
    for (const theme of surface.themes ?? []) {
      monaco.editor.defineTheme(theme.id, materializeMonacoTheme(theme));
      defined += 1;
    }
  }
  if (defined === 0 && options?.absentIsVisible === true) {
    const key = 'absent:themes';
    const ledger = ledgerOf(monaco);
    if (!ledger.has(key)) {
      ledger.add(key);
      console.warn(
        '[monaco-language-surface] 没有语言面供方（插件未激活）：供方主题未定义，选了那一套会回落基底主题',
      );
    }
  }
  // 只有真铺过才记账：空供方那一轮若也记进 WeakSet，晚到的供方就永远补不上
  // （monarch / config 走逐键台账、可晚补，主题必须同一口径）。
  if (defined > 0) themedInstances.add(instance);
  return defined > 0;
}

/** 装配自检：此刻有哪几门语言交出了语言面（状态读数与测试反查用） */
export function monacoLanguageSurfaceInventory(): readonly string[] {
  return monacoLanguageSurfaces().map((surface) => surface.languageId);
}
