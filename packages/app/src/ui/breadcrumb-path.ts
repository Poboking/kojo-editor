import type { EditorDocumentSymbol } from '@kojo/plugin-api';
import { enclosingChainAt } from '@kojo/plugin-api';
import { LARGE_FILE_LINES } from './editor-options';

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
 * 两条判据各挡一类全文级开销：
 * - **同 path 同行 ⇒ 不重算**：敲字改的是列，不是行；块的边界即使真的变了，最多滞后到
 *   下一次换行即补上。换来的是"每敲一键全文解析一次"不再发生（光标监听没有防抖）。
 * - **大文件档 ⇒ 不给面包屑**：与 `editor-options` 里 `stickyScroll` 同一条降级理由
 *   （52,000 行那种文件上一次全文解析几十毫秒，一条呈现栏不值）。
 *   注意：false 对大文件是"**必须清空链**"而非"维持现状"——调用方须另行判体量
 *   （`LARGE_FILE_LINES`）并清链，否则前一份文件的旧链残留，点击段会把别的文件的
 *   行号 reveal 进当前文件（EditorPane 的 `crumbRefresh` 负责这件事）。
 */
export function crumbsNeedRefresh(next: CrumbCursor, last: CrumbCursor | null): boolean {
  if (next.lineCount >= LARGE_FILE_LINES) return false;
  return last === null || last.path !== next.path || last.line !== next.line;
}
