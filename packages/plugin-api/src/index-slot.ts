/**
 * `{i}`（时机编号槽）取值口径的**单一真源**（契约层纯函数；零游戏知识、零 IO）。
 *
 * ## 为什么必须收拢到一枚
 *
 * 同一个槽位有三个消费者，各算一次：
 * 1. **转译器**（`kojo-sugar/codegen.ts::resolveTimingIndex`）——算出来的编号直接进产物字节；
 * 2. **悬停**（`app/monaco/kojo-hover-native.ts::resolveIndex`）——算出来的编号拼进"这个时机
 *    会生成哪个函数名"；
 * 3. **编号槽补全**（`app/monaco/kojo-completion-instructions.ts`）——枚举该槽能写哪些候选名。
 *
 * 1016 批给 `计数器` 面加了 `indexKind: 'counter'`（悬停/转译跟上了），补全面却仍只认
 * 指令名表 ⇒ **同一个槽位，悬停认计数器表、补全出指令名**（写下去必被 `timing-counter-unknown`
 * 拦）；`literal` 面（`时机 图像 `）同样被指令名串台。IX-1 批把"按 kind 选表 + 查表"
 * 收拢成本模块三枚纯函数，三处只准调它——**同槽异口径从构造上不可能再出现**。
 *
 * ## kind 语义（契约 `KojoFaceTemplate.indexKind`）
 *
 * | kind | 名令牌 | 编号令牌（纯数字） | 候选面 |
 * |---|---|---|---|
 * | `'command'`（缺省） | 查**指令名表** `KojoInstructionTable` | 不查表、逐字节直通 | 指令名 |
 * | `'counter'` | 查**计数器值域表** `KojoCounterTable` | 不查表、逐字节直通 | 计数器名 |
 * | `'literal'` | **不查任何表**、原样透传 | 原样透传 | **零候选**（尾部是运行期字符串，列表给不出真值） |
 *
 * 一律**不猜**：表缺席 / 名未登记 ⇒ `{ ok: false }` 或 `undefined`——调用方各自 fail-closed
 * （转译器报诊断不产半成品；补全零候选 + `requires` 机制发一次可见降级信号）。
 */

import type { KojoCounterTable, KojoInstructionTable, KojoIndexKind } from './game';

/** 编号槽解析所需的表（**全部可选**；缺席 = 该路不解析，与既有"缺表即零候选"同一纪律） */
export interface KojoIndexTables {
  /** 指令名表（`KojoFaceTemplate.indexKind === 'command'` 时用） */
  readonly instructionTable?: KojoInstructionTable;
  /** 计数器值域表（`indexKind === 'counter'` 时用） */
  readonly counterTable?: KojoCounterTable;
}

/** 名令牌 → `{i}` 段取值的解析结果（`reason` 供调用方挑人话文案，判词不在此处） */
export type KojoIndexResolution =
  | { readonly ok: true; readonly index: string }
  | { readonly ok: false; readonly reason: 'no-table' | 'unknown' };

/** 纯数字令牌判定（不查表、逐字节直通的那条路） */
const DIGITS_RE = /^\d+$/;

/**
 * 名令牌 → `{i}` 段取值（口径与转译器 `resolveTimingIndex` 逐字一致）。
 *
 * - `'literal'` / 纯数字 / 缺失表里的名 → 见头注表；一切"算不出来"都返回 `ok:false`，
 *   **绝不返回半个编号**；
 * - `'command'` 与 `'counter'` 的 `reason` 都区分 `'no-table'`（表缺席或空表）与
 *   `'unknown'`（表在、名不在）——转译器据此出**两套互斥人话**（成因可分辨，不静默）。
 */
export function resolveKojoIndexName(
  kind: KojoIndexKind | undefined,
  token: string,
  tables: KojoIndexTables,
): KojoIndexResolution {
  const k = kind ?? 'command';
  // `literal`：尾部是运行期形态名，原样透传（连纯数字也不查表——本面无"编号"概念）。
  if (k === 'literal') return { ok: true, index: token };
  // 纯数字令牌：旧写法（`时机 计数器 20：` / `时机 指令 310：`）逐字节直通，不进任何表。
  if (DIGITS_RE.test(token)) return { ok: true, index: token };
  if (k === 'counter') {
    const table = tables.counterTable;
    const no = table?.lookupByName(token);
    if (no === undefined) return { ok: false, reason: missing(table) ? 'no-table' : 'unknown' };
    return { ok: true, index: String(no) };
  }
  const table = tables.instructionTable;
  const no = table?.lookupByName(token);
  if (no === undefined) return { ok: false, reason: missing(table) ? 'no-table' : 'unknown' };
  return { ok: true, index: String(no) };
}

/** 「这枚表算不算缺席」（表 undefined / `hasTable=false` / 正查抛错 ⇒ 缺席；抛错绝不让补全链崩） */
function missing(table: KojoInstructionTable | KojoCounterTable | undefined): boolean {
  if (table === undefined) return true;
  try {
    return table.hasTable === false;
  } catch {
    return true;
  }
}

/** 编号槽的一条**正向候选**（`no` = 该名在表里的编号；同名多编号取首条 = 号小者） */
export interface KojoIndexCandidate {
  readonly name: string;
  readonly no: number;
}

/**
 * 编号槽的**正向候选**（补全面用；按 `kind` 选表，`literal` 面恒零候选）。
 *
 * 与 `KojoInstructionTable.names` / `KojoCounterTable.names` 同一约定：**枚举能力是可选的**
 * （未提供 ⇒ 零候选，不猜）；枚举里有、正查却无 = 表自相矛盾 ⇒ 该名跳过。返回序即展示序。
 */
export function kojoIndexCandidates(
  kind: KojoIndexKind | undefined,
  tables: KojoIndexTables,
): readonly KojoIndexCandidate[] {
  const k = kind ?? 'command';
  if (k === 'literal') return [];
  const table: KojoInstructionTable | KojoCounterTable | undefined =
    k === 'counter' ? tables.counterTable : tables.instructionTable;
  if (table === undefined || missing(table)) return [];
  const enumerate = table.names;
  if (typeof enumerate !== 'function') return [];
  const out: KojoIndexCandidate[] = [];
  const seen = new Set<string>();
  for (const name of enumerate.call(table)) {
    if (name.length === 0 || seen.has(name)) continue;
    const no = table.lookupByName(name);
    if (no === undefined) continue; // 枚举有、正查无 ⇒ 不猜
    seen.add(name);
    out.push({ name, no });
  }
  return out;
}

/**
 * 编号 → 名（**反向**；悬停/回显用）。`literal` 面无反向、表缺席、号未登记 ⇒ `undefined`。
 *
 * 存在的理由：`lookupByNumber` / `lookupByNo` 自 1016 起在生产侧**零消费**——作者看到
 * `时机 计数器 20：` 时无从知道 20 是哪条计数器（正向名路径能查，反向号路径查不了）。
 */
export function kojoIndexNameOf(
  kind: KojoIndexKind | undefined,
  no: number,
  tables: KojoIndexTables,
): string | undefined {
  const k = kind ?? 'command';
  if (k === 'literal') return undefined;
  return k === 'counter' ? tables.counterTable?.lookupByNumber(no) : tables.instructionTable?.lookupByNo(no);
}
