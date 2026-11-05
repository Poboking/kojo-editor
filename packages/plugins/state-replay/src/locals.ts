/**
 * 函数级求值上下文叠加（v0.2 第六批；游戏无关；本插件私有）。
 *
 * 在状态视图（快照）之上叠加**函数内**语义（本地量数据流 / 调用上下文与参数槽
 * 赋值），并提供调用上下文的逐槽合并（面板注入 × 适配器推导）。全是引擎语言层
 * 知识，不含游戏知识。
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
 *    2026-11-05 E3（未发布循环量的循环头使旧赋值失效）：若找到的赋值在一条
 *    **未发布**的 `FOR` 循环头之前（`loopHeaderBinding` 非 null，且该循环不在
 *    `detail.loopCounters` 里），该赋值已被循环头每一轮写入覆盖 ⇒ 不返回旧值，
 *    改判 unknown('local-no-write')、理由复用"循环量逐轮取值、区间未发布"那套。
 *    复现：`LOCAL = 0` + `FOR LOCAL,1,CHARANUM`（区间未发布）+ 体内 `IF LOCAL == 0`
 *    此前因取旧赋值而被判成 true。**已发布**的循环不受影响——逐值试算在
 *    `loop-range.ts` 的谓词层做，本层不抢。
 *
 * 2. **调用上下文 + 参数槽直线赋值**：`ARG / ARGS` 引用（裸名 ≡ 0 号槽）的
 *    **调用时初值**来自注入的 `ReplayCallContext`；未提供 / 未覆盖的槽位 →
 *    unknown('call-context')（默认不猜测 0：转发自路由层的值是场景输入，编辑器
 *    无从推断）。
 *
 *    2026-11-05 E2（函数内赋值参与数据流）：引擎语义是"调用时写初值、函数体内
 *    可覆盖"（`ConvertArg` / `IntoFunction`），所以 `ARG(:n) = …` 与 LOCAL 同族
 *    一样进直线数据流：先按**同一套前缀可达性**找使用点之前最后一条该 `name+index`
 *    的赋值，找到就求值它，**找不到才回落到注入值**。此前"注入永远优先"把
 *    `ARG = TARGET` 这类参数补位当成没写过——那是错的（复现：assignment
 *    `ARG = TARGET`(TARGET=49) + 注入 `ints:[0]` ⇒ `ARG == 49` 被误判为假）。
 *    契约 `FunctionAssignment` 头注里"静态叠加层不消费"一句是 E2 之前的旧口径，
 *    本文件按新语义执行它（契约**形状**未变，只改回放侧解释）。
 *    **已知近似**：赋值行的上一行若是 `SIF …` 守卫（`SIF !ARG / ARG = TARGET`
 *    惯用形），本层不建模"守卫可能为假 ⇒ 赋值可能不执行"——直线数据流只认
 *    路径前缀，不认 if 语义；这一档宁可把补位当已执行（与"调用时初值"同源），
 *    也不退回"注入永远优先"。
 *
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
 * 3. **调用上下文逐槽合并**（2026-11-05 E1）：`mergeCallContext` 把面板显式注入
 *    与适配器推导的"确定事实"逐 kind 逐下标合并（显式非 undefined 胜、undefined
 *    由推导值补）。语义理由：两者描述的是**同一份调用实参的不同槽位**，显式注入
 *    只是"面板手工填的那几格"，不是"整份上下文的替代品"——此前"显式整体取代
 *    推导器"会让路由确定的「发言者槽 = 回放角色号」被面板的其它槽位一起盖掉
 *    （HK-20 缺陷；面板部分注入含预填 0 时尤甚）。
 *
 * KW-15E 1103 判性批：`local-no-write` 的**判定口径一字未改**（真语料 K49×save03 的
 * 191 枚逐枚归类后，可证子集为 0 枚，见 `noWriteReason` 的四种事实），只把"为什么
 * 判不出"写实；不许把别支 / 循环头 / 引擎动词写的值当成本使用点可取的赋值。
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
/**
 * 命令返回值寄存器族（语言级事实）：真语料里绝大多数"函数内没人赋值"的读取都是这两枚——
 * 它们的值由**上方的引擎动词行**写入（输入类动词、被调函数的返回、位操作一类），
 * 而本叠加层只认 `RESULT = …` 这种直线赋值 ⇒ 文案不许把它们说成"没人写过、只剩残留"。
 */
const RESULT_REGISTERS = new Set(['RESULT', 'RESULTS']);

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

/** 一种槽位数组的逐下标合并（显式非 undefined 胜；缺位/undefined 由推导值补；长度取 max） */
function mergeSlots<T>(
  explicit: readonly (T | undefined)[] | undefined,
  derived: readonly (T | undefined)[] | undefined,
): (T | undefined)[] | undefined {
  const len = Math.max(explicit?.length ?? 0, derived?.length ?? 0);
  if (len === 0) return undefined;
  const out: (T | undefined)[] = [];
  let any = false;
  for (let i = 0; i < len; i++) {
    const fromExplicit = explicit?.[i];
    const v = fromExplicit !== undefined ? fromExplicit : derived?.[i];
    if (v !== undefined) any = true;
    out.push(v);
  }
  // 全 undefined 的 kind 整体省略（"有槽位但一格都没值"与"没有这份上下文"是同一事实）
  return any ? out : undefined;
}

/**
 * 调用上下文**逐槽合并**（E1 2026-11-05）——显式注入与推导器产物描述的是同一份
 * 调用实参的不同槽位，不是整份替换关系：
 * - 逐 kind（`ints` / `strs`）逐下标：**显式非 undefined 胜出**，`undefined` / 缺位
 *   由推导值补上（含"显式 0 / 空串是真实实参"——0 ≠ 未提供）；
 * - 某 kind 合并后全 undefined ⇒ 该 kind 省略；两 kind 都空 ⇒ 返回 `undefined`；
 * - 结果数组长度取两者长度的较大者（保留稀疏洞：洞 = 该槽仍未知）。
 *
 * 为什么必须逐槽：面板只注入"作者手填的那几格"（缺省空 = 未提供，预填 0 是否
 * 算实参由面板的假设链路决定），而推导器只填"路由确定的几格"（如发言者槽 =
 * 回放角色号）。整体取代会让任一侧的确定事实凭空消失（HK-20 缺陷）。
 */
export function mergeCallContext(
  explicit?: ReplayCallContext,
  derived?: ReplayCallContext,
): ReplayCallContext | undefined {
  if (!explicit && !derived) return undefined;
  const ints = mergeSlots(explicit?.ints, derived?.ints);
  const strs = mergeSlots(explicit?.strs, derived?.strs);
  if (!ints && !strs) return undefined;
  return { ...(ints ? { ints } : {}), ...(strs ? { strs } : {}) };
}

/** `FOR` 头部第一枚槽位（`LOCAL:2,1,CHARANUM` → `LOCAL` / 下标 2；解析不出 → null） */
const LOOP_HEAD_SLOT_RE = /^([A-Z_][A-Z0-9_]*)(?::(\d+))?\s*,/i;

/**
 * 该槽位是不是**使用点所在这条循环的循环量**（返回 `FOR` 行；不是则 null）。
 * 只读骨架事实（`detail.statements` 的 `FOR`…同深度 `NEXT` 配对），不读正文行——
 * 与抽取侧 `collectLoopCounters` 的分工一致：那边只发布**能算值域**的循环，
 * 这里补的是"发布不了但确实由循环头逐轮写入"这一族的事实，供文案说清因果。
 */
function loopHeaderBinding(
  detail: FunctionPredicates,
  name: string,
  index: number,
  at: OverlayPosition,
): number | null {
  const stmts = detail.statements;
  for (let i = 0; i < stmts.length; i++) {
    const open = stmts[i]!;
    if (open.kind !== 'FOR') continue;
    if (open.line >= at.line) continue; // 循环头在使用点之后 = 与本次读取无关
    const m = LOOP_HEAD_SLOT_RE.exec(open.expression.trim());
    if (!m || m[1]!.toUpperCase() !== name) continue;
    if ((m[2] ? Number(m[2]) : 0) !== index) continue;
    const close = stmts.slice(i + 1).find((t) => t.kind === 'NEXT' && t.depth === open.depth);
    if (!close || close.line <= open.line + 1) continue; // 配不上对的 FOR 不宣称绑定
    if (at.line < close.line) return open.line;
  }
  return null;
}

/** 赋值行号列表的展示（超过 6 枚省略号收尾；三族文案共用一把尺） */
function lineList(as: readonly FunctionAssignment[]): string {
  return `${as
    .slice(0, 6)
    .map((a) => String(a.line))
    .join(' / ')}${as.length > 6 ? ' …' : ''}`;
}

/** 循环量族文案（E3 复用）：值由 FOR 头逐轮写入、区间未发布 ⇒ 不可知 */
function loopHeaderReason(loopHeader: number, at: OverlayPosition): string {
  return `该槽位是 FOR 循环量（第 ${loopHeader} 行的循环头逐轮写入它），使用点在第 ${at.line} 行的循环体内：每一轮的取值都不同，而这条循环的取值区间没能发布（端点非字面量 / 区间过宽 / 体内有标签行都是不发布的条件），故不可知`;
}

/**
 * 该循环头是否在抽取侧**已发布**（`detail.loopCounters`，按 openLine + name + index 认）。
 * 已发布的循环由谓词层逐值试算（`judgePredicateWithLoops`）；本叠加层不抢它，
 * 未发布的才由 E3 判"旧赋值失效"。
 */
function loopIsPublished(
  detail: FunctionPredicates,
  openLine: number,
  name: string,
  index: number,
): boolean {
  const counters = detail.loopCounters;
  if (!counters || counters.length === 0) return false;
  return counters.some(
    (c) => c.openLine === openLine && c.name.toUpperCase() === name && c.index === index,
  );
}

/**
 * 「无可见赋值」的四种事实（KW-15E 1103 判性；一条都不改判定，只改因果说法）：
 *
 * 1. **分支里的赋值**（真语料 97/191）：函数内确有更早赋值，但都在与本使用点
 *    不同的分支路径上。本叠加层的可达性只有一条规则（赋值路径是使用点路径的
 *    前缀），**不折叠分支**——即使每条分支都写了同一个槽位，"走的究竟哪一支"
 *    本身可能就是未知（真语料里那 12 枚的分支条件含 `!RAND:6`），取值又互不相同。
 *    所以这一族的正确结论至今仍是未知，文案只许说"不同分支"，不许说"没人写"。
 * 2. **循环量**：使用点在某条 `FOR` 的体内，该槽位由循环头逐轮写入（每轮一个值）。
 * 3. **命令返回值寄存器**（`RESULT` / `RESULTS`，真语料 87/191 的主体）：函数内没有
 *    直线赋值，值来自上方某条引擎动词行——哪条动词写它、写成什么，本编辑器不建模。
 * 4. **只在更后面写**（5/191）：函数内该槽位的第一次赋值就在使用点之后。
 */
function noWriteReason(
  name: string,
  elsewhere: readonly FunctionAssignment[],
  later: readonly FunctionAssignment[],
  loopHeader: number | null,
  at: OverlayPosition,
): string {
  if (elsewhere.length > 0) {
    return `函数内另有 ${elsewhere.length} 处赋值（第 ${lineList(elsewhere)} 行），都在与本使用点不同的分支路径上；本叠加层只认「赋值在本使用点的外层路径（含同一路径）」这一条可达性，不折叠分支，因此走的是哪一支、那支写的值是多少都判不出（各分支取值不同或分支条件本身未知时，一律保持未知，不许拿别支的赋值当必得）`;
  }
  if (loopHeader !== null) {
    return loopHeaderReason(loopHeader, at);
  }
  if (RESULT_REGISTERS.has(name)) {
    return `${name} 是引擎的命令返回值寄存器：本函数内没有对它的赋值语句，本使用点的值来自更上方某条引擎动词行（哪条动词写它、写成什么，本编辑器不建模）；进入函数时的残留值同样不可知`;
  }
  if (later.length > 0) {
    return `本函数内该槽位只在使用点之后（第 ${lineList(later)} 行）才被赋值，第 ${at.line} 行处还取不到；进入函数时的残留值不可知`;
  }
  return '本函数内该槽位没有赋值语句，进入函数时的残留值不可知';
}

export interface CreateOverlayOptions {
  detail: FunctionPredicates;
  callContext?: ReplayCallContext;
  /** 基础读取器（视图读路径）：赋值 RHS 中的非本地量引用落到它 */
  baseRead: ValueReader;
}

/** 叠加层为空（无赋值且无调用上下文）→ null，调用方跳过叠加 */
export function createFunctionOverlay(opts: CreateOverlayOptions): OverlayReader | null {
  const detail = opts.detail;
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

  /**
   * 使用点之前**最后一条可达**的同槽位赋值（LOCAL 与 ARG/ARGS 共用同一套规则，
   * E2 起）：`line < at.line`（同行的赋值不算——避免 RHS 自引用递归）且赋值路径是
   * 使用点路径的前缀（同路径或祖先路径）。`assignments` 按行升序，越过使用点即止。
   */
  const lastReachableAssignment = (
    name: string,
    index: number,
    at: OverlayPosition,
  ): FunctionAssignment | null => {
    let pick: FunctionAssignment | null = null;
    for (const a of assignments) {
      if (a.name !== name || a.index !== index) continue;
      if (a.line >= at.line) break; // assignments 按行升序；越过使用点即止
      if (!isPrefixPath(a.context, at.context)) continue;
      pick = a;
    }
    return pick;
  };

  /** 本地量槽位解析（last-write-wins among 可达赋值；未发布循环头使旧赋值失效 = E3） */
  const resolveLocal = (name: string, index: number, at: OverlayPosition): ReplayValue => {
    const pick = lastReachableAssignment(name, index, at);
    if (!pick) {
      // 旧文案对"函数里明明写了、只是不在本使用点的必经路径上"那一族是**假话**
      // （读起来像没人赋值）。机器码沿用 `local-no-write`（v0.2 第六批立的边界、
      // 判定口径一字未改），只把"为什么算它无可见赋值"写实。
      // KW-15E 1103 判性批（真语料 191 枚逐枚归类，回执见提交信息）：这枚码底下其实
      // 是四种不同的事实，混在一句里就有三成的点位被说成"只剩进入函数时的残留"这种
      // 根本对不上的理由。判定口径仍是一条都不放宽——**能收的一枚都没多收**。
      const sameSlot = (a: FunctionAssignment): boolean => a.name === name && a.index === index;
      const elsewhere = assignments.filter((a) => sameSlot(a) && a.line < at.line);
      const later = assignments.filter((a) => sameSlot(a) && a.line >= at.line);
      const loopHeader = loopHeaderBinding(detail, name, index, at);
      return {
        kind: 'unknown',
        unknown: {
          code: 'local-no-write',
          message: `本地量在函数内无可见赋值：${name}:${index}（第 ${at.line} 行前，同分支路径）——${noWriteReason(name, elsewhere, later, loopHeader, at)}`,
        },
      };
    }
    // E3：赋值在循环头**之前**、而循环量由未发布的 FOR 头逐轮写入 ⇒ 旧赋值已被
    // 每一轮覆盖，不能当本使用点的取值（复现见文件头）。已发布的循环不在此列：
    // 那档由谓词层逐值试算（`judgePredicateWithLoops`），本层保持原行为不抢。
    const loopHeader = loopHeaderBinding(detail, name, index, at);
    if (loopHeader !== null && pick.line < loopHeader && !loopIsPublished(detail, loopHeader, name, index)) {
      return {
        kind: 'unknown',
        unknown: {
          code: 'local-no-write',
          message: `本地量在函数内无可见赋值：${name}:${index}（第 ${at.line} 行前，同分支路径）——${loopHeaderReason(loopHeader, at)}；第 ${pick.line} 行那条赋值在循环头之前，每一轮都被循环头覆盖，不当成本使用点的取值`,
        },
      };
    }
    return evalAssignment(pick);
  };

  /** ARG/ARGS 槽位解析（E2：函数内赋值覆盖调用时初值；裸名 ≡ 0 号槽） */
  const resolveArg = (
    name: string,
    indices: readonly string[],
    text: string,
    at: OverlayPosition,
  ): ReplayValue => {
    let slot: number | null = null;
    if (indices.length === 0) slot = 0; // 裸 ARG ≡ ARG:0（1D 裸引用 = 0 号下标，引擎语义）
    else if (indices.length === 1 && /^-?\d+$/.test(indices[0]!)) slot = Number(indices[0]);
    if (slot === null || slot < 0) {
      return { kind: 'unknown', unknown: { code: 'call-context', message: `调用参数槽位无法解析：${text}` } };
    }
    // E2：调用上下文是**调用时初值**，函数体内 `ARG(:n) = …` 可覆盖它。与 LOCAL 同一套
    // 前缀可达性、同一套 last-write-wins；找到赋值就求值它（RHS 判不出 → 相应的
    // unknown，不猜），**找不到才回落到注入值**。
    const pick = lastReachableAssignment(name, slot, at);
    if (pick) return evalAssignment(pick);
    if (!callContext) {
      // KW-28 1103：旧文案只说"未提供"，读起来像"谁忘了给"——实际是**这一格的值取决于
      // 本次调用的实参**，而回放既没有调用栈（存档只有状态）也无从知道是哪一处调用进来
      // 的。把因果写实，免得作者去找一个并不存在的"提供入口"。
      // E5（2026-11-05）：再点一句"面板没给这一格填值"，让作者知道缺的就是他自己那格输入。
      return {
        kind: 'unknown',
        unknown: {
          code: 'call-context',
          message: `ARG/ARGS 为调用参数，面板没给这一格填值：${text}（这一格的值由本次调用的实参决定；存档里只有状态、没有调用栈，静态也无从确定是哪一处调用带进来的值 ⇒ 不猜）`,
        },
      };
    }
    const arr = name === 'ARG' ? callContext.ints : callContext.strs;
    const v = arr?.[slot];
    if (v === undefined) {
      // E5（2026-11-05）：旧文案"注入的实参只填了部分槽位"对作者不可操作——面板并不知道
      // 该填哪一格、有的格甚至没有输入框。改成指路：这格的值由本次调用的实参决定，
      // 面板在「场景参数」里可以填（数值槽也能勾「按默认场景 0 试算」），字符串槽照实参填；
      // "不猜、不借用相邻槽位"的口径原样保留。机器码不变（`call-context`）。
      return {
        kind: 'unknown',
        unknown: {
          code: 'call-context',
          message: `调用上下文未覆盖该槽位：${text}（这一格的值由本次调用的实参决定；面板可在「场景参数」里给它填值——数值槽也可勾「按默认场景 0 试算」，字符串槽需照实参填；没填的这一格不猜，也不借用相邻槽位）`,
        },
      };
    }
    return { kind: 'value', value: v };
  };

  const resolve = (ref: VariableRef, at: OverlayPosition): ReplayValue | null => {
    const name = ref.name.toUpperCase();
    if (OVERLAY_ARGS.has(name)) return resolveArg(name, ref.indices, ref.text, at);
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
