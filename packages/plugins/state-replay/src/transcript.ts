/**
 * 台词推演（v0.3 口上调试统一批；游戏无关；本插件私有）。
 *
 * 职责：把抽取层的显示行（`FunctionPredicates.displays`）在状态视图上求值成
 * 消息窗视角的逐行结果——**会不会输出**（可见性）与**输出什么**（插值替换）。
 * 这是架构文档 §5.4 预留的 `preview` 槽位的引擎半边（渲染归 UI 消费方）。
 *
 * ## 可见性判定（几何组装；纯函数）
 *
 * 单遍语义（与 `branches.ts` 同口径：循环体内多次执行刻意不建模）：
 * - 起点 `shown`；被**每层**包络链逐步细化（外→内）：
 *   - 链 `taken` 且本行在命中分支区间内 → 保持；在别的分支区间 → `hidden`；
 *   - 链 `no-match` / `unreachable` → `hidden`（确定不执行）；
 *   - 链 `unknown` → `maybe`（该层判不出，内层无法救回——与 Kleene 的
 *     "前序未知可能为真"同源）；未闭合链的无界尾段同样只给 `maybe`。
 * - `SIF` 守卫：**只看同行**（`SIF 条件 PRINT…`，抽取侧 `sifGuarded` 标记）——
 *   引擎语义里 `SIF` 只约束同一行的语句，`SIF` 单独成行等于空操作。按该行
 *   谓词判定细化（真 → 保持；假 → `hidden`；未知 → `maybe`）。
 *   反向推断（"上一行是 SIF 就守这一行"）**刻意不做**：那在引擎里不成立，
 *   会把会显示的行误报成不显示。
 *
 * ## 文本求值
 *
 * 插值切片**只用抽取侧的 `start/end` 偏移**（切片判据单一真源在
 * condition-extractor `display.ts`，回放侧不重扫）。判定不了的表达式以
 * `%?%` 占位并计入 `unresolved`——诚实边界与谓词求值同源，绝不猜。
 * `%NAME%` / `%CALLNAME%`（省略角色位）按引擎语义补 `MASTER`——Emuera 的
 * 角色变量省略下标即 MASTER，不是"当前回放角色"（后者是 `TARGET`）。
 */

import type {
  BranchChainOutcome,
  ConditionExpr,
  FunctionDisplayLine,
  FunctionPredicates,
  PredicateReplay,
  ReplayUnknown,
  TranscriptLine,
  TranscriptVisibility,
  VariableRef,
} from '@kojo/plugin-api';
import { evaluateExpr, type CallResolver, type EvalContext, type ValueReader } from './evaluate';
import type { OverlayReader } from './locals';

/** 未知占位（UI 与文档同词：判不出的插值以 `%?%` 落在文本里） */
const UNKNOWN_PLACEHOLDER = '%?%';

/** 不可救回的兜底未知（几何判定给的原因，非求值错误） */
function guardUnknown(message: string): ReplayUnknown {
  return { code: 'opaque', message };
}

/** 链内第 idx 个成员的分支区间（与 branches.ts 的 spans 同构重建） */
function spanOfMember(chain: BranchChainOutcome, idx: number): { start: number; end: number } {
  const start = chain.members[idx]?.line ?? 0;
  const next = chain.members[idx + 1]?.line;
  const end = next ?? chain.endLine ?? Number.MAX_SAFE_INTEGER;
  return { start, end };
}

/** 链是否包络该行（未闭合链 = 管到函数尾；可见性按保守口径只给 maybe） */
function chainCovers(chain: BranchChainOutcome, line: number): boolean {
  return line > chain.headLine && (chain.endLine !== undefined ? line < chain.endLine : true);
}

interface Visibility {
  visibility: TranscriptVisibility;
  reason?: ReplayUnknown;
  guardLine?: number;
}

/**
 * 本行所在的**链成员**（分支头行）及其区间；不在任何分支体内 → null。
 * 只认成员自身区间（`line > 成员行 && line < 下一成员行/闭合行`）。
 */
function memberAt(chain: BranchChainOutcome, line: number): { idx: number; span: { start: number; end: number } } | null {
  for (let idx = 0; idx < chain.members.length; idx++) {
    const sp = spanOfMember(chain, idx);
    if (line > sp.start && line < sp.end) return { idx, span: sp };
  }
  return null;
}

/**
 * 包络链逐层细化（外→内；首个非 shown 即定型——内层无法救回）。
 *
 * `unknown` 链**不是**一律给 maybe（2026-11-02 真实语料收紧）：分支体只在"本成员被
 * 选中"时执行，而"被选中"要求本成员条件为真且前序全假 ⇒ **本成员条件明确为假时，
 * 它体内的行一定不执行**，与前序判不判得出无关。只按"链未知"整段判 maybe，会把
 * 作者最想看的"这句到底在哪个分支下"糊成一片"可能"。
 *
 * @param predsByLine 谓词求值结果按行归并（CASE 同行多值：任一为真即命中）
 */
function visibilityFromChains(
  line: number,
  chains: readonly BranchChainOutcome[],
  predsByLine: ReadonlyMap<number, readonly PredicateReplay[]>,
): Visibility {
  let vis: Visibility = { visibility: 'shown' };
  for (const chain of chains) {
    if (!chainCovers(chain, line)) continue;
    if (vis.visibility !== 'shown') break; // hidden/maybe 已定型（unknown 外层主导）
    switch (chain.outcome) {
      case 'taken': {
        const idx = chain.members.findIndex((m) => m.line === chain.takenLine);
        if (idx < 0) {
          vis = { visibility: 'maybe', reason: guardUnknown(`第 ${chain.headLine} 行的分支无命中记录`), guardLine: chain.headLine };
          break;
        }
        const sp = spanOfMember(chain, idx);
        if (line > sp.start && line < sp.end) {
          // 在命中分支内；分支无界尾段（未闭合链）→ 保守 maybe
          if (sp.end === Number.MAX_SAFE_INTEGER) {
            vis = { visibility: 'maybe', reason: guardUnknown(`第 ${chain.headLine} 行的分支未闭合，管辖范围判不定`), guardLine: chain.headLine };
          }
          break; // shown → 保持，继续看内层
        }
        vis = { visibility: 'hidden', reason: guardUnknown(`第 ${chain.headLine} 行的分支走了别处`), guardLine: chain.headLine };
        break;
      }
      case 'no-match':
        vis = { visibility: 'hidden', reason: guardUnknown(`第 ${chain.headLine} 行的分支全部未命中`), guardLine: chain.headLine };
        break;
      case 'unreachable':
        vis = { visibility: 'hidden', reason: guardUnknown(`外层分支未进入，第 ${chain.headLine} 行的分支不会执行`), guardLine: chain.headLine };
        break;
      case 'unknown': {
        const at = memberAt(chain, line);
        const member = at ? chain.members[at.idx] : undefined;
        const preds = member ? (predsByLine.get(member.line) ?? []) : [];
        // 该成员条件**全部明确为假** ⇒ 这一支不可能被选中 ⇒ 体内行一定不执行
        if (preds.length > 0 && preds.every((p) => p.outcome.kind === 'false')) {
          vis = {
            visibility: 'hidden',
            reason: guardUnknown(`第 ${member!.line} 行的条件不成立（整条链另有分支判不出，但这一支确定不会走）`),
            guardLine: member!.line,
          };
          break;
        }
        vis = {
          visibility: 'maybe',
          reason: chain.unknown ?? guardUnknown(`第 ${chain.headLine} 行的分支判不出走向`),
          guardLine: chain.headLine,
        };
        break;
      }
    }
  }
  return vis;
}

/** SIF 同行守卫细化（`shown` 才继续；hidden/maybe 已定型） */
function refineBySif(vis: Visibility, dl: FunctionDisplayLine, sifByLine: Map<number, PredicateReplay>): Visibility {
  if (vis.visibility !== 'shown') return vis;
  if (!dl.sifGuarded) return vis;
  const pred = sifByLine.get(dl.line);
  if (!pred) {
    // 无求值记录：保守 maybe（SIF 守着这行是确定的，判不定的是它会真会假）
    return { visibility: 'maybe', reason: guardUnknown(`第 ${dl.line} 行的 SIF 条件无求值记录`), guardLine: dl.line };
  }
  if (pred.outcome.kind === 'true') return vis;
  if (pred.outcome.kind === 'false') {
    return { visibility: 'hidden', reason: guardUnknown(`第 ${dl.line} 行的 SIF 条件不成立`), guardLine: dl.line };
  }
  return { visibility: 'maybe', reason: pred.outcome.unknown, guardLine: dl.line };
}

/**
 * 省略角色位的 `NAME` / `CALLNAME` = `MASTER`（Emuera 角色变量省略下标语义；
 * `MASTER` 由状态视图按快照顶层指针解析，不是写死的 0）。
 */
function specialRef(ref: VariableRef): VariableRef {
  if (ref.indices.length > 0) return ref;
  if (ref.name === 'NAME' || ref.name === 'CALLNAME') {
    return { name: ref.name, indices: ['MASTER'], text: ref.text };
  }
  return ref;
}

/** 值 → 消息窗文本（引擎打印语义：数值十进制、字符串原样） */
function formatValue(v: number | string): string {
  return typeof v === 'number' ? String(v) : v;
}

/** 单表达式求值：值 → 文本片段；判不出 → null（调用方占位 + 计数） */
function evalText(expr: ConditionExpr, ctx: EvalContext): string | null {
  const v = evaluateExpr(expr, ctx);
  if (v.kind !== 'value') return null;
  return formatValue(v.value);
}

/**
 * 载荷 → 求值文本（只消费抽取侧的切片偏移；不在回放侧重扫）。
 * 外层引号剥离：`PRINTFORM "…"` 的引号是写法不是输出（切片偏移随之平移）。
 */
function evaluateText(dl: FunctionDisplayLine, ctxOf: (at: { line: number; context: readonly string[] }) => EvalContext): { text: string; unresolved: number } {
  let body = dl.payload;
  let shift = 0;
  if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) {
    body = body.slice(1, -1);
    shift = 1;
  }
  const ctx = ctxOf({ line: dl.line, context: dl.context ?? [] });
  let text = '';
  let unresolved = 0;
  let cursor = 0;
  for (const interp of dl.interpolations) {
    const start = interp.start - shift;
    const end = interp.end - shift;
    if (start < 0 || end > body.length || start < cursor) continue; // 越界切片（引号剥离错位）：跳过不猜
    text += body.slice(cursor, start);
    cursor = end;
    if (interp.form === 'inlineTernary') {
      const v = evaluateExpr(interp.expr, ctx);
      if (v.kind === 'unknown') {
        // 选不出：两支都可能——并排呈现（UI 图例解释），计入未定
        text += `${interp.thenText ?? ''}／${interp.elseText ?? ''}`;
        unresolved++;
        continue;
      }
      const n = typeof v.value === 'number' ? v.value : null;
      if (n === null) {
        text += `${interp.thenText ?? ''}／${interp.elseText ?? ''}`;
        unresolved++;
        continue;
      }
      text += n !== 0 ? (interp.thenText ?? '') : (interp.elseText ?? '');
      continue;
    }
    const piece = evalText(interp.expr, ctx);
    if (piece === null) {
      text += UNKNOWN_PLACEHOLDER;
      unresolved++;
      continue;
    }
    text += piece;
  }
  text += body.slice(cursor);
  return { text, unresolved };
}

/** 台词推演构建入参（引擎装配；测试可注入合成实现） */
export interface BuildTranscriptOptions {
  detail: FunctionPredicates;
  /** 函数体所在文件全部行（1 基取行；保留给后续「跳过 SIF 停用区」类判据） */
  lines: readonly string[];
  /** 谓词求值结果（SIF 同行守卫取其判定；即 `replayPredicates` 的产物） */
  predicates: readonly PredicateReplay[];
  /** 分支走向（`buildBranchOutcomes` 产物；几何覆盖的判据源） */
  branches: readonly BranchChainOutcome[];
  /** 状态视图读取器（`view.read`） */
  read: ValueReader;
  /** 本地量数据流叠加（缺省 = 纯视图求值） */
  overlay?: OverlayReader;
  /** 用户函数内联通道（缺省 = 调用一律 unknown('call')） */
  resolveCall?: CallResolver;
}

/**
 * 构建台词推演（纯函数）。无显示行 → 返回 null（消费方按缺省隐藏该区）。
 * 绝不抛错：单行求值的任何异常都按"判不出"呈现（与求值器同一韧性口径）。
 */
export function buildTranscript(opts: BuildTranscriptOptions): TranscriptLine[] | null {
  const displays = opts.detail.displays;
  if (!displays || displays.length === 0) return null;

  // SIF 行 → 求值记录（守卫判定取这里）
  const sifByLine = new Map<number, PredicateReplay>();
  for (const p of opts.predicates) {
    if (p.kind === 'SIF') sifByLine.set(p.line, p);
  }
  // 包络链按链头行升序 = 外→内（branches 产物已按 headLine 排序；防御性再排一次）
  const chains = [...opts.branches].sort((a, b) => a.headLine - b.headLine);
  // 谓词求值结果按行归并（unknown 链的"本支明确为假"判据要按行取；CASE 同行多值）
  const predsByLine = new Map<number, PredicateReplay[]>();
  for (const p of opts.predicates) {
    const arr = predsByLine.get(p.line);
    if (arr) arr.push(p);
    else predsByLine.set(p.line, [p]);
  }

  const out: TranscriptLine[] = [];
  for (const dl of displays) {
    const chainVis = visibilityFromChains(dl.line, chains, predsByLine);
    const vis = refineBySif(chainVis, dl, sifByLine);
    if (vis.visibility === 'hidden') {
      out.push({ line: dl.line, verb: dl.verb, visibility: 'hidden', payload: dl.payload, text: '', unresolved: 0, reason: vis.reason, guardLine: vis.guardLine });
      continue;
    }
    let text = '';
    let unresolved = 0;
    try {
      const ctxOf = (at: { line: number; context: readonly string[] }): EvalContext => ({
        read: (ref) => {
          const resolved = specialRef(ref);
          const o = opts.overlay ? opts.overlay(resolved, at) : null;
          return o ?? opts.read(resolved);
        },
        ...(opts.resolveCall ? { resolveCall: opts.resolveCall } : {}),
      });
      const built = evaluateText(dl, ctxOf);
      text = built.text;
      unresolved = built.unresolved;
    } catch (err) {
      // 求值通道意外异常：显式降级为"判不出"，绝不抛错中断整棵推演
      text = UNKNOWN_PLACEHOLDER;
      unresolved = Math.max(1, dl.interpolations.length);
      void err;
    }
    out.push({
      line: dl.line,
      verb: dl.verb,
      visibility: vis.visibility,
      payload: dl.payload,
      text,
      unresolved,
      ...(vis.reason ? { reason: vis.reason } : {}),
      ...(vis.guardLine !== undefined ? { guardLine: vis.guardLine } : {}),
    });
  }
  return out;
}
