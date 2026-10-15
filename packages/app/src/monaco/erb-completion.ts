import type * as Monaco from 'monaco-editor';
import type {
  ErbIndex,
  KojoInstructionTable,
  KojoLibraryTable,
  VariableSchema,
} from '@kojo/plugin-api';
import type { DictionaryLookup } from '@kojo/plugin-kojo-sugar';
import { ERB_DIRECTIVES, ERB_LANGUAGE_ID } from './erb-language';

/**
 * `.erb` 方言补全的**装配 seam**（宿主层）——补 `erb-language.ts` 侧 Monarch 高亮之外的
 * 唯一补全入口（本批前 `.erb` **0 个**补全 provider）。
 *
 * 与 `kojo-completion.ts` **同构但不同语言、不同 seam**（不与 kojo 合并）：只注册**一个**
 * `registerCompletionItemProvider(ERB_LANGUAGE_ID, …)`，候选由 `ERB_COMPLETION_SOURCES`
 * （**可扩展数组**）里的各 source 提供、合并、按 label 去重、排序（前缀精确 > 前缀命中 > 其它）。
 * 新增补全能力 = 往数组里**追加**一个 `ErbCompletionSource`（宿主零改动）。
 *
 * 数据源两层（与 kojo 同纪律：**不猜**）：
 * - **语言层**（跨游戏、与项目无关）：`erb-directives` source —— 指令 / 预处理指令 /
 *   指令行，词表**派生**自 `erb-language.ts` 的单一真源 `ERB_DIRECTIVES`；
 * - **adapter 层**（游戏知识，只住 adapter）：`ErbCompletionTables` —— 宿主只读不解释，
 *   表缺席即该路不产候选。函数名（`erbFunctionNames`）由宿主按 `ErbIndex.fingerprint`
 *   记忆化后注入（为兄弟批次 EC-3 预置）。
 *
 * 纯逻辑与 Monaco 绑定分离：`ErbCompletionSource.provide` 可单测（只依赖 ctx 里的
 * `model` / `position` / `range` / `tables`），`installErbCompletion` 只做协议翻译。
 */
export interface ErbCompletionTables {
  /** 变量字典（`makeLookup(adapter.variableSchema)` 产物）；缺席 = 不做变量补全 */
  readonly dictionary?: DictionaryLookup;
  /** 适配器变量 schema 本体（枚举名字用 `VariableSchema.names`）；缺席 = 不做变量补全 */
  readonly variableSchema?: VariableSchema;
  /** 基础库函数名表（adapter `kojoLibraryTable`）；缺席 = 不做库函数名补全 */
  readonly libraryTable?: KojoLibraryTable;
  /** 指令名表（adapter `kojoInstructionTable`）；缺席 = 不做指令名补全 */
  readonly instructionTable?: KojoInstructionTable;
  /**
   * 项目内**全部函数名**（已排序）的提供者——为 EC-3 的「函数调用补全」预置。
   * 缺席 / 解析器缺席 / 索引未构建 ⇒ 空数组（**无候选**，不猜）。同步取用（补全 provider 是同步 API）。
   */
  readonly erbFunctionNames?: () => readonly string[];
}

/** 一次补全请求的上下文（`range` = 替换区间，由装配点按当前词算出，各 source 共用） */
export interface ErbCompletionSourceContext {
  readonly monaco: typeof Monaco;
  readonly model: Monaco.editor.ITextModel;
  readonly position: Monaco.Position;
  readonly range: Monaco.IRange;
  readonly tables: ErbCompletionTables;
}

/** 一个补全候选来源（**扩展点**：往 `ERB_COMPLETION_SOURCES` 追加即可） */
export interface ErbCompletionSource {
  readonly id: string;
  provide(ctx: ErbCompletionSourceContext): Monaco.languages.CompletionItem[];
}

/* ============================== 行首 / 行中判定 ============================== */

/**
 * 当前 token 的**替换区间**（1 基）。
 *
 * Monaco 的默认词法不含指令记号：`#DIM` 的 `#` 与 `[SKIPSTART]` 的 `[`/`]` 都是词分隔符，
 * `getWordUntilPosition` 只给 `DIM` / `SKIPSTART`。故向前吞并紧邻的 `#` / `[`，
 * 让替换区间覆盖整个记号（否则插入 `#DIM` 会得到 `#DIM` 之外多出一个残留 `#`）。
 */
export function erbTokenRange(model: Monaco.editor.ITextModel, position: Monaco.Position): Monaco.IRange {
  const line = model.getLineContent(position.lineNumber);
  const word = model.getWordUntilPosition(position);
  let start = word.startColumn;
  while (start > 1 && (line[start - 2] === '#' || line[start - 2] === '[')) start--;
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: start,
    endColumn: word.endColumn,
  };
}

/**
 * 光标是否在**行首位置**（纯函数，可单测）：当前 token 之前只有空白。
 *
 * 用于分野「行首给全表 / 行中只给表达式子集」——`#DIM` / `[SKIPSTART]` 这类**必须行首**的
 * 候选绝不在行中弹出。token 起始列向前吞并 `#` / `[` 的意义见 {@link erbTokenRange}。
 */
export function isLineHeadContext(model: Monaco.editor.ITextModel, position: Monaco.Position): boolean {
  const line = model.getLineContent(position.lineNumber);
  const range = erbTokenRange(model, position);
  return /^\s*$/.test(line.slice(0, range.startColumn - 1));
}

/* ============================== 语言层 source ============================== */

/**
 * **必须行首**的预处理指令（`#DIM` / `#FUNCTION` …）。这些名字不出现在表达式里，
 * 故只进「行首」候选集，绝不在行中弹出。
 */
const ERB_PREPROCESSOR_DIRECTIVES = [
  '#DIM', '#DIMS', '#DIMSA', '#DIMSTR', '#DIMCHAR', '#DIMF',
  '#FUNCTION', '#FUNCTIONS', '#DEFINE', '#INCLUDE', '#ONLY',
];
/** **必须行首**的区间标记行（`[SKIPSTART]` 起、`[SKIPEND]` 止）。 */
const ERB_BRACKET_DIRECTIVES = ['[SKIPSTART]', '[SKIPEND]'];

/**
 * 「行中」可出现的**关键字子集**（可出现在表达式 / 实参里）：控制流分支与闭合、循环、
 * 调用 / 跳转、`PRINT*` 家族。`PRINT*` 从 `ERB_DIRECTIVES` **派生**（单一真源，不手抄）。
 */
const ERB_MIDLINE_KEYWORDS: readonly string[] = [
  'IF', 'ELSEIF', 'ELSE', 'ENDIF', 'SIF',
  'WHILE', 'WEND',
  'SELECTCASE', 'CASE', 'CASEELSE', 'ENDSELECT',
  'RETURN', 'BREAK', 'CONTINUE',
  'CALL', 'CALLF', 'CALLL', 'CALLFORM', 'CALLFORML', 'CALLFORMF',
  'JUMP', 'TRYCALL', 'TRYCALLFORM', 'TRYCALLFORMF', 'TRYJUMP', 'TRYCCALLFORM',
  ...ERB_DIRECTIVES.filter((d) => d.startsWith('PRINT')),
];

/**
 * 指令 / 关键字补全（本批唯一 source）：**行首**给 `ERB_DIRECTIVES` 全表 + 预处理指令 +
 * 区间标记行；**行中**只给表达式 / 实参可出现的关键字子集（`#DIM` 这类必须行首的不出现）。
 *
 * 词表来自 `erb-language.ts` 的 `ERB_DIRECTIVES`（高亮与补全**同一份清单**，不另抄）。
 */
const DIRECTIVES_SOURCE: ErbCompletionSource = {
  id: 'erb-directives',
  provide({ monaco, model, position, range }): Monaco.languages.CompletionItem[] {
    const items: Monaco.languages.CompletionItem[] = [];
    const seen = new Set<string>();
    const push = (label: string, detail: string): void => {
      if (seen.has(label)) return;
      seen.add(label);
      items.push({
        label,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: label,
        detail,
        range,
        sortText: `0_${label}`,
      });
    };
    if (isLineHeadContext(model, position)) {
      for (const d of ERB_DIRECTIVES) push(d, '指令');
      for (const d of ERB_PREPROCESSOR_DIRECTIVES) push(d, '预处理指令');
      for (const d of ERB_BRACKET_DIRECTIVES) push(d, '指令行');
    } else {
      for (const k of ERB_MIDLINE_KEYWORDS) push(k, '关键字');
    }
    return items;
  },
};

/**
 * 全部补全来源（**稳定扩展点**）。后续批次（EC-2 变量 / 基础库、EC-3 函数名）往这里
 * 追加 `ErbCompletionSource`，装配点与排序/去重口径零改动。
 */
export const ERB_COMPLETION_SOURCES: ErbCompletionSource[] = [DIRECTIVES_SOURCE];

/* ============================== 记忆化：函数名 provider（EC-3 预置） ============================== */

/**
 * 把「取当前 `ErbIndex`」的记忆化为「函数名（已排序）提供者」。
 *
 * 失效判据 = `ErbIndex.fingerprint`（整项目指纹）：指纹不变 ⇒ 纯派生必不变 ⇒ 复用上次排好序
 * 的名字数组（不重排、不重建）；指纹 `null`（有文件取不到 stat）⇒ **一律重算**（保守失效，
 * 与 `plugin-api/erb.ts` 的指纹口径一致）。索引缺席 ⇒ 空数组（**无候选**，不猜）。
 *
 * `getIndex` 抛错（解析器缺席 / 索引在途）⇒ 返回空数组，**绝不让整个补全 seam 崩**。
 */
export function memoizedErbFunctionNames(getIndex: () => ErbIndex | null | undefined): () => readonly string[] {
  let memo: readonly string[] = [];
  let memoFingerprint: string | null = null;
  let hasMemo = false;
  return (): readonly string[] => {
    let index: ErbIndex | null | undefined;
    try {
      index = getIndex();
    } catch {
      return [];
    }
    if (!index) return [];
    const fp = index.fingerprint ?? null;
    if (fp !== null && hasMemo && fp === memoFingerprint) return memo;
    memo = [...index.byName.keys()].sort();
    memoFingerprint = fp;
    hasMemo = true;
    return memo;
  };
}

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
  sources: readonly ErbCompletionSource[],
  ctx: ErbCompletionSourceContext,
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
        `[erb-completion] source '${source.id}' provide 抛错：${e instanceof Error ? e.message : String(e)}`,
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
 * 为 `.erb` / `.erh`（`ERB_LANGUAGE_ID`）注册**一个**补全 provider。
 * `triggerCharacters` 保守：只取指令记号 `#` 与区间标记 `[`（不打扰常规输入）。
 * `getTables` 每次补全时才调用（表按当前项目 adapter 实时取，同 hover 纪律）。
 * 返回可释放句柄——宿主在编辑器卸载时 `dispose()`。
 */
export function installErbCompletion(
  monaco: typeof Monaco,
  getTables: () => ErbCompletionTables,
): Monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider(ERB_LANGUAGE_ID, {
    triggerCharacters: ['#', '['],
    provideCompletionItems(model, position) {
      const range = erbTokenRange(model, position);
      const line = model.getLineContent(position.lineNumber);
      const prefix = line.slice(range.startColumn - 1, range.endColumn - 1);
      const suggestions = mergeSuggestions(
        ERB_COMPLETION_SOURCES,
        { monaco, model, position, range, tables: getTables() },
        prefix,
      );
      return { suggestions };
    },
  });
}
