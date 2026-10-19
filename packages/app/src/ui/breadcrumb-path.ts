import type { EditorDocumentSymbol } from '@kojo/plugin-api';
import { enclosingChainAt } from '@kojo/plugin-api';

/**
 * 面包屑链（D1，2026-10-15 折叠/面包屑批）——宿主自绘面包屑栏的**纯逻辑**。
 *
 * 为什么走宿主自绘（取证，monaco-editor 0.57.0）：standalone 公开面 `monaco.d.ts` 里
 * `breadcrumb` **零命中**——包内仅有 diff 编辑器专属的 `diffEditorBreadcrumbs` 与残留的
 * `breadcrumb.*` 主题色变量；VSCode 那条面包屑住在 `vs/workbench`，不在 monaco-editor 产物里。
 * 所以不硬造 workbench 级组件，宿主画一条轻量栏，数据**复用 B3 的 documentSymbol 树**
 * （`collectDocumentSymbols`）——同一棵树喂大纲 / 吸顶 / 面包屑，不建第二份符号树。
 *
 * 与 `stickyScroll` 的分工（同一状态只在一处显示）：吸顶显示的是**最内层块头**（滚动时
 * 钉在顶部的那一行，来自同一棵 outline 树）；面包屑显示的是**完整链**（外→内各级 +
 * 点击跳转）。同源同判据，两者只可能一致、不可能打架。
 */

/** 一条面包屑（`startLine` = 块头行，点击跳这里；模型坐标，宿主已按活动 model 判据过滤） */
export interface CrumbItem {
  readonly name: string;
  readonly kind: EditorDocumentSymbol['kind'];
  readonly startLine: number;
}

/**
 * 光标行 → 符号链（外 → 内，1 基闭区间）。
 *
 * **判据不在本文件**（W7 NAV-SCOPE）：区间包含、平局折法、嵌套下行全在契约层的
 * `enclosingChainAt` 一处——同一行此前有四份尺子（面包屑 / 大纲吸顶 / 跳状态 / 调用层级），
 * 各给各的答案，没有裁决者。现在四条消费者读同一条，差异只体现在**模式参数**上
 * （面包屑与吸顶要最内层 ⇒ 链尾；跳状态要"这一行属于哪个函数"⇒ 同一条链上取
 * 最后一个 `kind === 'function'` 的节点）。
 *
 * 与旧口径的一致性（逐条钉在 `tests/breadcrumb-path.test.ts`）：平铺结构与嵌套树走同一条
 * 判据；不含该行 ⇒ 空链（**不猜**）；同区间双胞胎只留文档序第一枚（确定性）。
 */
export function symbolChainAt(symbols: readonly EditorDocumentSymbol[], line: number): EditorDocumentSymbol[] {
  return enclosingChainAt(symbols, line);
}

/** 符号链 → 面包屑项（宿主 setState 前的形状收窄；等值判据见 `crumbsKey`） */
export function toCrumbs(chain: readonly EditorDocumentSymbol[]): CrumbItem[] {
  return chain.map((symbol) => ({ name: symbol.name, kind: symbol.kind, startLine: symbol.startLine }));
}

/** 面包屑列表的**等值键**（同键 = 视觉无变化，光标每动一次不该白刷一次 React） */
export function crumbsKey(crumbs: readonly CrumbItem[]): string {
  return crumbs.map((c) => `${c.startLine}\u0000${c.name}`).join('\u0001');
}

/** 一次刷新请求的位点事实（链只由这三项决定：文件 + 行 + 体量） */
export interface CrumbCursor {
  readonly path: string;
  readonly line: number;
  readonly lineCount: number;
}

/**
 * 这次光标 / 文件变化值不值得重算链（性能闸）。
 *
 * 面包屑没有现成的"增量"可用：链要从**整篇符号树**下行，而符号树每次都要重解析全文。
 * 这一条只回答"位点动没动"（同 path 同行 ⇒ 不重算：敲字改的是列不是行，块边界即使真的
 * 变了，最多滞后到下一次换行即补上），换来的是"每敲一键全文解析一次"不再发生。
 *
 * **大文件不在这里判**（1020 编辑器体感批改）：这里曾经一并写着"≥5,000 行不给面包屑"，
 * 但那条闸把索引快路（干净缓冲区 + 已索引名录，**零解析**）也一起挡死了——大文件明明
 * 一次全文解析都不必付，链却整个消失。体量闸因此上移到调用方（`EditorPane` 的
 * `crumbRefresh`）：**只有"既没缓存也没索引、又必须现解析"时**才按体量清链，
 * 清链的理由（前一份文件的旧链会把别的文件行号 reveal 进当前文件）逐字不变。
 */
export function crumbsNeedRefresh(next: CrumbCursor, last: CrumbCursor | null): boolean {
  return last === null || last.path !== next.path || last.line !== next.line;
}

/**
 * 光标行的**逐级下拉数据**（VS Code 面包屑那两条：父级 + 同级）。
 *
 * 一级 = `current`（链上这一枚）+ `siblings`（与它**同层**的那些符号，含自己）；
 * "同层"按引用在树上找到它真正住的那一份数组（顶层 `symbols` 或某个父节点的 `children`），
 * 而不是"上一条链项的 children"——归属链是全树下行的结果，重叠兄弟与平铺树都可能让
 * 两者不等，拿链的相邻关系猜层级会把作者导到别处的块。
 *
 * 找不到归属（树在这一拍被换掉 / 传进来的不是同一批对象）⇒ 同级为空，**不猜**。
 * `siblings` 按 `startLine` 文档序，超出 {@link CRUMB_SIBLING_LIMIT} 时以当前项为窗心开窗，
 * 差额如实报在 `hidden`（铁律 4：截断要说出来，不能让人以为"就这些"）。
 */
export interface CrumbLevel {
  readonly current: CrumbItem;
  readonly siblings: readonly CrumbItem[];
  /** 因窗口上限没列出的同层项数（`0` = 全量在内） */
  readonly hidden: number;
}

/** 同级下拉一屏最多列多少项（超出取以当前项为窗心的那一段） */
export const CRUMB_SIBLING_LIMIT = 200;

/** 找到 `target` 真正住在的那一份同层数组（按引用比；找不到 ⇒ 空数组） */
function levelContaining(
  nodes: readonly EditorDocumentSymbol[],
  target: EditorDocumentSymbol,
): readonly EditorDocumentSymbol[] {
  if (nodes.includes(target)) return nodes;
  for (const node of nodes) {
    const children = node.children;
    if (!children || children.length === 0) continue;
    const found = levelContaining(children, target);
    if (found.length > 0) return found;
  }
  return [];
}

/** 同层窗口：不超限给全量；超限给以当前项为窗心的连续一段 */
function siblingWindow(
  level: readonly EditorDocumentSymbol[],
  current: EditorDocumentSymbol,
): { readonly siblings: readonly CrumbItem[]; hidden: number } {
  if (level.length <= CRUMB_SIBLING_LIMIT) return { siblings: toCrumbs(level), hidden: 0 };
  const at = level.indexOf(current);
  const half = Math.floor(CRUMB_SIBLING_LIMIT / 2);
  // 窗心靠左/靠右时贴边取满，中间时居中——当前项恒在窗口内（at<0 时从 0 起，链本身仍可见）
  const from = at < 0 ? 0 : Math.max(0, Math.min(at - half, level.length - CRUMB_SIBLING_LIMIT));
  return { siblings: toCrumbs(level.slice(from, from + CRUMB_SIBLING_LIMIT)), hidden: level.length - CRUMB_SIBLING_LIMIT };
}

/** 符号树 + 光标行 → 逐级下拉数据（外→内，与 {@link symbolChainAt} 同一条链） */
export function crumbLevelsAt(
  symbols: readonly EditorDocumentSymbol[],
  line: number,
): CrumbLevel[] {
  return symbolChainAt(symbols, line).map((node) => {
    const level = levelContaining(symbols, node);
    const { siblings, hidden } = siblingWindow(level, node);
    return { current: toCrumbs([node])[0]!, siblings, hidden };
  });
}
