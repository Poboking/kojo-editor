/**
 * ERB **成员位**的判据（`@kojo/erb-lang/completion-members`）。
 *
 * ## 这一格回答什么
 *
 * 光标停在哪一种"成员位"上——三种，**都不是普通名字位**：
 * - `member`：点号成员位（`M_KOJO.K12` / `M_KOJO.|`）。接收者是点号之前的连续名字段；
 * - `field`：`族:…` 引用里的名字段（`CSTR:名` 这类引擎族的索引位）；
 * - `variable-family`：裸族头位（写一段前缀等引擎族全名，与族头补全同一份扫描）。
 *
 * ## 为什么在语言面库
 *
 * 三条判据各自都是**语法**：`.` 在 ERB 里不是运算符（点号位的接收者只能是名字）、
 * `族:段:` 的段式是引用语法、"裸标识符名位"是词法。它们此前与候选装配一起住在宿主——
 * 而候选装配要读 adapter 表（游戏事实），判据不要。判据进包之后，插件的供方能对同一个
 * 位置给出与宿主逐字相同的判断。
 *
 * ## 复用而不是重抄
 *
 * - 代码视野（串内 / 注释内不认）= 位置门那一份（`erbCompletionGate`），不另写引号计数；
 * - `族:` 名字段 = `erbVariableReferenceSlotAt`（**结构侧**的面，不核族头白名单——
 *   `CSTR:` / `EX:` 这类引擎族不在降糖白名单里，但结构上仍是引用）；
 * - 裸族头名位 = `erbDeclaredNameSlot`（与族头候选同一份扫描）；
 * - 被 sigil 领起的 token（`$标签.` / `@函数.`）不认 = `ERB_SIGIL_BEFORE`（同一份排除集）。
 *
 * ## 不猜的方向
 *
 * `1.` 的小数点、`..`、接收者为空、`1:` / `0:` 这种编号形族头、裸名位前缀不命中任何引擎族
 * ——一律 `null`（"这里不是成员位"），而不是交一份空候选冒充判断。
 */
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/kojo-vocab/engine';
import { NAME_CHAR_RE, erbCompletionGate } from './completion-context';
import { ERB_SIGIL_BEFORE, erbDeclaredNameSlot } from './completion-families';
import { erbVariableReferenceSlotAt } from './completion-variables';

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

/** 1 基列 → 0 基列（越界夹进线内；非法列 ⇒ `null`）。纯算术，不是判据 */
function col0Of(line: string, column: number): number | null {
  if (!Number.isFinite(column) || column < 1) return null;
  return Math.min(column - 1, line.length);
}

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
  // 2) 接收者 = 点号之前的连续名字字符段；空 / 数值 / `(x).` / 被 sigil 领起（`$标签.` / `@函数.`）一律不认
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
 * 判定顺序：代码视野 → 点号成员 → `族:` 名字段 → 裸族头。
 */
export function erbMemberSlotAt(lineText: string, column: number): ErbMemberSlot | null {
  const col0 = col0Of(lineText, column);
  if (col0 === null) return null;
  // 串内 / 行注释内不是代码视野（判据 = 位置门那一份，不另写引号计数）
  if (erbCompletionGate(lineText, column) === 'in-string') return null;

  const member = memberSlotWithin(lineText, col0);
  if (member !== null) return member;

  // `族:…` 的名字段（结构层判据；不核对族头白名单 ⇒ 不在降糖白名单里的引擎族同样认得）。
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

  // 裸族头位（写一段前缀等族名）：名位判据与族头候选同一份
  const nameSlot = erbDeclaredNameSlot(lineText, column);
  if (nameSlot === null) return null;
  const needle = nameSlot.prefix.toUpperCase();
  const hit =
    needle.length === 0 || ENGINE_VARIABLE_FAMILIES.some((family) => family.toUpperCase().startsWith(needle));
  if (!hit) return null;
  return { kind: 'variable-family', start: nameSlot.start, end: nameSlot.end, prefix: nameSlot.prefix };
}