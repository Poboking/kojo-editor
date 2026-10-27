import type * as Monaco from './entry';
import type { KojoFaceTable, KojoIndexKind, KojoIndexTables } from '@kojo/plugin-api';
import { kojoIndexCandidates } from '@kojo/plugin-api';
import { TIMING_NAMED_PARAMS } from '@kojo/kojo-vocab/keywords';
import { lineRange } from './completion-range';
import {
  CASE_ANCHOR,
  col0Of,
  insideStringOrComment,
  timingHeadParts,
} from './kojo-completion-position';

/**
 * KC-3 · `.kojo` **编号槽**的正向补全（`kojoIndexCompletionItems`，IX-1 起按面分流）。
 *
 * 两个落点：
 * - `时机 <分野> <编号令牌位>：` 的编号槽 —— 编号可以是**中文指令名**（`indexKind: 'command'`）
 *   或**中文计数器名**（`'counter'`），`literal` 面则**零候选**（尾部是运行期字符串）；
 * - `当 …： 是 <值…>：` 分支头的值位 —— 裸中文词经**指令名表**查编号（P-5，恒指令名）。
 *
 * 分流口径**不在此处自造**：一律调契约纯函数 `kojoIndexCandidates(kind, tables)`
 * （`packages/plugin-api/src/index-slot.ts`），表选择 / 枚举回号 / `literal` 零候选都在那一份里
 * ——与转译器 `resolveTimingIndex`、悬停 `kojo-hover-native.ts` **同一真源**，同槽异口径从构造上
 * 不可能再出现（IX-1 前：悬停认计数器表、补全只出指令名，写下去必被 `timing-counter-unknown` 拦）。
 *
 * 名字来源 = 各表的 `names()`（**可选**枚举能力；只有反查面时**零候选**，降级信号由装配层的
 * `requires: 'instructionTable' | 'counterTable'` 发，本模块不另造一套）。`detail` 的编号一律回
 * `lookupByName` 取——**只用表、不猜**（枚举有而正查无 = 表自相矛盾，该名直接跳过）。
 *
 * 纯函数：只读模型、不产生编辑、不写盘、不发事件；位置不符 / 表缺省 / 枚举能力缺席一律 `[]`，
 * 绝不抛。Monaco provider 注册刻意不在此处——编排层（`kojo-completion.ts`）负责接进补全基座。
 */

/** 令牌切分用空白 */
const WHITESPACE_RE = /\s/;
/** 值分隔符：半角 / 全角逗号 */
const COMMA_RE = /[,，]/;
/** 全 / 半角冒号 */
const COLON_RE = /[：:]/;
/** CJK 判定（含扩展 A / 假名）；CJK-primary 过滤用 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * 编号槽补全所需的三张表（全部**可选**；缺席 = 该路零候选，与既有纪律一致）。
 * 形状是契约 `KojoIndexTables` 加一张分野表——分野表用来读出该面的 `indexKind`。
 */
export interface IndexSlotTables extends KojoIndexTables {
  /** 时机分野模板表（adapter `kojoFaceTemplates`）：据面名取 `indexKind` */
  readonly faceTable?: KojoFaceTable;
}

/**
 * 命名参数**键**名集（单一真源 = `kojo-sugar` 的 `TIMING_NAMED_PARAMS`，含隐藏英文别名）：
 * 编号槽扫描靠它把 `成否:` / `类型:` / `参数:` 认成键而非编号——否则会把键当成编号名来补。
 */
const NAMED_PARAM_KEYS: ReadonlySet<string> = new Set(
  TIMING_NAMED_PARAMS.flatMap((p) => (p.alias === undefined ? [p.name] : [p.name, p.alias])),
);

/** 一段替换区间（0 基列下标，`end` 不含） */
export interface Slot {
  readonly start: number;
  readonly end: number;
}

/** 时机块头编号落点：替换区间 + 该块头的**分野名**（选表要它） */
export interface TimingNumberSlot extends Slot {
  readonly face: string;
}

/**
 * 落点 1：`时机 <分野> <编号令牌位>：` 的**编号槽**（`column` = Monaco 的 1 基列）。
 *
 * 与 `parseTimingHead` 同口径：尾段只按**空白**切分（块头终结冒号贴在末令牌上、由
 * `stripBlockColon` 剥掉），编号 = 第一个**非命名参数键**的尾令牌；`成否:` / `类型:` /
 * `参数` 一出现即说明编号位已被跳过（那一处归 `kojo-face` 的 KC-2b）。
 *
 * 导出 = 「上下文主动触发」用的同一判据（`suggest-context-trigger.ts`）：分野段界取自
 * `kojo-completion-position` 的 {@link timingHeadParts}，与 `kojo-face` **共用一份**，不另扫。
 */
export function timingNumberSlotAt(line: string, column: number): TimingNumberSlot | null {
  const col0 = col0Of(line, column);
  if (col0 === null) return null;
  const parts = timingHeadParts(line);
  if (parts === null) return null;
  const faceEnd = parts.faceEnd;
  const face = parts.face;

  // 分野令牌之后须有**至少一个空白**——否则光标仍在分野令牌内（那一处归 `kojo-face`）。
  let slotStart = faceEnd;
  while (slotStart < line.length && WHITESPACE_RE.test(line[slotStart]!)) slotStart++;
  if (slotStart === faceEnd) return null;

  // 行尾插入点（`时机 指令 |`）：光标恰在插入点才给候选。
  if (slotStart >= line.length) {
    return col0 === slotStart ? { start: slotStart, end: slotStart, face } : null;
  }

  let slotEnd = slotStart;
  while (slotEnd < line.length && !WHITESPACE_RE.test(line[slotEnd]!)) slotEnd++;
  const raw = line.slice(slotStart, slotEnd);
  const trimmed = raw.endsWith('：') || raw.endsWith(':') ? raw.slice(0, -1) : raw;

  // 令牌 = 命名参数键（`成否:` / `参数`）⇒ 不是编号槽（交回 `kojo-face`）。
  if (NAMED_PARAM_KEYS.has(trimmed)) return null;

  // 「编号 + 块头终结冒号」：替换区间**不含**那枚冒号。
  const end = slotStart + trimmed.length;
  if (col0 < slotStart || col0 > end) return null;
  return { start: slotStart, end, face };
}

/**
 * 落点 2：`当 …：` 块里 `是 <值…>：` 分支头的**值位**（P-5：裸中文词 = 指令名）。
 * 顶层逗号（引号内的不算）分段 → 取含光标那段 → 段内以空白切出光标所在的"词"。
 *
 * 导出理由同 {@link timingNumberSlotAt}：候选源与主动触发吃**同一枚**判据。
 */
export function caseValueSlotAt(line: string, column: number): Slot | null {
  const col0 = col0Of(line, column);
  if (col0 === null) return null;
  const head = CASE_ANCHOR.exec(line);
  if (head === null) return null;
  const bodyStart = head[0].length;

  // 块头终结冒号 = 行（忽略行尾空白）的最后一枚 `：` / `:`；还没写它也照样认（作者正在写）。
  let regionEnd = line.length;
  while (regionEnd > bodyStart && WHITESPACE_RE.test(line[regionEnd - 1]!)) regionEnd--;
  if (regionEnd > bodyStart && COLON_RE.test(line[regionEnd - 1]!)) {
    regionEnd--;
    while (regionEnd > bodyStart && WHITESPACE_RE.test(line[regionEnd - 1]!)) regionEnd--;
  }
  // 光标落在**末令牌之后的空白**（`是 1, |`）= 正在起一个新值：空插入点。与 `kojo-face` 的
  // 尾段空位（`active === undefined` ⇒ `range = {col0, col0}`）同口径——只有光标恰在行尾、
  // 其后全是空白才认（光标停在空白中间不认）；其余越界一律不认。
  if (col0 > regionEnd) {
    return col0 === line.length && line.slice(regionEnd).trim() === ''
      ? { start: col0, end: col0 }
      : null;
  }
  if (col0 < bodyStart) return null;

  let segStart = bodyStart;
  let segEnd = regionEnd;
  let inString = false;
  for (let i = bodyStart; i < regionEnd; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString || !COMMA_RE.test(ch)) continue;
    if (col0 <= i) {
      segEnd = i;
      break;
    }
    segStart = i + 1;
  }
  if (col0 < segStart || col0 > segEnd) return null;

  let start = col0;
  let end = col0;
  while (start > segStart && !WHITESPACE_RE.test(line[start - 1]!)) start--;
  while (end < segEnd && !WHITESPACE_RE.test(line[end]!)) end++;
  return { start, end };
}

/** 编号槽候选的**展示口径**（各表各自的措辞；表本身不产人话） */
const INDEX_KIND_DETAIL_LABEL: Readonly<Record<KojoIndexKind, string>> = {
  command: '指令名',
  counter: '计数器名',
  literal: '编号槽',
};

/** 一枚落点 → 候选项（共用装配；`kind` 决定措辞，候选由契约纯函数给） */
function buildItems(
  monaco: typeof Monaco,
  position: Monaco.Position,
  slot: Slot,
  line: string,
  kind: KojoIndexKind,
  candidates: readonly { readonly name: string; readonly no: number }[],
): Monaco.languages.CompletionItem[] {
  const prefix = line.slice(slot.start, position.column - 1);
  const range = lineRange(position, slot.start, slot.end);
  const itemKind = monaco.languages.CompletionItemKind.EnumMember;
  // CJK-primary（规范 §4.1，同 `kojo-face` 的 `valueSetOf` 口径）：表里有中文名 ⇒ 纯 ASCII
  // 名视作隐藏兼容别名，不进面板。
  const hasCjk = candidates.some((c) => CJK_RE.test(c.name));
  const detailLabel = INDEX_KIND_DETAIL_LABEL[kind];
  const out: Monaco.languages.CompletionItem[] = [];
  candidates.forEach((c, idx) => {
    if (hasCjk && !CJK_RE.test(c.name)) return;
    if (prefix.length > 0 && !c.name.startsWith(prefix)) return;
    out.push({
      label: c.name,
      kind: itemKind,
      insertText: c.name,
      filterText: c.name,
      detail: `${detailLabel} → 编号 ${c.no}`,
      range,
      sortText: `${String(idx).padStart(3, '0')}_${c.name}`,
    });
  });
  return out;
}

/**
 * 产出编号槽候选（**纯函数**，供补全基座调用）。
 *
 * 行为：仅当光标落在上述两个落点之一时出货，`kind` = `EnumMember`，`insertText` = 名字，
 * `detail` = `<表名> → 编号 N`（编号来自 `lookupByName`），替换范围**只覆盖光标处那个令牌**；
 * 前缀过滤 / 排序（数据源原序，`names()` 返回序）与 CJK-primary 照既有 source 打法。
 *
 * `kinds` 声明**本次调用负责哪些面**：`['command']` 的源只出指令名（含 `是` 值位），
 * `['counter']` 的源只出计数器名（`是` 值位判为指令面，非本源的活 ⇒ `[]`）。两源各自
 * 声明对应的 `requires` 表键，缺表即跳过 + 一次可见降级信号（**不静默**）。
 */
export function kojoIndexCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  tables: IndexSlotTables,
  kinds: readonly KojoIndexKind[],
): Monaco.languages.CompletionItem[] {
  if (!model || !position) return [];
  if (!Number.isFinite(position.lineNumber) || position.lineNumber < 1) return [];
  if (!Number.isFinite(position.column) || position.column < 1) return [];

  const line = model.getLineContent(position.lineNumber);
  const col0 = position.column - 1;
  if (col0 > line.length) return [];
  if (insideStringOrComment(line, col0)) return [];

  const timing = timingNumberSlotAt(line, position.column);
  if (timing !== null) {
    // 按面的 `indexKind` 选表：缺省 `'command'`（表缺省 / 未登记面照旧走指令名，与契约同口径）。
    const kind = tables.faceTable?.faces[timing.face]?.indexKind ?? 'command';
    if (!kinds.includes(kind)) return [];
    return buildItems(monaco, position, timing, line, kind, kojoIndexCandidates(kind, tables));
  }

  const caseSlot = caseValueSlotAt(line, position.column);
  if (caseSlot === null) return [];
  // `是` 值位恒按指令名查（P-5）——计数器面没有这条构造，故只有 command 源认这处。
  if (!kinds.includes('command')) return [];
  return buildItems(monaco, position, caseSlot, line, 'command', kojoIndexCandidates('command', tables));
}
