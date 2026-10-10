/**
 * 回放面板纯逻辑（零 React；可单测）。
 *
 * - `parseCallContextText`：把用户输入的槽位赋值文本（`0=36, 1=15`）解析为
 *   `ReplayCallContext`——ARG/ARGS 是场景输入，编辑器不猜测；
 * - `groupUnknowns`：未知原因分组统计（面板分组渲染用）；
 * - `suggestFunctions`：函数名提示（按前缀/子串过滤条件索引中的函数名）；
 * - **假设值链路**（v1.0 收口 C9）：协议槽的"默认场景预填 0"是**假设值**而非
 *   确定值——`classifySlotValue`/`collectAssumedSlots` 判定来源，
 *   `summarizeAssumptions` 统计其对谓词结果的影响（"基于假设"标注 + 假设计数）。
 *
 * 全部函数为纯函数：输入 → 输出，无副作用、无 React、无服务依赖。
 */

import type { ConditionExpr, FunctionReplay, ReplayCallContext, ReplayUnknownCode } from '@kojo/plugin-api';

/** 解析失败的原因（呈现给用户） */
export type CallContextParseError = 'bad-syntax' | 'bad-slot' | 'bad-value' | 'dup-slot';

export type CallContextParseResult =
  | { ok: true; ints: (number | undefined)[]; strs: (string | undefined)[] }
  | { ok: false; error: CallContextParseError; detail: string };

/**
 * 解析调用上下文文本。
 *
 * 语法：逗号/空格分隔的 `槽位=值` 项；`n=v`（数字）→ ARG 槽；`s"..."` 或
 * `n="文本"` 形态中带引号的值 → ARGS 槽。示例：
 *   - `0=36, 1=15`          → ARG:0=36, ARG:1=15
 *   - `1="约会"`            → ARGS:1='约会'
 *   - 空 / 仅空白           → undefined（未提供上下文）
 *
 * 槽位必须是非负整数；未提供的槽位保持 undefined（unknown('call-context')）。
 */
export function parseCallContextText(text: string): CallContextParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, ints: [], strs: [] };

  const items = trimmed.split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0);
  const ints: (number | undefined)[] = [];
  const strs: (string | undefined)[] = [];
  const seenInt = new Set<number>();
  const seenStr = new Set<number>();

  for (const item of items) {
    const m = /^(\d+)\s*=\s*(.*)$/.exec(item);
    if (!m) {
      return { ok: false, error: 'bad-syntax', detail: `无法解析「${item}」（应为 槽位=值，如 0=36）` };
    }
    const slot = Number(m[1]);
    const raw = m[2]!.trim();
    if (!Number.isInteger(slot) || slot < 0 || slot > 999) {
      return { ok: false, error: 'bad-slot', detail: `槽位号非法：${m[1]}（0-999）` };
    }

    // 字符串值：带引号 → ARGS 槽
    const strM = /^"(.*)"$/.exec(raw);
    if (strM) {
      while (strs.length <= slot) strs.push(undefined);
      if (seenStr.has(slot)) return { ok: false, error: 'dup-slot', detail: `ARGS:${slot} 重复赋值` };
      seenStr.add(slot);
      strs[slot] = strM[1]!;
      continue;
    }

    // 数值槽
    if (!/^-?\d+$/.test(raw)) {
      return { ok: false, error: 'bad-value', detail: `值必须是整数或带引号字符串：「${raw}」` };
    }
    const v = Number(raw);
    if (!Number.isSafeInteger(v)) {
      return { ok: false, error: 'bad-value', detail: `数值超出安全整数范围：${raw}` };
    }
    while (ints.length <= slot) ints.push(undefined);
    if (seenInt.has(slot)) return { ok: false, error: 'dup-slot', detail: `ARG:${slot} 重复赋值` };
    seenInt.add(slot);
    ints[slot] = v;
  }

  return { ok: true, ints, strs };
}

/** 组装 `ReplayCallContext`（空槽位表 → undefined = 不注入，走 call-context unknown） */
export function toCallContext(result: Extract<CallContextParseResult, { ok: true }>): ReplayCallContext | undefined {
  const hasInts = result.ints.some((v) => v !== undefined);
  const hasStrs = result.strs.some((v) => v !== undefined);
  if (!hasInts && !hasStrs) return undefined;
  return {
    ...(hasInts ? { ints: result.ints } : {}),
    ...(hasStrs ? { strs: result.strs } : {}),
  };
}

export interface UnknownGroup {
  code: ReplayUnknownCode;
  count: number;
}

/** 未知原因分组（按数量降序；面板分组渲染用） */
export function groupUnknowns(replay: FunctionReplay): UnknownGroup[] {
  const counts = new Map<ReplayUnknownCode, number>();
  for (const p of replay.predicates) {
    if (p.outcome.kind === 'unknown') {
      const c = p.outcome.unknown.code;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
}

/**
 * 函数名提示：条件索引中的名字按子串过滤（大小写不敏感），最多 `limit` 条。
 * 空查询 → 空数组（不刷全量列表——9.5 万名字一次性渲染会拖垮 DOM）。
 */
export function suggestFunctions(names: readonly string[], query: string, limit = 50): string[] {
  const q = query.trim().toUpperCase();
  if (q.length < 2) return [];
  const hits: string[] = [];
  for (const n of names) {
    if (n.toUpperCase().includes(q)) {
      hits.push(n);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/* ------------------------- 假设值链路（v1.0 收口 C9） ------------------------- */

/**
 * 协议槽位键——`int` 与 `str` 同号互不冲突（签名可同时含 `ARG:0` 与 `ARGS:0`，
 * 如路由模板 `(ARGS:2, ARG:3, ARG:4)` → str:0 + int:0 + int:1）。
 */
export function slotKey(kind: 'int' | 'str', index: number): string {
  return `${kind}:${index}`;
}

/** 协议槽位的"默认场景"预填值（int → '0'；str → '' = 未提供） */
export function defaultSlotText(kind: 'int' | 'str'): string {
  return kind === 'int' ? '0' : '';
}

/** 协议槽位赋值的来源三态 */
export type SlotOrigin = 'manual' | 'assumption' | 'unset';

/**
 * 判定单个协议槽位赋值的来源（审阅 C9）：
 * - `unset`：空值——未提供该槽，求值走 `unknown('call-context')`，语义不变；
 * - `assumption`：**未手改且等于预填默认**（int 的 `'0'`）——"默认场景假设值"：
 *   未改动的 0 并不必然等于引擎真实默认，UI 必须标注，不得伪装成确定命中；
 * - `manual`：作者手输（含把预填 0 显式改写、以及 str 槽填写）。
 */
export function classifySlotValue(kind: 'int' | 'str', raw: string, edited: boolean): SlotOrigin {
  const t = raw.trim();
  if (t.length === 0) return 'unset';
  if (!edited && t === defaultSlotText(kind)) return 'assumption';
  return 'manual';
}

/** 假设值槽位（kind + index） */
export interface AssumedSlot {
  kind: 'int' | 'str';
  index: number;
}

/** 收集本次回放的"假设值"槽位（未手改的预填默认；str 预填空 = unset，不算假设） */
export function collectAssumedSlots(
  slots: readonly { index: number; kind: 'int' | 'str' }[],
  texts: Readonly<Record<string, string>>,
  edited: Readonly<Record<string, boolean>>,
): AssumedSlot[] {
  const out: AssumedSlot[] = [];
  for (const s of slots) {
    const k = slotKey(s.kind, s.index);
    if (classifySlotValue(s.kind, texts[k] ?? '', edited[k] === true) === 'assumption') {
      out.push({ kind: s.kind, index: s.index });
    }
  }
  return out;
}

/** 表达式引用的 ARG / ARGS 槽号（裸名 ≡ `:0`，与引擎寻址一致；动态索引段不可归因，跳过） */
export function exprArgSlots(expr: ConditionExpr): { ints: number[]; strs: number[] } {
  const ints = new Set<number>();
  const strs = new Set<number>();
  const walk = (e: ConditionExpr): void => {
    switch (e.kind) {
      case 'ref': {
        const name = e.name.toUpperCase();
        if (name !== 'ARG' && name !== 'ARGS') return;
        const rawIdx = e.indices[0];
        const idx = rawIdx === undefined ? 0 : /^\d+$/.test(rawIdx) ? Number(rawIdx) : null;
        if (idx === null) return; // 动态索引段（如 ARG:ARG:0）无法静态归因
        (name === 'ARG' ? ints : strs).add(idx);
        return;
      }
      case 'call':
        for (const a of e.args) walk(a);
        return;
      case 'unary':
        walk(e.operand);
        return;
      case 'binary':
        walk(e.left);
        walk(e.right);
        return;
      case 'ternary':
        walk(e.cond);
        walk(e.then);
        walk(e.else);
        return;
      default:
        return; // literal / nameValue / opaque 不含槽位引用（opaque 原文本不可归因）
    }
  };
  walk(expr);
  return { ints: [...ints], strs: [...strs] };
}

/** 假设值对回放结果的影响 */
export interface AssumptionImpact {
  /** 与 `replay.predicates` 逐位对齐：该谓词是否读取了任一假设值槽位 */
  affected: boolean[];
  /** 被谓词实际消费的假设槽位（去重；= "本结果含 N 个假设参数"的 N） */
  consumed: AssumedSlot[];
}

/**
 * 汇总"假设值"对回放结果的影响：
 * - `affected[i]` = 该谓词是否读到了假设槽（面板"基于假设"标注依据）；
 * - `consumed` = 至少被一条谓词读取的假设槽位（汇总计数，未被读取的槽不影响可信度）。
 */
export function summarizeAssumptions(replay: FunctionReplay, assumed: readonly AssumedSlot[]): AssumptionImpact {
  const affected = replay.predicates.map(() => false);
  if (assumed.length === 0) return { affected, consumed: [] };
  const consumed = new Map<string, AssumedSlot>();
  replay.predicates.forEach((p, i) => {
    const { ints, strs } = exprArgSlots(p.expr);
    for (const a of assumed) {
      const used = a.kind === 'int' ? ints.includes(a.index) : strs.includes(a.index);
      if (!used) continue;
      affected[i] = true;
      consumed.set(slotKey(a.kind, a.index), a);
    }
  });
  return { affected, consumed: [...consumed.values()] };
}
