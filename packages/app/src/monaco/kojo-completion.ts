import type * as Monaco from 'monaco-editor';
import type { KojoFaceTable, KojoInstructionTable, KojoLibraryTable } from '@kojo/plugin-api';
import type { DictionaryLookup } from '@kojo/plugin-kojo-sugar';
import {
  RESERVED_PRONOUNS,
  SUGAR_KEYWORD_ROLE_LABEL,
  SUGAR_LEXICON_OPERATORS,
} from '@kojo/plugin-kojo-sugar';
import { KOJO_LANGUAGE_ID, NOTIN_MARKS, PRIMARY_WORDS, SYSTEM_FUNCTION_WORDS } from './kojo-language';

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
  provide(ctx: CompletionSourceContext): Monaco.languages.CompletionItem[];
}

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

/* ============================== 语言层 + 文件层 source ============================== */

/**
 * 词表 source（原 `kojo-language.ts` 内联补全的 5 组静态候选，行为逐字等价）：
 * 本文件别名 → 保留代词 → 中文主形关键字 → 中文运算符（含 `不在`）→ 系统函数名。
 * 英文隐藏别名**不进**补全列表（规范 §4.1 中英不对等展示）。
 */
const LEXICON_SOURCE: CompletionSource = {
  id: 'kojo-lexicon',
  provide({ monaco, model, range }): Monaco.languages.CompletionItem[] {
    const suggestions: Monaco.languages.CompletionItem[] = [];

    // 1. 文件内 `别名` 名字（别名补全——最常用，排最前）
    for (const name of aliasNamesOf(model.getValue())) {
      suggestions.push({
        label: name,
        kind: monaco.languages.CompletionItemKind.Variable,
        insertText: name,
        detail: '别名（本文件）',
        range,
        sortText: `1_${name}`,
      });
    }
    // 2. 保留代词（她 / 你）
    for (const p of RESERVED_PRONOUNS) {
      suggestions.push({
        label: p,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: p,
        detail: '保留代词',
        range,
        sortText: `2_${p}`,
      });
    }
    // 3. 中文主形关键字（英文隐藏别名**不进**补全，规范 §4.1）
    for (const w of PRIMARY_WORDS) {
      suggestions.push({
        label: w.word,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: w.word,
        detail: SUGAR_KEYWORD_ROLE_LABEL[w.role],
        range,
        sortText: `3_${w.role}_${w.word}`,
      });
    }
    // 4. 中文运算符 + `不在`
    for (const op of [...SUGAR_LEXICON_OPERATORS, ...NOTIN_MARKS]) {
      suggestions.push({
        label: op,
        kind: monaco.languages.CompletionItemKind.Operator,
        insertText: op,
        detail: '运算符',
        range,
        sortText: `4_${op}`,
      });
    }
    // 5. 中文系统函数名（HK-11①；从 `SYSTEM_FUNCTION_ALIASES` 派生）
    //    补全即调用形态——插入 `名字(`，作者接着写实参加 `)`
    for (const name of SYSTEM_FUNCTION_WORDS) {
      suggestions.push({
        label: name,
        kind: monaco.languages.CompletionItemKind.Function,
        insertText: `${name}(`,
        detail: '系统函数',
        range,
        sortText: `5_${name}`,
      });
    }

    return suggestions;
  },
};

/**
 * 全部补全来源（**稳定扩展点**）。后续批次往这里追加 `CompletionSource`，
 * 装配点与排序/去重口径零改动。
 */
export const KOJO_COMPLETION_SOURCES: CompletionSource[] = [LEXICON_SOURCE];

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

/** 依次问各 source，按 label 去重（先注册者胜），再按排名键排序并写回 `sortText` */
function mergeSuggestions(
  sources: readonly CompletionSource[],
  ctx: CompletionSourceContext,
  prefix: string,
): Monaco.languages.CompletionItem[] {
  const byLabel = new Map<string, Monaco.languages.CompletionItem>();
  for (const source of sources) {
    let items: Monaco.languages.CompletionItem[];
    try {
      items = source.provide(ctx);
    } catch (e: unknown) {
      // source 由外部追加：单个抛错不拖垮整条补全链（退化可见，其余 source 照常出候选）
      console.warn(
        `[kojo-completion] source '${source.id}' provide 抛错：${e instanceof Error ? e.message : String(e)}`,
      );
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
 */
export function installKojoCompletion(
  monaco: typeof Monaco,
  getTables: () => CompletionTables,
): Monaco.IDisposable {
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
      );
      return { suggestions };
    },
  });
}
