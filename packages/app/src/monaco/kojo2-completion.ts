/**
 * Kojo 2.0 **补全候选组装**（K2-EDITOR-SEMANTIC 第一刀 + K2-COMPLETE-ARGS-FACE）。
 *
 * ## 分工
 * 本文件是**纯函数组装**：源码 + 1 基行列进，候选数组出；零 IO、零 Monaco、零注册。
 * 宿主（CUTOVER）只做 Monaco 翻译：候选 → `monaco.languages.CompletionItem`、
 * `triggerCharacters` / `range` / `CompletionItemKind` 由宿主那一侧决定。
 *
 * ## 候选源（全部从公共入口派生，不手抄词表）
 * - **锚点**：`# @ > ? !` 五枚语法标点（core 没有"锚点"常量；它们是标点，不是词表）；
 * - **声明词**：`@kojo/kojo-core` 的 `KOJO_DECL_WORDS`；
 * - **`# 机` 事件**：当前项目 adapter 的 `eventCatalog`（宿主经 core 的 `eventNames` 注入；
 *   Monaco 语言层不 import 具体 adapter——解耦审计 A 项把这一层钉成"零游戏名词"）；
 * - **`@织` 事件**：与 `# 机` **同一枚**事件名单（`eventNames` 投影，不另立第二份）；
 * - **域符号**：`@kojo/kojo-core` 的 `KOJO_DOMAIN_SYMBOL_NAMES`（`我 / 你 / 她`）；
 * - **表 / 池 / 模 / 函名单**：本文件声明的名字（`kojo2-declarations.ts` 的同一份索引）；
 * - **`# 机 <事件>` 参数**：宿主注入的 `eventArgs` 投影（core `projectEventArgs(eventCatalog)`）；
 * - **存储期 / 类型词**：core `KOJO_STORAGE_WORDS` / `KOJO_TYPE_WORDS`（`# 变量` / `# 常量` 槽位）；
 * - **`# 模` 形参**：同文件模板声明头（`kojo2-declarations.ts` 的 `params`）在模板体内的引用；
 * - **`@颜绘` 对象**：core `KOJO_FACE_OBJECT_WORDS`（`我 / 你`）；
 * - **`@颜绘` 表情 / 服装 / 差分 / 特效**：宿主注入的 `faceTemplates` 投影；
 * - **行尾表演提示 `(心形)`**：宿主注入的 `hintNames` 投影（adapter `hintSupport` 的那份名单）。
 *
 * ## 位置门
 * - 台词 / 旁白 / 转义字面文本的**正文**：不做任何语法补全；行尾 `(…)` 提示组例外；
 * - `{…}` 插值内：例外——那是表达式位，给域符号 + 表 / 池 / 模 / 函名单 + 当前模板形参；
 * - `@原生` 围栏体内（含栏头）：一律不补（原文不解释）；
 * - 注释 / 旧写法行：不补。
 *
 * ## 为什么候选不做 Monaco 过滤
 * 本函数只按**已输入前缀**裁一遍（让纯函数可单测、也减少宿主侧噪音）；Monaco 仍会按
 * `filterText` 再过滤，两层不冲突。候选的 `insertText` 一律是原文名字，**不在这里塞括号 /
 * snippet**——调用形态是宿主翻译层的决定，纯函数不替它猜。块级 snippets 因此住
 * `kojo2-completion-snippets.ts`（数据 + 行首门），由宿主按 `kind: 'snippet'` 追加。
 *
 * ## 未注入 = 零候选（不猜）
 * 事件参数 / 颜绘参数 / 行尾提示名这三路的事实都只存在于**当前项目**（adapter 或工程数据），
 * 语言层不内置任何一条；宿主没注入就返回空数组，而不是借一个"像的"词兜底。
 */

import {
  KOJO_DECL_WORDS,
  KOJO_DOMAIN_SYMBOL_NAMES,
  KOJO_FACE_MAX_ARGS,
  KOJO_FACE_OBJECT_WORDS,
  KOJO_STORAGE_WORDS,
  KOJO_TYPE_WORDS,
  eventNames,
  type GameAdapter,
} from '@kojo/kojo-core';
import {
  insideInterpolation,
  insideStringOrComment,
  isAllBlank,
  isBlank,
} from './kojo-completion-position';
import {
  KOJO2_DECL_WORD_BY_KIND,
  KOJO2_MACHINE_WORD,
  KOJO2_MEMBER_DECLARATION_KINDS,
  kojo2DocumentOf,
  kojo2IsNativeRecord,
  kojo2IsTextSurface,
  kojo2TokenSpanAt,
  type Kojo2Declaration,
  type Kojo2DeclarationKind,
  type Kojo2Document,
  type Kojo2Query,
} from '@kojo/kojo-lang';
import {
  KOJO2_DISPATCH_WORDS,
  KOJO2_INDENT_WIDTH,
  KOJO2_NATIVE_FENCE_WORD,
  KOJO2_TEMPLATE_SLOT,
} from './kojo2-lexicon';

/**
 * 五锚点（`#` 声明 / `@` 调度 / `>` 旁白 / `?` 条件 / `!` 触发）。
 * core 没有"锚点"常量——这是**语法标点**，不是词表；本文件只此一处写它们。
 */
export const KOJO2_ANCHOR_CHARS = ['#', '@', '>', '?', '!'] as const;

/** adapter 事件目录的**名字投影**（顺序 = `eventCatalog.events` 表序；零手抄）。 */
export function kojo2EventNamesOf(adapter: GameAdapter): readonly string[] {
  return eventNames(adapter);
}

/**
 * `@颜绘` / `@织` 在 core 调度词表里的**位序**（`tokens.ts` §2.1 的声明序；只取词，不写字形）。
 * 取不到（core 改表）⇒ `''`：位置门自然不命中（宁可零候选，也不猜错词）。
 */
const FACE_WORD = KOJO2_DISPATCH_WORDS[2] ?? '';
const WEAVE_WORD = KOJO2_DISPATCH_WORDS[9] ?? '';

/** `# 变量` / `# 常量` 的词形（声明词表同一枚真源）。 */
const VARIABLE_WORD = KOJO2_DECL_WORD_BY_KIND.variable;
const CONSTANT_WORD = KOJO2_DECL_WORD_BY_KIND.constant;

/**
 * 候选的语义类别（宿主据此映射 Monaco `CompletionItemKind`）。
 *
 * `eventArgument` / `valueType` / `storagePeriod` / `templateParam` / `templateSlot` /
 * `faceObject` / `faceArgument` / `hintName` 是 K2-COMPLETE-ARGS-FACE 的 additive 档；
 * 宿主映射缺省落 `Text`（**不借邻居的颜色**），细分映射由翻译层按这一枚决定。
 */
export type Kojo2CompletionKind =
  | 'anchor'
  | 'declarationWord'
  | 'event'
  | 'domainSymbol'
  | 'declaration'
  | 'eventArgument'
  | 'valueType'
  | 'storagePeriod'
  | 'templateParam'
  | 'templateSlot'
  | 'faceObject'
  | 'faceArgument'
  | 'hintName';

/** 一条候选（纯数据；不带 Monaco 的 `range` / `insertTextRules`）。 */
export interface Kojo2CompletionCandidate {
  readonly label: string;
  readonly insertText: string;
  readonly kind: Kojo2CompletionKind;
  readonly detail: string;
  readonly sortText: string;
  /** 仅 `kind === 'declaration'` 时给出，宿主可细分为变量 / 表 / 池 / 模 / 函。 */
  readonly declarationKind?: Kojo2DeclarationKind;
}

/* ============================== 注入面（宿主投影） ============================== */

/**
 * 一条事件参数的**形状投影**（宿主从 adapter `eventCatalog.events[].args` 派生）。
 *
 * 与 core `MigrateEventArgShape` **结构相同**：宿主可直接把
 * `projectEventArgs(adapter.eventCatalog)` 交进来（不用另写投影）。
 */
export interface Kojo2EventArgument {
  /** 参数名（补全 label / detail 用；adapter 事实，语言层不内置任何一条） */
  readonly name: string;
  /** 可选（缺省 = 必填；adapter `required` 取反） */
  readonly optional?: boolean;
  /** `optional` 的反面写法（adapter 原样投影时可直接用；两者都给时以 `optional` 为准） */
  readonly required?: boolean;
  /** 值形状（缺省 = 不判） */
  readonly kind?: 'int' | 'string' | 'any';
}

/** 事件名 → 参数形状（`# 机 <事件>` 参数位的唯一候选源）。 */
export type Kojo2EventArgumentMap = Readonly<Record<string, readonly Kojo2EventArgument[]>>;

/**
 * `@颜绘` 的**参数模板投影**（宿主注入；adapter / 工程数据的事实）。
 *
 * 口径按 §8.3 的位置序：对象之后依次是 表情 / 服装 / 差分 / 特效（第四枚是特效）。
 * 每一格都**可缺省**：缺省 = 这一格零候选（不猜任何内置表情名）。对象词本身不在这里
 * ——`我 / 你` 是 core 的固定域词（`KOJO_FACE_OBJECT_WORDS`）。
 */
export interface Kojo2FaceTemplates {
  /** 第一枚实参（对象省略时）：表情 */
  readonly expressions?: readonly string[];
  /** 第二枚（有对象时）/ 第一枚（无对象时）：服装 */
  readonly costumes?: readonly string[];
  /** 第三枚：差分 */
  readonly differentials?: readonly string[];
  /** 第四枚（`KOJO_FACE_MAX_ARGS` 上限内）：特效 */
  readonly effects?: readonly string[];
}

/**
 * 可选注入。事件名单**不从本模块的 import 里来**（Monaco 语言层零游戏名词）：
 * 宿主把当前项目 adapter 交进来，事件名由 core 的 `eventNames` 派生；测试可直接给
 * `events` 覆盖（两路都缺 ⇒ `# 机` 只给零候选，不猜任何内置事件）。
 *
 * 其余三路（事件参数 / 颜绘参数 / 行尾提示名）同理：**注入才有候选**，缺省零候选。
 */
export interface Kojo2CompletionOptions {
  /** 当前项目 adapter（宿主从内核拿；事件名 = `eventNames(adapter)`）。 */
  readonly adapter?: GameAdapter;
  /** 直接给事件名（测试 / 多 adapter 组合；优先于 `adapter`）。 */
  readonly events?: readonly string[];
  /** `# 机 <事件>` 参数形状投影（宿主 = `projectEventArgs(adapter.eventCatalog)`）。 */
  readonly eventArgs?: Kojo2EventArgumentMap;
  /** `@颜绘` 参数模板投影（宿主按 adapter / 工程数据派生）。 */
  readonly faceTemplates?: Kojo2FaceTemplates;
  /** 行尾 `(…)` 表演提示名（宿主按 adapter `hintSupport` 投影）。 */
  readonly hintNames?: readonly string[];
}

/** 前缀裁剪（只做 `startsWith`；大小写不敏感不适用——2.0 名字区分大小写）。 */
function withPrefix(names: readonly string[], prefix: string): string[] {
  return prefix.length === 0 ? [...names] : names.filter((name) => name.startsWith(prefix));
}

/** 锚点候选（空行 / 行首空白处）。 */
function anchorCandidates(): Kojo2CompletionCandidate[] {
  return KOJO2_ANCHOR_CHARS.map((anchor) => ({
    label: anchor,
    insertText: anchor,
    kind: 'anchor' as const,
    detail: '锚点',
    sortText: `0_${anchor}`,
  }));
}

/** 声明词候选（`#` 之后的第一枚词）。 */
function declarationWordCandidates(prefix: string): Kojo2CompletionCandidate[] {
  return withPrefix(KOJO_DECL_WORDS, prefix).map((word) => ({
    label: word,
    insertText: word,
    kind: 'declarationWord' as const,
    detail: '声明词',
    sortText: `1_${word}`,
  }));
}

/** `# 机` / `@织` 事件候选（adapter eventCatalog；名单可注入，缺省零候选——不猜内置事件）。 */
function eventCandidates(
  prefix: string,
  options: Kojo2CompletionOptions,
): Kojo2CompletionCandidate[] {
  const events =
    options.events ?? (options.adapter === undefined ? [] : kojo2EventNamesOf(options.adapter));
  return withPrefix(events, prefix).map((event) => ({
    label: event,
    insertText: event,
    kind: 'event' as const,
    detail: '事件',
    sortText: `2_${event}`,
  }));
}

/** 域符号候选（`{…}` 插值内）。 */
function domainSymbolCandidates(prefix: string): Kojo2CompletionCandidate[] {
  return withPrefix(KOJO_DOMAIN_SYMBOL_NAMES, prefix).map((symbol) => ({
    label: symbol,
    insertText: symbol,
    kind: 'domainSymbol' as const,
    detail: '域符号',
    sortText: `3_${symbol}`,
  }));
}

/** 声明名候选（表 / 池 / 模 / 函；同文件声明索引）。 */
function declarationCandidates(
  document: Kojo2Document,
  kinds: readonly Kojo2DeclarationKind[],
  prefix: string,
  callHint = false,
): Kojo2CompletionCandidate[] {
  const allowed = new Set<Kojo2DeclarationKind>(kinds);
  const seen = new Set<string>();
  const out: Kojo2CompletionCandidate[] = [];
  for (const declaration of document.declarations) {
    if (!allowed.has(declaration.kind)) continue;
    if (seen.has(declaration.name)) continue;
    if (prefix.length > 0 && !declaration.name.startsWith(prefix)) continue;
    seen.add(declaration.name);
    out.push({
      label: declaration.name,
      insertText: declaration.name,
      kind: 'declaration',
      declarationKind: declaration.kind,
      detail: declarationDetail(declaration, callHint),
      sortText: `4_${declaration.kind}_${declaration.name}`,
    });
  }
  return out;
}

/** 声明种类文案（只用于候选 detail；词形来自 core 词表，见 `kojo2-declarations.ts`）。 */
function declarationKindLabel(declaration: Kojo2Declaration): string {
  return KOJO2_DECL_WORD_BY_KIND[declaration.kind];
}

/**
 * 声明候选的 detail。
 *
 * `callHint` = 调用位（`! <名>`）才追加两段**声明头事实**（additive，不改候选顺序 / 去重）：
 * - `@函` / `# 模` 的形参（`@函` 的默认值由声明索引拼成 `名 = 10`；模板只写名字）；
 * - `# 模` 有没有 `[插槽]`——**有插槽的模板在调用处必须带缩进块**（§7.2），作者在选名字的
 *   那一刻就该看到这条，而不是写完调用再被诊断打回来。
 */
function declarationDetail(declaration: Kojo2Declaration, callHint: boolean): string {
  const base = `${declarationKindLabel(declaration)}（本文件第 ${declaration.line} 行）`;
  if (!callHint) return base;
  const extra: string[] = [];
  if (declaration.params !== undefined && declaration.params.length > 0) {
    extra.push(`参数：${declaration.params.join('、')}`);
  }
  if (declaration.kind === 'template' && declaration.hasSlot !== undefined) {
    extra.push(`插槽：${declaration.hasSlot ? `有 ${KOJO2_TEMPLATE_SLOT}` : '无插槽'}`);
  }
  return extra.length === 0 ? base : `${base} · ${extra.join(' · ')}`;
}

/* ============================== 行首头部切分 ============================== */

/** 行首锚 + 首词 + 词后原文（`before` 的切片；`tail` 保留前导空白）。 */
interface HeadParts {
  readonly anchor: '#' | '@';
  /** 首词（锚后第一个空白前的内容；可能为空串 = 还没写词） */
  readonly word: string;
  /** 词之后的原文（原样，含前导空白；词后无内容 = 空串） */
  readonly tail: string;
}

/** 切出行首 `#` / `@` + 首词 + 尾巴；不是这两种锚 ⇒ `null`。 */
function headPartsOf(before: string): HeadParts | null {
  const trimmed = before.replace(/^[ \t\u3000]*/, '');
  const anchor = trimmed[0];
  if (anchor !== '#' && anchor !== '@') return null;
  const afterAnchor = trimmed.slice(1).replace(/^[ \t\u3000]*/, '');
  const wordEnd = afterAnchor.search(/[ \t\u3000]/);
  const word = wordEnd < 0 ? afterAnchor : afterAnchor.slice(0, wordEnd);
  const tail = wordEnd < 0 ? '' : afterAnchor.slice(wordEnd);
  return { anchor, word, tail };
}

/** 去掉前导空白（`tail` 的那一步；行内空白口径与位置层同一份 `isBlank`）。 */
function stripLeadingBlanks(text: string): string {
  let index = 0;
  while (index < text.length && isBlank(text[index]!)) index++;
  return text.slice(index);
}

/** 按空白（半角 / 制表 / 全角）切 `rest`；与 core `splitSpaces` 同口径（不认引号分组）。 */
function slotTokens(rest: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < rest.length) {
    while (index < rest.length && isBlank(rest[index]!)) index++;
    if (index >= rest.length) break;
    const start = index;
    while (index < rest.length && !isBlank(rest[index]!)) index++;
    out.push(rest.slice(start, index));
  }
  return out;
}

/** 槽位扫描结果：光标在哪个词上 / 是否正处在一枚新词的起点。 */
interface SlotScan {
  readonly tokens: readonly string[];
  /** 当前词下标；行以空白结尾（或还没有词）⇒ `tokens.length`（新词位） */
  readonly index: number;
  /** 当前词的已输入前缀（新词位 = 空串） */
  readonly prefix: string;
}

function scanSlot(rest: string): SlotScan {
  const tokens = slotTokens(rest);
  const trailingBlank = rest.length > 0 && isBlank(rest[rest.length - 1]!);
  if (trailingBlank) return { tokens, index: tokens.length, prefix: '' };
  const last = tokens[tokens.length - 1];
  if (last === undefined) return { tokens, index: 0, prefix: '' };
  return { tokens, index: tokens.length - 1, prefix: last };
}

/* ============================== 各专有位 ============================== */

/** `# 机 <事件前缀>` 的事件位（事件后已有实参 ⇒ 不在事件名位）。 */
function machineEventSlotPrefix(before: string): string | null {
  const trimmed = before.replace(/^[ \t\u3000]*/, '');
  if (!trimmed.startsWith('#')) return null;
  const rest = trimmed.slice(1).replace(/^[ \t\u3000]*/, '');
  if (!rest.startsWith(KOJO2_MACHINE_WORD)) return null;
  const afterWord = rest.slice(KOJO2_MACHINE_WORD.length);
  if (afterWord.length === 0) return null; // `# 机` 还没空格：仍归声明词位
  if (!/^[ \t\u3000]/.test(afterWord)) return null; // `# 机X` 不是事件位
  const tail = afterWord.replace(/^[ \t\u3000]+/, '');
  if (/[ \t\u3000]/.test(tail)) return null; // 已进入实参区
  return tail;
}

/** `# 机 <事件> <参数…>` 的实参位（事件名已写完才成立）。 */
interface EventArgSlot {
  readonly event: string;
  /** 0 基实参下标 */
  readonly slot: number;
  readonly prefix: string;
}

function machineArgumentSlotAt(before: string): EventArgSlot | null {
  const head = headPartsOf(before);
  if (head === null || head.anchor !== '#' || head.word !== KOJO2_MACHINE_WORD) return null;
  if (head.tail.length === 0 || !isBlank(head.tail[0]!)) return null;
  const rest = stripLeadingBlanks(head.tail);
  if (rest.length === 0) return null; // 事件名位（上一条门负责）
  const scan = scanSlot(rest);
  const event = scan.tokens[0];
  if (event === undefined) return null;
  if (scan.tokens.length === 1 && scan.index === 0) return null; // 正在写事件名
  const slot = scan.index - 1;
  if (slot < 0) return null;
  return { event, slot, prefix: scan.prefix };
}

/** 事件参数候选（注入才有；越界 / 未声明事件 / 无此事件条 ⇒ 零候选）。 */
function eventArgumentCandidates(
  slot: EventArgSlot,
  options: Kojo2CompletionOptions,
): Kojo2CompletionCandidate[] {
  const args = options.eventArgs?.[slot.event];
  if (args === undefined) return [];
  const arg = args[slot.slot];
  if (arg === undefined) return [];
  if (slot.prefix.length > 0 && !arg.name.startsWith(slot.prefix)) return [];
  const shape = eventArgumentShapeLabel(arg);
  return [
    {
      label: arg.name,
      insertText: arg.name,
      kind: 'eventArgument',
      detail: `事件参数 ${slot.slot + 1}/${args.length}：${arg.name}（${eventArgumentOptional(arg) ? '可选' : '必填'}，${shape}）`,
      sortText: `5_eventArgument_${String(slot.slot).padStart(2, '0')}_${arg.name}`,
    },
  ];
}

/** 参数是否可选（与 core `MigrateEventArgShape` 同判定：`optional` 优先，其次 `required === false`）。 */
function eventArgumentOptional(arg: Kojo2EventArgument): boolean {
  if (arg.optional !== undefined) return arg.optional;
  return arg.required === false;
}

/** 参数值形状文案（整数 / 字符串词形取 core 类型词表；`any` = 语言层不判，写"任意值"）。 */
function eventArgumentShapeLabel(arg: Kojo2EventArgument): string {
  if (arg.kind === 'int') return KOJO_TYPE_WORDS[0];
  if (arg.kind === 'string') return KOJO_TYPE_WORDS[1];
  return '任意值';
}

/** `@织 <事件前缀>` 的事件位（事件后还有实参 / 修饰词 ⇒ 不在事件名位）。 */
function weaveEventSlotPrefix(before: string): string | null {
  const head = headPartsOf(before);
  if (head === null || head.anchor !== '@' || head.word !== WEAVE_WORD) return null;
  if (head.tail.length === 0 || !isBlank(head.tail[0]!)) return null;
  const rest = stripLeadingBlanks(head.tail);
  if (/[ \t\u3000]/.test(rest)) return null; // 已进入实参 / 修饰词区
  return rest;
}

/** `# 变量` / `# 常量` 的尾槽：类型词位 / 存储期位。 */
interface DeclTailSlot {
  /** 变量 = 存储期位；常量没有存储期（`「# 常量 … = 值」` 是全部形状） */
  readonly slot: 'type' | 'storage';
  readonly prefix: string;
}

/**
 * `# 变量 <名> <类型> [= 初值] [场景|存档|会话]` / `# 常量 <名> <类型> = <值>` 的尾槽判定。
 *
 * 名字位（作者自己的名字）不补；`=` 之后的初值位不补（初值只允许字面量，§3.4.3）。
 * 常量的存储期不存在 ⇒ 类型之后一律零候选（**不把变量的词表借给常量**）。
 */
function declTailSlotAt(before: string): DeclTailSlot | null {
  const head = headPartsOf(before);
  if (head === null || head.anchor !== '#') return null;
  if (head.word !== VARIABLE_WORD && head.word !== CONSTANT_WORD) return null;
  const kind = head.word === VARIABLE_WORD ? 'variable' : 'constant';
  if (head.tail.length === 0 || !isBlank(head.tail[0]!)) return null;
  const rest = stripLeadingBlanks(head.tail);
  if (rest.length === 0) return null; // 名字位
  const scan = scanSlot(rest);
  if (scan.index === 0) return null; // 名字位（正在写名字）
  if (scan.index === 1) return { slot: 'type', prefix: scan.prefix };
  const eqIndex = scan.tokens.findIndex((token) => token.startsWith('='));
  if (eqIndex >= 0) {
    if (scan.index <= eqIndex) return null; // 正在写 `=` 本身 / 其前
    const inlineValue = (scan.tokens[eqIndex]?.length ?? 0) > 1;
    if (scan.index === eqIndex + 1 && !inlineValue) return null; // 初值位
  }
  return kind === 'variable' ? { slot: 'storage', prefix: scan.prefix } : null;
}

/** 类型词候选（`整数` / `字符串`；core 词表转发）。 */
function valueTypeCandidates(prefix: string): Kojo2CompletionCandidate[] {
  return withPrefix(KOJO_TYPE_WORDS, prefix).map((word) => ({
    label: word,
    insertText: word,
    kind: 'valueType' as const,
    detail: '类型词',
    sortText: `5_valueType_${word}`,
  }));
}

/** 存储期候选（`场景` / `存档` / `会话`；core 词表转发，顺序即默认值优先级）。 */
function storagePeriodCandidates(prefix: string): Kojo2CompletionCandidate[] {
  return withPrefix(KOJO_STORAGE_WORDS, prefix).map((word) => ({
    label: word,
    insertText: word,
    kind: 'storagePeriod' as const,
    detail: '存储期',
    sortText: `6_storagePeriod_${word}`,
  }));
}

/** `@颜绘` 的实参位（对象之后：表情 / 服装 / 差分 / 特效）。 */
interface FaceSlot {
  /** 0 = 表情（对象之后的第一格）/ 1 = 服装 / 2 = 差分 / 3 = 特效 */
  readonly argIndex: number;
  /** 光标是否正落在**第一枚词**上（对象与表情共用这一格） */
  readonly firstToken: boolean;
  readonly prefix: string;
}

function faceSlotAt(before: string): FaceSlot | null {
  const head = headPartsOf(before);
  if (head === null || head.anchor !== '@' || head.word !== FACE_WORD) return null;
  if (head.tail.length === 0 || !isBlank(head.tail[0]!)) return null;
  const scan = scanSlot(stripLeadingBlanks(head.tail));
  const firstToken = scan.index === 0;
  const first = scan.tokens[0];
  const objectTyped =
    !firstToken &&
    first !== undefined &&
    (KOJO_FACE_OBJECT_WORDS as readonly string[]).includes(first);
  const argIndex = firstToken ? 0 : scan.index - (objectTyped ? 1 : 0);
  if (argIndex < 0 || argIndex >= KOJO_FACE_MAX_ARGS) return null; // 超过上限（对象之外的实参格）
  return { argIndex, firstToken, prefix: scan.prefix };
}

/** `@颜绘` 对象候选（`我` / `你`；core 固定域词）。 */
function faceObjectCandidates(prefix: string): Kojo2CompletionCandidate[] {
  return withPrefix(KOJO_FACE_OBJECT_WORDS, prefix).map((word) => ({
    label: word,
    insertText: word,
    kind: 'faceObject' as const,
    detail: '颜绘对象',
    sortText: `5_faceObject_${word}`,
  }));
}

const FACE_SLOT_LABELS: readonly string[] = ['表情', '服装', '差分', '特效'];

/** `@颜绘` 参数候选（宿主 `faceTemplates` 投影；未注入 / 该格缺省 ⇒ 零候选）。 */
function faceArgumentCandidates(
  slot: FaceSlot,
  prefix: string,
  options: Kojo2CompletionOptions,
): Kojo2CompletionCandidate[] {
  const templates = options.faceTemplates;
  if (templates === undefined) return [];
  const names =
    slot.argIndex === 0
      ? templates.expressions
      : slot.argIndex === 1
        ? templates.costumes
        : slot.argIndex === 2
          ? templates.differentials
          : templates.effects;
  if (names === undefined) return [];
  return withPrefix(names, prefix).map((name) => ({
    label: name,
    insertText: name,
    kind: 'faceArgument' as const,
    detail: `颜绘参数（${FACE_SLOT_LABELS[slot.argIndex] ?? ''}）`,
    sortText: `6_faceArgument_${slot.argIndex}_${name}`,
  }));
}

/** 行尾提示组 `(…提示名…)` 的已输入前缀（光标在未闭合的 `(` 之后才成立）。 */
function hintSlotPrefixAt(
  lineText: string,
  col0: number,
  record: Kojo2Document['lines'][number],
): string | null {
  if (!kojo2IsTextSurface(record)) return null;
  if (!('body' in record) || !('bodyOffset' in record)) return null;
  // 台词：正文（引号内）终点之后才可能是提示组；旁白 / 裸行的正文一直吃到行尾
  // （未闭合的 `(` 会被词法层算进正文，所以这里不能用 bodyEnd 当前缀起点）。
  const safeStart =
    record.kind === 'dialogue' ? record.bodyOffset - record.lineOffset + record.body.length : 0;
  if (col0 <= safeStart) return null;
  const tail = lineText.slice(safeStart, col0);
  const open = tail.lastIndexOf('(');
  if (open < 0) return null;
  const inner = tail.slice(open + 1);
  if (inner.includes(')')) return null; // 光标之前已闭合 ⇒ 不在提示名里
  return inner.replace(/^[ \t\u3000]+/, '');
}

/** 行尾表演提示名候选（宿主 `hintNames` 投影；未注入 ⇒ 零候选）。 */
function hintNameCandidates(
  prefix: string,
  options: Kojo2CompletionOptions,
): Kojo2CompletionCandidate[] {
  return withPrefix(options.hintNames ?? [], prefix).map((name) => ({
    label: name,
    insertText: name,
    kind: 'hintName' as const,
    detail: '行尾表演提示',
    sortText: `5_hintName_${name}`,
  }));
}

/* ============================== 模板体（形参 / 插槽） ============================== */

/** 光标行所在的 `# 模` 体（模板声明头 + 体基准缩进）。 */
interface TemplateBodyAt {
  readonly declaration: Kojo2Declaration;
  readonly bodyIndent: number;
}

/**
 * 光标行落在哪个 `# 模` 体里（由**声明索引 + 词法缩进**推出，不重解析语法）。
 *
 * 体界：声明头之后，首个"非空行 / 非注释行且缩进小于体基准"的行之前；空行与注释行属于体
 * （与 parser 的模板体推进同口径）。嵌套命中取**最后一条**（声明的行序）。
 */
function enclosingTemplateAt(document: Kojo2Document, line: number): TemplateBodyAt | null {
  let best: TemplateBodyAt | null = null;
  for (const declaration of document.declarations) {
    if (declaration.kind !== 'template' || declaration.line >= line) continue;
    const header = document.lines[declaration.line - 1];
    if (header === undefined) continue;
    const bodyIndent = header.indent + KOJO2_INDENT_WIDTH;
    let end = declaration.line;
    for (let index = declaration.line; index < document.lines.length; index++) {
      const record = document.lines[index]!;
      if (record.kind === 'blank' || record.kind === 'comment') {
        end = record.number;
        continue;
      }
      if (record.indent < bodyIndent) break;
      end = record.number;
    }
    if (line > declaration.line && line <= end) best = { declaration, bodyIndent };
  }
  return best;
}

/**
 * 模板形参候选（`# 模 名(原因)` 的形参在**自己的体里**可引用）。
 *
 * 只在模板体内给；`taken` 是同一轮已出过的 label（域符号 / 成员名单）——形参**追加**在它们
 * 之后并跳过重名，既有候选的顺序与去重口径不动。
 */
function templateParamCandidates(
  document: Kojo2Document,
  line: number,
  prefix: string,
  taken: ReadonlySet<string>,
): Kojo2CompletionCandidate[] {
  const template = enclosingTemplateAt(document, line);
  if (template === null) return [];
  const params = template.declaration.params ?? [];
  const out: Kojo2CompletionCandidate[] = [];
  for (const name of params) {
    if (taken.has(name)) continue;
    if (prefix.length > 0 && !name.startsWith(prefix)) continue;
    out.push({
      label: name,
      insertText: name,
      kind: 'templateParam',
      detail: `模板形参（第 ${template.declaration.line} 行声明）`,
      sortText: `5_templateParam_${name}`,
    });
  }
  return out;
}

/**
 * `[插槽]` 补位候选：模板体里**还没有插槽**时，在体基准缩进的空行上给一枚 `[插槽]`。
 *
 * 追加在五锚点之后（既有的行首候选顺序不动）；模板已有 `[插槽]` / 不在模板体 / 不在体基准
 * 缩进的空行 ⇒ 零候选。
 */
function templateSlotCandidates(
  document: Kojo2Document,
  line: number,
  before: string,
): Kojo2CompletionCandidate[] {
  if (!isAllBlank(before)) return [];
  const record = document.lines[line - 1];
  if (record === undefined || record.kind !== 'blank') return [];
  const template = enclosingTemplateAt(document, line);
  if (template === null) return [];
  if (record.indent !== template.bodyIndent) return [];
  if (template.declaration.hasSlot !== false) return [];
  return [
    {
      label: KOJO2_TEMPLATE_SLOT,
      insertText: KOJO2_TEMPLATE_SLOT,
      kind: 'templateSlot',
      detail: `模板插槽（模板在第 ${template.declaration.line} 行声明，尚未写插槽）`,
      sortText: `9_templateSlot`,
    },
  ];
}

/* ============================== 表达式位 ============================== */

/**
 * 表达式位候选 = 域符号 + 表 / 池 / 模 / 函（**既有顺序不动**），末尾追加当前模板体内的形参。
 */
function expressionCandidates(
  document: Kojo2Document,
  line: number,
  prefix: string,
): Kojo2CompletionCandidate[] {
  const base = [
    ...domainSymbolCandidates(prefix),
    ...declarationCandidates(document, KOJO2_MEMBER_DECLARATION_KINDS, prefix),
  ];
  const taken = new Set(base.map((candidate) => candidate.label));
  return [...base, ...templateParamCandidates(document, line, prefix, taken)];
}

/** 兜底表达式位（条件行 / 调度区裸行）：成员名单 + 模板形参（不给域符号，保持既有口径）。 */
function fallbackExpressionCandidates(
  document: Kojo2Document,
  line: number,
  prefix: string,
): Kojo2CompletionCandidate[] {
  const base = declarationCandidates(document, KOJO2_MEMBER_DECLARATION_KINDS, prefix);
  const taken = new Set(base.map((candidate) => candidate.label));
  return [...base, ...templateParamCandidates(document, line, prefix, taken)];
}

/** 光标处名字段的前缀（名字字符集与声明索引同源）。 */
function tokenPrefixAt(lineText: string, col0: number): string {
  const span = kojo2TokenSpanAt(lineText, col0);
  if (span === null) return '';
  return lineText.slice(span.start, Math.max(span.start, Math.min(col0, span.end)));
}

/** `#` 之后正在写的第一枚词（`#` / `# 变` / `# ` 都算；词后已有空白 ⇒ 不是这个词的位）。 */
function declarationWordSlotPrefix(before: string): string | null {
  const trimmed = before.replace(/^[ \t\u3000]*/, '');
  if (!trimmed.startsWith('#')) return null;
  const rest = trimmed.slice(1).replace(/^[ \t\u3000]*/, '');
  if (rest.length === 0) return '';
  return /^[^ \t\u3000]*$/.test(rest) ? rest : null;
}

/** `! <被调名前缀>` 的名字位（池 / 模 / 函；实参括号之后不补）。 */
function triggerSlotPrefix(before: string): string | null {
  const trimmed = before.replace(/^[ \t\u3000]*/, '');
  if (!trimmed.startsWith('!')) return null;
  const rest = trimmed.slice(1);
  if (!/^[ \t\u3000]/.test(rest)) return null;
  const tail = rest.replace(/^[ \t\u3000]+/, '');
  return /[ \t\u3000(（,，:：]/.test(tail) ? null : tail;
}

/** `@原生` 栏头（`@原生` 整行）；栏头本身也不给补全。 */
function isNativeHeader(record: Kojo2Document['lines'][number] | undefined): boolean {
  return (
    record !== undefined &&
    record.kind === 'dispatch' &&
    record.known &&
    record.word === KOJO2_NATIVE_FENCE_WORD
  );
}

/**
 * 光标处的补全候选（**纯函数**）。
 *
 * 位置门顺序：原生围栏 → 注释 / 旧写法 → 字符串 / 行内注释 → 插值 → 行尾提示组 → 台词正文 →
 * 行首锚点（`# 模` 体里追加 `[插槽]`）→ 专有位（`# 机` 事件 / `# 机` 参数 / `@织` 事件 /
 * `#` 声明词 / `# 变量·常量` 尾槽 / `!` 调用 / `@颜绘` 参数）→ 兜底表达式位。
 * 任何一步判定"不是补全位"都返回空数组（静默，不弹噪声）。
 */
export function kojo2CompletionAt(
  query: Kojo2Query,
  options: Kojo2CompletionOptions = {},
): Kojo2CompletionCandidate[] {
  const document = kojo2DocumentOf(query.source);
  const record = document.lines[query.line - 1];
  const lineText = document.physical[query.line - 1]?.text ?? '';
  const col0 = Math.min(Math.max(query.column - 1, 0), lineText.length);

  if (record !== undefined) {
    if (kojo2IsNativeRecord(record) || isNativeHeader(record)) return [];
    if (record.kind === 'comment' || record.kind === 'legacy') return [];
  }
  if (insideStringOrComment(lineText, col0)) return [];

  const before = lineText.slice(0, col0);

  // 插值优先于"台词正文"门：`{…}` 里是表达式，不是台词。
  if (insideInterpolation(lineText, col0)) {
    return expressionCandidates(document, query.line, tokenPrefixAt(lineText, col0));
  }

  // 行尾表演提示组 `(心形)`：在台词正文门之前判（它挂在正文之后，不是正文）。
  if (record !== undefined) {
    const hintPrefix = hintSlotPrefixAt(lineText, col0, record);
    if (hintPrefix !== null) return hintNameCandidates(hintPrefix, options);
  }

  if (record !== undefined && kojo2IsTextSurface(record)) return [];

  // 行首空白 / 空行：五锚点（`# 模` 体里再追加 `[插槽]` 补位）
  if (isAllBlank(before)) {
    return [
      ...anchorCandidates(),
      ...templateSlotCandidates(document, query.line, before),
    ];
  }

  // `# 机 <事件>`：事件名（必须先于通用声明词位）
  const eventPrefix = machineEventSlotPrefix(before);
  if (eventPrefix !== null) return eventCandidates(eventPrefix, options);

  // `# 机 <事件> <参数…>`：事件参数（注入才有候选；未注入零候选）
  const eventArgSlot = machineArgumentSlotAt(before);
  if (eventArgSlot !== null) return eventArgumentCandidates(eventArgSlot, options);

  // `@织 <事件>`：事件位（与 `# 机` 同一枚名单）
  const weavePrefix = weaveEventSlotPrefix(before);
  if (weavePrefix !== null) return eventCandidates(weavePrefix, options);

  // `# <声明词>`
  const declarationPrefix = declarationWordSlotPrefix(before);
  if (declarationPrefix !== null) return declarationWordCandidates(declarationPrefix);

  // `# 变量 / # 常量 … `：类型词 / 存储期
  const declTail = declTailSlotAt(before);
  if (declTail !== null) {
    return declTail.slot === 'type'
      ? valueTypeCandidates(declTail.prefix)
      : storagePeriodCandidates(declTail.prefix);
  }

  // `! <池 / 模 / 函>`：名字位（detail 追加声明头形参与 `[插槽]` 提示）
  const triggerPrefix = triggerSlotPrefix(before);
  if (triggerPrefix !== null) {
    return declarationCandidates(
      document,
      ['pool', 'template', 'function'],
      triggerPrefix,
      true,
    );
  }

  // `@颜绘`：对象（我 / 你）+ 表情 / 服装 / 差分 / 特效（注入才有参数候选）
  const faceSlot = faceSlotAt(before);
  if (faceSlot !== null) {
    const objects = faceSlot.firstToken ? faceObjectCandidates(faceSlot.prefix) : [];
    return [...objects, ...faceArgumentCandidates(faceSlot, faceSlot.prefix, options)];
  }

  // 兜底表达式位：条件行 / 调度区裸行。台词与原生已在上方退让。
  // `? `（条件还没写）在 core 词法里是 `unknown`，但语法位置就是条件位 ⇒ 用行首锚点补判。
  if (
    record !== undefined &&
    (record.kind === 'condition' || record.kind === 'text' || isConditionSlot(before))
  ) {
    return fallbackExpressionCandidates(document, query.line, tokenPrefixAt(lineText, col0));
  }

  return [];
}

/** 行首 `?`（裸条件行 / 刚敲完锚点）：core 把它归 `unknown`，语义上仍是条件位。 */
function isConditionSlot(before: string): boolean {
  return /^[ \t\u3000]*\?/.test(before);
}
