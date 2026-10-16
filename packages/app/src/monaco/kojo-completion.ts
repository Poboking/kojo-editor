import type * as Monaco from './entry';
import type {
  KojoCallProtocol,
  KojoCallSlot,
  KojoFaceTable,
  KojoInstructionTable,
  KojoLibraryTable,
  VariableInfo,
  VariableSchema,
} from '@kojo/plugin-api';
import type { DictionaryLookup } from '@kojo/plugin-kojo-sugar';
import {
  RESERVED_PRONOUNS,
  SUGAR_KEYWORD_ROLE_LABEL,
  SUGAR_LEXICON_OPERATORS,
  SYSTEM_FUNCTION_ALIASES,
} from '@kojo/plugin-kojo-sugar';
import { describeCallSignature, slotParameterLabel } from './kojo-signature';
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
 *
 * 二段式供给（C-2 批补齐"完整"）：provide 只给 label / kind / 一行 detail；**中文名·说明·取值域·
 * 调用签名**等到 `resolveCompletionItem` 才回表算（候选对象身份 → 出处走 `WeakMap` 反查，见
 * {@link createCompletionProvenanceStore}）。同时**调用形态**候选按 `callProtocol` 的形参槽插成
 * 带 tabstop 的 snippet（取不到槽 ⇒ 纯文本照旧，见 {@link buildCallSnippetText}）。
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
  /**
   * 调用协议表（adapter `kojoCallProtocol`；**additive** 可选字段，与 `SignatureTables` 同一张表）。
   *
   * 只服务两件事：①`resolve` 阶段给函数类候选补**调用签名**详情；②把**调用形态**候选
   * （`insertText` 恰为 `名字(`）插成带 tabstop 的 snippet。缺席 / `slotsFor` 不认这个函数
   * ⇒ 既不给签名也不改片段（退化成纯文本，**不猜形参**）。
   */
  readonly callProtocol?: KojoCallProtocol;
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

/* ============================== resolve 反查：候选身份 → 数据出处 ============================== */

/**
 * 一条候选的**出处**（provide 时登记、resolve 时按对象身份取回）。
 *
 * 为什么不往 `CompletionItem` 上挂自定义字段：Monaco 会把候选对象在 suggest 模型 / 渲染器 /
 * `resolve` 之间传来传去并按**公开协议**读写（`vs/editor/contrib/suggest/browser/suggest.js`
 * 的 `CompletionItem` 持 `this.completion = 我们返回的那个对象`），私有字段既进不了序列化、
 * 也会被下一轮 `Object.assign(this.completion, 解析结果)` 搅在一起。`WeakMap` 以**对象身份**
 * 为键：provide 与 resolve 拿到的是同一个引用（standalone 无跨进程序列化，身份可靠），
 * 弹层销毁 ⇒ 键失去引用 ⇒ 元数据自动回收，**不产生无界增长**。
 */
export interface CompletionProvenance {
  /** 产出该候选的 source id（resolve 按它分派；不认识的 id ⇒ 不加详情） */
  readonly sourceId: string;
  /** 候选 label **原文**（= 回各张表的主键） */
  readonly label: string;
  /**
   * **本次 provide 拿到的表快照**（不在 resolve 时重跑 `getTables()`）：弹层存续期间项目
   * 若切换，详情必须与候选同源——两张表拼出来的"中文名"是假信息。
   */
  readonly tables: CompletionTables;
}

/** 候选身份 → 出处 的登记表（每次装配一枚，随句柄创建 / 回收） */
export interface CompletionProvenanceStore {
  register(item: Monaco.languages.CompletionItem, provenance: CompletionProvenance): void;
  lookup(item: Monaco.languages.CompletionItem): CompletionProvenance | undefined;
}

/** 建一枚 `WeakMap` 反查表（纯结构、可单测）。候选按契约是对象，仍走 `unknown` 守一道——
 *  外部 source 追加进来的东西不受我们类型管，`WeakMap` 对非对象键会抛，这里宁可静默不登记。 */
export function createCompletionProvenanceStore(): CompletionProvenanceStore {
  const byItem = new WeakMap<object, CompletionProvenance>();
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

/** `resolve` 阶段的懒填充产物（只允许动 Monaco 认的两个字段，其余零污染） */
export interface CompletionResolution {
  readonly detail?: string;
  readonly documentation?: { readonly value: string };
}

/* ============================== 调用协议 → snippet / 签名（复用 kojo-signature 的取槽口径） ============================== */

/** snippet 语法里的控制字符（`\` / `$` / `}`）——槽含义原文可能带它们，须转义后才进占位文本 */
export function escapeSnippetText(text: string): string {
  return text.replace(/[\\$}]/g, (ch) => `\\${ch}`);
}

/**
 * 形参槽 → 带 tabstop 的调用片段（**纯函数**）。
 *
 * `slots === undefined`（协议缺席 / 不认这个函数 / 求槽抛错）⇒ `undefined` ⇒ 调用方**保持纯文本插入**
 * （退化判据只有一条：拿不到槽就不猜形参）。`slots` 为空数组是**协议明确声明"此函数无槽"**，
 * 与"不认"是两种事实 ⇒ 给 `名字()`，让作者一次到位。
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

/**
 * 依次用这几个键回调用协议表取槽（**纯函数**；同一张表的两种命名面：原生名优先、表层名兜底——
 * 命中仍来自表本身，不是猜）。表缺席 / 全不认 / 每个键都抛 ⇒ `undefined`。
 */
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
      console.warn(`[kojo-completion] 调用协议对 '${key}' 求槽抛错：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return undefined;
}

/** 一条候选的查表键（表层名 ↔ 原生名两张面的回表键，取不到就只用表层名） */
function calleeKeys(label: string, tables: CompletionTables): readonly (string | undefined)[] {
  let native: string | undefined;
  try {
    native = tables.libraryTable?.lookupByName(label) ?? SYSTEM_FUNCTION_ALIASES.get(label);
  } catch {
    native = undefined; // 表抛错 ⇒ 只按表层名问协议，绝不让补全链崩
  }
  return native === undefined ? [label] : [native, label];
}

/** 签名详情行（`调用签名 \`名字(ARG:0 含义)\``）；取不到槽 ⇒ `undefined`（不进文档，不猜） */
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
 * 哪些 source 的候选是**调用形态**（`insertText` 恰为 `名字(`）⇒ 才允许改写成 snippet。
 * 变量 / 指令名 / 关键字 / 命名参数一律排除（它们插的不是调用）。
 */
const CALL_FORM_SOURCE_IDS: ReadonlySet<string> = new Set(['kojo-lexicon', 'kojo-library']);

/**
 * 候选替换区间的**归一形态**：Monaco 允许 `{insert, replace}` 双区间，取 `replace`；
 * 缺席（外部 source 没给）⇒ `undefined`。
 */
export function candidateRange(range: Monaco.languages.CompletionItem['range'] | undefined): Monaco.IRange | undefined {
  if (range === undefined) return undefined;
  return 'insert' in range ? range.replace : range;
}

/** 区间右端**紧邻**的那个字符（无 ⇒ `undefined`）。入参是行文本而不是 model：整轮补全只按行号取样一次 */
export function charAfterRange(lineText: string, range: Monaco.IRange | undefined): string | undefined {
  if (range === undefined) return undefined;
  const ch = lineText.slice(range.endColumn - 1, range.endColumn);
  return ch.length > 0 ? ch : undefined;
}

/**
 * 取 Monaco 的 `InsertAsSnippet` 枚举值（**不硬编码数字**）：桩 monaco 可能没这枚枚举
 * ⇒ 返回 `undefined`，调用方整条退化成纯文本插入。
 */
function insertAsSnippetRule(monaco: typeof Monaco): Monaco.languages.CompletionItemInsertTextRule | undefined {
  const rules = monaco.languages.CompletionItemInsertTextRule as unknown as Record<string, unknown> | undefined;
  const value = rules?.InsertAsSnippet;
  return typeof value === 'number' ? (value as Monaco.languages.CompletionItemInsertTextRule) : undefined;
}

/**
 * 把一条**调用形态**候选改写成带 tabstop 的 snippet（**原地**改 `insertText` / `insertTextRules`；
 * 纯判定 + 纯文本生成见 {@link buildCallSnippetText}）。返回是否改写。
 *
 * 不改写的情形（全部**退化成今天的纯文本**，一条不猜）：非调用形态 source / `insertText` 不是
 * `名字(` / 替换区间右端**紧跟一个 `(`**（作者已经自己开了括号，再插一片段等于给他多一对）/
 * 协议缺席或不认这个函数 / 桩 monaco 拿不到 `CompletionItemInsertTextRule` 枚举。
 */
export function applyCallSnippet(
  monaco: typeof Monaco,
  item: Monaco.languages.CompletionItem,
  provenance: CompletionProvenance,
  charAfter: string | undefined,
): boolean {
  if (!CALL_FORM_SOURCE_IDS.has(provenance.sourceId)) return false;
  const insertText = typeof item.insertText === 'string' ? item.insertText : undefined;
  if (insertText === undefined || insertText !== `${provenance.label}(`) return false;
  if (charAfter === '(') return false;
  const rule = insertAsSnippetRule(monaco);
  if (rule === undefined) return false;
  const snippet = buildCallSnippetText(
    provenance.label,
    slotsForCallee(provenance.tables.callProtocol, calleeKeys(provenance.label, provenance.tables)),
  );
  if (snippet === undefined) return false;
  item.insertText = snippet;
  item.insertTextRules = rule;
  return true;
}

/* ============================== resolve：按出处回表填详情（懒、可缺表、不抛） ============================== */

/** `VariableInfo.source` → 作者可读的名表面（契约层的跨游戏术语，非游戏知识） */
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
function familyFromDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const head = detail.split(':')[0];
  return head !== undefined && head.length > 0 ? head : undefined;
}

/** 取某族的枚举条目（无枚举能力 / 抛错 ⇒ `undefined`，不猜） */
function entriesOf(schema: VariableSchema | undefined, family: string): readonly VariableInfo[] | undefined {
  const enumerate = schema?.names;
  if (typeof enumerate !== 'function') return undefined;
  try {
    return enumerate(family);
  } catch {
    return undefined;
  }
}

/** 位表摘要（条数多时截断；条名为 adapter 原文） */
function bitsLine(bits: VariableInfo['bits']): string | undefined {
  if (bits === undefined || bits.length === 0) return undefined;
  const shown = bits.slice(0, 12).map((b) => `${String(b.bit)} ${b.label}`).join('、');
  return `位表 ${shown}${bits.length > 12 ? ' …' : ''}（共 ${String(bits.length)} 项）`;
}

/** 变量 / 属性候选的详情：族、编号、说明、名表来源、位表、原生引用 */
function variableDetail(label: string, detail: string | undefined, tables: CompletionTables): CompletionResolution | undefined {
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
  const native = tables.dictionary?.resolve?.(label);
  if (native !== undefined && native.length > 0 && native !== label) facts.push(`原生引用 \`${native}\``);
  if (facts.length === 0) return undefined; // 表里一条事实都没有 ⇒ 不编话术（不猜）
  return { documentation: { value: [`**${label}** · 变量 \`${family}\``, ...facts].join('\n\n') } };
}

/** 时机分野候选的详情：模板 / 编号口径 / 成否与 MESSAGECHECK 模板 / 各段取值域 */
function faceDetail(label: string, faceTable: KojoFaceTable | undefined): CompletionResolution | undefined {
  const tpl = faceTable?.faces[label];
  if (tpl === undefined) return undefined;
  const facts: string[] = [`函数名模板 \`${tpl.template}\``];
  if (tpl.indexKind !== undefined) {
    facts.push(`编号槽 ${INDEX_KIND_LABEL[tpl.indexKind] ?? tpl.indexKind}`);
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

/** 中文指令名候选的详情：编号 + 编号反查 + 两种写法 */
function instructionDetail(label: string, table: KojoInstructionTable | undefined): CompletionResolution | undefined {
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

/** 库函数候选的详情：原生名 + 调用签名（表不认这个函数 ⇒ 只给原生名） */
function libraryDetail(label: string, tables: CompletionTables): CompletionResolution | undefined {
  let native: string | undefined;
  try {
    native = tables.libraryTable?.lookupByName(label);
  } catch {
    return undefined;
  }
  if (native === undefined) return undefined;
  const facts = [`原生名 \`${native}\``, signatureLine(label, [native, label], tables.callProtocol)].filter(
    (s): s is string => s !== undefined,
  );
  return { documentation: { value: [`**${label}** · 库函数`, ...facts].join('\n\n') } };
}

/** 词表候选的详情：只有**系统函数**有可回表的事实（原生名 + 签名）；关键字 / 代词 / 运算符不编话术 */
function lexiconDetail(label: string, tables: CompletionTables): CompletionResolution | undefined {
  const native = SYSTEM_FUNCTION_ALIASES.get(label);
  if (native === undefined) return undefined;
  const facts = [
    `原生名 \`${native}\``,
    signatureLine(label, [native, label], tables.callProtocol),
    '插入形态为调用形：`名字(`',
  ].filter((s): s is string => s !== undefined);
  return { documentation: { value: [`**${label}** · 系统函数`, ...facts].join('\n\n') } };
}

/**
 * `resolveCompletionItem` 的**纯**内核：按出处回表算详情（`kojo-completion.ts` 之外的 source
 * 一律不认 ⇒ `undefined`，**不猜它想要什么**）。任何回表异常都在本函数内消化成"无详情"。
 */
export function resolveCompletionDetail(
  item: Monaco.languages.CompletionItem,
  provenance: CompletionProvenance,
): CompletionResolution | undefined {
  const tables = provenance.tables;
  try {
    switch (provenance.sourceId) {
      case 'kojo-variable':
        return variableDetail(provenance.label, typeof item.detail === 'string' ? item.detail : undefined, tables);
      case 'kojo-face':
        return faceDetail(provenance.label, tables.faceTable);
      case 'kojo-instruction':
        return instructionDetail(provenance.label, tables.instructionTable);
      case 'kojo-library':
        return libraryDetail(provenance.label, tables);
      case 'kojo-lexicon':
        return lexiconDetail(provenance.label, tables);
      default:
        return undefined;
    }
  } catch (e: unknown) {
    console.warn(`[kojo-completion] resolve '${provenance.sourceId}' 抛错：${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
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

/**
 * 依次问各 source，按 label 去重（先注册者胜），再按排名键排序并写回 `sortText`。
 *
 * `provenance`（**可选末参，additive**）：登记「最终交给 Monaco 的那个对象 → 出处」。登记必须
 * 在 `sortText` 重写**之后**、对**返回出去的那个引用**做——`{...item, sortText}` 造的是新对象，
 * 若登记的是 source 手里的原对象，resolve 拿到的就是这个副本，反查必然落空（这是本 seam
 * 唯一一处身份陷阱，故把它钉在注释里）。
 */
function mergeSuggestions(
  sources: readonly CompletionSource[],
  ctx: CompletionSourceContext,
  prefix: string,
  reported: Set<string>,
  onDegrade: CompletionDegradeReporter | undefined,
  provenance?: CompletionProvenanceStore,
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
      console.warn(`[kojo-completion] source '${source.id}' provide 抛错：${msg}`);
      // 抛错即视为缺：带 `requires` 的来源按该键报一次降级
      if (source.requires !== undefined) {
        reportDegrade(reported, source.id, source.requires, onDegrade, `求值抛错（${msg}）`);
      }
      continue;
    }
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
 * 为 `.kojo` 注册**一个**补全 provider（`triggerCharacters` 保守：`{` 与 `：`）。
 * `getTables` 每次补全时才调用（表按当前项目 adapter 实时取，同 hover 纪律）。
 * 返回可释放句柄——宿主在编辑器卸载时 `dispose()`。
 *
 * `onDegrade`（**可选第三参，additive**——旧调用方零改动）：某来源因依赖表缺席（或求值抛错）
 * 被跳过时**首次**回调一次；去重表随本句柄创建（**不做模块级全局去重**，否则第二次 install
 * 会吞掉信号 ⇒ 三态不可复跑）。不传 `onDegrade` 时降级仍以一行 `console.warn` 可见。
 *
 * 两件事在本装配点内完成，宿主零改动（`EditorPane` 早就不加参数地调它）：
 * - **`resolveCompletionItem`（二次详情，懒填充）**：provide 只给 label / kind / 一行 detail，
 *   中文名、说明、取值域、签名等到 Monaco 询问时才回表算（`CompletionProvenanceStore` 按
 *   **对象身份**反查出处）。表缺席 / 反查落底 ⇒ 原样返回候选，**不抛、不编**。
 * - **调用形态候选 → snippet**：`insertText` 恰为 `名字(` 且调用协议认得这个函数时，插成
 *   `名字(${1:ARG:0 槽含义}, ${2:…})`；取不到槽一律保持今天的纯文本插入（**不猜形参**）。
 */
export function installKojoCompletion(
  monaco: typeof Monaco,
  getTables: () => CompletionTables,
  onDegrade?: CompletionDegradeReporter,
): Monaco.IDisposable {
  const reported = new Set<string>();
  const provenance = createCompletionProvenanceStore();
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
      const tables = getTables();
      const suggestions = mergeSuggestions(
        KOJO_COMPLETION_SOURCES,
        { monaco, model, position, range, tables },
        word.word,
        reported,
        onDegrade,
        provenance,
      );
      // 调用形态候选 → snippet：**先按 source id 过滤**（只有词表系统函数 / 库函数两路可能命中），
      // 再按行号记忆化取行文本（同一行只取一次，不给 1000 条候选各取一遍）
      let lineAt = -1;
      let lineText = '';
      for (const item of suggestions) {
        const hit = provenance.lookup(item);
        if (hit === undefined || !CALL_FORM_SOURCE_IDS.has(hit.sourceId)) continue;
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
      const resolved = resolveCompletionDetail(item, hit);
      if (resolved === undefined) return item;
      if (resolved.detail !== undefined && item.detail === undefined) item.detail = resolved.detail;
      if (resolved.documentation !== undefined) item.documentation = resolved.documentation;
      return item;
    },
  });
}
