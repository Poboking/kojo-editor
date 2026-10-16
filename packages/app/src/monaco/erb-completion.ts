import type * as Monaco from './entry';
import type {
  ErbIndex,
  KojoCallProtocol,
  KojoCallSlot,
  KojoInstructionTable,
  KojoLibraryTable,
  VariableInfo,
  VariableSchema,
} from '@kojo/plugin-api';
import type { DictionaryLookup } from '@kojo/plugin-kojo-sugar';
import { SYSTEM_FUNCTION_REVERSE } from '@kojo/plugin-kojo-sugar';
import { describeCallSignature, slotParameterLabel } from './kojo-signature';
import { ERB_DIRECTIVES, ERB_LANGUAGE_ID } from './erb-language';
import { erbBitCompletionItems } from './erb-completion-bits';
import { erbCompletionGate, type ErbCompletionGate } from './erb-completion-context';
import { erbFunctionCompletionItems } from './erb-completion-functions';
import { erbLabelCompletionItems } from './erb-completion-labels';
import { erbSystemFunctionCompletionItems } from './erb-completion-system-functions';
import { erbVariableCompletionItems } from './erb-completion-variables';
import { ERB_SNIPPET_SOURCE } from './erb-completion-snippets';

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
 * 二段式供给同 kojo 侧（C-2 批）：详情延到 `resolveCompletionItem` 回表算，
 * 括号调用形态候选按 `callProtocol` 插成带 tabstop 的 snippet。
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
  /**
   * 调用协议表（adapter `kojoCallProtocol`；**additive** 可选字段，与 `SignatureTables` 同一张表）。
   *
   * 只服务两件事：①`resolve` 阶段给函数类候选补**调用签名**详情；②把**括号调用形态**的候选
   * （`insertText` 恰为 `名字(`，即 `erb-system-functions` 一路）插成带 tabstop 的 snippet。
   * 缺席 / 不认这个函数 ⇒ 无签名、无片段（退化纯文本，**不猜形参**）。
   */
  readonly callProtocol?: KojoCallProtocol;
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
  /**
   * 该来源依赖的 **adapter 能力键**（**additive** 可选声明；旧来源不写 = 无依赖）。
   *
   * 与 kojo 侧同纪律：`mergeSuggestions` 发现该键在当次 `tables` 中**缺席**
   * （`undefined` / `null`；对 `erbFunctionNames` 这类**函数值**键即「提供者缺席」）时，
   * **跳过**该来源（零候选，行为与今天一致）**并发出一次可见信号**（不静默）；该来源
   * `provide` 抛错（如函数提供者求值抛错）同样按此键报一次降级（**抛错即视为缺**）。
   * 信号经 `onDegrade` 回调 + 一行 `console.warn` 双通道，同一 `(来源 id, 缺键)` 在
   * **一次装配内只报一次**。
   */
  readonly requires?: keyof ErbCompletionTables;
  provide(ctx: ErbCompletionSourceContext): Monaco.languages.CompletionItem[];
}

/** 一次「补全来源降级」的可断言描述（缺表信号） */
export interface ErbCompletionDegrade {
  /** 被跳过（或抛错）的来源 id */
  readonly sourceId: string;
  /** 未能满足的依赖：adapter 表键 / 提供者键（缺席或求值抛错） */
  readonly missing: keyof ErbCompletionTables;
  /** 一句中文说明（含「缺席 / 抛错」「已跳过」「不猜」） */
  readonly reason: string;
}

/** 降级回调（`installErbCompletion` 可选第三参注入；便于测试直接断言，不依赖真 Monaco） */
export type ErbCompletionDegradeReporter = (degrade: ErbCompletionDegrade) => void;

/* ============================== resolve 反查：候选身份 → 数据出处 ============================== */

/**
 * 一条候选的**出处**（provide 时登记、resolve 时按对象身份取回）。与 kojo 侧同构、**各自一套**
 * （两条 seam 不互相 import：语言不同、表不同、失效判据不同，合并只会在将来互相绊住）。
 *
 * 反查键用**对象身份**而不是往候选上挂私有字段：Monaco 的 suggest 模型把我们返回的那个
 * 对象原样存进 `CompletionItem.completion`，`resolve` 时同一引用交回（standalone 无跨进程
 * 序列化，身份可靠），随后 `Object.assign(this.completion, 解析结果)` 只会合并协议字段。
 * `WeakMap` 键随弹层销毁回收，无界增长为零。
 */
export interface ErbCompletionProvenance {
  readonly sourceId: string;
  /** 候选 label 原文（= 回各张表的主键） */
  readonly label: string;
  /** **本次 provide 的表快照**（resolve 不重取：项目若在弹层存续期切换，两张表拼出的中文名是假信息） */
  readonly tables: ErbCompletionTables;
}

/** 候选身份 → 出处 的登记表（每次装配一枚） */
export interface ErbCompletionProvenanceStore {
  register(item: Monaco.languages.CompletionItem, provenance: ErbCompletionProvenance): void;
  lookup(item: Monaco.languages.CompletionItem): ErbCompletionProvenance | undefined;
}

export function createErbCompletionProvenanceStore(): ErbCompletionProvenanceStore {
  const byItem = new WeakMap<object, ErbCompletionProvenance>();
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

/** `resolve` 阶段的懒填充产物（只动 Monaco 认的 `detail` / `documentation`） */
export interface ErbCompletionResolution {
  readonly detail?: string;
  readonly documentation?: { readonly value: string };
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
): readonly KojoCallSlot[] | undefined {
  if (protocol === undefined) return undefined;
  for (const key of keys) {
    if (key === undefined || key.length === 0) continue;
    try {
      const slots = protocol.slotsFor(key);
      // 空数组（协议声明"无槽"）是**命中**：`if (slots)` 只对 `null` / `undefined`（不认）落空
      if (slots) return slots;
    } catch (e: unknown) {
      console.warn(`[erb-completion] 调用协议对 '${key}' 求槽抛错：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return undefined;
}

/** 签名详情行；取不到槽 ⇒ `undefined`（不进文档） */
function signatureLine(
  display: string,
  keys: readonly (string | undefined)[],
  protocol: KojoCallProtocol | undefined,
): string | undefined {
  const slots = slotsForCallee(protocol, keys);
  if (slots === undefined) return undefined;
  return `调用签名 \`${describeCallSignature(display, slots, 0).label}\``;
}

/**
 * 只有**括号调用形态**（`insertText` 恰为 `名字(`）才改写成 snippet —— ERB 侧即
 * `erb-system-functions` 一路（`GETBIT(` 这类表达式里的引擎原语）。
 *
 * `erb-functions` 一路**刻意不做**：它的候选落在 `@名字` 定义位与 `CALL 名字` 调用位，
 * 那里跟的是**逗号实参**而非括号，插 `名字(…)` 会产非法形态（槽再多也不改插入形态——
 * 把签名写进详情，让作者自己填，才是这条 seam 认得的部分）。
 */
const ERB_CALL_FORM_SOURCE_IDS: ReadonlySet<string> = new Set(['erb-system-functions']);

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
function insertAsSnippetRule(monaco: typeof Monaco): Monaco.languages.CompletionItemInsertTextRule | undefined {
  const rules = monaco.languages.CompletionItemInsertTextRule as unknown as Record<string, unknown> | undefined;
  const value = rules?.InsertAsSnippet;
  return typeof value === 'number' ? (value as Monaco.languages.CompletionItemInsertTextRule) : undefined;
}

/** 调用形态候选 → snippet（原地改；不改写即完全保持今天的纯文本插入） */
export function applyCallSnippet(
  monaco: typeof Monaco,
  item: Monaco.languages.CompletionItem,
  provenance: ErbCompletionProvenance,
  charAfterRangeValue: string | undefined,
): boolean {
  if (!ERB_CALL_FORM_SOURCE_IDS.has(provenance.sourceId)) return false;
  const insertText = typeof item.insertText === 'string' ? item.insertText : undefined;
  if (insertText === undefined || insertText !== `${provenance.label}(`) return false;
  if (charAfterRangeValue === '(') return false;
  const rule = insertAsSnippetRule(monaco);
  if (rule === undefined) return false;
  const snippet = buildCallSnippetText(
    provenance.label,
    slotsForCallee(provenance.tables.callProtocol, [provenance.label]),
  );
  if (snippet === undefined) return false;
  item.insertText = snippet;
  item.insertTextRules = rule;
  return true;
}

/* ============================== resolve：按出处回表填详情 ============================== */

/** `VariableInfo.source` → 名表面可读说法（契约层跨游戏术语） */
const VARIABLE_SOURCE_LABEL: Readonly<Record<string, string>> = {
  primary: '主名表',
  append: '追加名表',
  const: '具名常量',
};

/** 候选 `detail`（`族` / `族:编号`，由 `erb-variables` 写入）里的族头 */
function familyFromDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const head = detail.split(':')[0];
  return head !== undefined && head.length > 0 ? head : undefined;
}

function entriesOf(schema: VariableSchema | undefined, family: string): readonly VariableInfo[] | undefined {
  const enumerate = schema?.names;
  if (typeof enumerate !== 'function') return undefined;
  try {
    return enumerate(family);
  } catch {
    return undefined;
  }
}

function bitsLine(bits: VariableInfo['bits']): string | undefined {
  if (bits === undefined || bits.length === 0) return undefined;
  const shown = bits.slice(0, 12).map((b) => `${String(b.bit)} ${b.label}`).join('、');
  return `位表 ${shown}${bits.length > 12 ? ' …' : ''}（共 ${String(bits.length)} 项）`;
}

/** 变量名候选的详情：编号 / 说明 / 名表来源 / 位表（全来自 `variableSchema`，一条查不到就不写） */
function variableDetail(label: string, detail: string | undefined, tables: ErbCompletionTables): ErbCompletionResolution | undefined {
  const family = familyFromDetail(detail) ?? tables.dictionary?.resolveFamily?.(label);
  if (family === undefined) return undefined;
  const entry = entriesOf(tables.variableSchema, family)?.find((e) => e.name === label);
  if (entry === undefined) return undefined;
  const facts: string[] = [];
  const index: number | string | undefined = entry.index ?? entry.resolvedIndex;
  if (index !== undefined) facts.push(`编号 \`${String(index)}\``);
  if (entry.description !== undefined && entry.description.length > 0) facts.push(entry.description);
  const tier = entry.source === undefined ? undefined : VARIABLE_SOURCE_LABEL[entry.source];
  if (tier !== undefined) facts.push(`来源 ${tier}`);
  const bits = bitsLine(entry.bits);
  if (bits !== undefined) facts.push(bits);
  if (facts.length === 0) return undefined;
  return { documentation: { value: [`**${label}** · \`${family}\` 索引名`, ...facts].join('\n\n') } };
}

/** 项目函数候选的详情：中文名（库表反查面）+ 调用签名（协议）；两张表都不认 ⇒ 无详情 */
function functionDetail(label: string, tables: ErbCompletionTables): ErbCompletionResolution | undefined {
  const facts: string[] = [];
  let cn: string | undefined;
  try {
    cn = tables.libraryTable?.lookupByFunction?.(label);
  } catch {
    cn = undefined;
  }
  if (cn !== undefined && cn.length > 0) facts.push(`中文名 ${cn}`);
  const sig = signatureLine(label, [label], tables.callProtocol);
  if (sig !== undefined) facts.push(sig);
  if (facts.length === 0) return undefined;
  return { documentation: { value: [`**${label}** · 项目函数`, ...facts].join('\n\n') } };
}

/** 系统函数候选的详情：中文名（语言层反向表）+ 调用签名 */
function systemFunctionDetail(label: string, tables: ErbCompletionTables): ErbCompletionResolution | undefined {
  const cn = SYSTEM_FUNCTION_REVERSE.get(label);
  if (cn === undefined) return undefined;
  const facts = [signatureLine(label, [label], tables.callProtocol)].filter((s): s is string => s !== undefined);
  return { documentation: { value: [`**${label}** ↔ ${cn}`, ...facts].join('\n\n') } };
}

/**
 * `resolveCompletionItem` 的**纯**内核（可单测）：按出处回表算详情。
 *
 * 不产详情的三种情形一律返回 `undefined`（候选原样交回，**不抛、不编**）：本装配点不认的
 * source id（后来追加的 source ⇒ 让它自己声明详情）、表缺席、表里查不到这条事实。
 * `erb-directives` / `erb-labels` 走 `undefined` 分支——前者的中文说法**不在任何注入的表里**
 * （app 不得硬编码 ERB 词表），后者是本文件标签、本就无表可查。
 */
export function resolveErbCompletionDetail(
  item: Monaco.languages.CompletionItem,
  provenance: ErbCompletionProvenance,
): ErbCompletionResolution | undefined {
  const tables = provenance.tables;
  try {
    switch (provenance.sourceId) {
      case 'erb-variables':
        return variableDetail(provenance.label, typeof item.detail === 'string' ? item.detail : undefined, tables);
      case 'erb-functions':
        return functionDetail(provenance.label, tables);
      case 'erb-system-functions':
        return systemFunctionDetail(provenance.label, tables);
      default:
        return undefined;
    }
  } catch (e: unknown) {
    console.warn(`[erb-completion] resolve '${provenance.sourceId}' 抛错：${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
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

/* ============================== 变量 / 函数 / 标签 / 系统函数（EC-2..EC-5） ============================== */

/**
 * 变量族 + 具名索引补全（EC-2）：`CFLAG:` → 名字表、`CFLAG:TARGET:` → 名字。
 * 纯函数住在 `erb-completion-variables.ts`（族头白名单 = `ENGINE_VARIABLE_FAMILIES` 单一真源）。
 * `variableSchema` 缺席 ⇒ 该纯函数返回 `[]`（不猜）。
 */
const VARIABLES_SOURCE: ErbCompletionSource = {
  id: 'erb-variables',
  requires: 'variableSchema',
  provide({ monaco, model, position, tables }): Monaco.languages.CompletionItem[] {
    return erbVariableCompletionItems(monaco, model, position, tables.variableSchema);
  },
};

/**
 * 函数名补全（EC-3）：`@` 定义位 / `CALL` 系调用位。名字由宿主注入的
 * `erbFunctionNames`（按 `ErbIndex.fingerprint` 记忆化）取用；缺席 ⇒ `[]`（不猜）。
 * 纯函数内已做按数组身份记忆化的前缀二分索引（10 万条量级 O(log n + 命中数)）。
 */
const FUNCTIONS_SOURCE: ErbCompletionSource = {
  id: 'erb-functions',
  requires: 'erbFunctionNames',
  provide({ monaco, model, position, tables }): Monaco.languages.CompletionItem[] {
    return erbFunctionCompletionItems(monaco, model, position, tables.erbFunctionNames?.());
  },
};

/**
 * `$标签` 补全（EC-4）：仅 `GOTO` / `JUMP` 后出货本文件标签（无模块系统 ⇒ 跨文件不做）。
 * 标签来自当前 model 全文（纯函数内部扫，不读盘、不查索引）。
 */
const LABELS_SOURCE: ErbCompletionSource = {
  id: 'erb-labels',
  provide({ monaco, model, position }): Monaco.languages.CompletionItem[] {
    return erbLabelCompletionItems(monaco, model, position);
  },
};

/**
 * 系统函数名补全（EC-5）：英文名（`GETBIT(`），词表**只读派生**自 kojo-sugar 的
 * `SYSTEM_FUNCTION_REVERSE`（与 `.kojo` 侧同一张表，反向：那边插中文名、这边插英文名）。
 * 纯函数内已排除行首指令位 / 注释行 / 字符串内。
 */
const SYSTEM_FUNCTIONS_SOURCE: ErbCompletionSource = {
  id: 'erb-system-functions',
  provide({ monaco, model, position }): Monaco.languages.CompletionItem[] {
    return erbSystemFunctionCompletionItems(monaco, model, position);
  },
};

/**
 * 位补全（D7）：`GETBIT(变量, 位)` / `SETBIT|CLEARBIT|INVERTBIT 变量, 位` 的**第二实参坑**
 * 出货该变量位表（`VariableInfo.bits`）里的位号 + 中文位名。位表由 adapter 提供
 * （`variableSchema`）；无表 / 无位表 / 位坑已有内容（含写成变量）⇒ 零候选（不猜）。
 */
const BITS_SOURCE: ErbCompletionSource = {
  id: 'erb-bits',
  requires: 'variableSchema',
  provide({ monaco, model, position, tables }): Monaco.languages.CompletionItem[] {
    return erbBitCompletionItems(monaco, model, position, tables.variableSchema);
  },
};

/**
 * 全部补全来源（**稳定扩展点**）。各 source **独立文件 + 各自纯函数**，此处只做一行接线；
 * 装配点与排序/去重口径零改动（去重按 label、先注册者胜；排名 `前缀精确 > 前缀命中 > 其它`）。
 *
 * `erb-snippet`（R4）注册在**最前**：行首位置的块骨架与 `erb-directives` 的同名纯文本
 * 项按 label 去重（先注册者胜）⇒ 行首只留骨架、行中纯文本照旧（见 snippet 模块头注）。
 */
export const ERB_COMPLETION_SOURCES: ErbCompletionSource[] = [
  ERB_SNIPPET_SOURCE,
  DIRECTIVES_SOURCE,
  VARIABLES_SOURCE,
  FUNCTIONS_SOURCE,
  LABELS_SOURCE,
  SYSTEM_FUNCTIONS_SOURCE,
  BITS_SOURCE,
];

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

/**
 * 报**一次**降级信号（同一 `(来源 id, 缺键)` 在一次装配内只报一次；去重表随装配句柄创建）。
 * 双通道：`onDegrade` 回调（可断言）+ 一行 `console.warn`（运行时可读）——**不静默**。
 */
function reportDegrade(
  reported: Set<string>,
  sourceId: string,
  missing: keyof ErbCompletionTables,
  onDegrade: ErbCompletionDegradeReporter | undefined,
  detail: string,
): void {
  const dedupKey = `${sourceId}:${missing}`;
  if (reported.has(dedupKey)) return;
  reported.add(dedupKey);
  const reason = `来源 '${sourceId}' 依赖的适配器能力 '${missing}' ${detail}，已跳过该来源（不猜）`;
  console.warn(`[erb-completion] 降级：${reason}`);
  onDegrade?.({ sourceId, missing, reason });
}

/** 某来源的 `requires` 依赖在当次 `tables` 中是否缺席（`undefined` / `null`）；缺席则返回该键 */
function missingRequirement(
  source: ErbCompletionSource,
  tables: ErbCompletionTables,
): keyof ErbCompletionTables | undefined {
  const key = source.requires;
  if (key === undefined) return undefined;
  const value = tables[key];
  return value === undefined || value === null ? key : undefined;
}

/**
/**
 * 位置门的候选过滤器（T6）：门是**过滤**不是重排——各 source 的既有排序语义不动。
 * - `'call-target'`：只留**函数名形态**的候选（kind = Function / Method，按 kind 而非
 *   source 名单判——新 source 出函数名候选即自动进门，扩展点结构不破坏）；
 * - 其余门类：不过滤（维持现行为）。
 */
function gateFilter(
  gate: ErbCompletionGate,
  monaco: typeof Monaco,
): ((item: Monaco.languages.CompletionItem) => boolean) | undefined {
  if (gate !== 'call-target') return undefined;
  const fnKinds = new Set<number>([monaco.languages.CompletionItemKind.Function, monaco.languages.CompletionItemKind.Method]);
  return (item) => {
    const kind = typeof item.kind === 'number' ? item.kind : undefined;
    return kind !== undefined && fnKinds.has(kind);
  };
}

/**
 * 依次问各 source，按 label 去重（先注册者胜），再按排名键排序并写回 `sortText`。
 *
 * `provenance`（**可选末参，additive**）：对**最终交出去的那个对象引用**登记出处——
 * `{...item, sortText}` 造的是新对象，登记原对象会让 resolve 的反查必然落空。
 */
function mergeSuggestions(
  sources: readonly ErbCompletionSource[],
  ctx: ErbCompletionSourceContext,
  prefix: string,
  reported: Set<string>,
  onDegrade: ErbCompletionDegradeReporter | undefined,
  keep: ((item: Monaco.languages.CompletionItem) => boolean) | undefined,
  provenance?: ErbCompletionProvenanceStore,
): Monaco.languages.CompletionItem[] {
  const byLabel = new Map<string, { item: Monaco.languages.CompletionItem; sourceId: string }>();
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
      console.warn(`[erb-completion] source '${source.id}' provide 抛错：${msg}`);
      // 抛错即视为缺：带 `requires` 的来源按该键报一次降级
      if (source.requires !== undefined) {
        reportDegrade(reported, source.id, source.requires, onDegrade, `求值抛错（${msg}）`);
      }
      continue;
    }
    // 位置门在**去重前**逐 source 过滤：keyword 形态的候选不得占掉函数名候选的先注册位
    if (keep !== undefined) items = items.filter(keep);
    for (const item of items) {
      const label = labelText(item.label);
      if (!byLabel.has(label)) byLabel.set(label, { item, sourceId: source.id });
    }
  }
  return [...byLabel.values()]
    .map((entry) => ({ entry, key: rankKey(entry.item, prefix) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ entry, key }) => {
      const final: Monaco.languages.CompletionItem = { ...entry.item, sortText: key };
      provenance?.register(final, { sourceId: entry.sourceId, label: labelText(entry.item.label), tables: ctx.tables });
      return final;
    });
}

/* ============================== 装配点 ============================== */

/**
 * 为 `.erb` / `.erh`（`ERB_LANGUAGE_ID`）注册**一个**补全 provider。
 * `triggerCharacters` 保守：只取指令记号 `#` 与区间标记 `[`（不打扰常规输入）。
 * `getTables` 每次补全时才调用（表按当前项目 adapter 实时取，同 hover 纪律）。
 * 返回可释放句柄——宿主在编辑器卸载时 `dispose()`。
 *
 * `onDegrade`（**可选第三参，additive**——旧调用方零改动）：某来源因依赖表 / 提供者缺席
 * （或求值抛错）被跳过时**首次**回调一次；去重表随本句柄创建（**不做模块级全局去重**，
 * 否则第二次 install 会吞掉信号 ⇒ 三态不可复跑）。不传 `onDegrade` 时降级仍以一行
 * `console.warn` 可见。
 *
 * 与 kojo 侧同构地补上"完整"两件事（全部收口在本装配点，宿主零改动）：
 * `resolveCompletionItem` 懒填详情（候选对象身份 → 出处走 `WeakMap` 反查），以及
 * **括号调用形态**候选按 `callProtocol` 插成带 tabstop 的 snippet。取不到槽 ⇒ 纯文本照旧。
 */
export function installErbCompletion(
  monaco: typeof Monaco,
  getTables: () => ErbCompletionTables,
  onDegrade?: ErbCompletionDegradeReporter,
): Monaco.IDisposable {
  const reported = new Set<string>();
  const provenance = createErbCompletionProvenanceStore();
  return monaco.languages.registerCompletionItemProvider(ERB_LANGUAGE_ID, {
    triggerCharacters: ['#', '['],
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber);
      // 位置门（T6）：字符串 / FORM 串内不给代码补全；CALL 系名字位只给函数名候选；
      // 其余位置维持现行为。判定先于 range（串内零候选，不劳各 source 出货一遍）。
      const gate = erbCompletionGate(line, position.column);
      if (gate === 'in-string') return { suggestions: [] };
      const range = erbTokenRange(model, position);
      const prefix = line.slice(range.startColumn - 1, range.endColumn - 1);
      const tables = getTables();
      const suggestions = mergeSuggestions(
        ERB_COMPLETION_SOURCES,
        { monaco, model, position, range, tables },
        prefix,
        reported,
        onDegrade,
        gateFilter(gate, monaco),
        provenance,
      );
      // 调用形态候选 → snippet：只有 `erb-system-functions` 一路可能命中 ⇒ 先按 source id 过滤，
      // 再按行号记忆化取行文本（候选就在光标行，`line` 已取过 ⇒ 常态一次也不额外取）
      let lineAt = position.lineNumber;
      let lineText = line;
      for (const item of suggestions) {
        const hit = provenance.lookup(item);
        if (hit === undefined || !ERB_CALL_FORM_SOURCE_IDS.has(hit.sourceId)) continue;
        const box = candidateRange(item.range);
        if (box === undefined) continue;
        if (box.endLineNumber !== lineAt) {
          lineAt = box.endLineNumber;
          lineText = model.getLineContent(lineAt);
        }
        applyCallSnippet(monaco, item, hit, charAfterRange(lineText, box));
      }
      return { suggestions };
    },
    resolveCompletionItem(item) {
      const hit = provenance.lookup(item);
      if (hit === undefined) return item; // 不是本装配点产出的候选 ⇒ 原样交回（不猜）
      const resolved = resolveErbCompletionDetail(item, hit);
      if (resolved === undefined) return item;
      if (resolved.detail !== undefined && item.detail === undefined) item.detail = resolved.detail;
      if (resolved.documentation !== undefined) item.documentation = resolved.documentation;
      return item;
    },
  });
}
