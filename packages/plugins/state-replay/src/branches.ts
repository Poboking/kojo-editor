/**
 * 分支走向折叠（v0.2 第九批；游戏无关；本插件私有）。
 *
 * 把逐条谓词的三值结果按控制流骨架折叠成"该状态会走哪个分支"——
 * 比逐条谓词更接近口上作者的视角（作者写的是分支，不是谓词列表）。
 *
 * 支持两类链（与 erb-parser scanControlFlow 的配对表同源）：
 * - IF 链：IF → (ELSEIF)* → (ELSE)? → ENDIF；走首个真谓词，全假 → ELSE；
 * - SELECTCASE 链：SELECTCASE → (CASE)* → (CASEELSE)? → ENDSELECT；
 *   CASE 谓词由抽取层展开（逗号列表 → 同行多条谓词，**任一为真即命中**）。
 *
 * 可达性传播（简单版，宁少勿错）：链头若位于某条外层链"未进入分支"的
 * 行区间内 → 该链不可达（内层条件即使为真也不会执行）。已知近似（显式
 * 记录，不建模）：循环体内链的多次执行（回放取单遍语义）；unknown 不
 * 向内层传播（内层保留自身结果，UI 缩进已表达嵌套关系）。
 *
 * 宽容原则：孤儿 ELSEIF / 类型不匹配的入栈等骨架瑕疵一律跳过，绝不抛错
 * （明细数据来自 scanner 的宽容扫描，此处保持同一韧性）。
 */

import type {
  BranchChainOutcome,
  ControlFlowStatement,
  PredicateReplay,
  ReplayOutcome,
  ReplayUnknown,
} from '@kojo/plugin-api';

/** 链内分支区间（行号，1 基；end = 下一个成员行或闭合行） */
interface BranchSpan {
  /** 本分支首个成员行（IF / ELSEIF / ELSE / CASE / CASEELSE） */
  start: number;
  /** 本分支体区间终点（下一成员行；闭合时补齐） */
  end: number | null;
}

interface ChainFrame {
  kind: BranchChainOutcome['kind'];
  depth: number;
  headLine: number;
  /** 闭合行（ENDIF / ENDSELECT） */
  closeLine: number | null;
  members: BranchChainOutcome['members'][number][];
  /** 分支区间（与 members 中的条件/兜底成员一一对应；ELSE/CASEELSE 也有区间） */
  spans: BranchSpan[];
}

/** 判定链成员是否有条件谓词（ELSE / CASEELSE 无） */
function hasPredicate(kind: string): boolean {
  return kind === 'IF' || kind === 'ELSEIF' || kind === 'CASE';
}

/**
 * 折叠分支走向。
 * @param stmts 控制流骨架（detail.statements；scanControlFlow 产物切片）
 * @param predicates 谓词求值记录（detail.predicates 的回放结果；同行多条 = CASE 展开）
 */
export function buildBranchOutcomes(
  stmts: readonly ControlFlowStatement[],
  predicates: readonly PredicateReplay[],
): BranchChainOutcome[] {
  // 行 → 该行的谓词求值记录（CASE 展开的同行多条）
  const byLine = new Map<number, PredicateReplay[]>();
  for (const p of predicates) {
    const arr = byLine.get(p.line);
    if (arr) arr.push(p);
    else byLine.set(p.line, [p]);
  }

  const stack: ChainFrame[] = [];
  const done: ChainFrame[] = [];

  for (const s of stmts) {
    const top = stack[stack.length - 1];
    switch (s.kind) {
      case 'IF': {
        stack.push({
          kind: 'if-chain',
          depth: s.depth,
          headLine: s.line,
          closeLine: null,
          members: [{ line: s.line, kind: 'IF', text: s.expression }],
          spans: [{ start: s.line, end: null }],
        });
        break;
      }
      case 'ELSEIF': {
        if (top && top.kind === 'if-chain' && top.closeLine === null) {
          // 前一分支区间闭合于本行
          const prev = top.spans[top.spans.length - 1];
          if (prev) prev.end = s.line;
          top.members.push({ line: s.line, kind: 'ELSEIF', text: s.expression });
          top.spans.push({ start: s.line, end: null });
        }
        // 孤儿 ELSEIF → 跳过（宽容，与 scanner 同策略）
        break;
      }
      case 'ELSE': {
        if (top && top.kind === 'if-chain' && top.closeLine === null) {
          const prev = top.spans[top.spans.length - 1];
          if (prev) prev.end = s.line;
          top.members.push({ line: s.line, kind: 'ELSE', text: '' });
          top.spans.push({ start: s.line, end: null });
        }
        break;
      }
      case 'SELECTCASE': {
        stack.push({
          kind: 'select-chain',
          depth: s.depth,
          headLine: s.line,
          closeLine: null,
          members: [],
          spans: [],
        });
        break;
      }
      case 'CASE': {
        if (top && top.kind === 'select-chain' && top.closeLine === null) {
          const prev = top.spans[top.spans.length - 1];
          if (prev) prev.end = s.line;
          top.members.push({ line: s.line, kind: 'CASE', text: s.expression });
          top.spans.push({ start: s.line, end: null });
        }
        break;
      }
      case 'CASEELSE': {
        if (top && top.kind === 'select-chain' && top.closeLine === null) {
          const prev = top.spans[top.spans.length - 1];
          if (prev) prev.end = s.line;
          top.members.push({ line: s.line, kind: 'CASEELSE', text: '' });
          top.spans.push({ start: s.line, end: null });
        }
        break;
      }
      case 'ENDIF':
      case 'ENDSELECT': {
        const expected: BranchChainOutcome['kind'] = s.kind === 'ENDIF' ? 'if-chain' : 'select-chain';
        if (top && top.kind === expected && top.closeLine === null) {
          const prev = top.spans[top.spans.length - 1];
          if (prev) prev.end = s.line;
          top.closeLine = s.line;
          stack.pop();
          done.push(top);
        }
        // 孤儿闭合 / 类型不匹配 → 跳过
        break;
      }
      default:
        break; // SIF / 循环语句等不构成链
    }
  }

  // 未闭合链（宽容）：保留已收成员（closeLine = null，区间 end 补为大数）
  while (stack.length > 0) {
    const f = stack.pop()!;
    done.push(f);
  }

  // ---- 折叠求值（每条链独立） ----
  const outcomes: (BranchChainOutcome & { __span?: { head: number; end: number } })[] = [];
  for (const frame of done) {
    const spanOf = (idx: number): { start: number; end: number } => {
      const sp = frame.spans[idx];
      return { start: sp?.start ?? 0, end: sp?.end ?? Number.MAX_SAFE_INTEGER };
    };

    let takenLine: number | null = null;
    let outcome: BranchChainOutcome['outcome'] = 'no-match';
    let unknown: BranchChainOutcome['unknown'] | undefined;
    let decided = false;

    for (let i = 0; i < frame.members.length && !decided; i++) {
      const m = frame.members[i]!;
      if (!hasPredicate(m.kind)) {
        // ELSE / CASEELSE：前置全假（或本链无条件成员）→ 命中兜底
        takenLine = m.line;
        outcome = 'taken';
        decided = true;
        break;
      }
      const preds = byLine.get(m.line);
      if (!preds || preds.length === 0) {
        // 谓词记录缺失（如抽取层未产出）→ 未知（显式，不猜测）
        outcome = 'unknown';
        unknown = { code: 'opaque', message: `第 ${m.line} 行条件无求值记录` };
        decided = true;
        break;
      }
      // 同行谓词归约（v0.2 第十二批修复 H1）：连续 'and' 标记的谓词构成
      // 一个 AND 组（CASE `a TO b` 的两半边），其余各成 OR 组——语义 =
      // `CASE 1, 240 TO 359, 5` ≡ `v==1 || (240<=v && v<=359) || v==5`。
      // AND 组 Kleene：false 主导 → 组假；否则含 unknown → 组未知；否则真。
      const groups: { outcome: 'true' | 'false' | 'unknown'; unknown?: ReplayUnknown }[] = [];
      {
        let i = 0;
        while (i < preds.length) {
          if (preds[i]!.conjunction === 'and') {
            let group: 'true' | 'false' | 'unknown' = 'true';
            let unknownOf: (typeof groups)[number]['unknown'] | undefined;
            while (i < preds.length && preds[i]!.conjunction === 'and') {
              const o = preds[i]!.outcome;
              if (o.kind === 'false') group = 'false';
              else if (o.kind === 'unknown' && group !== 'false') {
                group = 'unknown';
                unknownOf = o.unknown;
              }
              i++;
            }
            groups.push({ outcome: group, ...(unknownOf ? { unknown: unknownOf } : {}) });
          } else {
            const o = preds[i]!.outcome;
            groups.push({
              outcome: o.kind === 'true' ? 'true' : o.kind === 'false' ? 'false' : 'unknown',
              ...(o.kind === 'unknown' ? { unknown: o.unknown } : {}),
            });
            i++;
          }
        }
      }
      const anyTrue = groups.some((g) => g.outcome === 'true');
      if (anyTrue) {
        takenLine = m.line;
        outcome = 'taken';
        decided = true;
        break;
      }
      const blockedGroup = groups.find((g) => g.outcome === 'unknown');
      if (blockedGroup) {
        // 本成员全非真但有未知：即使后续成员为真也不能保证走到（前序未知
        // 可能为真）→ 整链走向未知，立即阻断（链语义，与 Kleene 的
        // "后续无法救回"一致）。
        outcome = 'unknown';
        unknown = blockedGroup.unknown;
        decided = true;
        break;
      }
      // 全假 → 下一成员
    }

    const lastMember = frame.members[frame.members.length - 1];
    outcomes.push({
      kind: frame.kind,
      headLine: frame.headLine,
      depth: frame.depth,
      members: frame.members,
      takenLine,
      outcome,
      ...(unknown ? { unknown } : {}),
      __span: {
        head: frame.headLine,
        end: frame.closeLine ?? lastMember?.line ?? frame.headLine,
      },
    });
  }

  // ---- 可达性传播（简单版）：链头位于外层链"未进入分支"区间 → unreachable ----
  // 外层 = 包含本链头的、深度更小的链；取深度最小（最直接外层）。
  const final = outcomes.map((o) => {
    const { __span, ...rest } = o;
    const span = __span!;
    let outer: (typeof outcomes)[number] | null = null;
    for (const p of outcomes) {
      if (p === o) continue;
      const ps = p.__span!;
      if (ps.head < span.head && span.head < ps.end) {
        if (!outer || p.depth < outer.depth) outer = p;
      }
    }
    if (outer && (outer.outcome === 'taken' || outer.outcome === 'no-match')) {
      // 外层确定走向：检查本链头是否在命中分支区间内
      const idx = outer.members.findIndex((m) => m.line === outer!.takenLine);
      if (idx >= 0) {
        const sp = spanOfOuter(outer, idx);
        if (span.head >= sp.start && span.head < sp.end) return rest; // 在命中分支内 → 可达
      }
      return { ...rest, outcome: 'unreachable' as const, takenLine: null, unknown: undefined };
    }
    return rest;
  });

  // 按链头行序输出（UI 顺序呈现）
  return final.sort((a, b) => a.headLine - b.headLine);
}

/** 取外层链第 idx 个成员的分支区间（闭合后 end 已补齐；未闭合用 MAX） */
function spanOfOuter(
  outer: { members: BranchChainOutcome['members'][number][]; __span?: { head: number; end: number } },
  idx: number,
): { start: number; end: number } {
  // __span 只存链级信息；这里基于成员行序重建区间（与折叠时 spans 同构）：
  // 分支 i 的区间 = [member[i].line, member[i+1].line ?? 链尾)
  const m = outer.members;
  const start = m[idx]?.line ?? 0;
  const next = m[idx + 1]?.line;
  const end = next ?? outer.__span?.end ?? Number.MAX_SAFE_INTEGER;
  return { start, end };
}
