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

/** 数据流可解析的本地量槽位（与 extractor ASSIGNABLE_LOCALS 对齐） */
const OVERLAY_LOCALS = new Set(['LOCAL', 'LOCALS', 'RESULT', 'RESULTS']);
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
    const v = evaluateExpr(a.expr, (ref) => resolve(ref, { line: a.line, context: a.context }) ?? baseRead(ref));
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
      return {
        kind: 'unknown',
        unknown: {
          code: 'local-no-write',
          message: `本地量在函数内无可见赋值：${name}:${index}（第 ${at.line} 行前，同分支路径）`,
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
      return {
        kind: 'unknown',
        unknown: { code: 'call-context', message: `ARG/ARGS 为调用参数，未提供调用上下文：${text}` },
      };
    }
    const arr = name === 'ARG' ? callContext.ints : callContext.strs;
    const v = arr?.[slot];
    if (v === undefined) {
      return { kind: 'unknown', unknown: { code: 'call-context', message: `调用上下文未覆盖该槽位：${text}` } };
    }
    return { kind: 'value', value: v };
  };

  const resolve = (ref: VariableRef, at: OverlayPosition): ReplayValue | null => {
    const name = ref.name.toUpperCase();
    if (OVERLAY_ARGS.has(name)) return resolveArg(name, ref.indices, ref.text);
    if (!OVERLAY_LOCALS.has(name)) return null;

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
