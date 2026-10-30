import type * as Monaco from './entry';
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/kojo-vocab/engine';
import { BUILTIN_FUNCTION_NAMES } from '@kojo/plugin-erb-parser';
import { MAX_NAME_CANDIDATES, rankKey, startsWithFold, type CompletionTables } from './completion-core';
import { erbCompletionGate, NAME_CHAR_RE } from './erb-completion-context';
import { erbDeclaredNameSlot, ERB_SIGIL_BEFORE } from './erb-completion-families';
import { erbVariableReferenceSlotAt } from './erb-completion-variables';
import { ERB_LANGUAGE_ID } from './erb-language';
import { col0Of, lineAt } from './kojo-completion-position';

/**
 * ERB-COMPLETE-MEMBER · `.erb` 补全的**成员 / 属性 / 函数族**启发式扩展（纯逻辑 + 薄 Monaco 翻译）。
 *
 * 本模块是三样东西的**唯一实现**（各自只有一个数据来源，绝不手抄词表）：
 *
 * 1. **族头位**（`x = CF|` / `TFLAG|` / `CFLAG|`）：候选 = `ENGINE_VARIABLE_FAMILIES`
 *    （与 `erb-completion-variables.ts` / `erb-completion-families.ts` **同一个 import**，
 *    即降糖器 `resolveFamily` 认的那张族表）按大小写不敏感前缀过滤 ⇒ `confidence: 'certain'`
 *    （静态派生表命中）。位置判据直接复用 `erb-completion-families.ts` 的
 *    {@link erbDeclaredNameSlot}（裸标识符名位单源），不另写一份"名字位"扫描。
 *
 * 2. **点号成员位**（`y.|` / `x = y.|` / `M_KOJO_K1.|`）：ERB（EraBasic）**没有点号语法**，
 *    点号在这里只当**族查询键**用：作者写 `receiver.` 就是问"这个名字族里有哪些成员"。
 *    候选 = 两本**既有名录**里的同族名字，按装配核的排名键做**模糊排序**：
 *    - 项目函数族（`ErbIndex` 派生的 `tables.erbFunctionNames`）：`receiver_*`；
 *    - 系统函数族（`BUILTIN_FUNCTION_NAMES`——erb-parser 的 exmeth 静态签名表）：
 *      `receiver*`（接收者至少两字符）。
 *    两路都是**命名约定推断**（不是引擎语义）⇒ `confidence: 'heuristic'`。
 *
 * 3. **字段 / 属性位**（`CFLAG:|` / `CSTR:名|` 这类 `族:…` 的**名字段**）：
 *    ERB 的索引名空间是**adapter 注入的动态数据**（CSV / ALS），本模块**没有静态表** ⇒
 *    **零候选 + `uncertain: true`**（{@link ERB_MEMBER_UNCERTAIN_HINT} 供宿主 UI 显示
 *    "动态语言，仅供参考"）。**不猜**是硬纪律：造一条假名字比空列表危险得多。
 *    点号成员位同理——族里查不到成员时也返回 `uncertain: true`（那个位同样是动态的）。
 *
 * ## 与既有源的关系（additive）
 *
 * 本源是 `erb-completion.ts` 候选册**末尾追加**的一项（`erb-members`）：
 * - 既有源的顺序 / 去重口径 / 排序口径一行不动（合并核 `mergeSuggestions` 仍是那一份）；
 * - 族头候选与 `erb-families` **逐条重合**（同一张族表 + 同一个名位判据）⇒ 装配层按 label
 *   去重时**先注册者胜**（`erb-families` 在册在前）⇒ 合并结果里那一条的出处不变；
 * - 成员候选与 `erb-functions` 不重合（那一源只认 `@` / `CALL` 名字槽，这里认点号位）；
 * - 系统函数族成员与 `erb-system-functions` 在点号位**逐条重合**（后者在行中位整表出货）⇒
 *   去重后仍由老源出货（顺序口径不动）；本支的可见面在**纯 API**（宿主若要按族聚合可直接取）。
 * - `triggerCharacters` 只在既有清单**末尾追加** `.`（已在册则不重复）——`.erb` 侧此前没有
 *   任何候选源由 `.` 触发，而 Monaco 的默认词法把 `.` 当词分隔符 ⇒ 不追加就弹不出成员位。
 *
 * ## 位置判据（三条都是纯函数，零 IO）
 *
 * 顺序**严格**（{@link erbMemberSlotAt}）：串内 / 注释内 ⇒ 不认（判据 = `erbCompletionGate`
 * 的 `'in-string'`，与位置门同一份）→ 点号成员位 → `族:` 名字段（`erbVariableReferenceSlotAt`
 * 结构层判据，**不核对族头白名单**——`CSTR:` 这类引擎族不在降糖白名单里，但结构上仍是族引用）
 * → 裸族头位（前缀命中至少一个引擎族）。
 *
 * 三条边界的口径：
 * - `1.5` 的 `.` 是**小数点**不是成员位（接收者以数字开头一律不认）；
 * - `..` / `(x).` / 接收者为空 ⇒ 不认（说不出是哪个族，不猜）；
 * - 光标在族头**里面**（`CF|LAG:`）是族头位，光标在族头**之后**（`CFLAG:|`）是字段位。
 *
 * ## 排序（复用装配核那一份 fuzzy 排名键）
 *
 * 「成员」的模糊排序**不另写一套 fuzzy**：`completion-core.ts` 的 {@link rankKey}
 * （前缀精确 > 前缀命中 > 原文子序列 > 拼音首字母 > 全拚 > 其它）是全仓唯一实现，
 * `erb-completion-bits` 等各源的候选进装配后也走它。这里对**族后缀**（作者继续要打的那一段，
 * 如 `M_KOJO_` 之后的 `K12`）算同一个键 ⇒ 排序语义与其它源一致；`sortText` 写这枚键，
 * 装配层再按整 label 重排时同档内次序仍由它决定。
 *
 * ## 性能（口径与 `completion-perf.test.ts` 同款）
 *
 * 名录的**族索引**按数组身份记忆化（`WeakMap`，与 `completion-core` 的前缀索引同一纪律）：
 * 十万条名录只在**首次**调用建一次（冷启动，本模块不计入热路径），其后按族键 O(1) 取成员。
 * 单次扫描上限 = {@link MAX_NAME_CANDIDATES}（与 `erb-functions` 同一护栏，不另立数字）。
 *
 * ## 本批不做（v1 边界）
 *
 * - 语言面**只认 `.erb`**：model 的 `getLanguageId()` 存在且不是 `ERB_LANGUAGE_ID` ⇒ 整轮零动作
 *   （`.kojo` 原生区经跨装配路由进 ERB 册时，本源在 `.kojo` 文件里**沉默**——V1 不跨语言面）；
 *   桩 model 没有 `getLanguageId` 时不拦（纯函数可单测）。
 * - `uncertain` 只在**本源**的返回值上（宿主拿不到 `provide` 的返回值形状）——装配层目前
 *   只消费 `items`，提示面留给宿主接线。
 */

/* ============================== 契约：确定度 + 结果壳 ============================== */

/**
 * 候选**确定度**（additive 可选字段，旧消费方按 `CompletionItem` 读，零改动）：
 * - `'certain'`：静态派生表命中（引擎变量族表，跨游戏语言层事实）；
 * - `'heuristic'`：命名约定 / 名录归属推断（点号成员位；动态语言，仅供参考）。
 */
export type ErbMemberConfidence = 'certain' | 'heuristic';

/**
 * 带确定度标注的候选。字段**可选**：所有既有候选对象仍是合法值（结构兼容），
 * 本源出的每一条都会写上（测试可断言；宿主想显示角标也能直接读）。
 */
export interface ErbMemberCompletionItem extends Monaco.languages.CompletionItem {
  readonly confidence?: ErbMemberConfidence;
}

/** 成员位种类：点号成员 / 变量族头 / `族:` 名字段 */
export type ErbMemberSlotKind = 'member' | 'variable-family' | 'field';

/** 一处成员位（0 基、左含右不含的名字段区间） */
export interface ErbMemberSlot {
  readonly kind: ErbMemberSlotKind;
  /** 名字段起点（0 基，含）——替换范围左界 */
  readonly start: number;
  /** 名字段终点（0 基，不含）——替换范围右界 */
  readonly end: number;
  /** 光标前已输入的名字片段（过滤 / 排序用） */
  readonly prefix: string;
  /** 点号成员位的接收者原文（`M_KOJO` in `M_KOJO.K12`）；其余位种缺省 */
  readonly receiver?: string;
  /** 点号成员位的接收者起点（0 基）；成员候选的替换范围从这里开始（连点号一起替换） */
  readonly receiverStart?: number;
  /** `族:` 名字段 / 族头位的族头原文 */
  readonly family?: string;
}

/**
 * `uncertain` 的**说明文案**（宿主 UI 显示用；本层不做 UI）。
 * 口径：ERB 的索引名 / 动态成员由 adapter 数据决定，本模块**没有静态数据 ⇒ 不猜**。
 */
export const ERB_MEMBER_UNCERTAIN_HINT = '动态语言，仅供参考（该位无静态数据，未做猜测）';

/** 一次成员补全的**完整**结果（`items` 之外还带位种与不确定标记） */
export interface ErbMemberCompletionResult {
  /** 候选（每条带 `confidence`；空数组 = 不猜） */
  readonly items: ErbMemberCompletionItem[];
  /** 命中/认出的成员位；`null` = 这里不是成员位 */
  readonly slot: ErbMemberSlot | null;
  /**
   * `true` = 认出了成员位但**没有静态数据**（字段 / 属性 / 查不到成员的族）⇒ UI 可显示
   * {@link ERB_MEMBER_UNCERTAIN_HINT}。恒与 `items.length === 0` 同现。
   */
  readonly uncertain: boolean;
  /** `uncertain` 时的人话说明（否则缺省） */
  readonly uncertainHint?: string;
}

/* ============================== 位置判据 ============================== */

/** 接收者是否"说不出是哪个族"：空 / 数值字面量开头（`1.5` 的小数点）/ 全数字 */
function usableReceiver(receiver: string): boolean {
  return receiver.length > 0 && !/^[0-9]/.test(receiver);
}

/**
 * `族:` 引用的**族头形**：ASCII 标识符起头（引擎族全是 ASCII；`1:` 这类编号不是族引用）。
 * 只是形状判据，不认任何具体族名（族名真源仍是 `ENGINE_VARIABLE_FAMILIES`）。
 */
const FAMILY_HEAD_RE = /^[A-Za-z_]/;

/** 点号成员位：`receiver.|` / `receiver.前缀|`（光标在点号后或成员段内） */
function memberSlotWithin(lineText: string, col0: number): ErbMemberSlot | null {
  // 1) 光标所在的名字段（点号之后那一段）
  let segStart = col0;
  while (segStart > 0 && NAME_CHAR_RE.test(lineText[segStart - 1]!)) segStart--;
  if (segStart === 0 || lineText[segStart - 1] !== '.') return null;
  const dot = segStart - 1;
  // `..` 不是成员位（说不出是哪两个东西的点号）
  if (dot > 0 && lineText[dot - 1] === '.') return null;
  // 2) 接收者 = 点号之前的连续名字字符段；空 / 数值 / `(x).` / 被 sigil 领起（`$标签.` / `@函数.`）一律不认（不猜）
  let receiverStart = dot;
  while (receiverStart > 0 && NAME_CHAR_RE.test(lineText[receiverStart - 1]!)) receiverStart--;
  const receiver = lineText.slice(receiverStart, dot);
  if (!usableReceiver(receiver)) return null;
  if (receiverStart > 0 && ERB_SIGIL_BEFORE.has(lineText[receiverStart - 1]!)) return null;
  // 3) 成员段右界（替换范围只覆盖已输入片段）
  let end = col0;
  while (end < lineText.length && NAME_CHAR_RE.test(lineText[end]!)) end++;
  return {
    kind: 'member',
    start: segStart,
    end,
    prefix: lineText.slice(segStart, col0),
    receiver,
    receiverStart,
  };
}

/**
 * 光标处的**成员位**（纯函数；`column` = Monaco 的 1 基列）。返回 `null` = 这里不是成员位
 * （**不猜**：串内 / 注释内 / `1.` 数值 / `..` / 接收者为空 / 裸名位前缀不命中任何引擎族）。
 *
 * 判定顺序（三条判据各自的单源见模块头注）：代码视野 → 点号成员 → `族:` 名字段 → 裸族头。
 */
export function erbMemberSlotAt(lineText: string, column: number): ErbMemberSlot | null {
  const col0 = col0Of(lineText, column);
  if (col0 === null) return null;
  // 串内 / 行注释内不是代码视野（判据 = 位置门那一份，不另写引号计数）
  if (erbCompletionGate(lineText, column) === 'in-string') return null;

  const member = memberSlotWithin(lineText, col0);
  if (member !== null) return member;

  // `族:…` 的名字段（结构层判据；不核对族头白名单 ⇒ `CSTR:` 这类引擎族同样认得）。
  // 族头必须是**标识符形**：`1:` / `0:` 是表达式里的编号 / 三元式尾部，不是族引用（不猜）。
  const reference = erbVariableReferenceSlotAt(lineText, column);
  if (reference !== null && FAMILY_HEAD_RE.test(reference.family)) {
    return {
      kind: 'field',
      start: reference.start,
      end: reference.end,
      prefix: reference.prefix,
      family: reference.family,
    };
  }

  // 裸族头位（`CF|` / `TFLAG|`）：名位判据与 `erb-families` 同一份
  const nameSlot = erbDeclaredNameSlot(lineText, column);
  if (nameSlot === null) return null;
  const needle = nameSlot.prefix.toUpperCase();
  const hit =
    needle.length === 0 || ENGINE_VARIABLE_FAMILIES.some((family) => family.toUpperCase().startsWith(needle));
  if (!hit) return null;
  return { kind: 'variable-family', start: nameSlot.start, end: nameSlot.end, prefix: nameSlot.prefix };
}

/* ============================== 候选：引擎变量族（certain） ============================== */

/** 替换区间（1 基） */
function rangeOf(lineNumber: number, start: number, end: number): Monaco.IRange {
  return { startLineNumber: lineNumber, endLineNumber: lineNumber, startColumn: start + 1, endColumn: end + 1 };
}

/**
 * 族头候选：`ENGINE_VARIABLE_FAMILIES` 全表按**大小写不敏感前缀**过滤（展示保留族名原形）。
 * `kind` = Variable、`detail` = `引擎变量族`、排序前缀精确优先——与 `erb-families` 同法，
 * 但 `confidence` 恒 `'certain'`（静态派生表命中）。
 */
function familyCandidates(
  monaco: typeof Monaco,
  slot: ErbMemberSlot,
  lineNumber: number,
): ErbMemberCompletionItem[] {
  const needle = slot.prefix.toUpperCase();
  const range = rangeOf(lineNumber, slot.start, slot.end);
  const items: ErbMemberCompletionItem[] = [];
  for (const family of ENGINE_VARIABLE_FAMILIES) {
    const upper = family.toUpperCase();
    if (needle.length > 0 && !upper.startsWith(needle)) continue;
    const exact = needle.length > 0 && upper === needle;
    items.push({
      label: family,
      kind: monaco.languages.CompletionItemKind.Variable,
      insertText: family,
      filterText: family,
      detail: '引擎变量族',
      range,
      sortText: `${exact ? '0' : '1'}_${family}`,
      confidence: 'certain',
    });
  }
  return items;
}

/* ============================== 候选：点号成员族（heuristic） ============================== */

/**
 * 名录的**族成员查询**（按「数组身份 + 族键」记忆化）：`M_KOJO_K1.` ⇒ `M_KOJO_K1_` 开头的名字。
 *
 * 旧形态是**全量桶索引**：为名录里每个名字的每个下划段建一个桶 + 一枚守卫 `Set`（`M_KOJO_K1_HATSUMI`
 * 进 `M_` / `M_KOJO_` / `M_KOJO_K1_` 三桶）。MEM-12 实测（110,049 条名字 / 真语料量级，整轮
 * `erbMemberCompletion`）：**首问 541–1008 ms、常驻增量 35.9 MB**——而作者一次点号只会问**一个**族键。
 * 改成按需扫一遍（`startsWithFold`，ASCII 零分配）+ 按族键记忆化后：首问 24 ms、常驻增量 0.7 MB。
 *
 * 记忆化上限 {@link FAMILY_CACHE_LIMIT}：点号位关心的就是"当前打开的几个族"这一量级，
 * 超出按最久未问丢（丢了只是重扫一遍，答案不变）。键与去重仍按**归一化大写**
 * （引擎函数名大小写不敏感），展示保留定义处原拼写。
 */
const FAMILY_INDEX_CACHE = new WeakMap<object, Map<string, readonly string[]>>();
const FAMILY_CACHE_LIMIT = 32;

function familyMembersOf(names: readonly string[], key: string): readonly string[] {
  let cache = FAMILY_INDEX_CACHE.get(names);
  if (cache === undefined) {
    cache = new Map<string, readonly string[]>();
    FAMILY_INDEX_CACHE.set(names, cache);
  }
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const members: string[] = [];
  const guard = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string' || name.length <= key.length) continue;
    if (!startsWithFold(name, key)) continue;
    const upper = name.toUpperCase(); // 只折叠**命中者**（几百条），不再为 11 万条全表造大写串
    if (guard.has(upper)) continue; // 名录里大小写重名 ⇒ 一条（首次者胜）
    guard.add(upper);
    members.push(name);
  }

  while (cache.size >= FAMILY_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  cache.set(key, members);
  return members;
}

/** 一条族成员命中：完整名 + 族后缀（作者在点号之后继续打的那一段）+ 排名键（只算一次） */
interface MemberHit {
  readonly name: string;
  readonly suffix: string;
  readonly key: string;
}

/** 名录取数（提供者缺席 / 抛错 ⇒ `undefined` = 该路零候选，绝不抛进补全链） */
function functionNamesOf(tables: CompletionTables): readonly string[] | undefined {
  try {
    const names = tables.erbFunctionNames?.();
    return Array.isArray(names) ? names : undefined;
  } catch {
    return undefined;
  }
}

/** 项目函数族成员（`receiver_*`） */
function projectFamilyMembers(names: readonly string[] | undefined, receiver: string): readonly string[] {
  if (names === undefined || names.length === 0) return [];
  return familyMembersOf(names, `${receiver.toUpperCase()}_`);
}

/**
 * 系统函数族成员（`receiver*`，来自 erb-parser 的内建签名表；接收者至少两字符——单字母会把整张系统函数表
 * 抖进候选，那是噪声不是族）。`name === receiver` 本身不算成员（同一枚名字没有"成员"可言）。
 */
function systemFamilyMembers(receiver: string): readonly string[] {
  const needle = receiver.toUpperCase();
  if (needle.length < 2) return [];
  const out: string[] = [];
  for (const name of BUILTIN_FUNCTION_NAMES) {
    if (name === needle) continue;
    if (name.startsWith(needle)) out.push(name);
  }
  return out;
}

/**
 * 点号成员候选（`receiver.|` ⇒ 同族成员）。排序 = 装配核 {@link rankKey} 作用在**族后缀**上：
 * 前缀精确 > 前缀命中 > 子序列模糊（与其它源同一套判据），互不相关的成员**不进面**。
 * 名录按归一化名有序 ⇒ 扫描上限 {@link MAX_NAME_CANDIDATES} 不改变常见族的完整命中。
 */
function memberCandidates(
  monaco: typeof Monaco,
  slot: ErbMemberSlot,
  lineNumber: number,
  tables: CompletionTables,
): ErbMemberCompletionItem[] {
  const receiver = slot.receiver;
  if (receiver === undefined) return [];
  const fragment = slot.prefix;
  /** 命中：完整名 + 作者要继续打的那一段（项目族去掉 `receiver_` 的 `_`，系统族没有分隔符） */
  const hits: MemberHit[] = [];
  const seen = new Set<string>();
  const collect = (member: string, suffixStart: number): boolean => {
    if (hits.length >= MAX_NAME_CANDIDATES) return false;
    const suffix = member.slice(suffixStart);
    if (suffix.length === 0) return true; // 与接收者同名（或只差一个分隔符）⇒ 不是成员
    const normalized = member.toUpperCase();
    if (seen.has(normalized)) return true;
    // 排名键只算一次：空片段 = 名录原序（稳定档）；否则走装配核那一份 fuzzy 判据
    const key = fragment.length === 0 ? `2|${suffix}` : rankKey({ label: suffix } as Monaco.languages.CompletionItem, fragment);
    // 已输入片段与族后缀无关的成员不入面（"其它"档 = rankKey 的 `2|` 档）
    if (fragment.length > 0 && key.startsWith('2|')) return true;
    seen.add(normalized);
    hits.push({ name: member, suffix, key });
    return hits.length < MAX_NAME_CANDIDATES;
  };
  for (const member of projectFamilyMembers(functionNamesOf(tables), receiver)) {
    if (!collect(member, receiver.length + 1)) break; // 族键带 `_`：后缀从接收者长度 + 1 开始
  }
  if (hits.length < MAX_NAME_CANDIDATES) {
    for (const member of systemFamilyMembers(receiver)) {
      if (!collect(member, receiver.length)) break;
    }
  }
  if (hits.length === 0) return [];

  const range = rangeOf(lineNumber, slot.receiverStart ?? slot.start, slot.end);
  hits.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return hits.map(({ name, suffix, key }) => ({
    label: name,
    kind: monaco.languages.CompletionItemKind.Function,
    // ERB 没有点号语法：点号只是族查询键，落字一律是**完整函数名**（替换范围连接收者一起覆盖）
    insertText: name,
    filterText: suffix,
    detail: `函数族成员（${receiver}）`,
    documentation: {
      value: [
        `点号成员推断：\`${receiver}.\` ⇒ 项目函数族 \`${receiver}_*\` / 系统函数族 \`${receiver}*\``,
        'ERB 无点号语法：接受后落字为完整函数名（点号只是族查询键，写回正文的是 `名字`）。',
      ].join('\n\n'),
    },
    range,
    sortText: key,
    confidence: 'heuristic',
  }));
}

/* ============================== 语言面守卫（v1：只认 `.erb`） ============================== */

/**
 * 该 model 是不是**本语言面**：`getLanguageId` 存在且不等于 `ERB_LANGUAGE_ID` ⇒ 否。
 * 缺席 / 抛错的桩 model 视为"是"（纯函数可单测；判据本身不因桩而静默）。
 */
function isErbLanguageSurface(model: Monaco.editor.ITextModel): boolean {
  const read = (model as { getLanguageId?: () => string }).getLanguageId;
  if (typeof read !== 'function') return true;
  try {
    return read.call(model) === ERB_LANGUAGE_ID;
  } catch {
    return true;
  }
}

/* ============================== 入口 ============================== */

/**
 * 产出**成员 / 属性 / 函数族**补全结果（**纯函数**，供补全基座与测试调用）。
 *
 * 行为（逐条对应模块头注）：
 * - 语言面不是 `.erb` ⇒ 整轮零动作（`{items: [], slot: null, uncertain: false}`）；
 * - 族头位 ⇒ `ENGINE_VARIABLE_FAMILIES` 前缀命中（`confidence: 'certain'`）；
 * - 点号成员位 ⇒ 名录同族成员（`confidence: 'heuristic'`，模糊排序）；
 * - 字段 / 属性位 ⇒ 零候选（本模块无静态数据）；
 * - 认出成员位但零候选 ⇒ `uncertain: true` + {@link ERB_MEMBER_UNCERTAIN_HINT}。
 *
 * 非法行 / 列、桩 model 缺件、名录提供者抛错一律**不抛**（零候选）。
 */
export function erbMemberCompletion(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  tables: CompletionTables,
): ErbMemberCompletionResult {
  const empty: ErbMemberCompletionResult = { items: [], slot: null, uncertain: false };
  if (!model || !position) return empty;
  if (!Number.isFinite(position.lineNumber) || position.lineNumber < 1) return empty;
  if (!Number.isFinite(position.column) || position.column < 1) return empty;
  if (!isErbLanguageSurface(model)) return empty;

  const slot = erbMemberSlotAt(lineAt(model, position.lineNumber), position.column);
  if (slot === null) return empty;
  if (slot.kind === 'variable-family') {
    return { items: familyCandidates(monaco, slot, position.lineNumber), slot, uncertain: false };
  }
  const items = slot.kind === 'member' ? memberCandidates(monaco, slot, position.lineNumber, tables) : [];
  if (items.length === 0) {
    return { items: [], slot, uncertain: true, uncertainHint: ERB_MEMBER_UNCERTAIN_HINT };
  }
  return { items, slot, uncertain: false };
}

/**
 * 成员补全候选（**薄翻译**：取 {@link erbMemberCompletion} 的 `items`，供 `CompletionSource`
 * 那条接口用——`provide` 只认 `CompletionItem[]`，`uncertain` 标记留在纯 API 面上）。
 */
export function erbMemberCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  tables: CompletionTables,
): ErbMemberCompletionItem[] {
  return erbMemberCompletion(monaco, model, position, tables).items;
}
