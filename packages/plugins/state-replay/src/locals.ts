/**
 * 函数级求值上下文叠加（v0.2 第六批；游戏无关；本插件私有）。
 *
 * 在状态视图（快照）之上叠加两类**函数内**语义，两者都是引擎语言层知识：
 *
 * 1. **本地量数据流**：`LOCAL / LOCALS / RESULT / RESULTS` 的直线赋值
 *    （`condition.extractor` 的 `FunctionPredicates.assignments`）按行序求值。
 *    可达性规则：赋值 A 对使用点 U 可得 ⇔ `A.context` 是 `U.context` 的
 *    **前缀**（同路径或祖先路径）——兄弟分支互不可达，闭合块外的使用点
 *    不吃块内赋值。取**最后一个**可达赋值（last-write-wins，直线近似）。
 *    已知近似（刻意不做分支敏感性）：同一 if/else 两侧对同槽位的赋值，
 *    在"使用点位于另一分支"时可能吃到对方分支的赋值（真实语料中该形态
 *    罕见；记录为边界，宁少勿错的方向由 prefix 规则兜住大多数）。
 *
 * 2. **调用上下文**：`ARG / ARGS` 引用（裸名 ≡ 0 号槽）按注入的
 *    `ReplayCallContext` 取值；未提供 / 未覆盖的槽位 → unknown('call-context')。
 *    （默认不猜测 0：转发自路由层的值是场景输入，编辑器无从推断。）
 *    **KW-28 1103 判性读数**（真语料 K49 × save03 · 11,685 枚谓词 / 1,356 函数）：
 *    本族 858 枚，分布在 **131 个函数**（不是几枚助手函数：单函数最多 38 枚、前 10 名
 *    合计 250 枚＝29%，17 个函数只有 1 枚）——即各角色自己的 `M_KOJO*_EVENT_K*_*`
 *    入口函数，谓词形态是 `SELECTCASE ARG` 这类"按本次调用的 buffer 分支"。
 *    846 枚走 `!callContext`（路由模板里没有确定槽 / 协议不认识该函数名），12 枚走
 *    "已注入但没填这一格"。逐枚核过路由层的转发链（全语料 522 处 `KOJO_MESSAGE_SEND`
 *    调用点）：同一 `(种类, 时机)` 键的转发实参**在不同调用点取值不同**（`EVENT|34`
 *    有 29 处调用点，buffer1＝32 / 30 / 31 / 7 / 1 / 2 …），且 buffer 位常是调用方的
 *    运行期变量（`Activity_Type:ARG`）；路由层自身对 `ARG:3` / `ARG:4` **只有读没有写**。
 *    ⇒ 这一族是**场景输入**，不是求值能力缺口：严格判据（该键全语料唯一调用点 **且**
 *    被引用的那一格是字面量）只覆盖 **9 / 858 枚＝1%**，且它依赖"调用点枚举完整"这一
 *    静态无从自证的命题 ⇒ **不收**（假命中比未知贵）。红线：任何"把某一次调用的实参
 *    当作该槽的值"的捷径都要先过 `call-protocol.test.ts` 的那枚"槽值只能来自路由确定
 *    事实"闸（判据在测试里，读数在这里，两边都不许放宽）。
 *
 * 全部只读：叠加层绝不修改视图；求值复用 evaluate.ts（含 Kleene 语义）。
 */

import type {
  FunctionAssignment,
  FunctionPredicates,
  ReplayCallContext,
  ReplayValue,
  VariableRef,
} from '@kojo/plugin-api';
import { evaluateExpr, type ValueReader } from './evaluate';

/**
 * 数据流可解析的本地量槽位（与 extractor ASSIGNABLE_LOCALS 对齐）。
 * 导出给 `loop-range.ts` 用——同一插件里"哪些名字算本地量"只许这一份。
 */
export const LOCAL_FAMILY_SLOTS = new Set(['LOCAL', 'LOCALS', 'RESULT', 'RESULTS']);
const OVERLAY_ARGS = new Set(['ARG', 'ARGS']);

/** 使用点位置（谓词行 / 赋值行） */
export interface OverlayPosition {
  line: number;
  /** 分支上下文路径（外→内；谓词未填时视为顶层） */
  context: readonly string[];
}

/** 叠加读取器：返回 null = 不归本层管（调用方继续走 view.read） */
export type OverlayReader = (ref: VariableRef, at: OverlayPosition) => ReplayValue | null;

function isPrefixPath(prefix: readonly string[], path: readonly string[]): boolean {
  if (prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== path[i]) return false;
  }
  return true;
}

export interface CreateOverlayOptions {
  detail: FunctionPredicates;
  callContext?: ReplayCallContext;
  /** 基础读取器（视图读路径）：赋值 RHS 中的非本地量引用落到它 */
  baseRead: ValueReader;
}

/** 叠加层为空（无赋值且无调用上下文）→ null，调用方跳过叠加 */
export function createFunctionOverlay(opts: CreateOverlayOptions): OverlayReader | null {
  const assignments = opts.detail.assignments;
  const callContext = opts.callContext;
  const baseRead = opts.baseRead;
  if (assignments.length === 0 && !callContext) return null;

  /** 赋值求值记忆：`name:index@line` → 值（同一赋值的求值确定性成立） */
  const memo = new Map<string, ReplayValue>();

  /** 在赋值行位置求值其 RHS（递归消费更早的赋值；非本地量落到视图） */
  const evalAssignment = (a: FunctionAssignment): ReplayValue => {
    const key = `${a.name}:${a.index}@${a.line}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const v = evaluateExpr(
      a.expr,
      { read: (ref) => resolve(ref, { line: a.line, context: a.context }) ?? baseRead(ref) },
    );
    memo.set(key, v);
    return v;
  };

  /** 本地量槽位解析（last-write-wins among 可达赋值） */
  const resolveLocal = (name: string, index: number, at: OverlayPosition): ReplayValue => {
    let pick: FunctionAssignment | null = null;
    for (const a of assignments) {
      if (a.name !== name || a.index !== index) continue;
      if (a.line >= at.line) break; // assignments 按行升序；越过使用点即止
      if (!isPrefixPath(a.context, at.context)) continue;
      pick = a;
    }
    if (!pick) {
      // 旧文案对"函数里明明写了、只是不在本使用点的必经路径上"那一族是**假话**
      // （读起来像没人赋值）。机器码沿用 `local-no-write`（v0.2 第六批立的边界、
      // 判定口径一字未改），只把"为什么算它无可见赋值"写实。
      const elsewhere = assignments.filter((a) => a.name === name && a.index === index && a.line < at.line);
      const why =
        elsewhere.length === 0
          ? '本函数内该槽位没有赋值语句，进入函数时的残留值不可知'
          : `函数内另有 ${elsewhere.length} 处赋值（第 ${elsewhere
              .slice(0, 6)
              .map((a) => String(a.line))
              .join(' / ')} 行${elsewhere.length > 6 ? ' …' : ''}），但都不在本使用点的必经路径上；未被赋值时的残留值不可知`;
      return {
        kind: 'unknown',
        unknown: {
          code: 'local-no-write',
          message: `本地量在函数内无可见赋值：${name}:${index}（第 ${at.line} 行前，同分支路径）——${why}`,
        },
      };
    }
    return evalAssignment(pick);
  };

  /** ARG/ARGS 槽位解析（注入的调用上下文；裸名 ≡ 0 号槽） */
  const resolveArg = (name: string, indices: readonly string[], text: string): ReplayValue => {
    let slot: number | null = null;
    if (indices.length === 0) slot = 0; // 裸 ARG ≡ ARG:0（1D 裸引用 = 0 号下标，引擎语义）
    else if (indices.length === 1 && /^-?\d+$/.test(indices[0]!)) slot = Number(indices[0]);
    if (slot === null || slot < 0) {
      return { kind: 'unknown', unknown: { code: 'call-context', message: `调用参数槽位无法解析：${text}` } };
    }
    if (!callContext) {
      // KW-28 1103：旧文案只说"未提供"，读起来像"谁忘了给"——实际是**这一格的值取决于
      // 本次调用的实参**，而回放既没有调用栈（存档只有状态）也无从知道是哪一处调用进来
      // 的。把因果写实，免得作者去找一个并不存在的"提供入口"。
      return {
        kind: 'unknown',
        unknown: {
          code: 'call-context',
          message: `ARG/ARGS 为调用参数，未提供调用上下文：${text}（这一格的值由本次调用的实参决定；存档里只有状态、没有调用栈，静态也无从确定是哪一处调用带进来的值 ⇒ 不猜）`,
        },
      };
    }
    const arr = name === 'ARG' ? callContext.ints : callContext.strs;
    const v = arr?.[slot];
    if (v === undefined) {
      return {
        kind: 'unknown',
        unknown: {
          code: 'call-context',
          message: `调用上下文未覆盖该槽位：${text}（注入的实参只填了部分槽位；没填的这一格仍取决于本次调用 ⇒ 不猜，也不借用相邻槽位的值）`,
        },
      };
    }
    return { kind: 'value', value: v };
  };

  const resolve = (ref: VariableRef, at: OverlayPosition): ReplayValue | null => {
    const name = ref.name.toUpperCase();
    if (OVERLAY_ARGS.has(name)) return resolveArg(name, ref.indices, ref.text);
    if (!LOCAL_FAMILY_SLOTS.has(name)) return null;

    let index: number | null = null;
    if (ref.indices.length === 0) index = 0;
    else if (ref.indices.length === 1 && /^-?\d+$/.test(ref.indices[0]!)) index = Number(ref.indices[0]);
    if (index === null || index < 0) {
      // 动态索引 / 多维段：数据流不建模（保留 dynamic-index 语义）
      return { kind: 'unknown', unknown: { code: 'dynamic-index', message: `本地量索引段无法静态解析：${ref.text}` } };
    }
    return resolveLocal(name, index, at);
  };

  return (ref: VariableRef, at: OverlayPosition): ReplayValue | null => resolve(ref, at);
}
