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
 * 3. **排序**：`前缀精确 > 前缀命中 > 其它`，同档沿用 source 自带 `sortText`，label 兜底；
 * 4. **上限**：装配级截断（`MAX_ASSEMBLED_SUGGESTIONS`），截断可见（一行 warn，一次装配只报一次）；
 * 5. **降级**：`requires` 依赖缺席 / source 抛错 ⇒ 跳过该源 + 一次可见信号；
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
 * 写 `调用` 也能补到剧本函数名；外来词形（`kojoForms`）同理做成**可注入**——注入缺席即该路
 * 零候选并发一次降级信号，**不在本层抄一份语法扫描**。
 *
 * ## 分层纪律
 *
 * 本文件零语言名词、零游戏名词、零词表：`ERB` / `kojo` 只出现在文档与类型名里。
 * 纯逻辑与 Monaco 绑定分离：`mergeSuggestions` / 详情构造 / snippet 判定都可不经 provider 单测。
 */

/* ============================== 表（两语言共用同一份） ============================== */

/** 一条**外来词形**候选的最小描述（由宿主 / adapter 视图注入，装配核不认识任何词表） */
export interface CompletionForeignForm {
  /** 上屏与插入的原文 */
  readonly label: string;
  /** 一行说明（缺省 = 不写 detail，Monaco 右侧留空） */
  readonly detail?: string;
  /** 插入文本（缺省 = `label` 原文） */
  readonly insertText?: string;
}

/**
 * 补全消费的**唯一一张表**（`.kojo` 与 `.erb` 两个 seam 共用；语言侧文件保留各自的历史类型名
 * 作为别名，宿主 `EditorPane` 的表构造零改动即可同时满足两侧）。
 *
 * 纪律（缺一即该路**零候选 + 一次可见降级信号**，绝不猜）：
 * - `dictionary` / `variableSchema` / `faceTable` / `instructionTable` / `libraryTable` /
 *   `callProtocol` 全部来自**当前项目 adapter 贡献**，运行时现取；
 * - `erbFunctionNames` 是**项目索引派生**（非 adapter 表）：项目内全部函数名（已排序）的提供者；
 * - `kojoForms` 是**跨语言词形**的注入位（`.erb` 侧给 `.kojo` 词形候选）；数据源目前不在任何
 *   注入通道上，故缺席即零候选（不做第二份语法扫描）；
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
   * 跨语言词形的注入位（`.erb` 侧的 `.kojo` 词形候选）。注入缺席 = 该路零候选 + 一次降级信号。
   * 词形内容（label / 说明 / 插入文本）全部由提供方决定，装配核零解释。
   */
  readonly kojoForms?: () => readonly CompletionForeignForm[];
  /**
   * `.kojo` 文件级声明名（`别名` / `常量`）的**解析器通道**注入位。
   * 宿主可注入内核里那一枚 `sugar.transpile` 服务；未注入时由 `kojo-completion-declarations.ts`
   * 用同一个 `createSugarTranspileService` 懒建一枚只解析实例顶上（纯函数、零 IO）——
   * **绝不在编辑器侧写第二份别名正则**。
   */
  readonly kojoDeclarations?: CompletionDeclarationScanner;
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
   * 同一 `(来源 id, 缺键)` 在**一次装配内只报一次**。
   */
  readonly requires?: keyof CompletionTables;
  provide(ctx: CompletionSourceContext): Monaco.languages.CompletionItem[];
}

/** 一次「补全来源降级」的可断言描述（缺表信号） */
export interface CompletionDegrade {
  /** 被跳过（或抛错）的来源 id */
  readonly sourceId: string;
  /** 未能满足的依赖：adapter 表键 / 提供者键（缺席或求值抛错） */
  readonly missing: keyof CompletionTables;
  /** 一句中文说明（含「缺席 / 抛错」「已跳过」「不猜」） */
  readonly reason: string;
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
 * 排名键：`前缀精确`（label === 已输入词）> `前缀命中`（label 以已输入词开头）> 其它；
 * 同档内沿用各 source 自带的 `sortText`（保留其分组次序），再以 label 兜底。
 */
export function rankKey(item: Monaco.languages.CompletionItem, prefix: string): string {
  const label = labelText(item.label);
  const boost = prefix.length === 0 ? 2 : label === prefix ? 0 : label.startsWith(prefix) ? 1 : 2;
  return `${boost}|${item.sortText ?? ''}|${label}`;
}

/** 一次装配内共享的"已报"去重表 + 日志前缀（`[kojo-completion]` / `[erb-completion]`） */
export interface CompletionMergeOptions {
  readonly reported: Set<string>;
  readonly tag: string;
  readonly onDegrade?: CompletionDegradeReporter;
  /** 位置门的候选过滤器（**过滤**不是重排：各 source 的既有排序语义不动） */
  readonly keep?: (item: Monaco.languages.CompletionItem) => boolean;
  readonly provenance?: CompletionProvenanceStore;
  /** 装配级上限（缺省 {@link MAX_ASSEMBLED_SUGGESTIONS}；测试可放宽以验对拍） */
  readonly limit?: number;
}

/**
 * 报**一次**降级信号（同一 `(来源 id, 缺键)` 在一次装配内只报一次；去重表由装配句柄持有）。
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
 * 最后按上限截断（截断可见：一行 warn，一次装配只报一次）。
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
    // 位置门在**去重前**逐 source 过滤：keyword 形态的候选不得占掉函数名候选的先注册位
    if (opts.keep !== undefined) items = items.filter(opts.keep);
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
    const final: Monaco.languages.CompletionItem = { ...entry.item, sortText: key };
    opts.provenance?.register(final, {
      sourceId: entry.sourceId,
      label: labelText(entry.item.label),
      tables: ctx.tables,
    });
    return final;
  });
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
 * 返回是否改写。不改写的情形（一律**退化成纯文本**，一条不猜）：非调用形态 source / `insertText`
 * 不是 `名字(` / 替换区间右端**紧跟一个 `(`**（作者已自己开括号）/ 协议缺席或不认这个函数 /
 * 桩 monaco 拿不到 `CompletionItemInsertTextRule` 枚举。
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
  if (charAfter === '(') return false;
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
  /** 门类过滤（可选：位置门只筛候选，不重排） */
  readonly keep?: (item: Monaco.languages.CompletionItem) => boolean;
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
   * 位置判定：算替换区间 + 前缀 +（可选）门类过滤；返回 `undefined` = 整轮零候选（如字符串内）。
   * `monaco` 由装配核递进来——判定要读 kind 常量时**不必修**自己去记一枚句柄。
   */
  locate(monaco: typeof Monaco, model: Monaco.editor.ITextModel, position: Monaco.Position): CompletionLocation | undefined;
  resolveDetail(item: Monaco.languages.CompletionItem, provenance: CompletionProvenance): CompletionResolution | undefined;
}

/**
 * 装配一枚补全 provider（两语言共用；`registerCompletionItemProvider` 的唯一调用点在这里）。
 *
 * 三件事一次收口，宿主零改动：
 * ①`provideCompletionItems` = 位置判定 → `mergeSuggestions` → snippet 化；
 * ②`resolveCompletionItem` = 对象身份反查出处 → 语言侧回表算详情 → 只合并 `detail` / `documentation`；
 * ③降级去重表随句柄创建（**不做模块级全局去重**，否则第二次 install 会吞掉信号 ⇒ 三态不可复跑）。
 */
export function createCompletionProvider(
  monaco: typeof Monaco,
  assembly: CompletionAssembly,
  getTables: () => CompletionTables,
  onDegrade?: CompletionDegradeReporter,
): Monaco.languages.CompletionItemProvider {
  const reported = new Set<string>();
  const provenance = createCompletionProvenanceStore();
  const tag = assembly.logTag;
  return {
    triggerCharacters: [...assembly.triggerCharacters],
    provideCompletionItems(model, position) {
      const location = assembly.locate(monaco, model, position);
      if (location === undefined) return { suggestions: [] };
      const tables = getTables();
      const suggestions = mergeSuggestions(
        assembly.sources,
        { monaco, model, position, range: location.range, tables },
        location.prefix,
        {
          reported,
          tag,
          onDegrade,
          keep: location.keep,
          provenance,
        },
      );
      applyCallSnippets(monaco, suggestions, provenance, model, assembly.callForm, tag, location.seed);
      return { suggestions };
    },
    resolveCompletionItem(item) {
      const hit = provenance.lookup(item);
      if (hit === undefined) return item; // 不是本装配点产出的候选 ⇒ 原样交回（不猜）
      let resolved: CompletionResolution | undefined;
      try {
        resolved = assembly.resolveDetail(item, hit);
      } catch (e: unknown) {
        console.warn(`${tag} resolve '${hit.sourceId}' 抛错：${errorText(e)}`);
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
