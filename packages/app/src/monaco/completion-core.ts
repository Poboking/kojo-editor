import type * as Monaco from './entry';
import { errorText } from '@kojo/plugin-api';
import type {
  KojoCallProtocol,
  KojoCallSlot,
  KojoCounterTable,
  KojoFaceTable,
  KojoInstructionTable,
  KojoLibraryTable,
  VariableInfo,
  VariableSchema,
} from '@kojo/plugin-api';
import type { DictionaryLookup } from '@kojo/plugin-kojo-sugar';
import { pinyinKeysOf } from './pinyin';
import { describeCallSignature, slotParameterLabel } from './kojo-signature';

/**
 * COMPL-SHARED · 补全的**共享装配核**（`.kojo` 与 `.erb` 唯一的装配实现）。
 *
 * ## 为什么必须有这一份
 *
 * 此前两语言各抄一套同构代码：`mergeSuggestions` / `provenance` 反查 / snippet 化 / 去重 /
 * 排序各两份，两份的**唯一差异是候选源集合与位置判定**——而差异正是该留在语言侧的部分。
 * 本文件只收**与语言无关**的六件事：
 *
 * 1. **候选源协议**（`CompletionSource` / `CompletionSourceContext` / 统一的 `CompletionTables`）；
 * 2. **合并**：依次问各 source，按 label 去重（先注册者胜）；
 * 3. **排序**：`前缀精确 > 前缀命中 > 子序列 > 拼音首字母 > 全拚 > 其它`，同档沿用
 *    source 自带 `sortText`，label 兜底（模糊族三档 = P2-12 新增，判据见 {@link rankKey}）；
 * 4. **上限**：装配级截断（`MAX_ASSEMBLED_SUGGESTIONS`），截断可见（一行 warn，一轮装配只报一次）；
 * 5. **降级**：`requires` 依赖缺席 / source 抛错 ⇒ 跳过该源 + 一次可见信号；装配点自身抛错
 *    （位置判定 / 取表）⇒ 本轮空候选 + 一次可见信号，**绝不让 Monaco 静默吞掉整条补全链**；
 * 6. **二段式供给**：`provenance` 反查（对象身份）+ `resolveCompletionItem` 详情合并 +
 *    **调用形态候选 → snippet**（含区间右邻字符判"作者已写左括号"）。
 *
 * 语言侧（`kojo-completion.ts` / `erb-completion.ts`）只提供三样东西：
 * **候选源集合**、**位置判定**（{@link CompletionAssembly.locate}）、**回表口径**
 * （{@link CompletionAssembly.resolveDetail} + 调用形态策略）。装配分支只有一条。
 *
 * ## 跨语言候选
 *
 * 候选源集合按语言分册，但**表是同一份**（{@link CompletionTables}）：项目函数名
 * （`erbFunctionNames`，宿主按 `ErbIndex.fingerprint` 记忆化后注入）两册都消费 ⇒ `.kojo` 里
 * 写 `调用` 也能补到剧本函数名。
 *
 * ## 跨装配路由（additive）
 *
 * `.kojo` 是超集：同一份文档里既有糖行也有原生 ERB 直通（规范 §3.10）。原生行需要 ERB 册
 * 的全部候选源与位置门，而**不**需要任何糖源。解法不是把两册源合并（那样糖位会混进
 * `erb-*` 噪声、位置门也会互相打架），而是 {@link CompletionAssembly.route}：装配点在本轮
 * `locate` **之前**问一次根装配"这一位该交给谁"，拿到被路由装配后就**原样复用**同一条
 * provider 管线（同一个 `mergeSuggestions` / provenance / 降级去重 / snippet / resolve），
 * 只把 `locate` / `sources` / `callForm` / 日志前缀换成被路由装配的那一份。
 * 路由只走**一跳**（不递归）：被路由装配自己的 `route` 不再被追问——两册语言不会互指。
 * provenance 记下产出该候选的装配（{@link CompletionProvenance.assembly}），
 * `resolveCompletionItem` 按它分派回表口径（`erb-*` 候选归 ERB resolver）。
 *
 * ## 分层纪律
 *
 * 本文件零语言名词、零游戏名词、零词表：`ERB` / `kojo` 只出现在文档与类型名里。
 * 纯逻辑与 Monaco 绑定分离：`mergeSuggestions` / 详情构造 / snippet 判定都可不经 provider 单测。
 */

/* ============================== 表（两语言共用同一份） ============================== */

/**
 * 补全消费的**唯一一张表**（`.kojo` 与 `.erb` 两个 seam 共用；语言侧文件保留各自的历史类型名
 * 作为别名，宿主 `EditorPane` 的表构造零改动即可同时满足两侧）。
 *
 * 纪律（缺一即该路**零候选 + 一次可见降级信号**，绝不猜）：
 * - `dictionary` / `variableSchema` / `faceTable` / `instructionTable` / `libraryTable` /
 *   `callProtocol` 全部来自**当前项目 adapter 贡献**，运行时现取；
 * - `erbFunctionNames` 是**项目索引派生**（非 adapter 表）：项目内全部函数名（已排序）的提供者；
 * - `kojoDeclarations` 是**解析器通道**的注入位：`.kojo` 的 `别名` / `常量` 声明名一律经它取，
 *   宿主不注入时由本层懒建一枚只解析服务实例顶上（**同一个 parser，不留第二判据**）。
 */
export interface CompletionTables {
  /** 变量字典（`makeLookup(adapter.variableSchema)` 产物）；缺席 = 不做变量反查 */
  readonly dictionary?: DictionaryLookup;
  /** 适配器变量 schema 本体（枚举名字用 `VariableSchema.names`）；缺席 = 不做变量补全 */
  readonly variableSchema?: VariableSchema;
  /** 时机分野模板表（adapter `kojoFaceTemplates`）；缺席 = 不做分野补全 */
  readonly faceTable?: KojoFaceTable;
  /** 指令名表（adapter `kojoInstructionTable`）；缺席 = 不做指令名补全 */
  readonly instructionTable?: KojoInstructionTable;
  /**
   * 计数器值域表（adapter `kojoCounterTable`）；缺席 = 不做计数器名补全。
   *
   * `时机 计数器 <中文名>：` 的编号槽与指令名槽**同一落点、不同表**（按面的
   * `indexKind` 分流，见 `index-slot` 契约）；两张表各自是独立 source 的 `requires` 键。
   */
  readonly counterTable?: KojoCounterTable;
  /** 基础库函数名表（adapter `kojoLibraryTable`）；缺席 = 不做库函数名补全 */
  readonly libraryTable?: KojoLibraryTable;
  /**
   * 调用协议表（adapter `kojoCallProtocol`）。
   *
   * 只服务两件事：①`resolve` 阶段给函数类候选补**调用签名**详情；②把**调用形态**候选
   * （`insertText` 恰为 `名字(`）插成带 tabstop 的 snippet。缺席 / 不认这个函数 ⇒ 无签名、
   * 无片段（退化纯文本，**不猜形参**）。
   */
  readonly callProtocol?: KojoCallProtocol;
  /**
   * 项目内**全部函数名**（已排序）的提供者（宿主按 `ErbIndex.fingerprint` 记忆化后注入）。
   * 两语言共用：`.erb` 的 `@名字` / `CALL 名字` 位与 `.kojo` 的 `函数 名字` / `调用 名字` 位
   * 都从这里取名字。缺席 / 索引未构建 / 提供者抛错 ⇒ 空数组（**零候选**，不猜）。
   */
  readonly erbFunctionNames?: () => readonly string[];
  /**
   * 当前 ERB 文件的**解析事实通道**（宿主注入；缺席 ⇒ 相关来源零候选 / 回退）。
   * `path` 一律传 model 的 fsPath（路径归一责任在宿主；语义见 {@link ErbFileFactsProvider}）。
   */
  readonly erbFileFacts?: ErbFileFactsProvider;
  /**
   * `.kojo` 文件级声明名（`别名` / `常量`）的**解析器通道**注入位。
   * 宿主可注入内核里那一枚 `sugar.transpile` 服务；未注入时由 `kojo-completion-declarations.ts`
   * 用同一个 `createSugarTranspileService` 懒建一枚只解析实例顶上（纯函数、零 IO）——
   * **绝不在编辑器侧写第二份别名正则**。
   */
  readonly kojoDeclarations?: CompletionDeclarationScanner;
  /**
   * 「文档词补全」开关（宿主注入 `loadWordBasedSuggestionsPref`；每次补全现取）。
   * 缺席 = 不供词（测试桩 / 没接线）；`true` 才让两册的 `*-words` 源出货。
   * 注意：这是**候选源开关**，不是 Monaco 的 `editor.wordBasedSuggestions`（那一项恒 off，
   * 内建词 provider 绕不过台词 / 旁白门）。
   */
  readonly wordBasedSuggestions?: () => boolean;
}

/**
 * 当前 `.erb` 文件**解析事实**的提供者（宿主注入：内核索引 / 解析服务在手；本层零 IO、不猜）。
 *
 * 语义纪律（`undefined` 与 `[]` **严格分家**，消费方不得揉成一态）：
 * - `undefined` = **未索引 / 取不到** ⇒ 调用方自行回退（全文口径或零候选），不猜；
 * - `[]` = **已索引但确无该项** ⇒ 该路零候选（**不回退**——回退只会拿出与索引不一致的假事实）。
 *
 * `path` 由调用方传 model 的 fsPath 原文；归一（大小写 / 分隔符 / 工作区相对化）是
 * **宿主注入侧**的唯一责任，装配核零路径知识、不做任何规整。
 */
export interface ErbFileFactsProvider {
  /** 当前文件的 `#DIM*` 声明名；未索引 / 取不到 ⇒ `undefined`（不猜）。 */
  dimsOf(path: string): readonly string[] | undefined;
  /** 光标行所属函数内的 `$` 标签名；当前文件未索引 ⇒ `undefined`（调用方自行回退）。 */
  labelsAt(path: string, line: number): readonly string[] | undefined;
}

/** 一条文件级声明的类别（`别名` / `常量`；判别口径与契约 `AliasDecl` / `ConstDecl` 同族） */
export type CompletionDeclarationKind = 'alias' | 'const';

/** 一条文件级声明名（`.kojo` 头部 `别名 X = …` / `常量 X = 5` 的 `X`） */
export interface CompletionDeclaration {
  readonly name: string;
  readonly kind: CompletionDeclarationKind;
}

/**
 * 文件级声明名扫描器（**解析器通道**的形状）：整篇 `.kojo` 文本 + 文件路径 → 声明名。
 * 判据必须来自 `sugar.transpile` 的 `parse`（同一个 parser、同一套注释 / 字符串 / 全角折叠口径），
 * 不许在编辑器侧再写一份正则。
 */
export type CompletionDeclarationScanner = (text: string, filePath: string) => readonly CompletionDeclaration[];

/* ============================== 候选源（扩展点） ============================== */

/** 一次补全请求的上下文（`range` = 替换区间，由装配点按当前词算出，各 source 共用） */
export interface CompletionSourceContext {
  readonly monaco: typeof Monaco;
  readonly model: Monaco.editor.ITextModel;
  readonly position: Monaco.Position;
  readonly range: Monaco.IRange;
  readonly tables: CompletionTables;
}

/** 一个补全候选来源（**扩展点**：各语言把自己的 source 数组追加一项即可） */
export interface CompletionSource {
  readonly id: string;
  /**
   * 该来源依赖的**表键**（可选声明；旧来源不写 = 无依赖）。
   *
   * `mergeSuggestions` 发现该键在当次 `tables` 中**缺席**（`undefined` / `null`；对
   * `erbFunctionNames` 这类**函数值**键即「提供者缺席」）时，**跳过**该来源（零候选）
   * **并发出一次可见信号**（不静默）；该来源 `provide` 抛错同样按此键报一次降级
   * （**抛错即视为缺**）。信号经 `onDegrade` 回调 + 一行 `console.warn` 双通道，
   * 同一 `(来源 id, 缺键)` 在**一轮装配内只报一次**——"一轮" = 一次 `provideCompletionItems`
   * （去重表**每轮新建**，绝不做句柄级 / 模块级去重：那样首轮之后这条降级就永久无声）。
   */
  readonly requires?: keyof CompletionTables;
  provide(ctx: CompletionSourceContext): Monaco.languages.CompletionItem[];
}

/** 装配核**自身**（不是某个候选源）抛错的阶段：位置判定 / 取表 / 合并 / snippet 化 */
export type CompletionAssemblyStage = 'route' | 'locate' | 'getTables' | 'merge' | 'snippet';

/** 装配级抛错的载荷（只在 `failure` 上出现；缺表降级恒不带 ⇒ 旧断言零改动） */
export interface CompletionAssemblyFailure {
  /** 抛错发生在装配的哪一步（不猜：由装配点当场记录，不是事后推断） */
  readonly stage: CompletionAssemblyStage;
  /** 错误原文（`Error.message`；非 `Error` 时 `String(e)`） */
  readonly error: string;
}

/**
 * 装配级抛错信号的 `sourceId`（与截断水位 `__cap__` 同族的下划线魔键：它不对应任何候选源，
 * 故不会与真实来源 id 相撞）。
 */
export const COMPLETION_ASSEMBLY_SOURCE_ID = '__assembly__';

/** 一次「补全降级」的可断言描述（缺表信号 / 装配级抛错信号两形态） */
export interface CompletionDegrade {
  /** 被跳过（或抛错）的来源 id；装配级抛错 = {@link COMPLETION_ASSEMBLY_SOURCE_ID} */
  readonly sourceId: string;
  /**
   * 未能满足的依赖：adapter 表键 / 提供者键（缺席或求值抛错）。
   *
   * **additive 改动**：装配级抛错没有"某个来源缺某张表"这件事 ⇒ 该字段缺席（`undefined`），
   * 改由 {@link CompletionDegrade.failure} 描述。旧形态（缺表信号）三字段照旧、值不变。
   */
  readonly missing?: keyof CompletionTables;
  /** 一句中文说明（含「缺席 / 抛错」「已跳过」「不猜」） */
  readonly reason: string;
  /** 装配级抛错（`route` / `locate` / `getTables` / `merge` / `snippet`）才带；缺表降级恒为 `undefined` */
  readonly failure?: CompletionAssemblyFailure;
}

/** 降级回调（`installCompletion` 注入；便于测试直接断言，不依赖真 Monaco） */
export type CompletionDegradeReporter = (degrade: CompletionDegrade) => void;

/* ============================== resolve 反查：候选身份 → 数据出处 ============================== */

/**
 * 一条候选的**出处**（provide 时登记、resolve 时按对象身份取回）。
 *
 * 为什么不往 `CompletionItem` 上挂自定义字段：Monaco 会把候选对象在 suggest 模型 / 渲染器 /
 * `resolve` 之间传来传去并按**公开协议**读写（`CompletionItem` 持 `this.completion = 我们返回的
 * 那个对象`），私有字段既进不了序列化、也会被下一轮 `Object.assign(this.completion, 解析结果)`
 * 搅在一起。`WeakMap` 以**对象身份**为键：provide 与 resolve 拿到的是同一个引用（standalone 无
 * 跨进程序列化，身份可靠），弹层销毁 ⇒ 键失去引用 ⇒ 元数据自动回收，**不产生无界增长**。
 */
export interface CompletionProvenance {
  /** 产出该候选的 source id（resolve 按它分派；不认识的 id ⇒ 不加详情） */
  readonly sourceId: string;
  /** 候选 label **原文**（= 回各张表的主键） */
  readonly label: string;
  /**
   * **本次 provide 拿到的表快照**（不在 resolve 时重跑 `getTables()`）：弹层存续期间项目若切换，
   * 详情必须与候选同源——两张表拼出来的"中文名"是假信息。
   */
  readonly tables: CompletionTables;
  /**
   * 产出该候选的装配（additive；跨装配路由时 = 被路由装配，缺省 = provider 的根装配）。
   * `resolveCompletionItem` 按它分派回表口径——`.kojo` 原生区的 `erb-*` 候选必须回 ERB resolver，
   * 而糖位候选回糖册。`sourceId` 原样保留（诊断与既有断言零改动）。
   */
  readonly assembly?: CompletionAssembly;
}

/** 候选身份 → 出处 的登记表（每次装配一枚，随句柄创建 / 回收） */
export interface CompletionProvenanceStore {
  register(item: Monaco.languages.CompletionItem, provenance: CompletionProvenance): void;
  lookup(item: Monaco.languages.CompletionItem): CompletionProvenance | undefined;
}

/** 建一枚 `WeakMap` 反查表（纯结构、可单测；两语言共用同一实现） */
export function createCompletionProvenanceStore(): CompletionProvenanceStore {
  const byItem = new WeakMap<object, CompletionProvenance>();
  // 候选按契约是对象，仍经 `unknown` 守一道：外部追加的 source 不受我们的类型管，
  // 而 `WeakMap` 对非对象键会抛——宁可静默不登记，也不让补全链崩。
  const keyOf = (item: Monaco.languages.CompletionItem): object | undefined => {
    const value: unknown = item;
    return typeof value === 'object' && value !== null ? value : undefined;
  };
  return {
    register(item, provenance) {
      const key = keyOf(item);
      if (key !== undefined) byItem.set(key, provenance);
    },
    lookup(item) {
      const key = keyOf(item);
      return key === undefined ? undefined : byItem.get(key);
    },
  };
}

/** `resolve` 阶段的懒填充产物（只动 Monaco 认的 `detail` / `documentation`，其余零污染） */
export interface CompletionResolution {
  readonly detail?: string;
  readonly documentation?: { readonly value: string };
}

/* ============================== 合并 / 去重 / 排序 / 上限 ============================== */

/** 装配级候选上限（单源的护栏另有其数：见 `projectFunctionCandidates`） */
export const MAX_ASSEMBLED_SUGGESTIONS = 1000;

/** 候选 label 的两种形态（`string` 与 `{label}`）归一为原文 */
export function labelText(label: Monaco.languages.CompletionItem['label']): string {
  return typeof label === 'string' ? label : label.label;
}

/**
 * 排名键（P2-12 起含**模糊族三档**；硬判据次序，改前必红）：
 *
 * `前缀精确`（label === 已输入词）> `前缀命中`（label 以已输入词开头）>
 * `子序列`（已输入词是 label **原文**的字符子序列，大小写不敏感）>
 * `拼音首字母`（是**首字母串**的子序列）>
 * `全拚`（是**全拼串**的子序列，可跨字边界）>
 * `其它`；同档内沿用各 source 自带的 `sortText`（保留其分组次序），再以 label 兜底。
 *
 * 档位键形 `0|` / `1|` / `2a|` / `2b|` / `2c|` / `2|`：ASCII `a`(0x61) < `|`(0x7C) ⇒
 * 字符串比较下三档模糊恰好夹在「前缀命中」与「其它」之间；**既有三档键形逐字不变**
 * （`2a|` 不匹配 `/^2\|/`，旧断言零回归）。
 *
 * 三档必须分别锚在不同串上（**坍缩论证**）：首字母串恒为全拼串的子序列 ⇒ 若「首字母」
 * 与「全拚」两档都做在全拼串上，先判先得，「拼音首字母」档永不可能触发。
 */
export function rankKey(item: Monaco.languages.CompletionItem, prefix: string): string {
  const label = labelText(item.label);
  const base = item.sortText ?? '';
  // 空前缀：整表平铺（旧键形逐字不变：`2|<sortText>|<label>`）
  if (prefix.length === 0) return `2|${base}|${label}`;
  if (label === prefix) return `0|${base}|${label}`;
  if (label.startsWith(prefix)) return `1|${base}|${label}`;
  const tier = fuzzyTier(label, prefix);
  return tier === undefined ? `2|${base}|${label}` : `2${tier}|${base}|${label}`;
}

/** 模糊族三档的档位字母（判定次序即优先级：原文子序列 > 拼音首字母 > 全拚） */
type FuzzyTier = 'a' | 'b' | 'c';

/** `needle` 是否为 `haystack` 的字符子序列（大小写归一由调用方负责） */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  const n = needle.length;
  for (const ch of haystack) {
    if (i < n && ch === needle[i]) {
      i += 1;
      if (i === n) return true;
    }
  }
  return false;
}

/**
 * 模糊族档位（**纯函数**；`undefined` = 落「其它」档）。空前缀由调用方提前分流。
 *
 * 三档的锚串刻意不同（坍缩论证见 {@link rankKey} 头注）：a 锚 label 原文、b 锚拼音
 * 首字母串、c 锚全拼串。纯 ASCII 标签（无拼音键）只可能进 a 档（子序列原文匹配）。
 */
function fuzzyTier(label: string, prefix: string): FuzzyTier | undefined {
  const lower = prefix.toLowerCase();
  if (isSubsequence(lower, label.toLowerCase())) return 'a';
  const keys = pinyinKeysOf(label);
  if (keys === undefined) return undefined;
  if (isSubsequence(lower, keys.initials)) return 'b';
  if (isSubsequence(lower, keys.full)) return 'c';
  return undefined;
}

/**
 * **一轮装配**内共享的"已报"去重表 + 日志前缀（`[kojo-completion]` / `[erb-completion]`）。
 *
 * `reported` 由**调用方**持有并每轮新建（形状不动：装配点是唯一生产调用方，测试可自带一枚）。
 */
export interface CompletionMergeOptions {
  readonly reported: Set<string>;
  readonly tag: string;
  readonly onDegrade?: CompletionDegradeReporter;
  /**
   * 位置门的候选过滤器（**过滤**不是重排：各 source 的既有排序语义不动）。
   * 第二参 = 产出该候选的 `source.id`（additive：名字槽这类"同 kind 不同源"的候选按来源 id
   * 收口；**少参谓词天然兼容**——既有单参消费方零改动）。
   */
  readonly keep?: (item: Monaco.languages.CompletionItem, sourceId: string) => boolean;
  readonly provenance?: CompletionProvenanceStore;
  /**
   * 本轮实际出货的装配（additive；跨装配路由时 = 被路由装配）。只做一件事：登记进每条候选的
   * {@link CompletionProvenance.assembly}，让 resolve 分派到正确的回表口径。
   */
  readonly assembly?: CompletionAssembly;
  /** 装配级上限（缺省 {@link MAX_ASSEMBLED_SUGGESTIONS}；测试可放宽以验对拍） */
  readonly limit?: number;
}

/**
 * 报**一次**降级信号（同一 `(来源 id, 缺键)` 在**一轮装配**内只报一次；去重表由调用方按轮传入）。
 * 双通道：`onDegrade` 回调（可断言）+ 一行 `console.warn`（运行时可读）——**不静默**。
 */
function reportDegrade(opts: CompletionMergeOptions, sourceId: string, missing: keyof CompletionTables, detail: string): void {
  const dedupKey = `${sourceId}:${missing}`;
  if (opts.reported.has(dedupKey)) return;
  opts.reported.add(dedupKey);
  const reason = `来源 '${sourceId}' 依赖的适配器能力 '${missing}' ${detail}，已跳过该来源（不猜）`;
  console.warn(`${opts.tag} 降级：${reason}`);
  opts.onDegrade?.({ sourceId, missing, reason });
}

/** 某来源的 `requires` 依赖在当次 `tables` 中是否缺席（`undefined` / `null`）；缺席则返回该键 */
export function missingRequirement(
  source: CompletionSource,
  tables: CompletionTables,
): keyof CompletionTables | undefined {
  const key = source.requires;
  if (key === undefined) return undefined;
  const value = tables[key];
  return value === undefined || value === null ? key : undefined;
}

/**
 * 依次问各 source，按 label 去重（**先注册者胜**），再按排名键排序并写回 `sortText`，
 * 最后按上限截断（截断可见：一行 warn，一轮装配只报一次）。
 *
 * 身份陷阱（两语言此前各自踩过、现在只有一份实现）：登记 `provenance` 必须对
 * **最终交出去的那个对象引用**做——`{...item, sortText}` 造的是新对象，登记原对象会让
 * resolve 的反查必然落空。
 */
export function mergeSuggestions(
  sources: readonly CompletionSource[],
  ctx: CompletionSourceContext,
  prefix: string,
  opts: CompletionMergeOptions,
): Monaco.languages.CompletionItem[] {
  const byLabel = new Map<string, { item: Monaco.languages.CompletionItem; sourceId: string }>();
  for (const source of sources) {
    // 依赖表缺席：跳过该来源（零候选）+ 发一次可见信号（不静默）
    const missing = missingRequirement(source, ctx.tables);
    if (missing !== undefined) {
      reportDegrade(opts, source.id, missing, '缺席');
      continue;
    }
    let items: Monaco.languages.CompletionItem[];
    try {
      items = source.provide(ctx);
    } catch (e: unknown) {
      // source 由外部追加：单个抛错不拖垮整条补全链（退化可见，其余 source 照常出候选）
      const msg = errorText(e);
      console.warn(`${opts.tag} source '${source.id}' provide 抛错：${msg}`);
      // 抛错即视为缺：带 `requires` 的来源按该键报一次降级
      if (source.requires !== undefined) reportDegrade(opts, source.id, source.requires, `求值抛错（${msg}）`);
      continue;
    }
    // 位置门在**去重前**逐 source 过滤：keyword 形态的候选不得占掉函数名候选的先注册位；
    // 谓词第二参 = 本 source 的 id（名字槽候选源白名单按来源 id 筛——同为 Function kind 的
    // 系统函数源与项目函数源靠 kind 分不开）
    const keep = opts.keep;
    if (keep !== undefined) items = items.filter((item) => keep(item, source.id));
    for (const item of items) {
      const label = labelText(item.label);
      if (!byLabel.has(label)) byLabel.set(label, { item, sourceId: source.id });
    }
  }
  const ranked = [...byLabel.values()]
    .map((entry) => ({ entry, key: rankKey(entry.item, prefix) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const limit = opts.limit ?? MAX_ASSEMBLED_SUGGESTIONS;
  const kept = ranked.slice(0, limit);
  if (kept.length < ranked.length && !opts.reported.has('__cap__')) {
    opts.reported.add('__cap__');
    console.warn(
      `${opts.tag} 候选 ${String(ranked.length)} 条超上限，截断为 ${String(limit)} 条（前缀精确与命中档优先，不静默丢弃水位）`,
    );
  }
  return kept.map(({ entry, key }) => {
    const final: Monaco.languages.CompletionItem = withPinyinFilterText({ ...entry.item, sortText: key });
    opts.provenance?.register(final, {
      sourceId: entry.sourceId,
      label: labelText(entry.item.label),
      tables: ctx.tables,
      ...(opts.assembly !== undefined ? { assembly: opts.assembly } : {}),
    });
    return final;
  });
}

/**
 * filterText 的**可检索键并集**补齐（P2-12 · SUGGEST-PINYIN-GAP）：把中文候选的拼音键补进
 * `filterText`，让 Monaco 的客户端过滤（`fuzzyScore` 不挂拼音词典）能用 ASCII 拼音命中中文候选。
 *
 * 口径（**并集，不是互斥放行**——SUGGEST-PINYIN-GAP 改的就是这一条）：
 * 1. **不覆盖 source 自带的匹配面 = 一个键都不丢，而不是原样放行**：
 *    - 无 `filterText`，或逐字等于 label 原文（全仓九源的主流写法）⇒ 补为
 *      `原文 全拼串 首字母串`，**原文留在首位** ⇒ 前缀匹配与匹配位次上色不破
 *      （非原文开头时高亮退化的代价，判据记在 `kojo-completion.ts` 的头注里）；**产出逐字同旧**，
 *      现有主流源的既有钉值断言零改动；
 *    - `filterText` 已存在且**不等于** label 原文（source 自定义了异于原文的键）⇒ **自带键仍居首位**
 *      （对原键输入的前缀打分与上色面不动），其后追加 `label 原文 全拼串 首字母串`
 *      ⇒ 原键 / 中文原文 / 罗马字三类输入都命中；旧口径"自定义键 = 不补拼音"会把拼音检索
 *      整段挡在这几路之外（作者用罗马字找中文函数名时搜不到它们），且中文原文输入也命不中
 *      （原键不含中文时候选直接被 `continue` 丢弃）——两条都是本次要销的账；
 * 2. **显示面仍是 `label` 原文**：本函数只写 `filterText`（匹配键），绝不碰 `label` / `insertText`
 *    （上屏与落盘面；插入用 `insertText ?? label`，与 filterText 无关）。
 *
 * 纯 ASCII 标签（{@link pinyinKeysOf} 返 `undefined`）⇒ 不补：无可拼音键，不造噪声
 * （此时 source 自带键原样保留）。拼音键锚在 label 上——label 纯 ASCII 而自带键是中文时，
 * 那枚中文键不自得拼音（今日全仓零路如此；`rankKey` 同样锚 label，两处口径一致）。
 */
function withPinyinFilterText(item: Monaco.languages.CompletionItem): Monaco.languages.CompletionItem {
  const label = labelText(item.label);
  const keys = pinyinKeysOf(label);
  if (keys === undefined) return item;
  const own = item.filterText;
  if (own === undefined || own === label) return { ...item, filterText: `${label} ${keys.full} ${keys.initials}` };
  return { ...item, filterText: `${own} ${label} ${keys.full} ${keys.initials}` };
}

/* ============================== 调用协议 → snippet / 签名 ============================== */

/** snippet 控制字符（`\` / `$` / `}`）转义——槽含义原文可能带它们 */
export function escapeSnippetText(text: string): string {
  return text.replace(/[\\$}]/g, (ch) => `\\${ch}`);
}

/**
 * 形参槽 → 带 tabstop 的调用片段（**纯函数**）。
 * `slots === undefined`（协议缺席 / 不认 / 抛错）⇒ `undefined` ⇒ 调用方保持纯文本（**不猜形参**）；
 * `slots` 为空数组是协议明确声明"无槽"这一**事实** ⇒ 给 `名字()`。
 */
export function buildCallSnippetText(
  name: string,
  slots: readonly KojoCallSlot[] | undefined,
): string | undefined {
  if (slots === undefined) return undefined;
  if (slots.length === 0) return `${name}()`;
  const stops = slots.map((slot, i) => {
    const placeholder = escapeSnippetText(slotParameterLabel(slot).replace(/\s+/g, ' ').trim());
    return `\${${String(i + 1)}:${placeholder}}`;
  });
  return `${name}(${stops.join(', ')})`;
}

/** 依次用这几个键回协议表取槽（命中仍来自表本身）；全不认 / 表缺席 ⇒ `undefined` */
export function slotsForCallee(
  protocol: KojoCallProtocol | undefined,
  keys: readonly (string | undefined)[],
  tag: string,
): readonly KojoCallSlot[] | undefined {
  if (protocol === undefined) return undefined;
  for (const key of keys) {
    if (key === undefined || key.length === 0) continue;
    try {
      const slots = protocol.slotsFor(key);
      // 空数组（协议声明"无槽"）是**命中**：`if (slots)` 只对 `null` / `undefined`（不认）落空
      if (slots) return slots;
    } catch (e: unknown) {
      console.warn(`${tag} 调用协议对 '${key}' 求槽抛错：${errorText(e)}`);
    }
  }
  return undefined;
}

/** 签名详情行（`调用签名 \`名字(ARG:0 含义)\``）；取不到槽 ⇒ `undefined`（不进文档，不猜） */
export function signatureLine(
  display: string,
  keys: readonly (string | undefined)[],
  protocol: KojoCallProtocol | undefined,
  tag: string,
): string | undefined {
  const slots = slotsForCallee(protocol, keys, tag);
  if (slots === undefined) return undefined;
  return `调用签名 \`${describeCallSignature(display, slots, 0).label}\``;
}

/**
 * 一条候选的**回表取键策略**：同一个 label 在表里可能有"表层名 / 原生名"两种命名面，
 * 取键顺序归语言侧（`.kojo` 先问原生名、`.erb` 只有原生名）。命中一律来自表本身，不是猜。
 */
export interface CompletionCallFormPolicy {
  /** 哪些 source 的候选是**调用形态**（`insertText` 恰为 `名字(`）⇒ 才允许改写成 snippet */
  readonly sourceIds: ReadonlySet<string>;
  /** 回调用协议表取槽的键序列（缺省 = 只用 label） */
  readonly keysFor?: (label: string, tables: CompletionTables) => readonly (string | undefined)[];
}

/** 候选区间的**归一形态**（`{insert,replace}` 双区间取 `replace`；缺席 ⇒ `undefined`） */
export function candidateRange(range: Monaco.languages.CompletionItem['range'] | undefined): Monaco.IRange | undefined {
  if (range === undefined) return undefined;
  return 'insert' in range ? range.replace : range;
}

/** 区间右端紧邻的字符（判"作者已自己写了左括号"）；入参是行文本而非 model ⇒ 整轮补全按行记忆化取一次 */
export function charAfterRange(lineText: string, range: Monaco.IRange | undefined): string | undefined {
  if (range === undefined) return undefined;
  const ch = lineText.slice(range.endColumn - 1, range.endColumn);
  return ch.length > 0 ? ch : undefined;
}

/** 取 Monaco 的 `InsertAsSnippet` 枚举值（**不硬编码数字**）；桩 monaco 没这枚枚举 ⇒ `undefined` ⇒ 整条退化纯文本 */
export function insertAsSnippetRule(monaco: typeof Monaco): Monaco.languages.CompletionItemInsertTextRule | undefined {
  const rules = monaco.languages.CompletionItemInsertTextRule as unknown as Record<string, unknown> | undefined;
  const value = rules?.InsertAsSnippet;
  return typeof value === 'number' ? (value as Monaco.languages.CompletionItemInsertTextRule) : undefined;
}

/**
 * 把一条**调用形态**候选改写成带 tabstop 的 snippet（**原地**改 `insertText` / `insertTextRules`）。
 * 返回是否 snippet 化。不改写的情形（一条不猜）：非调用形态 source / `insertText` 不是 `名字(` /
 * 协议缺席或不认这个函数 / 桩 monaco 拿不到 `CompletionItemInsertTextRule` 枚举。
 *
 * 特殊分支：替换区间右端**紧跟一个 `(`**（作者已自己开括号）⇒ 不 snippet 化（仍返回 `false`），
 * 但**形态必须当场修正**：`insertText` 由 `名字(` 收回纯 `名字`（作者那枚 `(` 留在替换区间右端）
 * ⇒ 接受候选落字恰为 `名字(`；不修正则原样插入的 `名字(` 与作者那枚 `(` 叠成 `名字((`（明显非法）。
 */
export function applyCallSnippet(
  monaco: typeof Monaco,
  item: Monaco.languages.CompletionItem,
  provenance: CompletionProvenance,
  charAfter: string | undefined,
  policy: CompletionCallFormPolicy,
  tag: string,
): boolean {
  if (!policy.sourceIds.has(provenance.sourceId)) return false;
  const insertText = typeof item.insertText === 'string' ? item.insertText : undefined;
  if (insertText === undefined || insertText !== `${provenance.label}(`) return false;
  if (charAfter === '(') {
    item.insertText = provenance.label;
    // 已核实：本仓调用形态的 source（系统函数 / 库函数两处）从不预置 `insertTextRules`
    //（仅 snippet 源会设，而它们不产 `名字(` 形态）——此处仍防御性清掉：外部追加的 source
    // 若预置过，纯名字按 snippet 规则解析会吞 `$` / `}` 等字符。
    if (item.insertTextRules !== undefined) delete item.insertTextRules;
    return false;
  }
  const rule = insertAsSnippetRule(monaco);
  if (rule === undefined) return false;
  const keys = policy.keysFor === undefined ? [provenance.label] : policy.keysFor(provenance.label, provenance.tables);
  const snippet = buildCallSnippetText(provenance.label, slotsForCallee(provenance.tables.callProtocol, keys, tag));
  if (snippet === undefined) return false;
  item.insertText = snippet;
  item.insertTextRules = rule;
  return true;
}

/**
 * 一轮候选的 snippet 化（装配点调用；两语言共用）。
 *
 * **先按 source id 过滤**（多数候选不参与），再按行号记忆化取行文本——同一行只取一次，
 * 不给上千条候选各取一遍。`seed` 是装配点**已经取过**的那一行（省一次读取）。
 */
export function applyCallSnippets(
  monaco: typeof Monaco,
  items: readonly Monaco.languages.CompletionItem[],
  provenance: CompletionProvenanceStore,
  model: Monaco.editor.ITextModel,
  policy: CompletionCallFormPolicy,
  tag: string,
  seed?: { readonly lineNumber: number; readonly text: string },
): void {
  let lineAt = seed?.lineNumber ?? -1;
  let lineText = seed?.text ?? '';
  for (const item of items) {
    const hit = provenance.lookup(item);
    if (hit === undefined || !policy.sourceIds.has(hit.sourceId)) continue;
    const box = candidateRange(item.range);
    if (box === undefined) continue;
    if (box.endLineNumber !== lineAt) {
      lineAt = box.endLineNumber;
      lineText = model.getLineContent(lineAt);
    }
    applyCallSnippet(monaco, item, hit, charAfterRange(lineText, box), policy, tag);
  }
}

/* ============================== 共用的回表详情构造（措辞单一真源） ============================== */

/** `VariableInfo.source` → 名表面可读说法（契约层跨游戏术语） */
const VARIABLE_SOURCE_LABEL: Readonly<Record<string, string>> = {
  primary: '主名表',
  append: '追加名表',
  const: '具名常量',
};

/** `KojoFaceTemplate.indexKind` → 编号槽取值口径的可读说法 */
const INDEX_KIND_LABEL: Readonly<Record<string, string>> = {
  command: '按指令名表换算',
  literal: '原样透传（字面名）',
  counter: '按计数器名表换算',
};

/** 候选 `detail`（`族` / `族:编号`，由变量 source 写入）里的族头 */
export function familyFromDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const head = detail.split(':')[0];
  return head !== undefined && head.length > 0 ? head : undefined;
}

/** 取某族的枚举条目（无枚举能力 / 抛错 ⇒ `undefined`，不猜） */
export function entriesOf(schema: VariableSchema | undefined, family: string): readonly VariableInfo[] | undefined {
  const enumerate = schema?.names;
  if (typeof enumerate !== 'function') return undefined;
  try {
    return enumerate(family);
  } catch {
    return undefined;
  }
}

/** 位表摘要（条数多时截断；条名为 adapter 原文） */
export function bitsLine(bits: VariableInfo['bits']): string | undefined {
  if (bits === undefined || bits.length === 0) return undefined;
  const shown = bits.slice(0, 12).map((b) => `${String(b.bit)} ${b.label}`).join('、');
  return `位表 ${shown}${bits.length > 12 ? ' …' : ''}（共 ${String(bits.length)} 项）`;
}

/**
 * 变量 / 索引名候选的详情（两语言共用一份实现）：编号 / 说明 / 名表来源 / 位表 / 原生引用。
 * 事实全部来自 `variableSchema` 与 `dictionary`，一条查不到就不写；一条都没有 ⇒ `undefined`（不编话术）。
 */
export function variableDetail(
  label: string,
  detail: string | undefined,
  tables: CompletionTables,
  heading: string,
): CompletionResolution | undefined {
  const family = familyFromDetail(detail) ?? tables.dictionary?.resolveFamily?.(label);
  if (family === undefined) return undefined;
  const entry = entriesOf(tables.variableSchema, family)?.find((e) => e.name === label);
  const facts: string[] = [];
  if (entry !== undefined) {
    const index: number | string | undefined = entry.index ?? entry.resolvedIndex;
    if (index !== undefined) facts.push(`编号 \`${String(index)}\``);
    if (entry.description !== undefined && entry.description.length > 0) facts.push(entry.description);
    const tier = entry.source === undefined ? undefined : VARIABLE_SOURCE_LABEL[entry.source];
    if (tier !== undefined) facts.push(`来源 ${tier}`);
    const bits = bitsLine(entry.bits);
    if (bits !== undefined) facts.push(bits);
  }
  let native: string | undefined;
  try {
    native = tables.dictionary?.resolve?.(label);
  } catch {
    native = undefined; // 字典抛错 ⇒ 只给已取到的事实，绝不让 resolve 崩
  }
  if (native !== undefined && native.length > 0 && native !== label) facts.push(`原生引用 \`${native}\``);
  if (facts.length === 0) return undefined;
  return { documentation: { value: [`**${label}** · ${heading} \`${family}\``, ...facts].join('\n\n') } };
}

/**
 * 项目函数候选的详情（两语言共用）：中文名（库表反查面）+ 调用签名（协议）。
 * 两张表都不认 ⇒ `undefined`（不编话术）。
 */
export function projectFunctionDetail(
  label: string,
  tables: CompletionTables,
  tag: string,
): CompletionResolution | undefined {
  const facts: string[] = [];
  let cn: string | undefined;
  try {
    cn = tables.libraryTable?.lookupByFunction?.(label);
  } catch {
    cn = undefined;
  }
  if (cn !== undefined && cn.length > 0) facts.push(`中文名 ${cn}`);
  const sig = signatureLine(label, [label], tables.callProtocol, tag);
  if (sig !== undefined) facts.push(sig);
  if (facts.length === 0) return undefined;
  return { documentation: { value: [`**${label}** · 项目函数`, ...facts].join('\n\n') } };
}

/** 中文指令名候选的详情：编号 + 编号反查 + 两种写法（表不认 ⇒ `undefined`） */
export function instructionDetail(label: string, table: KojoInstructionTable | undefined): CompletionResolution | undefined {
  if (table === undefined || table.hasTable === false) return undefined;
  let no: number | undefined;
  try {
    no = table.lookupByName(label);
  } catch {
    return undefined;
  }
  if (no === undefined) return undefined;
  const facts: string[] = [`编号 \`${String(no)}\``];
  try {
    const back = table.lookupByNo(no);
    if (back !== undefined && back.length > 0) facts.push(`编号反查 \`${back}\``);
  } catch {
    /* 反查面抛错 ⇒ 只给已取到的编号，不编造 */
  }
  facts.push(`写法 \`时机 指令 ${label}：\`／\`是 ${label}\``);
  return { documentation: { value: [`**${label}** · 指令名`, ...facts].join('\n\n') } };
}

/** 中文计数器名候选的详情：编号 + 编号反查 + 两种写法（表不认 ⇒ `undefined`） */
export function counterDetail(label: string, table: KojoCounterTable | undefined): CompletionResolution | undefined {
  if (table === undefined || table.hasTable === false) return undefined;
  let no: number | undefined;
  try {
    no = table.lookupByName(label);
  } catch {
    return undefined;
  }
  if (no === undefined) return undefined;
  const facts: string[] = [`编号 \`${String(no)}\``];
  try {
    const back = table.lookupByNumber(no);
    if (back !== undefined && back.length > 0) facts.push(`编号反查 \`${back}\``);
  } catch {
    /* 反查面抛错 ⇒ 只给已取到的编号，不编造 */
  }
  facts.push(`写法 \`时机 计数器 ${label}：\`／\`时机 计数器 ${String(no)}：\``);
  return { documentation: { value: [`**${label}** · 计数器名`, ...facts].join('\n\n') } };
}

/** 时机分野候选的详情：模板 / 编号口径 / 成否与 MESSAGECHECK 模板 / 各段取值域 */
export function faceDetail(label: string, faceTable: KojoFaceTable | undefined): CompletionResolution | undefined {
  const tpl = faceTable?.faces[label];
  if (tpl === undefined) return undefined;
  const facts: string[] = [`函数名模板 \`${tpl.template}\``];
  if (tpl.indexKind !== undefined) facts.push(`编号槽 ${INDEX_KIND_LABEL[tpl.indexKind] ?? tpl.indexKind}`);
  const slot = tpl.template.includes('{i}')
    ? (tpl.slotSemantics?.index ?? faceTable?.slotSemantics?.index)
    : undefined;
  if (slot !== undefined) {
    facts.push(`编号含义：${slot.label}${slot.detail !== undefined ? `（${slot.detail}）` : ''}`);
  }
  if (tpl.autoIndex === true) facts.push('省略编号时按本文件最小未用号自动分配');
  const successTpl = tpl.success?.template;
  if (successTpl !== undefined) facts.push(`成否模板 \`${successTpl}\``);
  const messageCheckTpl = tpl.messageCheck?.template;
  if (messageCheckTpl !== undefined) facts.push(`隐藏判定模板 \`${messageCheckTpl}\``);
  const segments = tpl.segments;
  if (segments !== undefined) {
    for (const name of Object.keys(segments)) {
      const values = segments[name];
      const keys = values === undefined ? [] : Object.keys(values);
      if (keys.length > 0) {
        facts.push(`段 \`${name}\` 取值 ${keys.slice(0, 12).join('、')}${keys.length > 12 ? ' …' : ''}`);
      }
    }
  }
  return { documentation: { value: [`**${label}** · 时机分野`, ...facts].join('\n\n') } };
}

/** 库函数候选的详情：原生名 + 调用签名（表不认这个函数 ⇒ 只给原生名） */
export function libraryDetail(label: string, tables: CompletionTables, tag: string): CompletionResolution | undefined {
  let native: string | undefined;
  try {
    native = tables.libraryTable?.lookupByName(label);
  } catch {
    return undefined;
  }
  if (native === undefined) return undefined;
  const facts = [
    `原生名 \`${native}\``,
    signatureLine(label, [native, label], tables.callProtocol, tag),
  ].filter((s): s is string => s !== undefined);
  return { documentation: { value: [`**${label}** · 库函数`, ...facts].join('\n\n') } };
}

/* ============================== 装配点工厂（唯一的 provider 实现） ============================== */

/** 一次补全的**位置判定结果**（语言侧算出；返回 `undefined` = 整轮零候选，如字符串内） */
export interface CompletionLocation {
  /** 替换区间 */
  readonly range: Monaco.IRange;
  /** 光标前已输入词（排序档位用） */
  readonly prefix: string;
  /** 门类过滤（可选：位置门只筛候选，不重排；第二参 = 候选来源 id，additive——单参谓词天然兼容） */
  readonly keep?: (item: Monaco.languages.CompletionItem, sourceId: string) => boolean;
  /** 判定过程中**已经读过**的那一行（snippet 化复用它，省一次 model 读取） */
  readonly seed?: { readonly lineNumber: number; readonly text: string };
}

/** 一门语言的补全装配声明：只有"源集合 + 位置判定 + 回表口径"，没有装配实现 */
export interface CompletionAssembly {
  readonly languageId: string;
  /** 日志前缀（`[kojo-completion]` / `[erb-completion]`——退化信号要说清是哪条 seam） */
  readonly logTag: string;
  readonly triggerCharacters: readonly string[];
  readonly sources: readonly CompletionSource[];
  readonly callForm: CompletionCallFormPolicy;
  /**
   * **跨装配路由**（可选；additive）。装配点在本轮 `locate` 之前问一次：返回非 `undefined`
   * ⇒ 本轮整条管线（`locate` / `sources` / `callForm` / 日志前缀 / resolve 分派）改用被路由
   * 装配，provenance 照旧记 `sourceId` 并额外记下归属装配。
   *
   * `.kojo` 的用法：位置在原生区（`@` 块 / 全大写指令行 / `$标签`）⇒ 返回
   * `ERB_COMPLETION_ASSEMBLY`；糖位返回 `undefined`（用自己）。**只走一跳**：被路由装配的
   * `route` 不再被追问（两册语言不互指）。路由只改写"用哪本册"，不改写合并 / 去重 / 排序 /
   * 降级 / snippet 的任何一行语义——那些仍只有 {@link mergeSuggestions} 与
   * {@link createCompletionProvider} 这一份实现。
   */
  route?(
    monaco: typeof Monaco,
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
  ): CompletionAssembly | undefined;
  /**
   * 位置判定：算替换区间 + 前缀 +（可选）门类过滤；返回 `undefined` = 整轮零候选（如字符串内）。
   * `monaco` 由装配核递进来——判定要读 kind 常量时**不必修**自己去记一枚句柄。
   */
  locate(monaco: typeof Monaco, model: Monaco.editor.ITextModel, position: Monaco.Position): CompletionLocation | undefined;
  resolveDetail(item: Monaco.languages.CompletionItem, provenance: CompletionProvenance): CompletionResolution | undefined;
}

/**
 * 装配一枚补全 provider（两语言共用；`registerCompletionItemProvider` 的唯一调用点在这里）。
 *
 * 四件事一次收口，宿主零改动：
 * ①`provideCompletionItems` = **路由** → 位置判定 → `mergeSuggestions` → snippet 化（整段有兜底
 *   try/catch：任一环节抛错都返回 `{ suggestions: [] }`——Monaco 要求的形状，**并在这条路上报
 *   一次降级**，不再让 promise reject 被 Monaco 吞成"补全突然没了"）。路由只换"用哪本册"，
 *   合并 / 去重 / 排序 / 降级 / snippet 一行都不复制；
 * ②`resolveCompletionItem` = 对象身份反查出处 → **按产出装配**回表算详情 → 只合并
 *   `detail` / `documentation`；
 * ③降级去重表**每轮装配新建**（= 一次 `provideCompletionItems` 一份 ⇒ "每轮至多一次"成立）。
 *   曾经随句柄创建 ⇒ 首轮之后同一缺键**永久无声**（正是排查时最需要看见的那条信号）；
 * ④路由只走**一跳**（被路由装配的 `route` 不再被追问，见 {@link CompletionAssembly.route}）。
 */
export function createCompletionProvider(
  monaco: typeof Monaco,
  assembly: CompletionAssembly,
  getTables: () => CompletionTables,
  onDegrade?: CompletionDegradeReporter,
): Monaco.languages.CompletionItemProvider {
  const provenance = createCompletionProvenanceStore();
  return {
    triggerCharacters: [...assembly.triggerCharacters],
    provideCompletionItems(model, position) {
      const reported = new Set<string>(); // 一轮一份（见③）：句柄级去重 = 首轮之后永久无声
      let stage: CompletionAssemblyStage = 'route';
      // 本轮实际出货的装配：路由命中 = 被路由装配；否则就是 provider 自己的装配
      let active: CompletionAssembly = assembly;
      try {
        const routed = assembly.route?.(monaco, model, position);
        if (routed !== undefined) active = routed;
        const tag = active.logTag;
        stage = 'locate';
        const location = active.locate(monaco, model, position);
        if (location === undefined) return { suggestions: [] };
        stage = 'getTables';
        const tables = getTables();
        stage = 'merge';
        const suggestions = mergeSuggestions(
          active.sources,
          { monaco, model, position, range: location.range, tables },
          location.prefix,
          {
            reported,
            tag,
            onDegrade,
            keep: location.keep,
            provenance,
            assembly: active,
          },
        );
        stage = 'snippet';
        applyCallSnippets(monaco, suggestions, provenance, model, active.callForm, tag, location.seed);
        return { suggestions };
      } catch (e: unknown) {
        // 装配核自己抛错（路由 / 位置判定 / 取表 / 合并 / snippet）：候选本轮清空，但**信号必须
        // 出去**——返回 `undefined` / 裸数组都不是 Monaco 要求的形状，promise reject 更会被
        // Monaco 吞掉。日志前缀取当前装配：路由已发生时说清是哪本册出的问题。
        const msg = e instanceof Error ? e.message : String(e);
        const reason = `装配在 '${stage}' 阶段抛错（${msg}），本轮返回空候选（不猜、不静默：Monaco 吞不掉已 resolve 的空列表）`;
        console.warn(`${active.logTag} 降级：${reason}`);
        onDegrade?.({
          sourceId: COMPLETION_ASSEMBLY_SOURCE_ID,
          reason,
          failure: { stage, error: msg },
        });
        return { suggestions: [] };
      }
    },
    resolveCompletionItem(item) {
      const hit = provenance.lookup(item);
      if (hit === undefined) return item; // 不是本装配点产出的候选 ⇒ 原样交回（不猜）
      // 按**产出装配**分派回表口径（跨装配路由后候选可能来自 ERB 册）；缺省 = provider 根装配
      const owner = hit.assembly ?? assembly;
      let resolved: CompletionResolution | undefined;
      try {
        resolved = owner.resolveDetail(item, hit);
      } catch (e: unknown) {
        console.warn(`${owner.logTag} resolve '${hit.sourceId}' 抛错：${errorText(e)}`);
        return item;
      }
      if (resolved === undefined) return item;
      if (resolved.detail !== undefined && item.detail === undefined) item.detail = resolved.detail;
      if (resolved.documentation !== undefined) item.documentation = resolved.documentation;
      return item;
    },
  };
}

/** 注册一门语言的补全 provider（返回可释放句柄——宿主在编辑器卸载时 `dispose()`） */
export function installCompletion(
  monaco: typeof Monaco,
  assembly: CompletionAssembly,
  getTables: () => CompletionTables,
  onDegrade?: CompletionDegradeReporter,
): Monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider(
    assembly.languageId,
    createCompletionProvider(monaco, assembly, getTables, onDegrade),
  );
}

/* ============================== 名字槽候选引擎（项目函数名两语言共用） ============================== */

/** 名字槽的替换区间与已输入前缀（0 基列；由语言侧的位置判定算出） */
export interface CompletionNameSlot {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
}

interface NameEntry {
  readonly name: string;
  readonly file?: string;
}

interface PrefixIndex {
  readonly keys: readonly string[];
  readonly entries: readonly NameEntry[];
}

/** 单源命中上限（空前缀 / 极短前缀会命中全表；逐条造对象既慢又无意义） */
export const MAX_NAME_CANDIDATES = 1000;

/** 按数组身份记忆化的前缀索引（十万条量级只建一次） */
const INDEX_CACHE = new WeakMap<object, PrefixIndex>();

function prefixIndexFor(functionNames: readonly (string | { name: string; file?: string })[]): PrefixIndex {
  const cached = INDEX_CACHE.get(functionNames);
  if (cached !== undefined) return cached;

  const seen = new Set<string>();
  const pairs: { key: string; entry: NameEntry }[] = [];
  for (const item of functionNames) {
    const name = typeof item === 'string' ? item : item.name;
    if (name.length === 0) continue;
    const key = name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const file = typeof item === 'string' ? undefined : item.file;
    pairs.push({ key, entry: file === undefined ? { name } : { name, file } });
  }
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const index: PrefixIndex = { keys: pairs.map((p) => p.key), entries: pairs.map((p) => p.entry) };
  INDEX_CACHE.set(functionNames, index);
  return index;
}

/** 首个小写等于或大于 `target` 的下标（升序数组；`target` 已归一化为大写） */
function lowerBound(keys: readonly string[], target: string): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 名字槽 → 项目函数名候选（**纯函数**，两语言共用一份实现）。
 *
 * 名字来源唯一 = 基座注入的 `functionNames`（`slot === null` / 名字缺席 ⇒ `[]`，不猜）。
 * 前缀匹配**大小写不敏感**（引擎侧函数名大小写不敏感，与 `ErbIndex.normalizedName` 同口径）；
 * 单次过滤 = 二分找前缀下界 + 连续前扫 ⇒ `O(log n + 命中数)`，与总量无关。
 * 上限内的排序：前缀精确优先，其次按归一化名升序。
 */
export function projectFunctionCandidates(
  monaco: typeof Monaco,
  functionNames: readonly (string | { name: string; file?: string })[] | undefined,
  slot: CompletionNameSlot | null,
  lineNumber: number,
): Monaco.languages.CompletionItem[] {
  if (!monaco || !functionNames || functionNames.length === 0 || slot === null) return [];
  const index = prefixIndexFor(functionNames);
  const keys = index.keys;
  const norm = slot.prefix.toUpperCase();
  const from = lowerBound(keys, norm);
  if (from >= keys.length || !keys[from]!.startsWith(norm)) return [];

  const range: Monaco.IRange = {
    startLineNumber: lineNumber,
    endLineNumber: lineNumber,
    startColumn: slot.start + 1,
    endColumn: slot.end + 1,
  };
  const kind = monaco.languages.CompletionItemKind.Function;
  const items: Monaco.languages.CompletionItem[] = [];
  for (let i = from; i < keys.length && items.length < MAX_NAME_CANDIDATES; i++) {
    const key = keys[i]!;
    if (!key.startsWith(norm)) break;
    const entry = index.entries[i]!;
    const exact = key === norm;
    items.push({
      label: entry.name,
      kind,
      insertText: entry.name,
      range,
      sortText: `${exact ? '0' : '1'}_${entry.name}`,
      ...(entry.file !== undefined ? { detail: entry.file } : {}),
    });
  }
  return items;
}
