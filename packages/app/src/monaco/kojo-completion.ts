import type * as Monaco from './entry';
import type {
  KojoFaceTable,
  KojoInstructionTable,
  KojoLibraryTable,
  VariableSchema,
} from '@kojo/plugin-api';
import type { DictionaryLookup } from '@kojo/plugin-kojo-sugar';
import {
  RESERVED_PRONOUNS,
  SUGAR_KEYWORD_ROLE_LABEL,
  SUGAR_LEXICON_OPERATORS,
} from '@kojo/plugin-kojo-sugar';
import { KOJO_LANGUAGE_ID, NOTIN_MARKS, PRIMARY_WORDS, SYSTEM_FUNCTION_WORDS } from './kojo-language';
import { variableCompletionItems } from './kojo-completion-variables';
import { faceCompletionItems } from './kojo-completion-faces';
import { instructionCompletionItems } from './kojo-completion-instructions';
import { libraryCompletionItems } from './kojo-completion-library';
import { KOJO_SNIPPET_SOURCE } from './kojo-completion-snippets';

/**
 * `.kojo` 表层 DSL 补全的**装配 seam**（宿主层）。
 *
 * 只注册**一个** `registerCompletionItemProvider(KOJO_LANGUAGE_ID, …)`，候选由
 * `KOJO_COMPLETION_SOURCES`（**可扩展数组**）里的各 source 提供、合并、按 label 去重、
 * 排序（前缀精确 > 前缀命中 > 其它）。新增补全能力 = 往数组里**追加**一个 `CompletionSource`
 * （宿主零改动）；本模块是唯一装配点（`kojo-language.ts` 的内联补全已删除）。
 *
 * 候选数据源三类：
 * - **语言层**（跨游戏、与项目无关）：中文主形关键字 / 保留代词 / 运算符 / 系统函数名，
 *   全部**派生**自 `kojo-sugar` 的转译器词表（单一真源，不复制词形）；
 * - **文件层**（本文件内）：头部 `别名` 声明名；
 * - **adapter 层**（游戏知识，只住 adapter）：`CompletionTables` —— 宿主只读不解释，
 *   表缺席即该路不产候选（**不猜**）。
 *
 * 纯逻辑与 Monaco 绑定分离：`CompletionSource.provide` 可单测（只依赖 ctx 里的
 * `model` / `position` / `range` / `tables`），`installKojoCompletion` 只做协议翻译。
 */
export interface CompletionTables {
  /** 变量字典（`makeLookup(adapter.variableSchema)` 产物）；缺席 = 不做变量补全 */
  readonly dictionary?: DictionaryLookup;
  /**
   * 适配器变量 schema **本体**（KC-1 枚举名字用 `VariableSchema.names`）。
   * 与 `dictionary` 同源（同一个 `adapter.variableSchema`）：`dictionary` 供 hover 反查，
   * 本体供补全**枚举**——两者都缺席 = 不做变量补全（**不猜**）。
   */
  readonly variableSchema?: VariableSchema;
  /** 时机分野模板表（adapter `kojoFaceTemplates`）；缺席 = 不做分野补全 */
  readonly faceTable?: KojoFaceTable;
  /** 指令名表（adapter `kojoInstructionTable`）；缺席 = 不做指令名补全 */
  readonly instructionTable?: KojoInstructionTable;
  /** 基础库函数名表（adapter `kojoLibraryTable`）；缺席 = 不做库函数名补全 */
  readonly libraryTable?: KojoLibraryTable;
}

/** 一次补全请求的上下文（`range` = 替换区间，由装配点按当前词算出，各 source 共用） */
export interface CompletionSourceContext {
  readonly monaco: typeof Monaco;
  readonly model: Monaco.editor.ITextModel;
  readonly position: Monaco.Position;
  readonly range: Monaco.IRange;
  readonly tables: CompletionTables;
}

/** 一个补全候选来源（**扩展点**：往 `KOJO_COMPLETION_SOURCES` 追加即可） */
export interface CompletionSource {
  readonly id: string;
  /**
   * 该来源依赖的 **adapter 表键**（**additive** 可选声明；旧来源不写 = 无依赖）。
   *
   * `mergeSuggestions` 发现该键在当次 `tables` 中**缺席**（`undefined` / `null`）时：**跳过**
   * 该来源（零候选，行为与今天一致）**并发出一次可见信号**（不静默——能力退化必须看得见）；
   * 该来源 `provide` 抛错时同样按此键报一次降级（**抛错即视为缺**）。信号经 `onDegrade`
   * 回调与一行 `console.warn` 双通道，同一 `(来源 id, 缺表键)` 在**一次装配内只报一次**。
   */
  readonly requires?: keyof CompletionTables;
  provide(ctx: CompletionSourceContext): Monaco.languages.CompletionItem[];
}

/** 一次「补全来源降级」的可断言描述（缺表信号） */
export interface CompletionDegrade {
  /** 被跳过（或抛错）的来源 id */
  readonly sourceId: string;
  /** 未能满足的依赖：adapter 表键（缺席）或来源 `requires` 键（求值抛错） */
  readonly missing: keyof CompletionTables;
  /** 一句中文说明（含「缺席 / 抛错」「已跳过」「不猜」） */
  readonly reason: string;
}

/** 降级回调（`installKojoCompletion` 可选第三参注入；便于测试直接断言，不依赖真 Monaco） */
export type CompletionDegradeReporter = (degrade: CompletionDegrade) => void;

/* ============================== 文件层：别名声明扫描 ============================== */

/** 头部 `别名 X = 目标` / `alias X = 目标` 的名字（补全用；轻量扫描，不重复转译器） */
const ALIAS_DECL = /^\s*(?:别名|alias)\s+([^\s=：:,，]+)/gm;

function aliasNamesOf(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(ALIAS_DECL)) {
    const name = m[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * 按 model 版本记忆化的别名表（与 `erb-completion-labels.ts` 的标签缓存同一纪律）。
 *
 * 别名全文正则扫描是每击键 `O(文件大小)`；同一版本（未编辑）下头部别名声明**必不变**
 * ⇒ 复用上次数组（同一引用）。版本号缺席（桩 model / 旧运行时）⇒ 退化为每次重扫
 * （行为正确，仅失去缓存），**不假定字段存在**。`WeakMap` 按 model 身份：关闭即回收。
 */
const ALIAS_CACHE = new WeakMap<
  Monaco.editor.ITextModel,
  { readonly versionId: number; readonly names: readonly string[] }
>();

function cachedAliasNames(model: Monaco.editor.ITextModel): readonly string[] {
  const getVersionId = (model as { getVersionId?: () => number }).getVersionId;
  const versionId = typeof getVersionId === 'function' ? getVersionId.call(model) : undefined;
  if (typeof versionId !== 'number') return aliasNamesOf(model.getValue());

  const cached = ALIAS_CACHE.get(model);
  if (cached !== undefined && cached.versionId === versionId) return cached.names;

  const names = aliasNamesOf(model.getValue());
  ALIAS_CACHE.set(model, { versionId, names });
  return names;
}

/* ============================== 语言层 + 文件层 source ============================== */

/**
 * 静态候选规格（L2 批：**模块级一次构建、内容恒定**）。
 *
 * 四组静态建议（保留代词 / 中文主形关键字 / 中文运算符 + `不在` / 系统函数名）
 * 的 label·kind·insertText·detail·sortText 只取决于 `kojo-sugar` 的词表常量
 * （单一真源；进程内不变）⇒ 在这里一次性展开。`provide` 每次只做"补本次 `range`
 * 与 Monaco kind 常量"这一件变量工作，不再每调从四个数组重新推导、展开对象
 * （原实现 = 每次弹建议整体重建，纯分配浪费 + GC 压力）。
 * 英文隐藏别名**不进**补全列表（规范 §4.1 中英不对等展示）。
 */
type StaticSuggestionKind = 'pronoun' | 'keyword' | 'operator' | 'function';

interface StaticSuggestionSpec {
  readonly label: string;
  readonly kind: StaticSuggestionKind;
  readonly insertText: string;
  readonly detail: string;
  readonly sortText: string;
}

const STATIC_SUGGESTION_SPECS: readonly StaticSuggestionSpec[] = [
  ...RESERVED_PRONOUNS.map(
    (p): StaticSuggestionSpec => ({ label: p, kind: 'pronoun', insertText: p, detail: '保留代词', sortText: `2_${p}` }),
  ),
  ...PRIMARY_WORDS.map(
    (w): StaticSuggestionSpec => ({
      label: w.word,
      kind: 'keyword',
      insertText: w.word,
      detail: SUGAR_KEYWORD_ROLE_LABEL[w.role],
      sortText: `3_${w.role}_${w.word}`,
    }),
  ),
  ...[...SUGAR_LEXICON_OPERATORS, ...NOTIN_MARKS].map(
    (op): StaticSuggestionSpec => ({ label: op, kind: 'operator', insertText: op, detail: '运算符', sortText: `4_${op}` }),
  ),
  ...SYSTEM_FUNCTION_WORDS.map(
    (name): StaticSuggestionSpec => ({
      // snippet 调用模板（R4）：插入后光标落在括号内（`名($1)$0`）。词表没有形参数据
      // ⇒ 不造参数 placeholder（不猜）；item 需带 `insertTextRules`，静态表存不下
      // ⇒ 在 `LEXICON_SOURCE.provide` 里对 function 组统一补。
      label: name,
      kind: 'function',
      insertText: `${name}($1)$0`,
      detail: '系统函数',
      sortText: `5_${name}`,
    }),
  ),
];

/**
 * 词表 source（原 `kojo-language.ts` 内联补全的 5 组候选，行为逐字等价）：
 * 本文件别名 → 保留代词 → 中文主形关键字 → 中文运算符（含 `不在`）→ 系统函数名。
 * 第 2..5 组走模块级静态规格表；第 1 组（别名）随编辑变，保持每调派生（全文正则
 * 已按 model 版本记忆化，见 `cachedAliasNames`）。
 */
const LEXICON_SOURCE: CompletionSource = {
  id: 'kojo-lexicon',
  provide({ monaco, model, range }): Monaco.languages.CompletionItem[] {
    const K = monaco.languages.CompletionItemKind;
    const suggestions: Monaco.languages.CompletionItem[] = [];

    // 1. 文件内 `别名` 名字（别名补全——最常用，排最前）
    for (const name of cachedAliasNames(model)) {
      suggestions.push({
        label: name,
        kind: K.Variable,
        insertText: name,
        detail: '别名（本文件）',
        range,
        sortText: `1_${name}`,
      });
    }
    // 2..5. 静态词表（模块级一次构建；此处只补 `range` 与 Monaco kind 常量）。
    // function 组是 snippet 调用模板（R4）：补 `insertTextRules` 让 Monaco 按 snippet 解析。
    // 常量对象防御性读取（测试桩 / 旧运行时可能不挂 `CompletionItemInsertTextRule`）。
    const insertAsSnippet = monaco.languages.CompletionItemInsertTextRule?.InsertAsSnippet;
    for (const s of STATIC_SUGGESTION_SPECS) {
      const item: Monaco.languages.CompletionItem = {
        label: s.label,
        kind: s.kind === 'operator' ? K.Operator : s.kind === 'function' ? K.Function : K.Keyword,
        insertText: s.insertText,
        detail: s.detail,
        range,
        sortText: s.sortText,
      };
      if (s.kind === 'function' && insertAsSnippet !== undefined) {
        item.insertTextRules = insertAsSnippet;
      }
      suggestions.push(item);
    }

    return suggestions;
  },
};

/**
 * 变量 / 属性补全（KC-1）：`{她的<前缀>}` / `{角色12的<前缀>}` 插值内弹变量名
 * （名字来自 `tables.variableSchema.names(...)` 枚举）。非该位置 / schema 缺省 → `[]`。
 */
const VARIABLE_SOURCE: CompletionSource = {
  id: 'kojo-variable',
  requires: 'variableSchema',
  provide({ monaco, model, position, tables }): Monaco.languages.CompletionItem[] {
    return variableCompletionItems(monaco, model, position, tables.variableSchema);
  },
};

/**
 * 时机分野补全（KC-2）：行首 `时机 <分野>：` 弹分野候选（`tables.faceTable.faces` 枚举）。
 * 非该位置 / 表缺省 → `[]`。
 */
const FACE_SOURCE: CompletionSource = {
  id: 'kojo-face',
  requires: 'faceTable',
  provide({ monaco, model, position, tables }): Monaco.languages.CompletionItem[] {
    return faceCompletionItems(monaco, model, position, tables.faceTable);
  },
};

/**
 * 指令名补全（KC-3）：`时机 <分野> <编号令牌位>：` 与 `当 …： 是 <值…>：` 的 CASE 值位
 * 弹中文指令名候选（`tables.instructionTable.names()` 枚举）。非该位置 / 表缺省 /
 * 无枚举能力 → `[]`。与 KC-2b 的命名参数键**同位置共存**（多 source 各自出货，按 label 去重）。
 */
const INSTRUCTION_SOURCE: CompletionSource = {
  id: 'kojo-instruction',
  requires: 'instructionTable',
  provide({ monaco, model, position, tables }): Monaco.languages.CompletionItem[] {
    return instructionCompletionItems(monaco, model, position, tables.instructionTable);
  },
};

/**
 * 库函数名补全（KC-4）：`.kojo` 表达式 / 正文的标识符位置弹中文库函数名候选
 * （`tables.libraryTable.names()` 枚举）。字符串内 / 注释内 / 插值内 / 表缺省 → `[]`。
 */
const LIBRARY_SOURCE: CompletionSource = {
  id: 'kojo-library',
  requires: 'libraryTable',
  provide({ monaco, model, position, tables }): Monaco.languages.CompletionItem[] {
    return libraryCompletionItems(monaco, model, position, tables.libraryTable);
  },
};

/**
 * 全部补全来源（**稳定扩展点**）。后续批次往这里追加 `CompletionSource`，
 * 装配点与排序/去重口径零改动。
 *
 * `kojo-snippet`（R4）注册在**最前**：行首位置的块头模板与 `kojo-lexicon` 的同名
 * 纯文本关键字按 label 去重（先注册者胜）⇒ 行首只留 snippet、行中纯文本照旧——
 * 「snippet 与既有纯文本补全项不重复出条目」就靠这个次序（见 snippet 模块头注）。
 */
export const KOJO_COMPLETION_SOURCES: CompletionSource[] = [
  KOJO_SNIPPET_SOURCE,
  LEXICON_SOURCE,
  VARIABLE_SOURCE,
  FACE_SOURCE,
  INSTRUCTION_SOURCE,
  LIBRARY_SOURCE,
];

/* ============================== 合并 / 去重 / 排序 ============================== */

function labelText(label: Monaco.languages.CompletionItem['label']): string {
  return typeof label === 'string' ? label : label.label;
}

/**
 * 排名键：`前缀精确`（label === 已输入词）> `前缀命中`（label 以已输入词开头）> 其它；
 * 同档内沿用各 source 自带的 `sortText`（保留其分组次序），再以 label 兜底。
 */
function rankKey(item: Monaco.languages.CompletionItem, prefix: string): string {
  const label = labelText(item.label);
  const boost = prefix.length === 0 ? 2 : label === prefix ? 0 : label.startsWith(prefix) ? 1 : 2;
  return `${boost}|${item.sortText ?? ''}|${label}`;
}

/**
 * 报**一次**降级信号（同一 `(来源 id, 缺表键)` 在一次装配内只报一次；去重表随装配句柄创建）。
 * 双通道：`onDegrade` 回调（可断言）+ 一行 `console.warn`（运行时可读）——**不静默**。
 */
function reportDegrade(
  reported: Set<string>,
  sourceId: string,
  missing: keyof CompletionTables,
  onDegrade: CompletionDegradeReporter | undefined,
  detail: string,
): void {
  const dedupKey = `${sourceId}:${missing}`;
  if (reported.has(dedupKey)) return;
  reported.add(dedupKey);
  const reason = `来源 '${sourceId}' 依赖的适配器表 '${missing}' ${detail}，已跳过该来源（不猜）`;
  console.warn(`[kojo-completion] 降级：${reason}`);
  onDegrade?.({ sourceId, missing, reason });
}

/** 某来源的 `requires` 依赖在当次 `tables` 中是否缺席（`undefined` / `null`）；缺席则返回该键 */
function missingRequirement(
  source: CompletionSource,
  tables: CompletionTables,
): keyof CompletionTables | undefined {
  const key = source.requires;
  if (key === undefined) return undefined;
  const value = tables[key];
  return value === undefined || value === null ? key : undefined;
}

/** 依次问各 source，按 label 去重（先注册者胜），再按排名键排序并写回 `sortText` */
function mergeSuggestions(
  sources: readonly CompletionSource[],
  ctx: CompletionSourceContext,
  prefix: string,
  reported: Set<string>,
  onDegrade: CompletionDegradeReporter | undefined,
): Monaco.languages.CompletionItem[] {
  const byLabel = new Map<string, Monaco.languages.CompletionItem>();
  for (const source of sources) {
    // 依赖表缺席：跳过该来源（零候选）+ 发一次可见信号（不静默）
    const missing = missingRequirement(source, ctx.tables);
    if (missing !== undefined) {
      reportDegrade(reported, source.id, missing, onDegrade, '缺席');
      continue;
    }
    let items: Monaco.languages.CompletionItem[];
    try {
      items = source.provide(ctx);
    } catch (e: unknown) {
      // source 由外部追加：单个抛错不拖垮整条补全链（退化可见，其余 source 照常出候选）
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[kojo-completion] source '${source.id}' provide 抛错：${msg}`);
      // 抛错即视为缺：带 `requires` 的来源按该键报一次降级
      if (source.requires !== undefined) {
        reportDegrade(reported, source.id, source.requires, onDegrade, `求值抛错（${msg}）`);
      }
      continue;
    }
    for (const item of items) {
      const label = labelText(item.label);
      if (!byLabel.has(label)) byLabel.set(label, item);
    }
  }
  return [...byLabel.values()]
    .map((item) => ({ item, key: rankKey(item, prefix) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ item, key }) => ({ ...item, sortText: key }));
}

/* ============================== 装配点 ============================== */

/**
 * 为 `.kojo` 注册**一个**补全 provider（`triggerCharacters` 保守：`{` 与 `：`）。
 * `getTables` 每次补全时才调用（表按当前项目 adapter 实时取，同 hover 纪律）。
 * 返回可释放句柄——宿主在编辑器卸载时 `dispose()`。
 *
 * `onDegrade`（**可选第三参，additive**——旧调用方零改动）：某来源因依赖表缺席（或求值抛错）
 * 被跳过时**首次**回调一次；去重表随本句柄创建（**不做模块级全局去重**，否则第二次 install
 * 会吞掉信号 ⇒ 三态不可复跑）。不传 `onDegrade` 时降级仍以一行 `console.warn` 可见。
 */
export function installKojoCompletion(
  monaco: typeof Monaco,
  getTables: () => CompletionTables,
  onDegrade?: CompletionDegradeReporter,
): Monaco.IDisposable {
  const reported = new Set<string>();
  return monaco.languages.registerCompletionItemProvider(KOJO_LANGUAGE_ID, {
    triggerCharacters: ['{', '：'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const suggestions = mergeSuggestions(
        KOJO_COMPLETION_SOURCES,
        { monaco, model, position, range, tables: getTables() },
        word.word,
        reported,
        onDegrade,
      );
      return { suggestions };
    },
  });
}
