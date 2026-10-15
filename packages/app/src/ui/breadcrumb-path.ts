import type { EditorDocumentSymbol } from '@kojo/plugin-api';

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
 * 每层取**区间最小**的包含项（ERB 侧是平铺的函数/声明列表、`.kojo` 侧是嵌套树，两种形状
 * 都走这一条判据），然后下钻 `children`。不含该行即断链——**不猜**父级。
 * 区间相同（同层双胞胎）时取文档序第一枚，保证确定性。
 */
export function symbolChainAt(symbols: readonly EditorDocumentSymbol[], line: number): EditorDocumentSymbol[] {
  const chain: EditorDocumentSymbol[] = [];
  let level: readonly EditorDocumentSymbol[] = symbols;
  for (;;) {
    let pick: EditorDocumentSymbol | undefined;
    for (const symbol of level) {
      if (symbol.startLine <= line && line <= symbol.endLine) {
        if (!pick || symbol.endLine - symbol.startLine < pick.endLine - pick.startLine) pick = symbol;
      }
    }
    if (pick === undefined) break;
    chain.push(pick);
    level = pick.children ?? [];
    if (level.length === 0) break;
  }
  return chain;
}

/** 符号链 → 面包屑项（宿主 setState 前的形状收窄；等值判据见 `crumbsKey`） */
export function toCrumbs(chain: readonly EditorDocumentSymbol[]): CrumbItem[] {
  return chain.map((symbol) => ({ name: symbol.name, kind: symbol.kind, startLine: symbol.startLine }));
}

/** 面包屑列表的**等值键**（同键 = 视觉无变化，光标每动一次不该白刷一次 React） */
export function crumbsKey(crumbs: readonly CrumbItem[]): string {
  return crumbs.map((c) => `${c.startLine}\u0000${c.name}`).join('\u0001');
}
