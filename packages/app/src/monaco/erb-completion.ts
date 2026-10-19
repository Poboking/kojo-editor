import type * as Monaco from './entry';
import type { ErbIndex } from '@kojo/plugin-api';
import { SYSTEM_FUNCTION_REVERSE } from '@kojo/plugin-kojo-sugar';
import { ERB_DIRECTIVES, ERB_LANGUAGE_ID, mergeDirectiveWords } from './erb-language';
import { erbBitCompletionItems } from './erb-completion-bits';
import { erbCompletionGate, ERB_GATE_SOURCE_WHITELIST, ERB_JUMP_KEYWORDS } from './erb-completion-context';
import { erbDeclaredCompletionItems } from './erb-completion-declared';
import { erbFamilyCompletionItems } from './erb-completion-families';
import { erbFunctionCompletionItems, erbFunctionNameSlot } from './erb-completion-functions';
import { erbLabelCompletionItems } from './erb-completion-labels';
import { erbSystemFunctionCompletionItems } from './erb-completion-system-functions';
import { erbVariableCompletionItems } from './erb-completion-variables';
import { erbWordCompletionItems } from './erb-completion-words';
import { ERB_SNIPPET_SOURCE } from './erb-completion-snippets';
import { errorText } from '@kojo/plugin-api';
import { isAllBlank } from './kojo-completion-position';
import {
  applyCallSnippet,
  buildCallSnippetText,
  candidateRange,
  charAfterRange,
  createCompletionProvenanceStore,
  escapeSnippetText,
  installCompletion,
  mergeSuggestions,
  projectFunctionDetail,
  rankKey,
  signatureLine,
  slotsForCallee,
  variableDetail,
  type CompletionAssembly,
  type CompletionDegrade,
  type CompletionDegradeReporter,
  type CompletionProvenance,
  type CompletionProvenanceStore,
  type CompletionResolution,
  type CompletionSource,
  type CompletionSourceContext,
  type CompletionTables,
} from './completion-core';

/**
 * `.erb` 方言补全的**候选册**（宿主层：只声明"有哪些源 + 位置怎么判 + 详情回哪张表"）。
 *
 * COMPL-SHARED 之后：装配实现（合并 / 去重 / 排序 / 上限 / 降级 / provenance / snippet /
 * provider 注册）与 `.kojo` **共用** `completion-core.ts` 的那一份，本文件不再复制任何一条分支。
 * 语言侧只剩三件事：
 *
 * 1. **候选源集合** `ERB_COMPLETION_SOURCES`（可扩展数组，新增能力 = 追加一项）；
 * 2. **位置判定**：{@link erbTokenRange}（记号级替换区间）、{@link isLineHeadContext}（行首 / 行中分野）、
 *    {@link erbCompletionGate}（八态位置门 v2：串内置空、名字位收窄）与**按候选源白名单**的
 *    keep 滤器（数据 = `ERB_GATE_SOURCE_WHITELIST`，位置侧单源；`default` 不过滤）；
 * 3. **回表口径**：`resolveErbCompletionDetail`（变量 / 项目函数 / 系统函数三条路）与
 *    **括号调用形态**名单（只有 `erb-system-functions` 一路插 `名字(`）。
 *
 * 数据源两层（与 `.kojo` 同纪律：**不猜**）：
 * - **语言层**（跨游戏、与项目无关）：`erb-directives` —— 指令 / 预处理指令 / 指令行，词表
 *   **派生**自 `erb-language.ts` 的单一真源 `ERB_DIRECTIVES`；adapter 指令名经
 *   `mergeDirectiveWords` 并入（与 Monarch 高亮刷新**同一个合并件**，大小写不敏感去重）；
 *   行首候选按**全记号前缀**（含吞并的 `#` / `[`）收窄；
 * - **adapter / 项目层**：`CompletionTables`（与 `.kojo` 同一张表，宿主只读不解释）——
 *   函数名（`erbFunctionNames`）由宿主按 `ErbIndex.fingerprint` 记忆化后注入，同一份表
 *   现在**也被 `.kojo` 消费**（跨语言候选打通）；变量族头 = `ENGINE_VARIABLE_FAMILIES`
 *   （`erb-families`）；`#DIM` 声明名走 `erbFileFacts` 解析器通道（`erb-declared`，
 *   未索引零候选不回退）。
 *
 * 纯逻辑与 Monaco 绑定分离：`CompletionSource.provide` 可单测（只依赖 ctx 里的
 * `model` / `position` / `range` / `tables`），装配点只做协议翻译。
 * 二段式供给同 `.kojo`：详情延到 `resolveCompletionItem` 回表算，括号调用形态候选按
 * `callProtocol` 插成带 tabstop 的 snippet。
 */

/* ============================== 契约别名（两语言并一后同一套类型；旧名零改动） ============================== */

/** `.erb` 侧的表 = 共享表（历史上叫 `ErbCompletionTables`；并一后只是别名，字段与 `.kojo` 同源） */
export type ErbCompletionTables = CompletionTables;
export type ErbCompletionSource = CompletionSource;
export type ErbCompletionSourceContext = CompletionSourceContext;
export type ErbCompletionDegrade = CompletionDegrade;
export type ErbCompletionDegradeReporter = CompletionDegradeReporter;
export type ErbCompletionProvenance = CompletionProvenance;
export type ErbCompletionProvenanceStore = CompletionProvenanceStore;
export type ErbCompletionResolution = CompletionResolution;
export { createCompletionProvenanceStore as createErbCompletionProvenanceStore };

/* ============================== 语言侧的回表口径（详情 / 调用形态） ============================== */

const ERB_LOG_TAG = '[erb-completion]';

/**
 * 只有**括号调用形态**（`insertText` 恰为 `名字(`）才改写成 snippet —— ERB 侧即
 * `erb-system-functions` 一路（`GETBIT(` 这类表达式里的引擎原语）。
 *
 * `erb-functions` 一路**刻意不做**：它的候选落在 `@名字` 定义位与 `CALL 名字` 调用位，
 * 那里跟的是**逗号实参**而非括号，插 `名字(…)` 会产非法形态（槽再多也不改插入形态——
 * 把签名写进详情，让作者自己填，才是这条 seam 认得的部分）。
 */
const ERB_CALL_FORM_SOURCE_IDS: ReadonlySet<string> = new Set(['erb-system-functions']);

/** `.erb` 口径的 snippet 改写：调用形态名单由本语言声明，改写实现在装配核（一份） */
export function applyErbCallSnippet(
  monaco: typeof Monaco,
  item: Monaco.languages.CompletionItem,
  provenance: ErbCompletionProvenance,
  charAfter: string | undefined,
): boolean {
  return applyCallSnippet(
    monaco,
    item,
    provenance,
    charAfter,
    { sourceIds: ERB_CALL_FORM_SOURCE_IDS },
    ERB_LOG_TAG,
  );
}

/** `.erb` 口径的取槽（引擎原语只有原生名这一面）；实现在装配核 */
export function erbSlotsForCallee(
  protocol: ErbCompletionTables['callProtocol'],
  keys: readonly (string | undefined)[],
): ReturnType<typeof slotsForCallee> {
  return slotsForCallee(protocol, keys, ERB_LOG_TAG);
}

/** 系统函数候选的详情：中文名（语言层反向表）+ 调用签名（ERB 独有的一路） */
function systemFunctionDetail(label: string, tables: ErbCompletionTables): ErbCompletionResolution | undefined {
  const cn = SYSTEM_FUNCTION_REVERSE.get(label);
  if (cn === undefined) return undefined;
  const facts = [signatureLine(label, [label], tables.callProtocol, ERB_LOG_TAG)].filter(
    (s): s is string => s !== undefined,
  );
  return { documentation: { value: [`**${label}** ↔ ${cn}`, ...facts].join('\n\n') } };
}

/**
 * `resolveCompletionItem` 的**纯**内核（可单测）：按出处回表算详情。
 *
 * 不产详情的三种情形一律返回 `undefined`（候选原样交回，**不抛、不编**）：本装配点不认的
 * source id（后来追加的 source ⇒ 让它自己声明详情）、表缺席、表里查不到这条事实。
 * `erb-directives` / `erb-labels` 走 `undefined` 分支——前者的中文说法**不在任何注入的表里**
 * （app 不得硬编码 ERB 词表），后者是本文件标签、本就无表可查。
 * 变量与项目函数两路**直接吃装配核的共用构造器**（与 `.kojo` 同一份实现、同一份措辞）。
 */
export function resolveErbCompletionDetail(
  item: Monaco.languages.CompletionItem,
  provenance: ErbCompletionProvenance,
): ErbCompletionResolution | undefined {
  const tables = provenance.tables;
  const label = provenance.label;
  try {
    switch (provenance.sourceId) {
      case 'erb-variables':
        return variableDetail(label, typeof item.detail === 'string' ? item.detail : undefined, tables, '索引名');
      case 'erb-functions':
        return projectFunctionDetail(label, tables, ERB_LOG_TAG);
      case 'erb-system-functions':
        return systemFunctionDetail(label, tables);
      default:
        return undefined;
    }
  } catch (e: unknown) {
    console.warn(`${ERB_LOG_TAG} resolve '${provenance.sourceId}' 抛错：${errorText(e)}`);
    return undefined;
  }
}

/* ============================== 行首 / 行中判定（ERB 独有的位置语义） ============================== */

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
 *
 * 空白口径走**单源** `isAllBlank`（= `kojo-sugar` lexer 的 `[ \t\u3000]`，全角空格算缩进）；
 * 此前这里是第四套手抄 `/^\s*$/`。口径差集里唯一可能出现在行文本内的是 U+00A0：真实语料
 * 3818 个 `.ERB` 零命中、且单源测试明确钉 NBSP 判假 ⇒ 统一按**非空白**处理（不再特判保留）。
 */
export function isLineHeadContext(model: Monaco.editor.ITextModel, position: Monaco.Position): boolean {
  const line = model.getLineContent(position.lineNumber);
  const range = erbTokenRange(model, position);
  return isAllBlank(line.slice(0, range.startColumn - 1));
}

/**
 * 位置门的候选过滤器（T6 · v2）：门是**过滤**不是重排——各 source 的既有排序语义不动。
 * 口径 = **按候选源白名单**（数据 = `ERB_GATE_SOURCE_WHITELIST`，位置侧单源）：名字位
 * （`call-target` / `def-slot` / …）只留该位认的 source。旧口径按候选 **kind** 过滤
 * （`Function` / `Method`）分不开「同 kind 不同源」——系统函数与项目函数同为 `Function`，
 * 旧口径在 `CALL` / `@` / `#` / `[` / `JUMP` 位漏进整张系统函数表（缺陷 2 的根因）。
 * `default` / `in-string` 不设名单（`in-string` 由 {@link ERB_COMPLETION_ASSEMBLY.locate}
 * 整轮置空）。
 */
function gateKeepFor(
  gate: ReturnType<typeof erbCompletionGate>,
): ((item: Monaco.languages.CompletionItem, sourceId: string) => boolean) | undefined {
  const allowed = ERB_GATE_SOURCE_WHITELIST[gate];
  if (allowed === undefined) return undefined;
  return (_item, sourceId) => allowed.has(sourceId);
}

/* ============================== 语言层 source ============================== */

/**
 * **必须行首**的预处理指令（`#DIM` / `#FUNCTION` …）。这些名字不出现在表达式里，
 * 故只进「行首」候选集，绝不在行中弹出。
 */
const ERB_PREPROCESSOR_DIRECTIVES = [
  // 真实语料计数（画蛇添足 4.980，ERB/ 全量）：#DIM 19,653 / #DIMS 8,439 / #FUNCTION 2,499 /
  // #FUNCTIONS 1,922 / #DEFINE 22。`#DIMSA` / `#DIMF` 引擎与 scanner 都不认（旧表把两者
  // 当成指令，选下去只会得到一条错行）；`#DIMSTR` / `#DIMCHAR` 合法但语料零命中，留作方言覆盖。
  // `#DIM CONST|SAVEDATA|GLOBAL` 是**同一条指令 + 修饰词**（scanner 的 DIM_MODIFIERS），
  // 补全给出整段前缀，作者少打一段、也不会写出引擎不认的 `#DIMCONST`。
  '#DIM', '#DIM CONST', '#DIM SAVEDATA', '#DIM GLOBAL',
  '#DIMS', '#DIMSTR', '#DIMCHAR',
  '#FUNCTION', '#FUNCTIONS', '#DEFINE', '#INCLUDE', '#ONLY',
];
/** **必须行首**的区间标记行（`[SKIPSTART]` 起、`[SKIPEND]` 止）。 */
const ERB_BRACKET_DIRECTIVES = ['[SKIPSTART]', '[SKIPEND]'];

/**
 * 「行中」可出现的**关键字子集**（可出现在表达式 / 实参里）：控制流分支与闭合、循环、
 * 调用 / 跳转、`PRINT*` 家族。`PRINT*` 从 `ERB_DIRECTIVES` **派生**（单一真源，不手抄）；
 * 跳转家族从 {@link ERB_JUMP_KEYWORDS} **单源展开**（与位置门 / 标签位判据同一份清单
 * ——手写的 `'JUMP'` / `'TRYJUMP'` 两个字面量此前漏收了 `GOTO` / `TRYGOTO`，行中补不到）。
 */
const ERB_MIDLINE_KEYWORDS: readonly string[] = [
  'IF', 'ELSEIF', 'ELSE', 'ENDIF', 'SIF',
  'WHILE', 'WEND',
  'SELECTCASE', 'CASE', 'CASEELSE', 'ENDSELECT',
  'RETURN', 'BREAK', 'CONTINUE',
  'CALL', 'CALLF', 'CALLL', 'CALLFORM', 'CALLFORML', 'CALLFORMF',
  ...ERB_JUMP_KEYWORDS,
  'TRYCALL', 'TRYCALLFORM', 'TRYCALLFORMF', 'TRYCCALLFORM',
  ...ERB_DIRECTIVES.filter((d) => d.startsWith('PRINT')),
];

/**
 * 指令 / 关键字补全：**行首**给 `ERB_DIRECTIVES` + adapter 指令名 + 预处理指令 + 区间标记行
 * （按全记号前缀收窄）；**行中**只给表达式 / 实参可出现的关键字子集（`#DIM` 这类必须行首的不出现）。
 *
 * 词表来自 `erb-language.ts` 的 `ERB_DIRECTIVES`（高亮与补全**同一份清单**，不另抄）；
 * adapter 指令名（`instructionTable.names()`，可选能力）经 `mergeDirectiveWords` 并入
 * ——与 Monarch 高亮刷新**同一个合并件、同一大小写不敏感去重口径**，detail 同为 `指令`；
 * 表 / `names` / 求值任一缺席或抛错 ⇒ 只用静态表（**别让 seam 崩**）。
 *
 * 行首再按**全记号前缀**过滤（前缀 = `erbTokenRange` 的替换区间文本，含吞并的 `#` / `[`）：
 * 打 `#DI` 只弹 `#DIM*`、打 `[SKIP` 只弹 `[SKIPSTART]`、打 `PR` 只弹 `PRINT*`——字表里的
 * `GETBIT` 这类指令词不再在 `#` / `[` 记号位抢候选（位置门白名单只保证"只问 erb-directives"，
 * 字表内收窄是本源的责任；各行首源与其余名字位源同法）。空前缀（裸行首 / Ctrl+Space）不过滤。
 * 行中分支**不动**（子集本就窄，既有钉住行为不重排）。
 */
const DIRECTIVES_SOURCE: ErbCompletionSource = {
  id: 'erb-directives',
  provide({ monaco, model, position, range, tables }): Monaco.languages.CompletionItem[] {
    const items: Monaco.languages.CompletionItem[] = [];
    const seen = new Set<string>();
    // 大小写不敏感去重（Emuera 关键字大小写不敏感；与 mergeDirectiveWords 同口径）
    const push = (label: string, detail: string): void => {
      const key = label.toUpperCase();
      if (seen.has(key)) return;
      seen.add(key);
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
      // 与 `locate` 的 prefix 同式（同区间、同切片）：全记号含 `#` / `[`
      const prefix = model.getLineContent(position.lineNumber).slice(range.startColumn - 1, range.endColumn - 1).toUpperCase();
      const hit = (label: string): boolean => prefix.length === 0 || label.toUpperCase().startsWith(prefix);
      let adapterNames: readonly string[] | undefined;
      try {
        const raw = tables.instructionTable?.names?.();
        adapterNames = Array.isArray(raw) ? raw : undefined;
      } catch {
        adapterNames = undefined; // 表求值抛错 ⇒ 只用静态表（不崩整轮，不静默丢弃其余源候选）
      }
      for (const d of mergeDirectiveWords(ERB_DIRECTIVES, adapterNames)) if (hit(d)) push(d, '指令');
      for (const d of ERB_PREPROCESSOR_DIRECTIVES) if (hit(d)) push(d, '预处理指令');
      for (const d of ERB_BRACKET_DIRECTIVES) if (hit(d)) push(d, '指令行');
    } else {
      for (const k of ERB_MIDLINE_KEYWORDS) push(k, '关键字');
    }
    return items;
  },
};

/* ============================== 变量 / 函数 / 标签 / 系统函数 / 位（EC-2..EC-5、D7） ============================== */

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
 * 纯函数内已做按数组身份记忆化的前缀二分索引（10 万条量级 O(log n + 命中数)）——
 * 那枚引擎与 `.kojo` 的 `kojo-functions` **共用**（`completion-core.projectFunctionCandidates`）。
 */
const FUNCTIONS_SOURCE: ErbCompletionSource = {
  id: 'erb-functions',
  requires: 'erbFunctionNames',
  provide({ monaco, model, position, tables }): Monaco.languages.CompletionItem[] {
    return erbFunctionCompletionItems(monaco, model, position, tables.erbFunctionNames?.());
  },
};

/**
 * `$标签` 补全（EC-4）：仅 `GOTO` / `JUMP`（跳转家族）后出货本文件标签（无模块系统 ⇒ 跨文件不做）。
 * 第 4 参 = 解析器事实通道 `tables.erbFileFacts`（labels 模块同批扩了可选第 4 参：
 * `labelsAt(path, line)` —— 未索引时模块内自行回落全文口径，本层只传参、不替它定回退策略）。
 */
const LABELS_SOURCE: ErbCompletionSource = {
  id: 'erb-labels',
  provide({ monaco, model, position, tables }): Monaco.languages.CompletionItem[] {
    return erbLabelCompletionItems(monaco, model, position, tables.erbFileFacts);
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
 * 变量**族头**补全（ERB-FAMILY）：裸标识符名位弹 `ENGINE_VARIABLE_FAMILIES`（写 `CF` 弹 `CFLAG`）。
 * 纯函数住在 `erb-completion-families.ts`（名字位判据 `erbDeclaredNameSlot` 与 `erb-declared` 单源共享）。
 * 无通道依赖：位置不符 / 前缀无族命中 ⇒ 零候选，不猜。
 */
const FAMILIES_SOURCE: ErbCompletionSource = {
  id: 'erb-families',
  provide({ monaco, model, position }): Monaco.languages.CompletionItem[] {
    return erbFamilyCompletionItems(monaco, model, position);
  },
};

/**
 * `#DIM` 声明名补全（EC-DECL）：唯一数据来源 = `erbFileFacts` 解析器通道（内核索引事实）。
 * 刻意**不挂 `requires`**：`erbFileFacts` 缺席是"宿主未注入通道"的正常态（不是 adapter 表
 * 缺席），挂上会让每轮补全都报一次降级信号。两态口径（判据单源在 `erb-completion-declared`）：
 * 索引**有意见**（数组，含空表）就以它为准、不与缓冲区合并；`undefined`（未索引 / 通道缺席 /
 * `.kojo` 根本不在 ERB 索引里）才回退到当前缓冲区的 `#DIM` 扫描。
 */
const DECLARED_SOURCE: ErbCompletionSource = {
  id: 'erb-declared',
  provide({ monaco, model, position, tables }): Monaco.languages.CompletionItem[] {
    return erbDeclaredCompletionItems(monaco, model, position, tables.erbFileFacts);
  },
};

/**
 * 文档词源（QSUG-2，**追加在最后**）：当前文件里同前缀的代码词。
 *
 * 开关住在 `tables.wordBasedSuggestions`（宿主注入设置页偏好）；缺席 = 不供。
 * 专用名槽（`CALL` 目标 / `@` 定义 / `$` 标签 / 变量末段 / 位号 / 指令记号）由位置门的
 * `keep` 白名单**整路滤掉**本 source（它不在任何白名单里）⇒ 不会把词混进"只出自己的源"的槽位。
 * 字符串 / `;` 注释在 `locate` 已整轮零候选。
 */
const WORDS_SOURCE: ErbCompletionSource = {
  id: 'erb-words',
  provide({ monaco, model, position, range, tables }): Monaco.languages.CompletionItem[] {
    if (tables.wordBasedSuggestions?.() !== true) return [];
    return erbWordCompletionItems(monaco, model, position, range);
  },
};

/**
 * 全部补全来源（**稳定扩展点**）。各 source **独立文件 + 各自纯函数**，此处只做一行接线；
 * 装配点与排序/去重口径零改动（实现在 `completion-core.ts`，与 `.kojo` 共用一份）。
 *
 * `erb-snippet`（R4）注册在**最前**：行首位置的块骨架与 `erb-directives` 的同名纯文本
 * 项按 label 去重（先注册者胜）⇒ 行首只留骨架、行中纯文本照旧（见 snippet 模块头注）。
 * 名字位两个新源（`erb-families` / `erb-declared`）**追加在末尾**：先注册者胜语义不动，
 * 同 label 与既有源相撞时老源胜。
 */
export const ERB_COMPLETION_SOURCES: ErbCompletionSource[] = [
  ERB_SNIPPET_SOURCE,
  DIRECTIVES_SOURCE,
  VARIABLES_SOURCE,
  FUNCTIONS_SOURCE,
  LABELS_SOURCE,
  SYSTEM_FUNCTIONS_SOURCE,
  BITS_SOURCE,
  FAMILIES_SOURCE,
  DECLARED_SOURCE,
  WORDS_SOURCE,
];

/* ============================== 记忆化：函数名 provider（EC-3 预置） ============================== */

/**
 * 把「取当前 `ErbIndex`」的记忆化为「函数名（已排序）提供者」。
 *
 * 展示名取**首个定义的原拼写**（`ErbFunctionRef.name`）。`byName` 的键是归一化大写名
 * （引擎大小写不敏感），直接拿键当候选会把作者写的 `M_Kojo_Message` 显示成
 * `M_KOJO_MESSAGE`——读起来像"工具不认识我的写法"。排序仍按归一化键（越接近前缀越靠前
 * 的既有语义不变），前缀匹配在装配核里本就大小写不敏感，故换显示不影响命中。
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
    memo = [...index.byName.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([normalizedName, refs]) => refs[0]?.name ?? normalizedName);
    memoFingerprint = fp;
    hasMemo = true;
    return memo;
  };
}

/* ============================== 位置判定 + 装配声明 ============================== */

/** `.erb` 的装配声明：源集合 + 位置判定 + 回表口径（装配实现零份——吃装配核那一份） */
export const ERB_COMPLETION_ASSEMBLY: CompletionAssembly = {
  languageId: ERB_LANGUAGE_ID,
  logTag: ERB_LOG_TAG,
  triggerCharacters: ['#', '[', '@', '$'],
  sources: ERB_COMPLETION_SOURCES,
  callForm: { sourceIds: ERB_CALL_FORM_SOURCE_IDS },
  locate(_monaco, model, position) {
    const line = model.getLineContent(position.lineNumber);
    // 位置门（T6 · v2）：串内 / 注释内不给代码补全；其余门类按**候选源白名单**过滤
    // （数据 = `ERB_GATE_SOURCE_WHITELIST`，位置侧单源；`default` 不过滤）。判定先于
    // range（串内零候选，不劳各 source 出货一遍）。
    const gate = erbCompletionGate(line, position.column);
    if (gate === 'in-string') return undefined;
    const range = erbTokenRange(model, position);
    const prefix = line.slice(range.startColumn - 1, range.endColumn - 1);
    return {
      range,
      prefix,
      keep: gateKeepFor(gate),
      seed: { lineNumber: position.lineNumber, text: line },
    };
  },
  resolveDetail(item, provenance) {
    try {
      return resolveErbCompletionDetail(item, provenance);
    } catch (e: unknown) {
      console.warn(`[erb-completion] resolve '${provenance.sourceId}' 抛错：${errorText(e)}`);
      return undefined;
    }
  },
};

/* ============================== 装配点（转发到装配核） ============================== */

/**
 * 为 `.erb` / `.erh`（`ERB_LANGUAGE_ID`）注册**一个**补全 provider。
 * `triggerCharacters` = 四个**只有补全能补**的记号：`#` 指令头、`[` 区间标记、
 * `@` 函数定义头（函数名候选）、`$` 标签目标（`JUMP $-` / `GOTO $-` 一族）。
 * 这些字符 Monaco 默认词法都不含（词分隔符），不弹窗就只剩手打全名一条路；
 * 其余位置由 `locate` 的位置门挡掉（串内 / 注释内零候选），不会打扰常规输入。
 * `getTables` 每次补全时才调用（表按当前项目 adapter 实时取，同 hover 纪律）。
 * 返回可释放句柄——宿主在编辑器卸载时 `dispose()`。
 *
 * `onDegrade`（可选第三参，additive——旧调用方零改动）：某来源因依赖表 / 提供者缺席
 * （或求值抛错）被跳过时**首次**回调一次；去重表随本句柄创建。不传时降级仍以一行
 * `console.warn` 可见。
 *
 * `resolveCompletionItem` 与 snippet 化都在装配核内完成（与 `.kojo` 同一份实现），宿主零改动。
 */
export function installErbCompletion(
  monaco: typeof Monaco,
  getTables: () => ErbCompletionTables,
  onDegrade?: ErbCompletionDegradeReporter,
): Monaco.IDisposable {
  return installCompletion(monaco, ERB_COMPLETION_ASSEMBLY, getTables, onDegrade);
}

/* ============================== 旧导出面（同名 = 装配核那一份实现） ============================== */

export {
  buildCallSnippetText,
  candidateRange,
  charAfterRange,
  escapeSnippetText,
  mergeSuggestions,
  rankKey,
};
export { createCompletionProvenanceStore };
export { applyErbCallSnippet as applyCallSnippet };
export { erbSlotsForCallee as slotsForCallee };
export { erbFunctionNameSlot };
