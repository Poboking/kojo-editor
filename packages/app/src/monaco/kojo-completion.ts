import type * as Monaco from './entry';
import {
  RESERVED_PRONOUNS,
  SUGAR_KEYWORD_ROLE_LABEL,
  SUGAR_LEXICON_OPERATORS,
  SYSTEM_FUNCTION_ALIASES,
} from '@kojo/plugin-kojo-sugar';
import { KOJO_LANGUAGE_ID, NOTIN_MARKS, PRIMARY_WORDS, SYSTEM_FUNCTION_WORDS } from './kojo-language';
import { variableCompletionItems } from './kojo-completion-variables';
import { faceCompletionItems } from './kojo-completion-faces';
import { instructionCompletionItems } from './kojo-completion-instructions';
import { libraryCompletionItems } from './kojo-completion-library';
import { kojoFunctionCompletionItems } from './kojo-completion-functions';
import { kojoDeclarationsOf } from './kojo-completion-declarations';
import { KOJO_SNIPPET_SOURCE } from './kojo-completion-snippets';
import {
  applyCallSnippet,
  buildCallSnippetText,
  candidateRange,
  charAfterRange,
  createCompletionProvenanceStore,
  escapeSnippetText,
  faceDetail,
  installCompletion,
  instructionDetail,
  libraryDetail,
  mergeSuggestions,
  projectFunctionDetail,
  rankKey,
  signatureLine,
  slotsForCallee,
  variableDetail,
  type CompletionAssembly,
  type CompletionDegrade,
  type CompletionDegradeReporter,
  type CompletionDeclaration,
  type CompletionDeclarationKind,
  type CompletionDeclarationScanner,
  type CompletionForeignForm,
  type CompletionProvenance,
  type CompletionProvenanceStore,
  type CompletionResolution,
  type CompletionSource,
  type CompletionSourceContext,
  type CompletionTables,
} from './completion-core';

/**
 * `.kojo` 表层 DSL 补全的**候选册**（语言侧：只声明"有哪些源 + 位置怎么判 + 详情回哪张表"）。
 *
 * COMPL-SHARED 之后的分层：装配实现（合并 / 去重 / 排序 / 上限 / 降级 / provenance / snippet /
 * provider 注册）**全部**住在 `completion-core.ts` 那一份里，`.erb` 与本文件共用同一实现。
 * 本文件剩下的都是"只有 `.kojo` 才懂"的三件事：
 *
 * 1. **候选源集合** `KOJO_COMPLETION_SOURCES`（可扩展数组，新增能力 = 追加一项，装配零改动）；
 * 2. **位置判定**：替换区间 = 当前词（{@link kojoCompletionRange}）；
 * 3. **回表口径**：候选出处 → 详情（变量 / 分野 / 指令名 / 库函数 / 系统函数 / 项目函数），
 *    以及"哪些 source 的候选是调用形态、按什么键回协议表取槽"。
 *
 * 候选数据源三类（纪律：缺表即该路零候选 + 一次可见降级信号，**不猜**）：
 * - **语言层**（跨游戏、与项目无关）：中文主形关键字 / 保留代词 / 运算符 / 系统函数名，
 *   全部**派生**自 `kojo-sugar` 的转译器词表（单一真源，不复制词形）；
 * - **文件层**（本文件内）：`别名` / `常量` 声明名——判据一律经解析器
 *   （`kojo-completion-declarations` → `sugar.transpile` 的 `parse`），**不再有第二份正则**；
 * - **adapter / 项目层**：`CompletionTables`（宿主只读不解释）+ 项目函数名——后者与 `.erb`
 *   吃**同一份表**，这就是"跨语言候选打通"的那一半：`.kojo` 里写 `调用` 也补得到剧本函数名。
 *
 * 二段式供给：provide 只给 label / kind / 一行 detail；**中文名·说明·取值域·调用签名**等到
 * `resolveCompletionItem` 才回表算（对象身份 → 出处走装配核的 `WeakMap` 反查）；**调用形态**候选
 * 按 `callProtocol` 的形参槽插成带 tabstop 的 snippet（取不到槽 ⇒ 纯文本照旧）。
 */

/* ============================== 契约面（与 `.erb` 同一张表 / 同一批类型；旧名零改动） ============================== */

export type {
  CompletionAssembly,
  CompletionDegrade,
  CompletionDegradeReporter,
  CompletionDeclaration,
  CompletionDeclarationKind,
  CompletionDeclarationScanner,
  CompletionForeignForm,
  CompletionProvenance,
  CompletionProvenanceStore,
  CompletionResolution,
  CompletionSource,
  CompletionSourceContext,
  CompletionTables,
};

/* ============================== 语言侧的回表口径（详情 / 调用形态） ============================== */

const KOJO_LOG_TAG = '[kojo-completion]';

/** 一条候选的查表键（表层名 ↔ 原生名两张面：原生名优先、表层名兜底；取不到就只用表层名） */
function calleeKeys(label: string, tables: CompletionTables): readonly (string | undefined)[] {
  let native: string | undefined;
  try {
    native = tables.libraryTable?.lookupByName(label) ?? SYSTEM_FUNCTION_ALIASES.get(label);
  } catch {
    native = undefined; // 表抛错 ⇒ 只按表层名问协议，绝不让补全链崩
  }
  return native === undefined ? [label] : [native, label];
}

/**
 * 哪些 source 的候选是**调用形态**（`insertText` 恰为 `名字(`）⇒ 才允许改写成 snippet。
 * 变量 / 指令名 / 关键字 / 命名参数 / 项目函数名一律排除（它们插的不是括号调用形）。
 */
const CALL_FORM_SOURCE_IDS: ReadonlySet<string> = new Set(['kojo-lexicon', 'kojo-library']);

/** 词表候选的详情：只有**系统函数**有可回表的事实（原生名 + 签名）；关键字 / 代词 / 运算符不编话术 */
function lexiconDetail(label: string, tables: CompletionTables): CompletionResolution | undefined {
  const native = SYSTEM_FUNCTION_ALIASES.get(label);
  if (native === undefined) return undefined;
  const facts = [
    `原生名 \`${native}\``,
    signatureLine(label, [native, label], tables.callProtocol, KOJO_LOG_TAG),
    '插入形态为调用形：`名字(`',
  ].filter((s): s is string => s !== undefined);
  return { documentation: { value: [`**${label}** · 系统函数`, ...facts].join('\n\n') } };
}

/**
 * `resolveCompletionItem` 的**纯**内核（可单测）：按出处分派到装配核的共用详情构造器。
 * 不认识的 source id ⇒ `undefined`（后来追加的 source 自己声明详情，**不猜它想要什么**）。
 */
export function resolveCompletionDetail(
  item: Monaco.languages.CompletionItem,
  provenance: CompletionProvenance,
): CompletionResolution | undefined {
  const tables = provenance.tables;
  const label = provenance.label;
  try {
    switch (provenance.sourceId) {
      case 'kojo-variable':
        return variableDetail(label, typeof item.detail === 'string' ? item.detail : undefined, tables, '变量');
      case 'kojo-face':
        return faceDetail(label, tables.faceTable);
      case 'kojo-instruction':
        return instructionDetail(label, tables.instructionTable);
      case 'kojo-library':
        return libraryDetail(label, tables, KOJO_LOG_TAG);
      case 'kojo-lexicon':
        return lexiconDetail(label, tables);
      case 'kojo-functions':
        return projectFunctionDetail(label, tables, KOJO_LOG_TAG);
      default:
        return undefined;
    }
  } catch (e: unknown) {
    console.warn(`${KOJO_LOG_TAG} resolve '${provenance.sourceId}' 抛错：${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** `.kojo` 口径的 snippet 改写：调用形态名单与取键策略由本语言声明，改写实现在装配核（一份） */
export function applyKojoCallSnippet(
  monaco: typeof Monaco,
  item: Monaco.languages.CompletionItem,
  provenance: CompletionProvenance,
  charAfter: string | undefined,
): boolean {
  return applyCallSnippet(
    monaco,
    item,
    provenance,
    charAfter,
    { sourceIds: CALL_FORM_SOURCE_IDS, keysFor: calleeKeys },
    KOJO_LOG_TAG,
  );
}

/** `.kojo` 口径的取槽（原生名优先、表层名兜底）；实现在装配核 */
export function kojoSlotsForCallee(
  protocol: CompletionTables['callProtocol'],
  keys: readonly (string | undefined)[],
): ReturnType<typeof slotsForCallee> {
  return slotsForCallee(protocol, keys, KOJO_LOG_TAG);
}

/* ============================== 文件层：`别名` / `常量` 声明名 ============================== */

/**
 * 本文件声明名（`别名` / `常量`）的候选面。
 *
 * 判据**不在此处**：一律经 `kojo-completion-declarations` 走解析器（`sugar.transpile` 的 `parse`），
 * 本函数只把"声明类别"翻成上屏措辞；按 model 版本的记忆化也在那一侧。
 */
function declarationItems(ctx: CompletionSourceContext): Monaco.languages.CompletionItem[] {
  const K = ctx.monaco.languages.CompletionItemKind;
  const out: Monaco.languages.CompletionItem[] = [];
  for (const decl of kojoDeclarationsOf(ctx.model, ctx.tables.kojoDeclarations)) {
    out.push({
      label: decl.name,
      kind: K.Variable,
      insertText: decl.name,
      detail: decl.kind === 'alias' ? '别名（本文件）' : '常量（本文件）',
      range: ctx.range,
      sortText: `1_${decl.name}`,
    });
  }
  return out;
}

/* ============================== 语言层 source ============================== */

/**
 * 静态候选规格（L2 批：**模块级一次构建、内容恒定**）。
 *
 * 四组静态建议（保留代词 / 中文主形关键字 / 中文运算符 + `不在` / 系统函数名）
 * 的 label·kind·insertText·detail·sortText 只取决于 `kojo-sugar` 的词表常量
 * （单一真源；进程内不变）⇒ 在这里一次性展开。`provide` 每次只做"补本次 `range`
 * 与 Monaco kind 常量"这一件变量工作，不再每调从四个数组重新推导、展开对象。
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
 * 本文件声明名（`别名` / `常量`）→ 保留代词 → 中文主形关键字 → 中文运算符（含 `不在`）→ 系统函数名。
 * 第 2..5 组走模块级静态规格表；第 1 组随编辑变，判据来自解析器（见 {@link declarationItems}）。
 */
const LEXICON_SOURCE: CompletionSource = {
  id: 'kojo-lexicon',
  provide(ctx): Monaco.languages.CompletionItem[] {
    const K = ctx.monaco.languages.CompletionItemKind;
    const suggestions: Monaco.languages.CompletionItem[] = declarationItems(ctx);

    // 静态词表（模块级一次构建；此处只补 `range` 与 Monaco kind 常量）。
    // function 组是 snippet 调用模板（R4）：补 `insertTextRules` 让 Monaco 按 snippet 解析。
    // 常量对象防御性读取（测试桩 / 旧运行时可能不挂 `CompletionItemInsertTextRule`）。
    const insertAsSnippet = ctx.monaco.languages.CompletionItemInsertTextRule?.InsertAsSnippet;
    for (const s of STATIC_SUGGESTION_SPECS) {
      const item: Monaco.languages.CompletionItem = {
        label: s.label,
        kind: s.kind === 'operator' ? K.Operator : s.kind === 'function' ? K.Function : K.Keyword,
        insertText: s.insertText,
        detail: s.detail,
        range: ctx.range,
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
 * 项目函数名补全（COMPL-SHARED · 跨语言候选打通）：`调用 <前缀>` / `函数 <前缀>` 的名字槽弹
 * **项目内全部函数名**（与 `.erb` 同一份 `erbFunctionNames`、同一份前缀索引引擎）。
 * 提供者缺席 / 索引未构建 / 位置不符 → `[]`（降级信号由 `requires` 机制发，**不猜**）。
 */
const FUNCTIONS_SOURCE: CompletionSource = {
  id: 'kojo-functions',
  requires: 'erbFunctionNames',
  provide({ monaco, model, position, tables }): Monaco.languages.CompletionItem[] {
    return kojoFunctionCompletionItems(monaco, model, position, tables.erbFunctionNames?.());
  },
};

/**
 * 全部补全来源（**稳定扩展点**）。后续批次往这里追加 `CompletionSource`，
 * 装配点与排序/去重口径零改动（实现在 `completion-core.ts`，与 `.erb` 共用一份）。
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
  FUNCTIONS_SOURCE,
];

/* ============================== 位置判定 + 装配声明 ============================== */

/**
 * 当前词的**替换区间**（口径逐字沿用旧装配点：Monaco 默认词法的 `getWordUntilPosition`）。
 * 导出只为让"两语言在同一候选集合上的装配对拍"能直接取同一枚区间算法。
 */
export function kojoCompletionRange(model: Monaco.editor.ITextModel, position: Monaco.Position): Monaco.IRange {
  const word = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };
}

/** `.kojo` 的装配声明：源集合 + 位置判定 + 回表口径（装配实现零份——吃装配核那一份） */
export const KOJO_COMPLETION_ASSEMBLY: CompletionAssembly = {
  languageId: KOJO_LANGUAGE_ID,
  logTag: KOJO_LOG_TAG,
  triggerCharacters: ['{', '：'],
  sources: KOJO_COMPLETION_SOURCES,
  callForm: { sourceIds: CALL_FORM_SOURCE_IDS, keysFor: calleeKeys },
  locate(_monaco, model, position) {
    return { range: kojoCompletionRange(model, position), prefix: model.getWordUntilPosition(position).word };
  },
  resolveDetail(item, provenance) {
    try {
      return resolveCompletionDetail(item, provenance);
    } catch (e: unknown) {
      console.warn(`[kojo-completion] resolve '${provenance.sourceId}' 抛错：${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  },
};

/* ============================== 装配点（转发到装配核） ============================== */

/**
 * 为 `.kojo` 注册**一个**补全 provider（`triggerCharacters` 保守：`{` 与 `：`）。
 * `getTables` 每次补全时才调用（表按当前项目 adapter 实时取，同 hover 纪律）。
 * 返回可释放句柄——宿主在编辑器卸载时 `dispose()`。
 *
 * `onDegrade`（可选第三参，additive——旧调用方零改动）：某来源因依赖表缺席（或求值抛错）
 * 被跳过时**首次**回调一次。装配实现（`resolveCompletionItem` / snippet 化 / 降级去重 / 上限）
 * 全在 `completion-core.ts` 的 `installCompletion`，本函数只是把 `.kojo` 的装配声明递进去。
 */
export function installKojoCompletion(
  monaco: typeof Monaco,
  getTables: () => CompletionTables,
  onDegrade?: CompletionDegradeReporter,
): Monaco.IDisposable {
  return installCompletion(monaco, KOJO_COMPLETION_ASSEMBLY, getTables, onDegrade);
}

/* ============================== 旧导出面（同名 = 装配核那一份实现） ============================== */

export {
  buildCallSnippetText,
  candidateRange,
  charAfterRange,
  createCompletionProvenanceStore,
  escapeSnippetText,
  mergeSuggestions,
  rankKey,
};
export { applyKojoCallSnippet as applyCallSnippet };
export { kojoSlotsForCallee as slotsForCallee };
