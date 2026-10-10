/**
 * 回放面板纯逻辑（零 React；可单测）。
 *
 * - `parseCallContextText`：把用户输入的槽位赋值文本（`0=36, 1=15`）解析为
 *   `ReplayCallContext`——ARG/ARGS 是场景输入，编辑器不猜测；
 * - `groupUnknowns`：未知原因分组统计（面板分组渲染用）；
 * - `suggestFunctions`：函数名提示（按前缀/子串过滤条件索引中的函数名）。
 */

import type { FunctionReplay, ReplayCallContext, ReplayUnknownCode } from '@kojo/plugin-api';

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
