import type { EnclosingMode, ErbFunction, ErbFunctionRef, ErbIndex, ErbReference } from '@kojo/plugin-api';
import { enclosingAt } from '@kojo/plugin-api';

/**
 * ERB 调用层级（2026-10-16 批 E）——**数据层**：入边 / 出边的收集与所属函数反查。
 *
 * 纯函数、零 Monaco、零 React，假索引即可 node 单测。选这个形态的原因：
 * Monaco standalone 从未暴露 CallHierarchyProvider（`editor.api.d.ts` 全文 0 处
 * CallHierarchy，取证见 PITFALLS §83）⇒ 宿主自建查询能力，UX 走既有 overlay 面板，
 * 不碰 Monaco provider 通道。
 *
 * ## 数据源（零第二判据）
 *
 * - **引用判定**：全部复用 erb-parser 反向索引（`ErbIndex.references.bySymbol`，
 *   经服务方法 `referencesTo` 同一条通道落表）。「什么算引用 / 什么算 CALL 调用点」
 *   的口径单源在 `erb-parser/references.ts`（`ErbReference.kind`）——本层只按 `kind`
 *   过滤，**禁止抄第二份正则**。
 * - **入边**：`bySymbol.get(归一化名)` 的引用点（`definition` 除外）→ 逐条反查所属函数。
 * - **出边**：`bySymbol` 全表里 `kind === 'call'` 且落在本函数定义区间内的调用点，
 *   按被调名分组。只认 `call`（CALL 直系族名字槽，引擎"按名调用"的可证明子集）；
 *   `mention`（表达式函数调用等）**不进**出边——宁可少报不误报，与索引自身的口径同方向。
 * - **所属函数反查**：优先走解析器的 `functionAt` 通道（"行 → 函数"的单一真源，
 *   缺席 = 提供方未实现）；缺席时退化到同一份索引 `files` 的定义区间包含判断——
 *   那条尺子**不在本文件写**，与大纲 / 面包屑 / 跳状态读的是契约层同一份
 *   （`enclosingAt(..., 'innermost')`，W7 NAV-SCOPE 批：此前这里用 `find` 取**第一个**
 *   区间包含者，是四份判据里唯一按文档序裁决的那一份）。
 *   反查不了（行漂移 / 索引缝）⇒ 跳过该条——**fail-open，宁缺毋错**。
 * - **索引未建 / 名字不在索引** ⇒ 空结果，不猜。
 *
 * 陈旧索引说明：调用层级只读不写，索引与现场文本之间没有锁；作者刚改过的行可能
 * 坐标漂移，反查不了就少一条（fail-open），不做文本验证那套（那是 rename 的写前
 * 判据，只读展示用不上）。
 */

/** 一处调用点（复用反向索引坐标：1 基行列，`endColumn` 不含端点） */
export type CallSite = ErbReference;

/** 入边一组：一个调用者函数 + 它对本函数的全部调用点（sites 保持索引的 行→列 序） */
export interface IncomingCallGroup {
  readonly caller: ErbFunction;
  readonly sites: readonly CallSite[];
}

/** 出边一组：一个被调函数（定义取 `byName` 第一枚）+ 本函数对它的全部调用点 */
export interface OutgoingCallGroup {
  readonly callee: ErbFunctionRef;
  readonly sites: readonly CallSite[];
}

/**
 * `functionAt` 通道的形状（解析器服务的可选成员；测试替身按此形状注入）。
 *
 * 返回值三态：函数 = 命中；`undefined` = 通道在场、权威答"不在此函数内"（尊重，
 * 不退化）；`null` = 通道不存在（服务 / 方法缺席）⇒ 调用方退化到索引自扫。
 */
export type FunctionAtResolver = (path: string, line: number) => ErbFunction | null | undefined;

/**
 * 位置 → 包围函数（**纯函数**；fail-open，反查不了返回 `undefined`）。
 *
 * - `functionAt` 在场：它是"行 → 函数"的单一真源，答 `undefined` 就是权威答案
 *   （契约明确"不在任何函数体内一律 undefined，不夹取"）；答 `null`（通道缺席）或
 *   抛错才退化自扫——两套判据只在"通道根本没接上"时兜底，不叠加制造漂移面。
 * - `functionAt` 缺席（`null`）：退化到同一份索引 `files` 上的**同一把尺子**
 *   （契约层 `enclosingAt`，`mode` 原样透传 ⇒ 兜底与真源不会给出两种答案）。
 */
export function resolveEnclosingFunction(
  index: ErbIndex,
  functionAt: FunctionAtResolver | null,
  filePath: string,
  line: number,
  mode: EnclosingMode = 'innermost',
): ErbFunction | undefined {
  if (functionAt) {
    try {
      const hit = functionAt(filePath, line);
      if (hit !== null) return hit ?? undefined;
    } catch {
      // 通道抛错 ⇒ 退化到本地区间判断（不把一次查询带崩）
    }
  }
  const file = index?.files?.get(filePath);
  if (!file) return undefined;
  return enclosingAt(file.functions, line, mode);
}

/**
 * 入边收集（**纯函数**）：`归一化名` 的全部引用点 → 逐条反查所属函数 → 按调用者分组。
 *
 * - `definition` 类引用是函数定义行自身，不是"被谁调用"，剔除；
 * - 引用点不在任何函数体内（顶层代码 / 行号漂移出索引缝）⇒ 跳过该条，不猜归属；
 * - 分组按首现序（索引本身按 构建序→行→列 确定排序，组间天然稳定）。
 */
export function incomingCalls(
  index: ErbIndex,
  functionAt: FunctionAtResolver | null,
  normalizedName: string,
): IncomingCallGroup[] {
  const refs = index.references?.bySymbol.get(normalizedName.toUpperCase());
  if (!refs || refs.length === 0) return [];
  const groups: IncomingCallGroup[] = [];
  const byCaller = new Map<string, { caller: ErbFunction; sites: CallSite[] }>();
  for (const ref of refs) {
    if (ref.kind === 'definition') continue;
    const caller = resolveEnclosingFunction(index, functionAt, ref.filePath, ref.line);
    if (!caller) continue;
    let group = byCaller.get(caller.normalizedName);
    if (!group) {
      group = { caller, sites: [] };
      byCaller.set(caller.normalizedName, group);
      groups.push({ caller, sites: group.sites });
    }
    group.sites.push(ref);
  }
  return groups;
}

/**
 * 出边收集（**纯函数**）：反向索引全表里 `kind === 'call'` 且落在本函数定义区间内的
 * 调用点 → 按被调名分组。
 *
 * 为什么出边走"索引反查"而不是正向扫函数体文本：正向扫就得在宿主层重写"什么算
 * CALL 引用"的判据（第二份正则必然与 `erb-parser/references.ts` 漂移）；而 bySymbol
 * 里的每一个 `call` 引用都是那条判据落表的——按行区间取子集即可，零新判据。
 * 代价是一次全表遍历（真语料 52,713 调用点 ≈ 毫秒级），面板打开才发生，可接受。
 *
 * 反向索引缺席（提供方未建）⇒ 空数组——出边与入边同源，索引没有就都没有，
 * 由 UI 层给可见说明。
 */
export function outgoingCalls(
  index: ErbIndex,
  def: { readonly filePath: string; readonly startLine: number; readonly endLine: number },
): OutgoingCallGroup[] {
  const bySymbol = index.references?.bySymbol;
  if (!bySymbol) return [];
  const groups: OutgoingCallGroup[] = [];
  for (const [calleeName, refs] of bySymbol) {
    const sites = refs.filter(
      (r) =>
        r.kind === 'call' &&
        r.filePath === def.filePath &&
        r.line >= def.startLine &&
        r.line <= def.endLine,
    );
    if (sites.length === 0) continue;
    const callee = index.byName.get(calleeName)?.[0];
    if (!callee) continue;
    groups.push({ callee, sites });
  }
  // sites 已是 行→列 序 ⇒ 每组首元素就是该组最早调用行；按它排出"函数体里的阅读序"
  groups.sort((a, b) => a.sites[0]!.line - b.sites[0]!.line);
  return groups;
}
